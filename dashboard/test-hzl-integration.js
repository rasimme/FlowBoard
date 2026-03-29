'use strict';

/**
 * Comprehensive integration test suite for hzl-service.js
 * Tests: CRUD, status persistence, restart recovery, edge cases
 */

const hzl = require('./hzl-service.js');
const path = require('path');
const fs = require('fs');

const DB_PATH = '/tmp/hzl-integration-test.db';
const CACHE_PATH = DB_PATH.replace(/\.db$/, '-cache.db');
const PROJECT = 'test-project';

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.error(`  ❌ ${msg}`);
  }
}

function assertEqual(actual, expected, msg) {
  if (actual === expected) {
    passed++;
    console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.error(`  ❌ ${msg} — expected: ${JSON.stringify(expected)}, got: ${JSON.stringify(actual)}`);
  }
}

function assertIncludes(arr, val, msg) {
  if (Array.isArray(arr) && arr.includes(val)) {
    passed++;
    console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.error(`  ❌ ${msg} — ${JSON.stringify(val)} not in ${JSON.stringify(arr)}`);
  }
}

function cleanDb() {
  for (const f of [DB_PATH, CACHE_PATH]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

async function run() {
  // ============================================================
  console.log('\n═══ PHASE 1: Fresh Init + Basic CRUD ═══');
  // ============================================================
  cleanDb();
  await hzl.init(DB_PATH);
  
  const emptyList = hzl.listTasks(PROJECT);
  assertEqual(emptyList.length, 0, 'Empty project has 0 tasks');

  // Create tasks
  const t1 = hzl.createTask(PROJECT, { title: 'Build API', priority: 'high' });
  assertEqual(t1.id, 'T-001', 'First task ID is T-001');
  assertEqual(t1.status, 'open', 'Default status is open');
  assertEqual(t1.priority, 'high', 'Priority set correctly');
  assertEqual(t1.completed, null, 'Completed is null');

  const t2 = hzl.createTask(PROJECT, { title: 'Write tests', priority: 'medium' });
  assertEqual(t2.id, 'T-002', 'Second task ID is T-002');

  const t3 = hzl.createTask(PROJECT, { title: 'Deploy', priority: 'low', status: 'backlog' });
  assertEqual(t3.id, 'T-003', 'Third task ID is T-003');
  assertEqual(t3.status, 'backlog', 'Custom initial status works');

  // Subtasks
  const s1 = hzl.createTask(PROJECT, { title: 'Subtask A', parentId: 'T-001' });
  assertEqual(s1.id, 'T-001-1', 'First subtask ID is T-001-1');
  assertEqual(s1.parentId, 'T-001', 'Subtask parentId correct');

  const s2 = hzl.createTask(PROJECT, { title: 'Subtask B', parentId: 'T-001' });
  assertEqual(s2.id, 'T-001-2', 'Second subtask ID is T-001-2');

  // Read
  const fetched = hzl.getTask(PROJECT, 'T-001');
  assertEqual(fetched.title, 'Build API', 'getTask returns correct title');
  assertIncludes(fetched.subtaskIds, 'T-001-1', 'Parent has subtask T-001-1');
  assertIncludes(fetched.subtaskIds, 'T-001-2', 'Parent has subtask T-001-2');

  // List
  const allTasks = hzl.listTasks(PROJECT);
  assertEqual(allTasks.length, 5, 'listTasks returns 5 tasks');

  // ============================================================
  console.log('\n═══ PHASE 2: Status Updates + Metadata Persistence ═══');
  // ============================================================

  // open → in-progress
  hzl.updateTask(PROJECT, 'T-001', { status: 'in-progress' });
  const t1ip = hzl.getTask(PROJECT, 'T-001');
  assertEqual(t1ip.status, 'in-progress', 'Status updated to in-progress');
  assertEqual(t1ip.completed, null, 'Completed still null for in-progress');

  // in-progress → review
  hzl.updateTask(PROJECT, 'T-001', { status: 'review' });
  const t1rev = hzl.getTask(PROJECT, 'T-001');
  assertEqual(t1rev.status, 'review', 'Status updated to review');

  // review → done
  hzl.updateTask(PROJECT, 'T-001', { status: 'done' });
  const t1done = hzl.getTask(PROJECT, 'T-001');
  assertEqual(t1done.status, 'done', 'Status updated to done');
  assert(t1done.completed !== null, 'Completed date set on done');

  // done → open (reopen)
  hzl.updateTask(PROJECT, 'T-001', { status: 'open' });
  const t1reopen = hzl.getTask(PROJECT, 'T-001');
  assertEqual(t1reopen.status, 'open', 'Status reopened to open');
  assertEqual(t1reopen.completed, null, 'Completed cleared on reopen');

  // blocked
  hzl.updateTask(PROJECT, 'T-002', { status: 'blocked' });
  assertEqual(hzl.getTask(PROJECT, 'T-002').status, 'blocked', 'Blocked status works');

  // Set various tasks to known states for restart test
  hzl.updateTask(PROJECT, 'T-001', { status: 'in-progress' });
  hzl.updateTask(PROJECT, 'T-001-1', { status: 'done' });
  hzl.updateTask(PROJECT, 'T-001-2', { status: 'review' });
  hzl.updateTask(PROJECT, 'T-003', { status: 'open' });  // backlog → open

  // Title update
  hzl.updateTask(PROJECT, 'T-002', { title: 'Write integration tests' });
  assertEqual(hzl.getTask(PROJECT, 'T-002').title, 'Write integration tests', 'Title update works');

  // Priority update
  hzl.updateTask(PROJECT, 'T-003', { title: 'Deploy to prod', priority: 'critical' });
  assertEqual(hzl.getTask(PROJECT, 'T-003').priority, 'critical', 'Priority update works');

  // ============================================================
  console.log('\n═══ PHASE 3: Delete + Archive ═══');
  // ============================================================

  const t4 = hzl.createTask(PROJECT, { title: 'Temporary task' });
  assertEqual(t4.id, 'T-004', 'T-004 created');
  hzl.deleteTask(PROJECT, 'T-004');
  assertEqual(hzl.getTask(PROJECT, 'T-004'), null, 'Deleted task returns null');

  // Verify ID not reused
  const t5 = hzl.createTask(PROJECT, { title: 'After delete' });
  assertEqual(t5.id, 'T-005', 'Next ID after deleting T-004 is T-005, not T-004');

  // Delete T-005 for clean restart test
  hzl.deleteTask(PROJECT, 'T-005');

  // ============================================================
  console.log('\n═══ PHASE 4: Task Counts + Summary ═══');
  // ============================================================

  const counts = hzl.getTaskCounts(PROJECT);
  console.log('  Counts:', JSON.stringify(counts));
  assert(typeof counts === 'object', 'getTaskCounts returns object');

  const summary = hzl.getTaskSummary(PROJECT);
  assert(typeof summary === 'string', 'getTaskSummary returns string');
  console.log('  Summary:', summary);

  // ============================================================
  console.log('\n═══ PHASE 5: RESTART RECOVERY (Critical!) ═══');
  // ============================================================

  // Snapshot expected state before restart
  const preRestart = {};
  for (const t of hzl.listTasks(PROJECT)) {
    preRestart[t.id] = { status: t.status, title: t.title, completed: t.completed, priority: t.priority };
  }
  console.log('  Pre-restart snapshot:');
  for (const [id, s] of Object.entries(preRestart)) {
    console.log(`    ${id}: ${s.status} "${s.title}" completed=${s.completed}`);
  }

  // Reinitialize from same DB (simulates restart)
  await hzl.init(DB_PATH);

  const postRestart = {};
  for (const t of hzl.listTasks(PROJECT)) {
    postRestart[t.id] = { status: t.status, title: t.title, completed: t.completed, priority: t.priority };
  }
  console.log('  Post-restart snapshot:');
  for (const [id, s] of Object.entries(postRestart)) {
    console.log(`    ${id}: ${s.status} "${s.title}" completed=${s.completed}`);
  }

  // Compare
  for (const [id, expected] of Object.entries(preRestart)) {
    const actual = postRestart[id];
    assert(actual !== undefined, `${id} exists after restart`);
    if (actual) {
      assertEqual(actual.status, expected.status, `${id} status persisted: ${expected.status}`);
      assertEqual(actual.title, expected.title, `${id} title persisted`);
      assertEqual(actual.completed, expected.completed, `${id} completed persisted`);
      assertEqual(actual.priority, expected.priority, `${id} priority persisted`);
    }
  }

  // Verify deleted tasks don't reappear
  assertEqual(hzl.getTask(PROJECT, 'T-004'), null, 'Deleted T-004 stays deleted after restart');
  assertEqual(hzl.getTask(PROJECT, 'T-005'), null, 'Deleted T-005 stays deleted after restart');

  // Verify ID continuity — next ID should be T-006 (not T-004 or T-005)
  const t6 = hzl.createTask(PROJECT, { title: 'After restart task' });
  assertEqual(t6.id, 'T-006', 'Next ID after restart is T-006 (respects deleted IDs)');
  hzl.deleteTask(PROJECT, 'T-006'); // clean up

  // ============================================================
  console.log('\n═══ PHASE 6: Multi-Project Isolation ═══');
  // ============================================================

  const PROJ_B = 'other-project';
  const b1 = hzl.createTask(PROJ_B, { title: 'Other project task' });
  assertEqual(b1.id, 'T-001', 'Other project starts at T-001 independently');

  const projATasks = hzl.listTasks(PROJECT);
  const projBTasks = hzl.listTasks(PROJ_B);
  assert(!projATasks.some(t => t.title === 'Other project task'), 'Project A does not see Project B tasks');
  assert(!projBTasks.some(t => t.title === 'Build API'), 'Project B does not see Project A tasks');
  assertEqual(projBTasks.length, 1, 'Project B has exactly 1 task');

  // Status update in one project doesn't affect other
  hzl.updateTask(PROJ_B, 'T-001', { status: 'done' });
  const projAT001 = hzl.getTask(PROJECT, 'T-001');
  assertEqual(projAT001.status, 'in-progress', 'Project A T-001 still in-progress after Project B T-001 done');

  // ============================================================
  console.log('\n═══ PHASE 7: Edge Cases ═══');
  // ============================================================

  // Update with no changes
  const beforeNoop = hzl.getTask(PROJECT, 'T-001');
  hzl.updateTask(PROJECT, 'T-001', {});
  const afterNoop = hzl.getTask(PROJECT, 'T-001');
  assertEqual(afterNoop.status, beforeNoop.status, 'No-op update preserves status');

  // Rapid status cycling
  hzl.updateTask(PROJECT, 'T-003', { status: 'in-progress' });
  hzl.updateTask(PROJECT, 'T-003', { status: 'review' });
  hzl.updateTask(PROJECT, 'T-003', { status: 'done' });
  hzl.updateTask(PROJECT, 'T-003', { status: 'open' });
  hzl.updateTask(PROJECT, 'T-003', { status: 'blocked' });
  assertEqual(hzl.getTask(PROJECT, 'T-003').status, 'blocked', 'Rapid status cycling lands on last status');

  // Status cycling survives restart
  await hzl.init(DB_PATH);
  assertEqual(hzl.getTask(PROJECT, 'T-003').status, 'blocked', 'Rapid-cycled status survives restart');

  // ============================================================
  console.log('\n═══ PHASE 8: Subtask Delete Modes ═══');
  // ============================================================

  // Create parent with subtasks, delete with mode='all'
  const p1 = hzl.createTask(PROJECT, { title: 'Parent to delete all' });
  hzl.createTask(PROJECT, { title: 'Child A', parentId: p1.id });
  hzl.createTask(PROJECT, { title: 'Child B', parentId: p1.id });
  hzl.updateTask(PROJECT, `${p1.id}-1`, { status: 'done' }); // ensure subtask status persists in archive
  hzl.deleteTask(PROJECT, p1.id, 'all');
  assertEqual(hzl.getTask(PROJECT, p1.id), null, 'Parent deleted with mode=all');
  assertEqual(hzl.getTask(PROJECT, `${p1.id}-1`), null, 'Child A deleted with mode=all');
  assertEqual(hzl.getTask(PROJECT, `${p1.id}-2`), null, 'Child B deleted with mode=all');

  // Create parent with subtasks, delete with mode='keep-children'
  const p2 = hzl.createTask(PROJECT, { title: 'Parent to orphan' });
  const c1 = hzl.createTask(PROJECT, { title: 'Orphan child', parentId: p2.id });
  hzl.deleteTask(PROJECT, p2.id, 'keep-children');
  assertEqual(hzl.getTask(PROJECT, p2.id), null, 'Parent deleted with keep-children');
  const orphan = hzl.getTask(PROJECT, c1.id);
  assert(orphan !== null, 'Child still exists after parent deleted with keep-children');
  assertEqual(orphan.parentId, null, 'Orphaned child has null parentId');

  // ============================================================
  console.log('\n═══ PHASE 9: Double Restart (rebuild from cold DB) ═══');
  // ============================================================

  // Re-init twice to ensure rebuild is idempotent
  await hzl.init(DB_PATH);
  await hzl.init(DB_PATH);

  const finalT1 = hzl.getTask(PROJECT, 'T-001');
  assertEqual(finalT1.status, 'in-progress', 'T-001 status correct after double restart');
  const finalT001_1 = hzl.getTask(PROJECT, 'T-001-1');
  assertEqual(finalT001_1.status, 'done', 'T-001-1 done status correct after double restart');
  const finalT001_2 = hzl.getTask(PROJECT, 'T-001-2');
  assertEqual(finalT001_2.status, 'review', 'T-001-2 review status correct after double restart');
  assertEqual(hzl.getTask(PROJECT, 'T-002').status, 'blocked', 'T-002 blocked survives double restart');
  assertEqual(hzl.getTask(PROJECT, 'T-003').status, 'blocked', 'T-003 blocked survives double restart');

  // Archived/deleted tasks still not reused
  const tAfterDouble = hzl.createTask(PROJECT, { title: 'After double restart' });
  const idNum = parseInt(tAfterDouble.id.replace('T-', ''), 10);
  assert(idNum > 8, `After double restart, new task ID ${tAfterDouble.id} skips all archived/deleted IDs`);

  // ============================================================
  console.log('\n═══ RESULTS ═══');
  // ============================================================
  console.log(`\n  ${passed} passed, ${failed} failed, ${passed + failed} total\n`);

  // Cleanup
  cleanDb();

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => {
  console.error('❌ FATAL:', e);
  process.exit(1);
});
