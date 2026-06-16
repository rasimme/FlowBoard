'use strict';

/**
 * T-186 — Review/Admin transition endpoint tests.
 *
 *   1. transition guard — pure-function checks that sensitive PUT
 *      transitions (review→done, done→reopen) get flagged.
 *   2. hzl-service.approveTask — review → done, records actor/reason
 *      in the activity surface, idempotent across owner state.
 *   3. hzl-service.rejectTask — review → in-progress (or blocked),
 *      requires reason, records it.
 *   4. hzl-service.completeTask — owner-only contract still holds
 *      (regression guard for the existing complete contract).
 *
 * Run: node test-review-admin-transitions.js
 */

const fs = require('fs');
const path = require('path');
const hzl = require('./hzl-service.js');
const guard = require('./task-transition-guard.js');

const DB_PATH = '/tmp/flowboard-t186-test.db';
const CACHE_PATH = DB_PATH.replace(/\.db$/, '-cache.db');
const PROJECT = 't186-project';

let passed = 0;
let failed = 0;

function ok(cond, msg) {
  if (cond) { passed++; console.log(`  ✅ ${msg}`); }
  else      { failed++; console.error(`  ❌ ${msg}`); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, `${msg} (got ${JSON.stringify(actual)})`);
}
function section(name) { console.log(`\n## ${name}`); }
function cleanDb() {
  for (const f of [DB_PATH, CACHE_PATH]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

function throws(fn, codeOrPattern, msg) {
  try {
    fn();
    failed++;
    console.error(`  ❌ ${msg} (no error thrown)`);
  } catch (e) {
    const match = (typeof codeOrPattern === 'string')
      ? (e.code === codeOrPattern || (e.message || '').includes(codeOrPattern))
      : codeOrPattern.test(e.message || '');
    if (match) { passed++; console.log(`  ✅ ${msg}`); }
    else { failed++; console.error(`  ❌ ${msg} (got: ${e.code || ''} ${e.message})`); }
  }
}

(async function main() {
  cleanDb();
  await hzl.init(DB_PATH);

  // -------------------------------------------------------------------------
  section('1. task-transition-guard — pure function');
  // -------------------------------------------------------------------------
  ok(typeof guard.isSensitiveTransition === 'function', 'exports isSensitiveTransition');
  ok(typeof guard.transitionErrorMessage === 'function', 'exports transitionErrorMessage');
  ok(typeof guard.adminOverrideReasonError === 'function', 'exports adminOverrideReasonError');

  ok(guard.isSensitiveTransition('review', 'done'),
    'review→done is sensitive');
  ok(!guard.isSensitiveTransition('archived', 'done'),
    'archived→done is NOT sensitive (restore from archive)');
  ok(!guard.isSensitiveTransition('done', 'archived'),
    'done→archived is NOT sensitive (terminal cleanup)');
  ok(guard.isSensitiveTransition('done', 'open'),
    'done→open is sensitive (reopen)');
  ok(guard.isSensitiveTransition('done', 'in-progress'),
    'done→in-progress is sensitive (reopen)');
  ok(guard.isSensitiveTransition('done', 'backlog'),
    'done→backlog is sensitive (reopen)');
  ok(guard.isSensitiveTransition('done', 'review'),
    'done→review is sensitive (reopen)');
  ok(!guard.isSensitiveTransition('open', 'in-progress'),
    'open→in-progress is NOT sensitive');
  ok(!guard.isSensitiveTransition('in-progress', 'review'),
    'in-progress→review is NOT sensitive');
  ok(!guard.isSensitiveTransition('open', 'backlog'),
    'open→backlog is NOT sensitive');
  ok(!guard.isSensitiveTransition('review', 'review'),
    'no-op transitions are NOT sensitive');

  const msg = guard.transitionErrorMessage('review', 'done');
  ok(typeof msg === 'string' && msg.includes('/approve'),
    'transitionErrorMessage(review, done) names the /approve endpoint');
  const reopen = guard.transitionErrorMessage('done', 'open');
  ok(typeof reopen === 'string' && /reopen|adminOverride|done/i.test(reopen),
    'transitionErrorMessage(done, open) explains the reopen / override path');
  ok(guard.adminOverrideReasonError('') && /reason/i.test(guard.adminOverrideReasonError('')),
    'adminOverrideReasonError rejects empty reason');
  ok(guard.adminOverrideReasonError('   ') && /reason/i.test(guard.adminOverrideReasonError('   ')),
    'adminOverrideReasonError rejects whitespace-only reason');
  eq(guard.adminOverrideReasonError('manual cleanup'), null,
    'adminOverrideReasonError accepts non-empty reason');

  // -------------------------------------------------------------------------
  section('2. hzl-service.completeTask — owner-only (regression)');
  // -------------------------------------------------------------------------
  const tA = hzl.createTask(PROJECT, { title: 'Owned task', priority: 'medium', status: 'open' });
  hzl.claimTask(PROJECT, tA.id, { agent: 'dev-botti', lease: 30 });
  throws(
    () => hzl.completeTask(PROJECT, tA.id, { agent: 'someone-else' }),
    'NOT_OWNER',
    'completeTask rejects non-owner with NOT_OWNER'
  );
  const completed = hzl.completeTask(PROJECT, tA.id, { agent: 'dev-botti' });
  eq(completed.status, 'review', 'owner can complete → review');

  // -------------------------------------------------------------------------
  section('3. hzl-service.approveTask — review → done');
  // -------------------------------------------------------------------------
  ok(typeof hzl.approveTask === 'function', 'hzl.approveTask is exported');

  // tA is already in review (completed above) — approve it
  const approved = hzl.approveTask(PROJECT, tA.id, { actor: 'operator', reason: 'looks good' });
  eq(approved.status, 'done', 'approveTask returns task in done');
  ok(approved.completed, 'approveTask sets completed date');

  // Approve from a non-review status should fail
  const tB = hzl.createTask(PROJECT, { title: 'Open task', priority: 'medium', status: 'open' });
  throws(
    () => hzl.approveTask(PROJECT, tB.id, { actor: 'operator' }),
    /not in review|review/i,
    'approveTask rejects task not in review'
  );

  // Approve writes an audit comment/event mentioning actor + transition
  const eventsA = hzl.getComments(PROJECT, tA.id);
  const approvalComment = eventsA.find(c => /approve|approved/i.test(c.message || ''));
  ok(approvalComment, 'approveTask records an audit comment containing "approved"');
  ok(approvalComment && /operator/.test(approvalComment.message || ''),
    'audit comment includes the actor');

  // -------------------------------------------------------------------------
  section('4. hzl-service.rejectTask — review → in-progress (default)');
  // -------------------------------------------------------------------------
  ok(typeof hzl.rejectTask === 'function', 'hzl.rejectTask is exported');

  const tC = hzl.createTask(PROJECT, { title: 'Reject me', priority: 'medium', status: 'open' });
  hzl.claimTask(PROJECT, tC.id, { agent: 'dev-botti', lease: 30 });
  hzl.completeTask(PROJECT, tC.id, { agent: 'dev-botti' });
  eq(hzl.getTask(PROJECT, tC.id).status, 'review', 'tC is in review');

  // Reason is required
  throws(
    () => hzl.rejectTask(PROJECT, tC.id, { actor: 'operator' }),
    /reason/i,
    'rejectTask requires a reason'
  );
  throws(
    () => hzl.rejectTask(PROJECT, tC.id, { actor: 'operator', reason: '   ' }),
    /reason/i,
    'rejectTask rejects whitespace-only reason'
  );

  const rejected = hzl.rejectTask(PROJECT, tC.id, {
    actor: 'operator',
    reason: 'tests are missing',
  });
  eq(rejected.status, 'in-progress', 'rejectTask sends task back to in-progress by default');

  const commentsC = hzl.getComments(PROJECT, tC.id);
  const rejectComment = commentsC.find(c => /reject|rejected/i.test(c.message || ''));
  ok(rejectComment, 'rejectTask records a comment');
  ok(rejectComment && /tests are missing/.test(rejectComment.message || ''),
    'rejection comment contains the reason text');
  ok(rejectComment && /operator/.test(rejectComment.message || ''),
    'rejection comment names the actor');

  // Reject to blocked target
  const tD = hzl.createTask(PROJECT, { title: 'Reject to blocked', priority: 'medium', status: 'open' });
  hzl.claimTask(PROJECT, tD.id, { agent: 'dev-botti', lease: 30 });
  hzl.completeTask(PROJECT, tD.id, { agent: 'dev-botti' });
  const rejD = hzl.rejectTask(PROJECT, tD.id, {
    actor: 'operator',
    reason: 'spec changed',
    target: 'blocked',
  });
  eq(rejD.status, 'in-progress', 'rejectTask with target=blocked still puts task in in-progress…');
  eq(rejD.blocked, true, '…but with blocked=true');

  // Rejecting a non-review task fails
  const tE = hzl.createTask(PROJECT, { title: 'Open already', priority: 'medium', status: 'open' });
  throws(
    () => hzl.rejectTask(PROJECT, tE.id, { actor: 'operator', reason: 'no' }),
    /review/i,
    'rejectTask rejects task not in review'
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(err => {
  console.error('FATAL:', err);
  process.exit(2);
});
