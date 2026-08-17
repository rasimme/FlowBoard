'use strict';

// T-443 backend regression coverage.  This stays service-level so it can
// exercise persistence, cache rebuilds, monitoring and lifecycle clear paths
// without coupling the assertions to a running operator service.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const hzl = require('./hzl-service.js');

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

    // Canonical metadata survives a full cache rebuild.
    await hzl.rebuildCache();
    const rebuilt = hzl.getTask('t443', created.blocked);
    assert.equal(rebuilt.workState, 'blocked');
    assert.deepEqual(Object.keys(rebuilt.workStateDetails).sort(), ['checkAgainAt', 'reason', 'responsible', 'setAt', 'waitingFor']);

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

    const commentsBefore = hzl.getComments('t443', created.waiting).length;
    const eval2 = hzl.evaluateStuckIndicators({ staleThreshold: 9999, now: new Date().toISOString() });
    assert.equal(eval2.indicators.filter(item => item.taskId === created.waiting).length, 1);
    assert.equal(hzl.getComments('t443', created.waiting).length, commentsBefore, 'reevaluation creates no reminder comments');
    assert.equal(hzl.getTask('t443', created.waiting).stuckIndicator.active, true);

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

    console.log('✅ T-443 backend work-state/indicator tests');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
