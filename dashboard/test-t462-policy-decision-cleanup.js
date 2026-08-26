'use strict';

/**
 * T-462 — the would_block/SPECIFY_REQUIRED policy decision was a T-447
 * observation-mode artifact. T-449/ADR-0035 removed the blocking behavior it
 * described but left the label itself: every ordinary task creation still
 * claimed "Direct agent task creation requires Specify or a validated
 * exception" in creationAudit, and the policy ledger kept appending
 * would_block/SPECIFY_REQUIRED rows for a gate that no longer exists.
 *
 * This test pins:
 *  - evaluateCreationPolicy no longer returns 'would_block' for the two
 *    paths that used to (plain tasks-api/delegate creation, and top-level
 *    noDepends delegation) — both are simply 'allowed' now.
 *  - DECISIONS in both task-creation-policy.js and policy-ledger.js only
 *    know 'allowed' and 'blocked'.
 *  - A newly created task's creationAudit carries no policyDecision /
 *    policyCode / policyReason — those fields said nothing once their only
 *    reachable value was 'allowed' on every created task.
 *  - The ledger itself keeps working the same way (it still records both
 *    allowed and blocked decisions) and never writes a would_block row for
 *    a new decision.
 *  - Historical would_block/SPECIFY_REQUIRED ledger lines are read back
 *    unmodified — the ledger is append-only and past rows are not rewritten.
 */

const os = require('os');
const path = require('path');

// T-460: hzl-service resolves its project/spec/audit dirs from
// OPENCLAW_WORKSPACE at require-time; without it the fallback lands under the
// repo root. Point it at a scratch dir before requiring hzl-service.
process.env.OPENCLAW_WORKSPACE = path.join(os.tmpdir(), 'flowboard-test-workspace-t462-policy-decision-cleanup');

const assert = require('assert');
const fs = require('fs');
const hzl = require('./hzl-service.js');
const taskCreationPolicy = require('./task-creation-policy.js');
const policyLedger = require('./policy-ledger.js');

const DB_PATH = '/tmp/flowboard-t462-policy-decision-cleanup.db';
const CACHE_PATH = DB_PATH.replace(/\.db$/, '-cache.db');
const PROJECT = 't462-policy-cleanup';

