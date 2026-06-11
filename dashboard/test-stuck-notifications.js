'use strict';

/**
 * Stuck-notification hardening tests for T-304.
 * Verifies: terminal/trashed tasks never report stuck, routed-unclaimed is
 * window-guarded, and getNotifiableStuckTasks is side-effect free unless
 * consume: true is passed (scheduler-only).
 *
 * Run: node test-stuck-notifications.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const hzlService = require('./hzl-service.js');

let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✅ ${msg}`); }
  else      { fail++; failures.push(msg); console.log(`  ❌ ${msg}`); }
}

const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-stuck-'));
process.env.FLOWBOARD_PROJECTS_DIR = process.env.FLOWBOARD_PROJECTS_DIR || path.join(WORKDIR, 'projects');
fs.mkdirSync(path.join(WORKDIR, 'projects'), { recursive: true });
const PROJECT = 'stuck-test';

function stuckIds(list) {
  return (list || []).map(t => t.taskId);
}

async function run() {
  console.log('# Stuck notifications (T-304)');
  await hzlService.init(path.join(WORKDIR, 'flowboard.db'));
  hzlService.createProject(PROJECT, 'stuck notification tests');

  // --- routed-unclaimed scoping ---
  const routedOpen = hzlService.createTask(PROJECT, { title: 'Routed open', status: 'open' });
  hzlService.routeTask(PROJECT, routedOpen.id, 'agent-a');
  const routedDone = hzlService.createTask(PROJECT, { title: 'Routed but done', status: 'open' });
  hzlService.routeTask(PROJECT, routedDone.id, 'agent-b');
  hzlService.updateTask(PROJECT, routedDone.id, { status: 'done' });
  const routedTrashed = hzlService.createTask(PROJECT, { title: 'Routed but trashed', status: 'open' });
  hzlService.routeTask(PROJECT, routedTrashed.id, 'agent-c');
  hzlService.updateTask(PROJECT, routedTrashed.id, { trashedAt: new Date().toISOString() });

  let stuck = hzlService.getStuckTasks({ staleThreshold: 0 });
  ok(stuckIds(stuck.routedUnclaimed).includes(routedOpen.id), 'open routed-unclaimed task reports stuck');
  ok(!stuckIds(stuck.routedUnclaimed).includes(routedDone.id), 'done task never reports routed-unclaimed (T-304)');
  ok(!stuckIds(stuck.combined).includes(routedTrashed.id), 'trashed task never reports stuck (T-304)');

  // --- stale detection baseline ---
  const claimed = hzlService.createTask(PROJECT, { title: 'Claimed and silent', status: 'open' });
  hzlService.claimTask(PROJECT, claimed.id, { agent: 'agent-d', lease: 60 });
  // threshold 0 means "stale after >0ms since the last checkpoint" — give it a tick
  await new Promise(r => setTimeout(r, 25));
  stuck = hzlService.getStuckTasks({ staleThreshold: 0 });
  ok(stuckIds(stuck.stale).includes(claimed.id), 'claimed task without fresh checkpoint reports stale at threshold 0');

  // --- notifiable: pure read by default ---
  const n1 = hzlService.getNotifiableStuckTasks({ staleThreshold: 0, notificationWindow: 60 });
  const n2 = hzlService.getNotifiableStuckTasks({ staleThreshold: 0, notificationWindow: 60 });
  ok(stuckIds(n1.stale).includes(claimed.id), 'notifiable (read-only) lists the stale task');
  ok(stuckIds(n2.stale).includes(claimed.id), 'second read-only call still lists it — GET has no side effect (T-304)');
  ok(stuckIds(n2.routedUnclaimed).includes(routedOpen.id), 'read-only call lists routed-unclaimed');

  // --- consume: true records and silences within the window ---
  const c1 = hzlService.getNotifiableStuckTasks({ staleThreshold: 0, notificationWindow: 60, consume: true });
  ok(stuckIds(c1.stale).includes(claimed.id), 'consuming call returns the stale task once');
  ok(stuckIds(c1.routedUnclaimed).includes(routedOpen.id), 'consuming call returns routed-unclaimed once');
  const c2 = hzlService.getNotifiableStuckTasks({ staleThreshold: 0, notificationWindow: 60, consume: true });
  ok(!stuckIds(c2.stale).includes(claimed.id), 'consumed stale task stays quiet within the window');
  ok(!stuckIds(c2.routedUnclaimed).includes(routedOpen.id), 'consumed routed-unclaimed stays quiet within the window (window guard, T-304)');

  // raw stuck list is unaffected by consumption (monitoring keeps full view)
  stuck = hzlService.getStuckTasks({ staleThreshold: 0 });
  ok(stuckIds(stuck.stale).includes(claimed.id), 'GET /tasks/stuck view is unaffected by notification consumption');

  fs.rmSync(WORKDIR, { recursive: true, force: true });
  if (fail === 0) {
    console.log(`\n✅ All ${pass} checks passed`);
  } else {
    console.log(`\n❌ ${fail} failed, ${pass} passed`);
    failures.forEach(f => console.log(`  - ${f}`));
  }
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
