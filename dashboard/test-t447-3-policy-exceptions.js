'use strict';

/** T-447-3 — server-context exception predicates and durable decisions. */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-t447-3-'));
const dbPath = path.join(root, 'flowboard.db');
const ledgerDir = path.join(root, 'audit');
process.env.FLOWBOARD_POLICY_LEDGER_DIR = ledgerDir;

const hzl = require('./hzl-service.js');
const ledger = require('./policy-ledger.js');

const PROJECT = 't447-3-exceptions';
const ledgerOptions = { dir: ledgerDir };
const human = { kind: 'human', verified: true, actor: 'telegram:42', humanId: '42' };
const evidence = { verified: true, actor: 'telegram:42', humanId: '42', requestId: 'request-1', verifiedAt: new Date().toISOString() };

function expectBlocked(fn, code) {
  assert.throws(fn, error => error.code === code, `blocked with ${code}`);
}

(async function main() {
  await hzl.init(dbPath);

  // Handoff: a real in-progress source is required.
  const handoffSource = hzl.createTask(PROJECT, { title: 'Handoff source', status: 'open' });
  hzl.claimTask(PROJECT, handoffSource.id, { agent: 'worker-one' });
  const handed = hzl.createTaskWithPolicy(PROJECT, { title: 'Handoff follow-on', status: 'open' }, {
    origin: 'handoff', exception: 'handoff', sourceTaskId: handoffSource.id,
    principal: { kind: 'agent', verified: false, actor: 'agent:worker-one' }, policyLedgerOptions: ledgerOptions,
  });
  assert.equal(handed.creationAudit.exception, 'handoff');
  assert.equal(handed.creationAudit.policyDecision, 'allowed');
  assert.deepEqual(handed.exceptionReview, { status: 'pending', reviewer: null, reviewedAt: null });

  const nonProgressSource = hzl.createTask(PROJECT, { title: 'Not in progress', status: 'open' });
  const beforeHandoffReject = hzl.listTasks(PROJECT).length;
  expectBlocked(() => hzl.createTaskWithPolicy(PROJECT, { title: 'Invalid handoff' }, {
    origin: 'handoff', exception: 'handoff', sourceTaskId: nonProgressSource.id,
    policyLedgerOptions: ledgerOptions,
  }), 'HANDOFF_SOURCE_NOT_IN_PROGRESS');
  assert.equal(hzl.listTasks(PROJECT).length, beforeHandoffReject, 'invalid handoff creates no task');

  // Delegate: the parent relation is exact; noDepends is never the exception.
  const delegateSource = hzl.createTask(PROJECT, { title: 'Delegate source', status: 'open' });
  const delegated = hzl.createTaskWithPolicy(PROJECT, { title: 'Child', parentId: delegateSource.id, status: 'open' }, {
    origin: 'delegate', exception: 'delegate_subtask', sourceTaskId: delegateSource.id,
    fromTaskId: delegateSource.id, principal: { kind: 'agent', verified: false, actor: 'agent:worker-one' },
    policyLedgerOptions: ledgerOptions,
  });
  assert.equal(delegated.creationAudit.exception, 'delegate_subtask');
  assert.equal(delegated.exceptionReview.status, 'pending');

  expectBlocked(() => hzl.createTaskWithPolicy(PROJECT, { title: 'Wrong parent', parentId: nonProgressSource.id }, {
    origin: 'delegate', exception: 'delegate_subtask', sourceTaskId: delegateSource.id,
    policyLedgerOptions: ledgerOptions,
  }), 'DELEGATE_PARENT_MISMATCH');

  // Both server-owned source fields must agree; choosing one by precedence
  // would let a caller pair an unrelated live source with the requested
  // parent.
  expectBlocked(() => hzl.createTaskWithPolicy(PROJECT, { title: 'Conflicting sources', parentId: delegateSource.id }, {
    origin: 'delegate', exception: 'delegate_subtask', sourceTaskId: delegateSource.id,
    fromTaskId: nonProgressSource.id, policyLedgerOptions: ledgerOptions,
  }), 'DELEGATE_SOURCE_CONFLICT');

  const noDepends = hzl.createTaskWithPolicy(PROJECT, { title: 'Top-level delegation', parentId: null }, {
    origin: 'delegate', sourceTaskId: delegateSource.id, fromTaskId: delegateSource.id,
    noDepends: true, policyLedgerOptions: ledgerOptions,
  });
  assert.equal(noDepends.creationAudit.exception, undefined, 'noDepends has no exception claim');
  assert.equal(noDepends.creationAudit.policyDecision, 'would_block');
  assert.equal(noDepends.exceptionReview, null);
  expectBlocked(() => hzl.createTaskWithPolicy(PROJECT, { title: 'noDepends with parent', parentId: delegateSource.id }, {
    origin: 'delegate', sourceTaskId: delegateSource.id, fromTaskId: delegateSource.id,
    noDepends: true, policyLedgerOptions: ledgerOptions,
  }), 'NO_DEPENDS_PARENT_CONFLICT');
  expectBlocked(() => hzl.createTaskWithPolicy(PROJECT, { title: 'Forged noDepends exception', parentId: null }, {
    origin: 'delegate', exception: 'delegate_subtask', sourceTaskId: delegateSource.id,
    noDepends: true, policyLedgerOptions: ledgerOptions,
  }), 'NO_DEPENDS_NOT_EXCEPTION');

  // Incident: only a non-empty server-supplied reference qualifies.
  const incident = hzl.createTaskWithPolicy(PROJECT, { title: 'Production incident' }, {
    origin: 'incident', exception: 'incident', incidentRef: 'INC-123', policyLedgerOptions: ledgerOptions,
  });
  assert.equal(incident.creationAudit.incidentRef, 'INC-123');
  assert.equal(incident.exceptionReview.status, 'pending');
  expectBlocked(() => hzl.createTaskWithPolicy(PROJECT, { title: 'Unreferenced incident' }, {
    origin: 'incident', exception: 'incident', incidentRef: '  ', policyLedgerOptions: ledgerOptions,
  }), 'INCIDENT_REFERENCE_REQUIRED');

  // Trivial: server-verified human evidence and one top-level action.
  const trivial = hzl.createTaskWithPolicy(PROJECT, { title: 'Small human-requested action' }, {
    origin: 'human_requested_trivial', exception: 'human_requested_trivial', principal: human,
    humanEvidence: evidence, actionCount: 1, policyLedgerOptions: ledgerOptions,
  });
  assert.equal(trivial.creationAudit.exception, 'human_requested_trivial');
  assert.equal(trivial.exceptionReview.status, 'pending');
  expectBlocked(() => hzl.createTaskWithPolicy(PROJECT, { title: 'Agent says trivial' }, {
    origin: 'human_requested_trivial', exception: 'human_requested_trivial',
    principal: { kind: 'agent', verified: false, actor: 'agent:worker-one' }, humanEvidence: evidence,
    actionCount: 1, policyLedgerOptions: ledgerOptions,
  }), 'HUMAN_EVIDENCE_REQUIRED');
  expectBlocked(() => hzl.createTaskWithPolicy(PROJECT, { title: 'Two actions', parentId: delegateSource.id }, {
    origin: 'human_requested_trivial', exception: 'human_requested_trivial', principal: human,
    humanEvidence: evidence, actionCount: 2, policyLedgerOptions: ledgerOptions,
  }), 'TRIVIAL_ACTION_SHAPE_INVALID');

  // The enum is closed; arbitrary exception strings cannot become audit truth.
  expectBlocked(() => hzl.createTaskWithPolicy(PROJECT, { title: 'Unknown exception' }, {
    origin: 'tasks-api', exception: 'operator_override', policyLedgerOptions: ledgerOptions,
  }), 'EXCEPTION_INVALID');

  const entries = ledger.readPolicyLedger(ledgerOptions);
  assert.ok(entries.some(e => e.decision === 'allowed' && e.exception === 'handoff'));
  assert.ok(entries.some(e => e.decision === 'allowed' && e.exception === 'delegate_subtask'));
  assert.ok(entries.some(e => e.decision === 'allowed' && e.exception === 'incident'));
  assert.ok(entries.some(e => e.decision === 'allowed' && e.exception === 'human_requested_trivial'));
  assert.ok(entries.some(e => e.decision === 'would_block' && e.code === 'SPECIFY_REQUIRED'));
  assert.ok(entries.some(e => e.decision === 'blocked' && e.code === 'NO_DEPENDS_NOT_EXCEPTION'));
  assert.ok(entries.every(e => ['allowed', 'would_block', 'blocked'].includes(e.decision)));
  assert.ok(entries.every(e => e.recordedAt && e.id), 'ledger entries have immutable evidence');

  // A deterministic ledger failure must roll back the just-created HZL task,
  // including its projection and event, rather than leaving an un-audited
  // would_block task behind.
  const failureLedgerDir = path.join(root, 'failure-audit');
  const originalAppend = ledger.appendPolicyRecord;
  ledger.appendPolicyRecord = () => {
    throw Object.assign(new Error('deterministic ledger failure'), { code: 'LEDGER_WRITE_FAILED' });
  };
  try {
    expectBlocked(() => hzl.createTaskWithPolicy(PROJECT, { title: 'Must roll back on ledger failure' }, {
      origin: 'tasks-api', policyLedgerOptions: { dir: failureLedgerDir },
    }), 'LEDGER_WRITE_FAILED');
  } finally {
    ledger.appendPolicyRecord = originalAppend;
  }
  assert.ok(!hzl.listTasks(PROJECT).some(t => t.title === 'Must roll back on ledger failure'),
    'ledger failure leaves no task projection');
  assert.deepEqual(ledger.readPolicyLedger({ dir: failureLedgerDir }), [],
    'ledger failure leaves no policy record');

  // Exception review is one-way and server-authoritative. The public task is
  // also a deep projection: mutating nested audit/review objects cannot alter
  // the cached or durable evidence.
  const reviewCopy = hzl.getTask(PROJECT, delegated.id);
  reviewCopy.creationAudit.principal.actor = 'agent:forged';
  reviewCopy.exceptionReview.status = 'reviewed';
  const beforeReview = hzl.getTask(PROJECT, delegated.id);
  assert.equal(beforeReview.creationAudit.principal.actor, 'agent:worker-one');
  assert.equal(beforeReview.exceptionReview.status, 'pending');
  const forgedReviewOpts = hzl.createTask(PROJECT, {
    title: 'Caller review metadata is ignored',
    exceptionReview: {
      status: 'reviewed', reviewer: 'forged', reviewedAt: '2000-01-01T00:00:00.000Z',
      verifiedHuman: true, reviewerHumanId: 'forged-human',
    },
  });
  assert.equal(forgedReviewOpts.exceptionReview, null,
    'caller-supplied nested review evidence is not persisted');
  expectBlocked(() => hzl.reviewException(PROJECT, delegated.id, {
    principal: { kind: 'agent', verified: false, actor: 'agent:worker-one', humanId: null },
    reviewer: 'forged', reviewedAt: '2000-01-01T00:00:00.000Z',
  }), 'EXCEPTION_REVIEW_REQUIRES_VERIFIED_HUMAN');
  const reviewed = hzl.reviewException(PROJECT, delegated.id, {
    principal: human,
    reviewer: 'forged', reviewedAt: '2000-01-01T00:00:00.000Z',
  });
  assert.equal(reviewed.exceptionReview.status, 'reviewed');
  assert.equal(reviewed.exceptionReview.reviewer, human.actor);
  assert.notEqual(reviewed.exceptionReview.reviewedAt, '2000-01-01T00:00:00.000Z');
  assert.throws(() => hzl.reviewException(PROJECT, delegated.id, { principal: human }),
    error => error.code === 'EXCEPTION_REVIEW_IMMUTABLE');
  const persistedReview = hzl.getTask(PROJECT, delegated.id);
  assert.equal(persistedReview.exceptionReview.reviewer, human.actor);
  assert.equal(persistedReview.exceptionReview.status, 'reviewed');

  // Task-local fields survive a projection rebuild independently of the ledger.
  await hzl.init(dbPath);
  const persisted = hzl.getTask(PROJECT, trivial.id);
  assert.equal(persisted.exceptionReview.status, 'pending');
  assert.equal(persisted.creationAudit.policyDecision, 'allowed');

  console.log('T-447-3 policy exception tests: all passed');
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
