'use strict';

/**
 * Compliance detection tests for T-263-4.
 * Verifies routed-unclaimed detection, checkpoint health, and contract compliance.
 *
 * Run: node test-compliance-detection.js
 */

const fs = require('fs');
const path = require('path');
const hzlService = require('./hzl-service.js');

let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✅ ${msg}`); }
  else      { fail++; failures.push(msg); console.log(`  ❌ ${msg}`); }
}

function section(title) {
  console.log(`\n## ${title}\n`);
}

const TEST_PROJECT = `test-compliance-${Date.now()}`;
const HZL_DB_PATH = path.join(__dirname, 'test-workspace', '.hzl', 'flowboard-test-compliance.db');

async function setup() {
  try {
    if (fs.existsSync(HZL_DB_PATH)) fs.unlinkSync(HZL_DB_PATH);
  } catch { /* ignored */ }

  await hzlService.init(HZL_DB_PATH);
  try {
    hzlService.createProject(TEST_PROJECT, 'Testing compliance detection');
  } catch (err) {
    // Project might already exist, that's OK
  }

  return {
    createTask: (title, opts = {}) => hzlService.createTask(TEST_PROJECT, {
      title,
      description: 'Test task',
      priority: 'high',
      status: opts.status || 'open',
      ...opts,
    }),
    routeTask: (taskId, agent) => hzlService.routeTask(TEST_PROJECT, taskId, agent),
    claimTask: (taskId, agent) => hzlService.claimTask(TEST_PROJECT, taskId, { agent }),
    addCheckpoint: (taskId, message, progress, agent) => hzlService.addCheckpoint(TEST_PROJECT, taskId, { message, progress, agent }),
  };
}