function cleanDb() {
  for (const file of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`, CACHE_PATH,
    `${CACHE_PATH}-wal`, `${CACHE_PATH}-shm`]) {
    try { fs.unlinkSync(file); } catch {}
  }
}

async function main() {
  cleanDb();
  await hzl.init(DB_PATH);

  // --- DECISIONS enums no longer know 'would_block' ---------------------
  assert.deepEqual(taskCreationPolicy.DECISIONS, ['allowed', 'blocked'],
    'task-creation-policy DECISIONS drops would_block');
  assert.deepEqual(policyLedger.DECISIONS, ['allowed', 'blocked'],
    'policy-ledger DECISIONS drops would_block');

  // --- evaluateCreationPolicy: plain tasks-api/delegate creation --------
  // This is the "jede Task-Erstellung" path from the bug report: ordinary
  // agent-created tasks via tasks-api with no exception and no Specify
  // confirmation. Per ADR-0035 this is simply allowed.
  const directResult = taskCreationPolicy.evaluateCreationPolicy({
    project: PROJECT,
    opts: { title: 'Direct task' },
    context: { origin: 'tasks-api' },
    getTask: () => null,
  });
  assert.equal(directResult.decision, 'allowed', 'plain tasks-api creation is allowed, not would_block');
  assert.notEqual(directResult.code, 'SPECIFY_REQUIRED', 'plain tasks-api creation does not carry the retired code');
  assert.ok(!/requires specify/i.test(directResult.reason), `reason no longer claims Specify is required: "${directResult.reason}"`);

  // origin: 'delegate' normally infers exception: 'delegate_subtask'
  // automatically (see inferException); an explicit null override is the
  // only way to reach the exception===null branch for this origin.
  const directDelegateResult = taskCreationPolicy.evaluateCreationPolicy({
    project: PROJECT,
    opts: { title: 'Direct delegate, no exception' },
    context: { origin: 'delegate', exception: null, sourceTaskId: 'T-001', fromTaskId: 'T-001' },
    getTask: () => null,
  });
  assert.equal(directDelegateResult.decision, 'allowed', 'delegate origin without exception is allowed, not would_block');

  // --- evaluateCreationPolicy: top-level noDepends delegation ------------
  const noDependsResult = taskCreationPolicy.evaluateCreationPolicy({
    project: PROJECT,
    opts: { title: 'Top-level delegated task' },
    context: { origin: 'delegate', noDepends: true, sourceTaskId: 'T-001', fromTaskId: 'T-001' },
    getTask: () => null,
  });
  assert.equal(noDependsResult.decision, 'allowed', 'top-level noDepends delegation is allowed, not would_block');
  assert.notEqual(noDependsResult.code, 'SPECIFY_REQUIRED', 'noDepends delegation does not carry the retired code');

  // The malformed-request checks ahead of that final branch are untouched —
  // this is not a blanket "everything is allowed now" change.
  const conflictResult = taskCreationPolicy.evaluateCreationPolicy({
    project: PROJECT,
    opts: { title: 'Bad noDepends' },
    context: { origin: 'delegate', noDepends: true, sourceTaskId: 'T-001', fromTaskId: 'T-002' },
    getTask: () => null,
  });
  assert.equal(conflictResult.decision, 'blocked', 'conflicting source ids on a noDepends delegation are still blocked');
  assert.equal(conflictResult.code, 'DELEGATE_SOURCE_CONFLICT');

  // --- A newly created task carries no false Specify-gate claim ---------
  const created = hzl.createTask(PROJECT, { title: 'Ordinary agent task' });
  assert.equal(created.creationAudit.origin, 'tasks-api');
  assert.ok(created.creationAudit.principal, 'creationAudit still carries principal');
  assert.ok(created.creationAudit.createdAt, 'creationAudit still carries createdAt');
  assert.equal(created.creationAudit.policyDecision, undefined,
    'creationAudit no longer states a policyDecision');
  assert.equal(created.creationAudit.policyCode, undefined,
    'creationAudit no longer states a policyCode');
  assert.equal(created.creationAudit.policyReason, undefined,
    'creationAudit no longer states a policyReason');

  // Reload from a fresh cache rebuild — the omission is durable, not just an
  // in-memory artifact of the create call's return value.
  await hzl.init(DB_PATH);
  const persisted = hzl.getTask(PROJECT, created.id);
  assert.equal(persisted.creationAudit.policyDecision, undefined,
    'reloaded task still carries no policyDecision');

  // --- Top-level noDepends delegation end to end -------------------------
  const source = hzl.createTask(PROJECT, { title: 'Delegation source', status: 'open' });
  hzl.claimTask(PROJECT, source.id, { agent: 'worker-one' });
  const delegated = hzl.workflowDelegate(PROJECT, {
    fromTaskId: source.id,
    title: 'Top-level delegated child',
    agent: 'worker-two',
    noDepends: true,
  });
  assert.equal(delegated.delegatedTask.parentId, null, 'noDepends delegation has no parent');
  assert.equal(delegated.delegatedTask.creationAudit.policyDecision, undefined,
    'noDepends-delegated task carries no policyDecision either');

  // --- The ledger never writes a would_block row for a new decision -----
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-t462-ledger-'));
  try {
    hzl.createTaskWithPolicy(PROJECT, { title: 'Ledger-observed task' }, {
      origin: 'tasks-api',
      policyLedgerOptions: { dir },
    });
    const entries = policyLedger.readPolicyLedger({ dir });
    assert.ok(entries.length >= 1, 'ledger recorded the decision');
    for (const entry of entries) {
      assert.notEqual(entry.decision, 'would_block', 'no new ledger row is would_block');
      assert.notEqual(entry.code, 'SPECIFY_REQUIRED', 'no new ledger row carries SPECIFY_REQUIRED');
    }
    assert.equal(entries[entries.length - 1].decision, 'allowed',
      'the plain tasks-api creation is logged as allowed');

    // appendPolicyRecord itself now rejects would_block as an invalid
    // decision — it is not just unused, it is no longer a valid value.
    assert.throws(
      () => policyLedger.appendPolicyRecord(PROJECT, { decision: 'would_block', origin: 'tasks-api' }, { dir }),
      (error) => error.code === 'POLICY_DECISION_INVALID',
      'the ledger rejects would_block as a decision value going forward'
    );

    // --- Historical would_block rows are read back unmodified -----------
    // The ledger is append-only history; a pre-existing line written before
    // this change must still be readable exactly as recorded. Simulate that
    // by writing a legacy-shaped line directly to a fresh ledger file.
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-t462-legacy-ledger-'));
    try {
      const legacyLine = JSON.stringify({
        version: 1, id: 'legacy-1', recordedAt: '2026-08-01T00:00:00.000Z',
        project: PROJECT, decision: 'would_block', origin: 'tasks-api', exception: null,
        taskId: 'T-100', sourceTaskId: null, reason: 'Direct agent task creation requires Specify or a validated exception',
        code: 'SPECIFY_REQUIRED', principal: null, evidence: null, governanceMode: 'compat',
      });
      const legacyFile = path.join(legacyDir, 'policy-ledger.jsonl');
      fs.mkdirSync(legacyDir, { recursive: true });
      fs.writeFileSync(legacyFile, `${legacyLine}\n`);
      const legacyEntries = policyLedger.readPolicyLedger({ dir: legacyDir });
      assert.equal(legacyEntries.length, 1);
      assert.equal(legacyEntries[0].decision, 'would_block', 'historical would_block row is preserved verbatim on read');
      assert.equal(legacyEntries[0].code, 'SPECIFY_REQUIRED', 'historical SPECIFY_REQUIRED row is preserved verbatim on read');
    } finally {
      fs.rmSync(legacyDir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('T-462 policy decision cleanup tests: all passed');
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
