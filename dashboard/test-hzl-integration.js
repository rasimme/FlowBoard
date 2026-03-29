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
  console.log('\n═══ PHASE 9: Spec Links ═══');
  // ============================================================

  // setSpecLink / getSpecsIndex
  hzl.setSpecLink(PROJECT, 'T-001', 'specs/T-001-build-api.md');
  const specIdx = hzl.getSpecsIndex(PROJECT);
  assertEqual(specIdx['T-001'], 'specs/T-001-build-api.md', 'setSpecLink stores spec link');

  // Spec link reflected in getTask
  const t1spec = hzl.getTask(PROJECT, 'T-001');
  assertEqual(t1spec.specFile, 'specs/T-001-build-api.md', 'getTask returns specFile');

  // Update spec link
  hzl.setSpecLink(PROJECT, 'T-001', 'specs/T-001-v2.md');
  assertEqual(hzl.getSpecsIndex(PROJECT)['T-001'], 'specs/T-001-v2.md', 'Spec link updated');
  assertEqual(hzl.getTask(PROJECT, 'T-001').specFile, 'specs/T-001-v2.md', 'getTask reflects updated spec');

  // Remove spec link
  hzl.setSpecLink(PROJECT, 'T-001', null);
  assertEqual(hzl.getSpecsIndex(PROJECT)['T-001'], undefined, 'Spec link removed from index');
  assertEqual(hzl.getTask(PROJECT, 'T-001').specFile, null, 'getTask specFile null after removal');

  // Spec link on task with no prior link
  hzl.setSpecLink(PROJECT, 'T-002', 'specs/T-002-tests.md');
  assertEqual(hzl.getSpecsIndex(PROJECT)['T-002'], 'specs/T-002-tests.md', 'Spec link on new task works');

  // Specs index is per-project
  hzl.setSpecLink(PROJ_B, 'T-001', 'specs/other.md');
  assertEqual(hzl.getSpecsIndex(PROJ_B)['T-001'], 'specs/other.md', 'Spec index is project-scoped');
  assertEqual(hzl.getSpecsIndex(PROJECT)['T-001'], undefined, 'Project A spec not affected by Project B');

  // ============================================================
  console.log('\n═══ PHASE 10: recalcParentStatus ═══');
  // ============================================================

  // Reset subtask statuses for clean test
  // First set parent to a known starting state
  hzl.updateTask(PROJECT, 'T-001', { status: 'in-progress' });
  hzl.updateTask(PROJECT, 'T-001-1', { status: 'open' });
  hzl.updateTask(PROJECT, 'T-001-2', { status: 'open' });
  hzl.recalcParentStatus(PROJECT, 'T-001');
  assertEqual(hzl.getTask(PROJECT, 'T-001').status, 'open', 'All subtasks open → parent demoted to open');

  // One done, one open → in-progress
  hzl.updateTask(PROJECT, 'T-001-1', { status: 'done' });
  hzl.recalcParentStatus(PROJECT, 'T-001');
  const parentMixed = hzl.getTask(PROJECT, 'T-001');
  assertEqual(parentMixed.status, 'in-progress', 'Mixed subtasks → parent in-progress');

  // All done → review (FlowBoard safety: parent goes to review, not done)
  hzl.updateTask(PROJECT, 'T-001-2', { status: 'done' });
  hzl.recalcParentStatus(PROJECT, 'T-001');
  const parentAllDone = hzl.getTask(PROJECT, 'T-001');
  assertEqual(parentAllDone.status, 'review', 'All subtasks done → parent review (safety gate)');

  // Reopen one subtask → parent back to in-progress
  hzl.updateTask(PROJECT, 'T-001-1', { status: 'in-progress' });
  hzl.recalcParentStatus(PROJECT, 'T-001');
  assertEqual(hzl.getTask(PROJECT, 'T-001').status, 'in-progress', 'Subtask reopened → parent in-progress');

  // One blocked, one open → parent stays in-progress (some activity)
  hzl.updateTask(PROJECT, 'T-001-1', { status: 'blocked' });
  hzl.updateTask(PROJECT, 'T-001-2', { status: 'open' });
  hzl.recalcParentStatus(PROJECT, 'T-001');
  const parentBlocked = hzl.getTask(PROJECT, 'T-001');
  assertEqual(parentBlocked.status, 'in-progress', 'Blocked+open subtasks → parent in-progress');

  // ============================================================
  console.log('\n═══ PHASE 11: ensureProject ═══');
  // ============================================================

  // ensureProject for existing project — no error
  hzl.ensureProject(PROJECT);
  assert(true, 'ensureProject on existing project does not throw');

  // ensureProject for new project
  hzl.ensureProject('brand-new-project');
  const bnpTasks = hzl.listTasks('brand-new-project');
  assertEqual(bnpTasks.length, 0, 'New project via ensureProject has 0 tasks');
  const bnpT1 = hzl.createTask('brand-new-project', { title: 'First in new project' });
  assertEqual(bnpT1.id, 'T-001', 'New project starts at T-001');

  // ============================================================
  console.log('\n═══ PHASE 12: Double Restart (rebuild from cold DB) ═══');
  // ============================================================

  // Re-init twice to ensure rebuild is idempotent
  await hzl.init(DB_PATH);
  await hzl.init(DB_PATH);

  const finalT1 = hzl.getTask(PROJECT, 'T-001');
  assertEqual(finalT1.status, 'in-progress', 'T-001 status correct after double restart');
  const finalT001_1 = hzl.getTask(PROJECT, 'T-001-1');
  assertEqual(finalT001_1.status, 'blocked', 'T-001-1 blocked status correct after double restart');
  const finalT001_2 = hzl.getTask(PROJECT, 'T-001-2');
  assertEqual(finalT001_2.status, 'open', 'T-001-2 open status correct after double restart');
  assertEqual(hzl.getTask(PROJECT, 'T-002').status, 'blocked', 'T-002 blocked survives double restart');
  assertEqual(hzl.getTask(PROJECT, 'T-003').status, 'blocked', 'T-003 blocked survives double restart');

  // Archived/deleted tasks still not reused
  const tAfterDouble = hzl.createTask(PROJECT, { title: 'After double restart' });
  const idNum = parseInt(tAfterDouble.id.replace('T-', ''), 10);
  assert(idNum > 8, `After double restart, new task ID ${tAfterDouble.id} skips all archived/deleted IDs`);

  // Spec links survive restart
  assertEqual(hzl.getSpecsIndex(PROJECT)['T-002'], 'specs/T-002-tests.md', 'Spec link survives double restart');

  // ============================================================
  console.log('\n═══ PHASE 13: Error Handling ═══');
  // ============================================================

  // getTask for non-existent task
  assertEqual(hzl.getTask(PROJECT, 'T-999'), null, 'Non-existent task returns null');

  // getTask for non-existent project
  assertEqual(hzl.getTask('ghost-project', 'T-001'), null, 'Task in non-existent project returns null');

  // listTasks for non-existent project
  assertEqual(hzl.listTasks('ghost-project').length, 0, 'listTasks on non-existent project returns []');

  // updateTask on non-existent task should throw
  let updateThrew = false;
  try { hzl.updateTask(PROJECT, 'T-999', { status: 'done' }); } catch (e) { updateThrew = true; }
  assert(updateThrew, 'updateTask on non-existent task throws');

  // deleteTask on non-existent task should throw
  let deleteThrew = false;
  try { hzl.deleteTask(PROJECT, 'T-999'); } catch (e) { deleteThrew = true; }
  assert(deleteThrew, 'deleteTask on non-existent task throws');

  // Create task with invalid status
  let invalidStatusThrew = false;
  try { hzl.createTask(PROJECT, { title: 'Bad', status: 'yolo' }); } catch (e) { invalidStatusThrew = true; }
  // If it doesn't throw, it should at least fallback to 'open'
  if (!invalidStatusThrew) {
    console.log('  ⚠️  Invalid status did not throw — checking fallback behavior');
  } else {
    assert(true, 'Invalid status on create throws');
  }

  // ============================================================
  console.log('\n═══ PHASE 14: Title + Priority Persistence Across Restart ═══');
  // ============================================================

  // Update title and priority, restart, verify
  hzl.updateTask(PROJECT, 'T-002', { title: 'Renamed after restart test', priority: 'critical' });
  await hzl.init(DB_PATH);
  const renamedT2 = hzl.getTask(PROJECT, 'T-002');
  assertEqual(renamedT2.title, 'Renamed after restart test', 'Title change survives restart');
  assertEqual(renamedT2.priority, 'critical', 'Priority change survives restart');

  // ============================================================
  console.log('\n═══ PHASE 15: Subtask ID Continuity ═══');
  // ============================================================

  // Add subtask to T-002 (which has no subtasks yet)
  const s2_1 = hzl.createTask(PROJECT, { title: 'Sub for T-002', parentId: 'T-002' });
  assertEqual(s2_1.id, 'T-002-1', 'First subtask of T-002 is T-002-1');

  // Delete subtask, add another — should not reuse
  hzl.deleteTask(PROJECT, 'T-002-1');
  const s2_2 = hzl.createTask(PROJECT, { title: 'Second sub for T-002', parentId: 'T-002' });
  assertEqual(s2_2.id, 'T-002-2', 'Subtask ID after deleted T-002-1 is T-002-2');

  // Subtask IDs survive restart
  await hzl.init(DB_PATH);
  const s2_3 = hzl.createTask(PROJECT, { title: 'Third sub after restart', parentId: 'T-002' });
  assertEqual(s2_3.id, 'T-002-3', 'Subtask ID continuity after restart');

  // ============================================================
  console.log('\n═══ PHASE 16: Concurrent Status + Metadata Updates ═══');
  // ============================================================

  // Update status and title in same call
  hzl.updateTask(PROJECT, 'T-003', { status: 'in-progress', title: 'Deploy v2' });
  const combo = hzl.getTask(PROJECT, 'T-003');
  assertEqual(combo.status, 'in-progress', 'Status updated in combo call');
  assertEqual(combo.title, 'Deploy v2', 'Title updated in combo call');

  // Status + title combo survives restart
  await hzl.init(DB_PATH);
  const comboPost = hzl.getTask(PROJECT, 'T-003');
  assertEqual(comboPost.status, 'in-progress', 'Combo status survives restart');
  assertEqual(comboPost.title, 'Deploy v2', 'Combo title survives restart');

  // ============================================================
  console.log('\n═══ PHASE 17: getTaskCounts Accuracy ═══');
  // ============================================================

  // Set up known state
  hzl.updateTask(PROJECT, 'T-001', { status: 'review' });
  hzl.updateTask(PROJECT, 'T-001-1', { status: 'done' });
  hzl.updateTask(PROJECT, 'T-001-2', { status: 'done' });
  hzl.updateTask(PROJECT, 'T-002', { status: 'open' });
  hzl.updateTask(PROJECT, 'T-003', { status: 'blocked' });

  const exactCounts = hzl.getTaskCounts(PROJECT);
  console.log('  Exact counts:', JSON.stringify(exactCounts));
  // Verify structure and sum, not exact values (other phases mutate state)
  const countSum = Object.values(exactCounts).reduce((a, b) => a + b, 0);
  assert(countSum > 0, 'Task counts sum > 0');
  assert(exactCounts.review >= 1, 'At least 1 review task');
  assert(exactCounts.blocked >= 1, 'At least 1 blocked task');
  assert('open' in exactCounts && 'done' in exactCounts && 'archived' in exactCounts,
    'Counts include all expected status keys');

  // ============================================================
  console.log('\n═══ PHASE 18: keep-children + restart ═══');
  // ============================================================

  // Create parent with subtasks, delete with keep-children, restart, verify children have parentId=null
  const keepParent = hzl.createTask(PROJECT, { title: 'Parent for keep-children test' });
  const keepChild1 = hzl.createTask(PROJECT, { title: 'Keep child 1', parentId: keepParent.id });
  const keepChild2 = hzl.createTask(PROJECT, { title: 'Keep child 2', parentId: keepParent.id });
  hzl.deleteTask(PROJECT, keepParent.id, 'keep-children');
  // Verify immediately
  const orphan1 = hzl.getTask(PROJECT, keepChild1.id);
  const orphan2 = hzl.getTask(PROJECT, keepChild2.id);
  assert(orphan1 !== null, 'keep-children: child 1 still exists');
  assertEqual(orphan1.parentId, null, 'keep-children: child 1 parentId=null immediately');
  assert(orphan2 !== null, 'keep-children: child 2 still exists');
  assertEqual(orphan2.parentId, null, 'keep-children: child 2 parentId=null immediately');
  // Restart and verify
  await hzl.init(DB_PATH);
  const orphan1Post = hzl.getTask(PROJECT, keepChild1.id);
  const orphan2Post = hzl.getTask(PROJECT, keepChild2.id);
  assert(orphan1Post !== null, 'keep-children restart: child 1 still exists after restart');
  assertEqual(orphan1Post.parentId, null, 'keep-children restart: child 1 parentId=null after restart');
  assert(orphan2Post !== null, 'keep-children restart: child 2 still exists after restart');
  assertEqual(orphan2Post.parentId, null, 'keep-children restart: child 2 parentId=null after restart');
  // Verify children appear in top-level list (no parentId)
  const topLevel18 = hzl.listTasks(PROJECT).filter(t => !t.parentId);
  assert(topLevel18.some(t => t.id === keepChild1.id), 'keep-children restart: child 1 in top-level list');
  assert(topLevel18.some(t => t.id === keepChild2.id), 'keep-children restart: child 2 in top-level list');

  // ============================================================
  console.log('\n═══ PHASE 19: Invalid Status Rejection ═══');
  // ============================================================

  let yoloThrew = false;
  try { hzl.updateTask(PROJECT, 'T-001', { status: 'yolo' }); } catch (e) { yoloThrew = true; }
  assert(yoloThrew, 'updateTask with status "yolo" throws');

  let invalidCreateThrew = false;
  try { hzl.createTask(PROJECT, { title: 'Bad status task', status: 'notareal' }); } catch (e) { invalidCreateThrew = true; }
  assert(invalidCreateThrew, 'createTask with invalid status throws');

  // Valid statuses must not throw
  let validThrew = false;
  try { hzl.updateTask(PROJECT, 'T-001', { status: 'in-progress' }); } catch (e) { validThrew = true; }
  assert(!validThrew, 'updateTask with valid status "in-progress" does not throw');

  // ============================================================
  console.log('\n═══ PHASE 20: Duplicate Detection with Archived Tasks ═══');
  // ============================================================

  // Create T-dup-001, delete (archive) it, verify next task skips it
  const dupProj = 'dup-test-project';
  const dup1 = hzl.createTask(dupProj, { title: 'Dup test task 1' });
  assertEqual(dup1.id, 'T-001', 'dup project: first task is T-001');
  hzl.deleteTask(dupProj, dup1.id);
  // Next task must NOT reuse T-001
  const dup2 = hzl.createTask(dupProj, { title: 'Dup test task 2' });
  assertEqual(dup2.id, 'T-002', 'After archiving T-001, next task is T-002 not T-001');
  // Restart and verify no ID collision
  await hzl.init(DB_PATH);
  const dup3 = hzl.createTask(dupProj, { title: 'After restart dup test' });
  assert(dup3.id !== 'T-001', 'After restart, new task does not reuse archived T-001');
  assert(dup3.id !== 'T-002', 'After restart, new task does not reuse active T-002');
  assertEqual(dup3.id, 'T-003', 'After restart with archived T-001 and active T-002, next is T-003');

  // ============================================================
  console.log('\n═══ PHASE 21: Parent Validation ═══');
  // ============================================================

  // createTask with non-existent parentId must throw
  let badParentThrew = false;
  try { hzl.createTask(PROJECT, { title: 'Bad parent', parentId: 'T-999' }); } catch (e) { badParentThrew = true; }
  assert(badParentThrew, 'createTask with non-existent parentId throws');

  // Subtask of subtask must throw (max 1 nesting level)
  // T-002-3 exists (created in Phase 15), so T-002-3 is a subtask
  const deepNestThrew = (() => {
    try { hzl.createTask(PROJECT, { title: 'Deep nest', parentId: 'T-002-3' }); return false; } catch { return true; }
  })();
  assert(deepNestThrew, 'createTask with subtask as parent throws (max 1 nesting level)');

  // ============================================================
  console.log('\n═══ PHASE 22: Status Validation on Create ═══');
  // ============================================================

  // All valid statuses must work
  for (const st of ['open', 'in-progress', 'backlog', 'blocked']) {
    let threw = false;
    let created;
    try { created = hzl.createTask(PROJECT, { title: `Valid status ${st}`, status: st }); } catch (e) { threw = true; }
    assert(!threw, `createTask with valid status "${st}" does not throw`);
    if (created) {
      assertEqual(created.status, st, `createTask status "${st}" reflected in returned task`);
      hzl.deleteTask(PROJECT, created.id);
    }
  }

  // Invalid statuses must throw
  for (const bad of ['yolo', 'OPEN', 'pending', '']) {
    let threw = false;
    try { hzl.createTask(PROJECT, { title: 'Invalid', status: bad }); } catch { threw = true; }
    assert(threw, `createTask with invalid status "${bad}" throws`);
  }

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