async function runTests() {
  section('Routed-Unclaimed Detection');

  const helpers = await setup();

  // Test 1: Detect routed-unclaimed task
  try {
    const task = helpers.createTask('Task without claim');
    helpers.routeTask(task.id, 'test-agent-1');

    const stuck = hzlService.getStuckTasks();
    const routedUnclaimed = stuck.routedUnclaimed || [];
    const found = routedUnclaimed.find(t => t.taskId === task.id);

    ok(
      found && found.reason === 'routed-unclaimed',
      'Detect routed-unclaimed: agent assigned but not claimed'
    );
  } catch (err) {
    fail++;
    failures.push(`routed-unclaimed detection failed: ${err.message}`);
    console.log(`  ❌ routed-unclaimed detection failed: ${err.message}`);
  }

  // Test 2: Claimed task not in routed-unclaimed list
  try {
    const task = helpers.createTask('Claimed task');
    helpers.routeTask(task.id, 'test-agent-2');
    helpers.claimTask(task.id, 'test-agent-2');

    const stuck = hzlService.getStuckTasks();
    const routedUnclaimed = stuck.routedUnclaimed || [];
    const found = routedUnclaimed.find(t => t.taskId === task.id);

    ok(!found, 'Claimed task not in routed-unclaimed list');
  } catch (err) {
    fail++;
    failures.push(`claimed task test failed: ${err.message}`);
    console.log(`  ❌ claimed task test failed: ${err.message}`);
  }

  // Test 3: Non-routed task not in routed-unclaimed list
  try {
    const task = helpers.createTask('Non-routed task');

    const stuck = hzlService.getStuckTasks();
    const routedUnclaimed = stuck.routedUnclaimed || [];
    const found = routedUnclaimed.find(t => t.taskId === task.id);

    ok(!found, 'Non-routed task not in routed-unclaimed list');
  } catch (err) {
    fail++;
    failures.push(`non-routed task test failed: ${err.message}`);
    console.log(`  ❌ non-routed task test failed: ${err.message}`);
  }

  section('Checkpoint Health');

  // Test 4: Checkpoint health for open task
  try {
    const task = helpers.createTask('Open task', { status: 'open' });
    const health = hzlService.getCheckpointHealth(TEST_PROJECT, task.id);
    ok(
      health.healthy === true && health.issues.length === 0,
      'Healthy: open task (not claimed yet)'
    );
  } catch (err) {
    fail++;
    failures.push(`open task health test failed: ${err.message}`);
    console.log(`  ❌ open task health test failed: ${err.message}`);
  }

  // Test 5: Checkpoint health returns error for non-existent task
  try {
    const health = hzlService.getCheckpointHealth(TEST_PROJECT, 'T-NONEXISTENT');
    ok(
      health.error !== undefined,
      'Error returned for non-existent task'
    );
  } catch (err) {
    fail++;
    failures.push(`non-existent task health test failed: ${err.message}`);
    console.log(`  ❌ non-existent task health test failed: ${err.message}`);
  }

  // Test 6: Checkpoint health for routed-unclaimed task
  try {
    const task = helpers.createTask('Routed unclaimed');
    helpers.routeTask(task.id, 'test-agent-5');

    const health = hzlService.getCheckpointHealth(TEST_PROJECT, task.id);
    ok(
      health.healthy === false && health.issues.some(i => i.includes('routed-unclaimed')),
      'Unhealthy: routed-unclaimed task'
    );
  } catch (err) {
    fail++;
    failures.push(`routed-unclaimed health test failed: ${err.message}`);
    console.log(`  ❌ routed-unclaimed health test failed: ${err.message}`);
  }

  section('Compliance Status');

  // Test 7: Compliance status for single project
  try {
    const task1 = helpers.createTask('Task 1', { status: 'in-progress' });
    helpers.routeTask(task1.id, 'test-agent-6');

    const compliance = hzlService.getComplianceStatus({
      project: TEST_PROJECT,
      includeDetails: true,
    });

    ok(
      compliance.summary.routedUnclaimedCount > 0 && !compliance.summary.healthy,
      'Compliance status detects routed-unclaimed in project'
    );
  } catch (err) {
    fail++;
    failures.push(`compliance status test failed: ${err.message}`);
    console.log(`  ❌ compliance status test failed: ${err.message}`);
  }

  // Test 8: Compliance status by agent
  try {
    const task = helpers.createTask('Agent task');
    helpers.routeTask(task.id, 'target-agent');

    const agentCompliance = hzlService.getComplianceStatus({
      agent: 'target-agent',
      includeDetails: true,
    });

    const found = agentCompliance.details.find(d => d.taskId === task.id);
    if (!found) {
      console.log(`    Debug: Looking for ${task.id} in agent 'target-agent'. Details:`, agentCompliance.details.slice(0, 2));
    }
    ok(
      found && found.issues.includes('routed-unclaimed'),
      'Compliance status filters by agent'
    );
  } catch (err) {
    fail++;
    failures.push(`agent compliance test failed: ${err.message}`);
    console.log(`  ❌ agent compliance test failed: ${err.message}`);
  }

  // Test 9: Notifiable routed-unclaimed tasks
  try {
    const task = helpers.createTask('Unclaimed notify');
    helpers.routeTask(task.id, 'notify-agent');

    const notifiable = hzlService.getNotifiableStuckTasks();
    const found = (notifiable.routedUnclaimed || []).find(t => t.taskId === task.id);

    ok(
      found && found.reason === 'routed-unclaimed',
      'Routed-unclaimed tasks are in notifiable list (critical)'
    );
  } catch (err) {
    fail++;
    failures.push(`notifiable routed-unclaimed test failed: ${err.message}`);
    console.log(`  ❌ notifiable routed-unclaimed test failed: ${err.message}`);
  }

  // Cleanup
  try {
    if (fs.existsSync(HZL_DB_PATH)) fs.unlinkSync(HZL_DB_PATH);
  } catch { /* ignored */ }

  // Report
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Passed: ${pass}/${pass + fail}`);
  if (fail > 0) {
    console.log(`Failed: ${fail}`);
    console.log('\nFailures:');
    failures.forEach(f => console.log(`  - ${f}`));
  }
  process.exit(fail > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
