'use strict';

/**
 * T-447-2 — every normal task-creation sink carries server-owned provenance
 * through the single policy-aware boundary. Policy enforcement itself remains
 * compatibility-pass-through until the later T-447 subtasks.
 */

const os = require('os');
const path = require('path');

// T-460: hzl-service resolves its project/spec/audit dirs from
// OPENCLAW_WORKSPACE at require-time; without it the fallback lands under the
// repo root. Point it at a scratch dir before requiring hzl-service.
process.env.OPENCLAW_WORKSPACE = path.join(os.tmpdir(), 'flowboard-test-workspace-t447-2-policy-boundary');

const assert = require('assert');
const fs = require('fs');
const hzl = require('./hzl-service.js');

const DB_PATH = '/tmp/flowboard-t447-2-policy-boundary.db';
const CACHE_PATH = DB_PATH.replace(/\.db$/, '-cache.db');
const PROJECT = 't447-2-boundary';

function cleanDb() {
  for (const file of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`, CACHE_PATH,
    `${CACHE_PATH}-wal`, `${CACHE_PATH}-shm`]) {
    try { fs.unlinkSync(file); } catch {}
  }
}

async function main() {
  cleanDb();
  await hzl.init(DB_PATH);

  const publicTask = hzl.createTask(PROJECT, {
    title: 'Public API boundary',
  });
  assert.equal(publicTask.creationAudit.origin, 'tasks-api',
    'ordinary exported creation uses the policy-aware boundary');
  assert.equal(hzl.createTaskRaw, undefined,
    'raw creation primitive is not exported as an ordinary creation path');

  const confirmation = {
    actor: 'telegram:42',
    humanId: '42',
    authSessionId: 'main',
    confirmedAt: '2026-08-24T17:00:00.000Z',
    specifySessionId: 'specify-test-1',
    proposalIdentity: { digest: 'proposal-digest' },
    proposalVersion: 1,
    proposalBoundAt: '2026-08-24T16:59:00.000Z',
  };
  const specifyTask = hzl.createTaskWithPolicy(PROJECT, {
    title: 'Specify boundary',
  }, {
    origin: 'specify',
    principal: { kind: 'human', verified: true, actor: confirmation.actor },
    specifyConfirmation: confirmation,
  });
  assert.equal(specifyTask.creationAudit.origin, 'specify');
  assert.equal(specifyTask.creationAudit.specifySessionId, confirmation.specifySessionId);
  assert.equal(specifyTask.specifyConfirmation.actor, confirmation.actor);

  const source = hzl.createTask(PROJECT, { title: 'Workflow source', status: 'open' });
  hzl.claimTask(PROJECT, source.id, { agent: 'worker-one' });
  const delegated = hzl.workflowDelegate(PROJECT, {
    fromTaskId: source.id,
    title: 'Delegated boundary',
    agent: 'worker-two',
  });
  assert.equal(delegated.delegatedTask.creationAudit.origin, 'delegate');
  assert.equal(delegated.delegatedTask.creationAudit.sourceTaskId, source.id);

  const handedOff = hzl.workflowHandoff(PROJECT, {
    fromTaskId: source.id,
    title: 'Handoff boundary',
    agent: 'worker-three',
  });
  assert.equal(handedOff.followOnTask.creationAudit.origin, 'handoff');
  assert.equal(handedOff.followOnTask.creationAudit.sourceTaskId, source.id);

  const imported = hzl.createTaskForMigration(PROJECT, { title: 'Migration escape hatch' });
  assert.equal(imported.creationAudit, null, 'migration path does not masquerade as a normal origin');

  const beforeInvalid = hzl.listTasks(PROJECT).length;
  assert.throws(
    () => hzl.createTaskWithPolicy(PROJECT, { title: 'Invalid origin' }, { origin: 'client-body' }),
    (error) => error.code === 'CREATION_ORIGIN_INVALID',
  );
  assert.equal(hzl.listTasks(PROJECT).length, beforeInvalid, 'invalid origin creates no task');

  // Creation provenance and Specify confirmation survive a cache rebuild.
  await hzl.init(DB_PATH);
  const persisted = hzl.getTask(PROJECT, specifyTask.id);
  assert.equal(persisted.creationAudit.origin, 'specify');
  assert.equal(persisted.specifyConfirmation.specifySessionId, confirmation.specifySessionId);

  console.log('T-447-2 policy boundary tests: all passed');
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
