'use strict';

/**
 * Tests for spawn-wrapper utility (T-263).
 * Verifies that buildSpawnPrompt() correctly combines handoff package with custom instructions.
 *
 * Run: node test-spawn-wrapper.js
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

const TEST_PROJECT = 'test-spawn';
const TEST_TASKS_DIR = path.join(__dirname, 'test-workspace', 'projects', TEST_PROJECT);
const HZL_DB_PATH = path.join(__dirname, 'test-workspace', '.hzl', 'flowboard-test-spawn.db');

async function setup() {
  try {
    if (fs.existsSync(HZL_DB_PATH)) fs.unlinkSync(HZL_DB_PATH);
  } catch { /* ignored */ }

  await hzlService.init(HZL_DB_PATH);

  try {
    hzlService.createProject(TEST_PROJECT, 'Testing spawn wrapper');

    const task = hzlService.createTask(TEST_PROJECT, {
      title: 'Test Spawn Task',
      description: 'Task for testing spawn wrapper',
      priority: 'high',
      status: 'open',
    });

    return task;
  } catch (e) {
    console.error('Setup error:', e.message);
    throw e;
  }
}

async function runTests() {
  section('Setup');
  const testTask = await setup();
  ok(testTask, `Created test task: ${testTask?.id}`);

  section('buildSpawnPrompt() — No custom prompt');
  try {
    const prompt = hzlService.buildSpawnPrompt(TEST_PROJECT, testTask.id);
    ok(prompt && prompt.includes('flowboard-handoff-contract'), 'Returns handoff package');
    ok(prompt.includes('Mandatory Startup Contract'), 'Includes startup contract');
    ok(!prompt.includes('Custom Instructions'), 'No custom instructions section when empty');
  } catch (e) {
    fail++;
    failures.push(`buildSpawnPrompt() without custom prompt: ${e.message}`);
    console.log(`  ❌ Error: ${e.message}`);
  }

  section('buildSpawnPrompt() — With custom prompt');
  try {
    const customMsg = 'Fix the bug in the toolbar';
    const prompt = hzlService.buildSpawnPrompt(TEST_PROJECT, testTask.id, customMsg);
    ok(prompt.includes('flowboard-handoff-contract'), 'Includes handoff package');
    ok(prompt.includes(customMsg), 'Includes custom instructions');
    ok(prompt.includes('# Custom Instructions'), 'Marks custom section');
    ok(prompt.indexOf('flowboard-handoff-contract') < prompt.indexOf('Custom Instructions'),
       'Handoff is prepended (comes first)');
  } catch (e) {
    fail++;
    failures.push(`buildSpawnPrompt() with custom prompt: ${e.message}`);
    console.log(`  ❌ Error: ${e.message}`);
  }

  section('buildSpawnPrompt() — With whitespace-only prompt');
  try {
    const prompt = hzlService.buildSpawnPrompt(TEST_PROJECT, testTask.id, '   \n  \t  ');
    ok(!prompt.includes('Custom Instructions'), 'Whitespace-only prompt treated as empty');
  } catch (e) {
    fail++;
    failures.push(`buildSpawnPrompt() with whitespace: ${e.message}`);
    console.log(`  ❌ Error: ${e.message}`);
  }

  section('buildSpawnPrompt() — With options');
  try {
    const prompt = hzlService.buildSpawnPrompt(TEST_PROJECT, testTask.id, 'Test task', {
      targetAgentId: 'agent-test-123',
      apiBase: 'http://example.com:18790',
    });
    ok(prompt.includes('agent-test-123'), 'Includes target agent ID from options');
    ok(prompt.includes('http://example.com:18790'), 'Uses custom API base from options');
  } catch (e) {
    fail++;
    failures.push(`buildSpawnPrompt() with options: ${e.message}`);
    console.log(`  ❌ Error: ${e.message}`);
  }

  section('buildSpawnPrompt() — Contract marker visibility');
  try {
    const prompt = hzlService.buildSpawnPrompt(TEST_PROJECT, testTask.id, 'Task work');
    const lines = prompt.split('\n');
    ok(lines[0].includes('```'), 'First line starts code fence');
    ok(lines[1].includes('flowboard-handoff-contract'), 'Contract marker on line 2');
    ok(lines[2].includes('```'), 'Contract marker ends on line 3');
  } catch (e) {
    fail++;
    failures.push(`Contract marker visibility: ${e.message}`);
    console.log(`  ❌ Error: ${e.message}`);
  }

  section('buildSpawnPrompt() — Non-existent task');
  try {
    hzlService.buildSpawnPrompt(TEST_PROJECT, 'T-FAKE-999');
    fail++;
    failures.push('buildSpawnPrompt() should throw for non-existent task');
    console.log(`  ❌ Should have thrown for non-existent task`);
  } catch (e) {
    ok(e.message.includes('Task not found'), 'Correctly throws for non-existent task');
  }

  section('Results');
  console.log(`\n✅ Passed: ${pass}`);
  console.log(`❌ Failed: ${fail}`);

  if (failures.length > 0) {
    console.log('\n## Failures\n');
    failures.forEach(f => console.log(`- ${f}`));
    process.exit(1);
  } else {
    console.log('\n🎉 All tests passed!\n');
    process.exit(0);
  }
}

// Run tests
runTests().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
