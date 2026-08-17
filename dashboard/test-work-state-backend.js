'use strict';

// T-443 backend regression coverage.  This stays service-level so it can
// exercise persistence, cache rebuilds, monitoring and lifecycle clear paths
// without coupling the assertions to a running operator service.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const hzl = require('./hzl-service.js');
const migrations = require('./migrations.js');
const { buildStuckNotifications } = require('./stuck-notify.js');

function rawMetadata(cacheDb, taskId) {
  const row = cacheDb.prepare(
    "SELECT metadata FROM tasks_current WHERE json_extract(metadata, '$.flowboard.id') = ?"
  ).get(taskId);
  return row ? JSON.parse(row.metadata) : null;
}

function injectLegacyMetadata(cacheDb, taskId, metadata) {
  cacheDb.prepare(
    "UPDATE tasks_current SET metadata = ? WHERE json_extract(metadata, '$.flowboard.id') = ?"
  ).run(JSON.stringify(metadata), taskId);
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-t443-backend-'));
  const db = path.join(dir, 'flowboard.db');
  try {
    await hzl.init(db);
    hzl.createProject('t443');

    const created = {};
    for (const state of ['working', 'waiting', 'blocked', 'paused']) {
      const task = hzl.createTask('t443', {
        title: `state-${state}`,
        status: 'open',
        workState: state,
        workStateDetails: { reason: `reason-${state}` },
      });
      created[state] = task.id;
      assert.equal(task.workState, state);
      assert.equal(task.blocked, state === 'blocked');
      assert.equal(task.workStateDetails.reason, `reason-${state}`);
    }

    const blocked = hzl.getTask('t443', created.blocked);
    assert.equal(blocked.blocked, true);
    assert.equal(blocked.workState, 'blocked');
    hzl.updateTask('t443', created.blocked, { blocked: false });
    assert.equal(hzl.getTask('t443', created.blocked).workState, 'working', 'legacy false uses compatibility default');
    hzl.updateTask('t443', created.blocked, { blocked: true });
    assert.equal(hzl.getTask('t443', created.blocked).workState, 'blocked');

    assert.throws(
      () => hzl.updateTask('t443', created.blocked, { blocked: true, workState: 'waiting' }),
      error => error.code === 'WORK_STATE_CONTRADICTION' && error.status === 400
    );
    assert.equal(hzl.getTask('t443', created.blocked).workState, 'blocked', 'contradiction leaves canonical state unchanged');

    // A contradictory update is atomic even when it carries an unrelated
    // scalar field: service-level callers must not get a partial title write.
    const atomic = hzl.createTask('t443', { title: 'atomic-before', status: 'open', workState: 'working' });
    assert.throws(
      () => hzl.updateTask('t443', atomic.id, { title: 'atomic-after', blocked: true, workState: 'waiting' }),
      error => error.code === 'WORK_STATE_CONTRADICTION' && error.status === 400
    );
    assert.equal(hzl.getTask('t443', atomic.id).title, 'atomic-before');
    assert.equal(hzl.getTask('t443', atomic.id).workState, 'working');

    // Canonical metadata survives a full cache rebuild.
    await hzl.rebuildCache();
    const rebuilt = hzl.getTask('t443', created.blocked);
    assert.equal(rebuilt.workState, 'blocked');
    assert.deepEqual(Object.keys(rebuilt.workStateDetails).sort(), ['checkAgainAt', 'reason', 'responsible', 'setAt', 'waitingFor']);

    // Legacy read-repair must preserve every top-level namespace and nested
    // flowboard field.  The raw cache mutation simulates a pre-T-443 row; the
    // subsequent rebuild exercises the actual repair/event/projection path.
    const legacyReadRepair = hzl.createTask('t443', { title: 'legacy-read-repair', status: 'open' });
    const cacheDb = hzl.getCacheDb();
    const legacyReadMeta = rawMetadata(cacheDb, legacyReadRepair.id);
    const { workState: _legacyReadState, workStateDetails: _legacyReadDetails, ...legacyReadFlowboard } = legacyReadMeta.flowboard;
    injectLegacyMetadata(cacheDb, legacyReadRepair.id, {
      integrations: { provider: 'keep-me', nested: { tokenRef: 'opaque-ref' } },
      audit: { importedBy: 'legacy-fixture' },
      flowboard: {
        ...legacyReadFlowboard,
        blocked: true,
        legacyNested: { untouched: true },
      },
    });
    await hzl.rebuildCache();
    const repairedMeta = rawMetadata(cacheDb, legacyReadRepair.id);
    assert.equal(hzl.getTask('t443', legacyReadRepair.id).workState, 'blocked');
    assert.deepEqual(repairedMeta.integrations, { provider: 'keep-me', nested: { tokenRef: 'opaque-ref' } });
    assert.deepEqual(repairedMeta.audit, { importedBy: 'legacy-fixture' });
    assert.deepEqual(repairedMeta.flowboard.legacyNested, { untouched: true });

    // Run the real m009 hook against another legacy row, then rebuild the
    // read model.  This catches migrations that accidentally replace metadata
    // instead of preserving it through the event-sourced projection.
    const legacyMigration = hzl.createTask('t443', { title: 'legacy-m009', status: 'open' });
    const legacyMigrationMeta = rawMetadata(cacheDb, legacyMigration.id);
    const { workState: _legacyMigrationState, workStateDetails: _legacyMigrationDetails, ...legacyMigrationFlowboard } = legacyMigrationMeta.flowboard;
    injectLegacyMetadata(cacheDb, legacyMigration.id, {
      runtime: { source: 'old-client', flags: { keep: true } },
      flowboard: { ...legacyMigrationFlowboard, blocked: true, imported: { version: 8 } },
    });
    const m009 = migrations.migrations.find(migration => migration.id === 'm009-canonical-work-state');
    assert.ok(m009, 'm009 migration is registered');
    m009.run(cacheDb, { hzlService: hzl });
    const migratedMeta = rawMetadata(cacheDb, legacyMigration.id);
    assert.equal(migratedMeta.flowboard.workState, 'blocked');
    assert.deepEqual(migratedMeta.runtime, { source: 'old-client', flags: { keep: true } });
    assert.deepEqual(migratedMeta.flowboard.imported, { version: 8 });
    await hzl.rebuildCache();
    assert.equal(hzl.getTask('t443', legacyMigration.id).blocked, true);

    // A due checkAgainAt is a nudge condition only — no lifecycle/work-state
    // mutation is performed by the evaluator.
    const waiting = hzl.updateTask('t443', created.waiting, {
      workState: 'waiting',
      workStateDetails: { waitingFor: 'external', checkAgainAt: new Date(Date.now() - 1000).toISOString() },
    });
    const before = { status: waiting.status, workState: waiting.workState };
    const eval1 = hzl.evaluateStuckIndicators({ staleThreshold: 9999, now: new Date().toISOString() });
    const waitingIndicator = eval1.indicators.find(item => item.taskId === created.waiting);
    assert.equal(waitingIndicator.reason, 'check-again');
    assert.deepEqual(
      { status: hzl.getTask('t443', created.waiting).status, workState: hzl.getTask('t443', created.waiting).workState },
      before,
      'checkAgainAt does not auto-transition task state'
    );

    // Paused tasks stay paused, but a due checkAgainAt is a re-evaluation
    // signal and produces the same transient indicator/nudge path.
    const paused = hzl.createTask('t443', {
      title: 'paused-due-check',
      status: 'in-progress',
      workState: 'paused',
      workStateDetails: {
        reason: 'operator pause',
        checkAgainAt: new Date(Date.now() - 1000).toISOString(),
      },
    });
    const pausedBefore = hzl.getTask('t443', paused.id);
    const pausedEval = hzl.evaluateStuckIndicators({ staleThreshold: 9999, now: new Date().toISOString() });
    assert.equal(pausedEval.indicators.find(item => item.taskId === paused.id)?.reason, 'check-again');
    const pausedAfter = hzl.getTask('t443', paused.id);
    assert.equal(pausedAfter.status, pausedBefore.status);
    assert.equal(pausedAfter.workState, 'paused');
    assert.equal(pausedAfter.workStateDetails.reason, 'operator pause');

    const commentsBefore = hzl.getComments('t443', created.waiting).length;
    const eval2 = hzl.evaluateStuckIndicators({ staleThreshold: 9999, now: new Date().toISOString() });
    assert.equal(eval2.indicators.filter(item => item.taskId === created.waiting).length, 1);
    assert.equal(hzl.getComments('t443', created.waiting).length, commentsBefore, 'reevaluation creates no reminder comments');
    assert.equal(hzl.getTask('t443', created.waiting).stuckIndicator.active, true);

    // Lifecycle changes clear attention state only; they do not auto-unblock
    // or rewrite work-state details.
    const lifecycle = hzl.createTask('t443', {
      title: 'lifecycle-preserves-work-state',
      status: 'open',
      workState: 'blocked',
      workStateDetails: { reason: 'human dependency', waitingFor: 'operator' },
    });
    const lifecycleDetails = hzl.getTask('t443', lifecycle.id).workStateDetails;
    hzl.updateTask('t443', lifecycle.id, { status: 'review' });
    assert.equal(hzl.getTask('t443', lifecycle.id).workState, 'blocked');
    assert.equal(hzl.getTask('t443', lifecycle.id).blocked, true);
    assert.deepEqual(hzl.getTask('t443', lifecycle.id).workStateDetails, lifecycleDetails);
    hzl.updateTask('t443', lifecycle.id, { status: 'backlog' });
    assert.equal(hzl.getTask('t443', lifecycle.id).workState, 'blocked');
    assert.equal(hzl.getTask('t443', lifecycle.id).blocked, true);
    assert.deepEqual(hzl.getTask('t443', lifecycle.id).workStateDetails, lifecycleDetails);

    // Checkpoint, release and completion are all clear boundaries.
    const claimed = hzl.createTask('t443', { title: 'clear-on-checkpoint', status: 'open' });
    hzl.claimTask('t443', claimed.id, { agent: 'main', lease: 60 });
    await new Promise(resolve => setTimeout(resolve, 5));
    hzl.evaluateStuckIndicators({ staleThreshold: 0 });
    assert.equal(hzl.getTask('t443', claimed.id).stuckIndicator.active, true);
    hzl.addCheckpoint('t443', claimed.id, { agent: 'main', message: 'recovered' });
    assert.equal(hzl.getTask('t443', claimed.id).stuckIndicator, null);

    hzl.evaluateStuckIndicators({ staleThreshold: 0 });
    hzl.releaseTask('t443', claimed.id, { agent: 'main' });
    assert.equal(hzl.getTask('t443', claimed.id).stuckIndicator, null);

    const complete = hzl.createTask('t443', { title: 'clear-on-complete', status: 'open' });
    hzl.claimTask('t443', complete.id, { agent: 'main', lease: 60 });
    await new Promise(resolve => setTimeout(resolve, 5));
    hzl.evaluateStuckIndicators({ staleThreshold: 0 });
    hzl.completeTask('t443', complete.id, { agent: 'main' });
    assert.equal(hzl.getTask('t443', complete.id).status, 'review');
    assert.equal(hzl.getTask('t443', complete.id).stuckIndicator, null);

    // Notification consumption is persisted/backoff-controlled and external
    // owners receive pull-based board attention rather than a live-session push.
    const external = hzl.createTask('t443', { title: 'external-attention', status: 'open' });
    hzl.claimTask('t443', external.id, { agent: 'dev-botti', lease: 60 });
    await new Promise(resolve => setTimeout(resolve, 5));
    const first = hzl.getNotifiableStuckTasks({ staleThreshold: 0, notificationWindow: 1, consume: true });
    assert.ok(first.stale.some(item => item.taskId === external.id));
    const second = hzl.getNotifiableStuckTasks({ staleThreshold: 0, notificationWindow: 1, consume: true });
    assert.ok(!second.stale.some(item => item.taskId === external.id));
    hzl.evaluateStuckIndicators({ staleThreshold: 0 });
    const attention = hzl.getAgentAttention('dev-botti', { staleThreshold: 0 });
    assert.ok(attention.stuckTasks.some(item => item.taskId === external.id && item.stuckIndicator?.active));

    // Notification ownership is claim-scoped, not based on the historical
    // `agent` soft chip.  Active OpenClaw and external claims retain their
    // respective routing semantics for due work-state incidents.
    const activeMain = hzl.createTask('t443', { title: 'active-main-due', status: 'open' });
    hzl.claimTask('t443', activeMain.id, { agent: 'main', lease: 60 });
    hzl.updateTask('t443', activeMain.id, {
      workState: 'waiting',
      workStateDetails: { waitingFor: 'operator', checkAgainAt: new Date(Date.now() - 1000).toISOString() },
    });
    const activeMainEval = hzl.evaluateStuckIndicators({ staleThreshold: 9999 });
    const activeMainEntry = hzl.getStuckTasks({ staleThreshold: 9999 }).workState
      .find(item => item.taskId === activeMain.id);
    const activeMainIndicator = activeMainEval.indicators.find(item => item.taskId === activeMain.id);
    assert.equal(activeMainEntry.agent, 'main');
    assert.ok(activeMainEntry.claimedAt, 'active claim carries claimedAt into routing entries');
    assert.equal(activeMainEntry.reason, 'check-again');
    assert.equal(activeMainIndicator.owner, 'main');
    assert.equal(activeMainIndicator.delivery, 'wake');

    const activeExternal = hzl.createTask('t443', { title: 'active-external-due', status: 'open' });
    hzl.claimTask('t443', activeExternal.id, { agent: 'dev-botti', lease: 60 });
    hzl.updateTask('t443', activeExternal.id, {
      workState: 'blocked',
      workStateDetails: { reason: 'vendor', checkAgainAt: new Date(Date.now() - 1000).toISOString() },
    });
    const activeExternalEval = hzl.evaluateStuckIndicators({ staleThreshold: 9999 });
    const activeExternalEntry = hzl.getStuckTasks({ staleThreshold: 9999 }).workState
      .find(item => item.taskId === activeExternal.id);
    const activeExternalIndicator = activeExternalEval.indicators.find(item => item.taskId === activeExternal.id);
    assert.equal(activeExternalEntry.agent, 'dev-botti');
    assert.equal(activeExternalIndicator.owner, 'dev-botti');
    assert.equal(activeExternalIndicator.ownerKind, 'external');
    assert.equal(activeExternalIndicator.delivery, 'board');

    // Claim → release → due incident: release deliberately preserves the
    // historical soft chip, but clears claimedAt.  The incident therefore
    // belongs to the operator, not to the former OpenClaw owner.
    const releasedIncident = hzl.createTask('t443', { title: 'released-due-incident', status: 'open' });
    hzl.claimTask('t443', releasedIncident.id, { agent: 'main', lease: 60 });
    hzl.releaseTask('t443', releasedIncident.id, { agent: 'main' });
    const released = hzl.getTask('t443', releasedIncident.id);
    assert.equal(released.agent, 'main', 'release preserves historical soft-chip attribution');
    assert.equal(released.claimedAt, null, 'release clears active claim marker');
    hzl.updateTask('t443', releasedIncident.id, {
      workState: 'waiting',
      workStateDetails: { waitingFor: 'operator', checkAgainAt: new Date(Date.now() - 1000).toISOString() },
    });
    const releasedEval = hzl.evaluateStuckIndicators({ staleThreshold: 9999 });
    const releasedEntry = hzl.getStuckTasks({ staleThreshold: 9999 }).workState
      .find(item => item.taskId === releasedIncident.id);
    const releasedIndicator = releasedEval.indicators.find(item => item.taskId === releasedIncident.id);
    assert.equal(releasedEntry.agent, null, 'historical agent is not an incident owner after release');
    assert.equal(releasedEntry.ownerKind, 'unowned');
    assert.equal(releasedIndicator.owner, null);
    assert.equal(releasedIndicator.delivery, 'operator');
    assert.ok(!hzl.getAgentAttention('main', { staleThreshold: 9999 }).stuckTasks
      .some(item => item.taskId === releasedIncident.id), 'released incident is not sent to former owner attention');
    const releasedPayloads = buildStuckNotifications(
      { stale: [], expired: [], routedUnclaimed: [], workState: [releasedEntry] },
      { operatorDelivery: { channel: 'telegram', target: 'operator', to: 'operator' } }
    );
    assert.equal(releasedPayloads.length, 1);
    assert.equal(releasedPayloads[0].endpoint, 'agent', 'released incident escalates to operator');
    assert.match(releasedPayloads[0].body.message, new RegExp(releasedIncident.id));

    for (const workState of ['blocked', 'paused']) {
      const releasedState = hzl.createTask('t443', { title: `released-${workState}-incident`, status: 'open' });
      hzl.claimTask('t443', releasedState.id, { agent: 'main', lease: 60 });
      hzl.releaseTask('t443', releasedState.id, { agent: 'main' });
      hzl.updateTask('t443', releasedState.id, {
        workState,
        workStateDetails: { reason: 'operator', checkAgainAt: new Date(Date.now() - 1000).toISOString() },
      });
      const stateEval = hzl.evaluateStuckIndicators({ staleThreshold: 9999 });
      const stateEntry = hzl.getStuckTasks({ staleThreshold: 9999 }).workState
        .find(item => item.taskId === releasedState.id);
      const stateIndicator = stateEval.indicators.find(item => item.taskId === releasedState.id);
      assert.equal(stateEntry.agent, null, `${workState} after release is unowned`);
      assert.equal(stateIndicator.owner, null, `${workState} after release has no former owner`);
      assert.equal(stateIndicator.delivery, 'operator', `${workState} after release escalates to operator`);
    }

    const wakeContract = hzl.createTask('t443', { title: 'wake-contract', status: 'open' });
    hzl.claimTask('t443', wakeContract.id, { agent: 'main', lease: 60 });
    await new Promise(resolve => setTimeout(resolve, 5));
    const wakeEval = hzl.evaluateStuckIndicators({ staleThreshold: 0, wakeAgent: 'ops' });
    const wakeIndicator = wakeEval.indicators.find(item => item.taskId === wakeContract.id);
    assert.equal(wakeIndicator.delivery, 'board', 'non-wake OpenClaw owners use the board contract');
    assert.equal(wakeIndicator.wakeAgent, 'ops');

    // Clearing an indicator also clears notification/backoff state, so a
    // fresh incident is immediately eligible rather than inheriting silence.
    const freshIncident = hzl.createTask('t443', {
      title: 'fresh-incident-after-recovery',
      status: 'open',
      workState: 'waiting',
      workStateDetails: { reason: 'dependency', checkAgainAt: new Date(Date.now() - 1000).toISOString() },
    });
    hzl.evaluateStuckIndicators({ staleThreshold: 9999 });
    const consumed = hzl.getNotifiableStuckTasks({ staleThreshold: 9999, notificationWindow: 60, consume: true });
    assert.ok(consumed.workState.some(item => item.taskId === freshIncident.id));
    const armedMeta = rawMetadata(cacheDb, freshIncident.id);
    assert.ok(armedMeta.flowboard.notifications.stuck.lastNotifiedAt);
    hzl.updateTask('t443', freshIncident.id, { workState: 'working' });
    const clearedMeta = rawMetadata(cacheDb, freshIncident.id);
    assert.equal(clearedMeta.flowboard.stuckIndicator, null);
    assert.equal(clearedMeta.flowboard.notifications.stuck.lastNotifiedAt, null);
    assert.equal(clearedMeta.flowboard.notifications.stuck.nextNotifyAt, null);
    assert.equal(clearedMeta.flowboard.notifications.stuck.backoffMinutes, null);
    assert.equal(clearedMeta.flowboard.notifications.stuck.notificationCount, 0);
    hzl.updateTask('t443', freshIncident.id, {
      workState: 'waiting',
      workStateDetails: { reason: 'new dependency', checkAgainAt: new Date(Date.now() - 1000).toISOString() },
    });
    const fresh = hzl.getNotifiableStuckTasks({ staleThreshold: 9999, notificationWindow: 60, consume: false });
    assert.ok(fresh.workState.some(item => item.taskId === freshIncident.id), 'new incident is immediately notifiable');

    console.log('✅ T-443 backend work-state/indicator tests');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
