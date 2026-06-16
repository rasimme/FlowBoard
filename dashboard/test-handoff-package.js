'use strict';

/**
 * Tests for handoff package endpoint (T-263).
 * Verifies that GET /api/projects/:name/tasks/:id/handoff returns
 * an agent-ready markdown package with the required marker and content.
 *
 * Run: node test-handoff-package.js
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

const TEST_PROJECT = 'test-handoff';
const TEST_PROJECT_DIR = path.join(__dirname, '..', 'projects', TEST_PROJECT);
const HZL_DB_PATH = path.join(__dirname, 'test-workspace', '.hzl', 'flowboard-test-handoff.db');
const TEST_ROOT = path.join(__dirname, 'test-workspace');

async function setup() {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });

  // Initialize hzlService for testing
  await hzlService.init(HZL_DB_PATH);
  fs.rmSync(TEST_PROJECT_DIR, { recursive: true, force: true });

  // Create test project and task
  try {
    hzlService.createProject(TEST_PROJECT, 'Testing handoff package generation');

    const task = hzlService.createTask(TEST_PROJECT, {
      title: 'Test Task for Handoff',
      description: 'This is a test task to verify handoff package',
      priority: 'high',
      status: 'open',
    });

    return task;
  } catch (err) {
    console.error('Setup failed:', err.message);
    process.exit(1);
  }
}

async function runTests() {
  section('Test Handoff Package Generation');

  const task = await setup();
  const taskId = task.id;

  // Test 1: Markdown format includes marker
  try {
    const markdown = hzlService.buildHandoffMarkdown(TEST_PROJECT, taskId, {
      apiBase: 'http://127.0.0.1:18790',
    });
    ok(
      markdown.includes('flowboard-handoff-contract: v1'),
      'Markdown includes contract marker'
    );
    ok(
      markdown.startsWith('```'),
      'Markdown starts with code fence for marker'
    );
  } catch (err) {
    fail++;
    failures.push(`Failed to generate markdown: ${err.message}`);
    console.log(`  ❌ Failed to generate markdown: ${err.message}`);
  }

  // Test 2: Markdown includes project info
  try {
    const markdown = hzlService.buildHandoffMarkdown(TEST_PROJECT, taskId, {
      apiBase: 'http://127.0.0.1:18790',
    });
    ok(markdown.includes(TEST_PROJECT), 'Markdown includes project name');
    ok(markdown.includes('# FlowBoard Task Handoff:'), 'Markdown includes handoff header');
  } catch (err) {
    fail++;
    failures.push(`Project info test failed: ${err.message}`);
  }

  // Test 3: Markdown includes task info
  try {
    const markdown = hzlService.buildHandoffMarkdown(TEST_PROJECT, taskId, {
      apiBase: 'http://127.0.0.1:18790',
    });
    ok(markdown.includes(taskId), 'Markdown includes task ID');
    ok(markdown.includes('Test Task for Handoff'), 'Markdown includes task title');
    ok(markdown.includes('## Task'), 'Markdown includes Task section');
  } catch (err) {
    fail++;
    failures.push(`Task info test failed: ${err.message}`);
  }

  // Test 4: Markdown includes API contract section
  try {
    const markdown = hzlService.buildHandoffMarkdown(TEST_PROJECT, taskId, {
      apiBase: 'http://127.0.0.1:18790',
      targetAgentId: 'test-handoff-agent',
    });
    ok(markdown.includes('## Mandatory Startup Contract'), 'Markdown includes mandatory startup contract');
    ok(
      markdown.includes('local-capable tool') && markdown.includes('Do not use external web-fetch'),
      'Markdown warns agents to use local-capable tools for localhost API calls'
    );
    ok(
      markdown.includes('Do not run `git commit`') && markdown.includes('`git push`'),
      'Markdown uses conservative default git policy'
    );
    ok(
      markdown.includes('## Git & External Action Policy') && markdown.includes('**Source**: default'),
      'Markdown labels default git policy as default-derived'
    );
    ok(markdown.includes('## API Contract'), 'Markdown includes API Contract section');
    ok(markdown.includes('GET'), 'Markdown includes GET method');
    ok(markdown.includes('POST'), 'Markdown includes POST method');
    ok(markdown.includes('/api/status'), 'Markdown includes status endpoint');
    ok(markdown.includes('"agentId": "test-handoff-agent"'), 'Markdown activates target agent id');
    ok(markdown.includes('/claim'), 'Markdown includes claim endpoint');
    ok(markdown.includes('/checkpoint'), 'Markdown includes checkpoint endpoint');
  } catch (err) {
    fail++;
    failures.push(`API contract test failed: ${err.message}`);
  }

  // Test 5: Markdown includes claim/checkpoint protocol
  try {
    const markdown = hzlService.buildHandoffMarkdown(TEST_PROJECT, taskId, {
      apiBase: 'http://127.0.0.1:18790',
      targetAgentId: 'test-handoff-agent',
    });
    ok(
      markdown.includes('Claim Task'),
      'Markdown includes Claim Task section'
    );
    ok(
      markdown.includes('"agent": "test-handoff-agent"'),
      'Markdown uses concrete agent id in task lifecycle calls'
    );
    ok(
      markdown.includes('Record Checkpoint'),
      'Markdown includes Record Checkpoint section'
    );
    ok(
      markdown.includes('Set Task to Review'),
      'Markdown includes Set Task to Review section'
    );
    ok(
      markdown.includes('Deactivate Project Context'),
      'Markdown includes terminal project deactivation section'
    );
    ok(
      markdown.includes('"project": null') && markdown.includes('"agentId": "test-handoff-agent"'),
      'Markdown deactivates target agent id after completion'
    );
  } catch (err) {
    fail++;
    failures.push(`Protocol test failed: ${err.message}`);
  }

  // Test 6: Markdown includes contract version and timestamp
  try {
    const markdown = hzlService.buildHandoffMarkdown(TEST_PROJECT, taskId, {
      apiBase: 'http://127.0.0.1:18790',
    });
    ok(
      markdown.includes('Contract Version'),
      'Markdown includes contract version'
    );
    ok(
      markdown.includes('Generated'),
      'Markdown includes generated timestamp'
    );
  } catch (err) {
    fail++;
    failures.push(`Version/timestamp test failed: ${err.message}`);
  }

  // Test 7: buildHandoffMarkdown throws for non-existent task
  try {
    hzlService.buildHandoffMarkdown(TEST_PROJECT, 'T-999999');
    fail++;
    failures.push('Should throw error for non-existent task');
    console.log(`  ❌ Should throw error for non-existent task`);
  } catch (err) {
    ok(true, 'Throws error for non-existent task');
  }

  // Test 8: Markdown format is readable text (no JSON escaping)
  try {
    const markdown = hzlService.buildHandoffMarkdown(TEST_PROJECT, taskId, {
      apiBase: 'http://127.0.0.1:18790',
    });
    ok(
      !markdown.includes('\\n') && !markdown.includes('\\"'),
      'Markdown is plain text (not JSON-escaped)'
    );
  } catch (err) {
    fail++;
    failures.push(`Readability test failed: ${err.message}`);
  }

  // Test 9: Test with checkpoint
  try {
    hzlService.addCheckpoint(TEST_PROJECT, taskId, {
      message: 'Starting work on this task',
      author: 'test-agent',
    });

    const markdown = hzlService.buildHandoffMarkdown(TEST_PROJECT, taskId, {
      apiBase: 'http://127.0.0.1:18790',
    });
    ok(markdown.includes('Checkpoints'), 'Markdown includes Checkpoints section');
    ok(markdown.includes('Starting work'), 'Markdown includes checkpoint message');
  } catch (err) {
    fail++;
    failures.push(`Checkpoint test failed: ${err.message}`);
  }

  // Test 10: Backward compatibility - getHandoffContext still works
  try {
    const context = hzlService.getHandoffContext(TEST_PROJECT, taskId);
    ok(context.taskId === taskId, 'getHandoffContext returns taskId');
    ok(context.project === TEST_PROJECT, 'getHandoffContext returns project');
    ok('spec' in context, 'getHandoffContext includes spec field');
    ok('repo' in context, 'getHandoffContext includes repo field');
  } catch (err) {
    fail++;
    failures.push(`Backward compatibility test failed: ${err.message}`);
  }

  // Test 11: Project-level Git policy overrides conservative default
  try {
    fs.mkdirSync(TEST_PROJECT_DIR, { recursive: true });
    fs.writeFileSync(path.join(TEST_PROJECT_DIR, 'PROJECT.md'), [
      '# Handoff Test Project',
      '',
      '## Agent Git Policy',
      'mode: commit-ok',
      'Agents may create local commits when the assigned task asks for code changes, but must not push without explicit user approval.',
      '',
    ].join('\n'));

    const markdown = hzlService.buildHandoffMarkdown(TEST_PROJECT, taskId, {
      apiBase: 'http://127.0.0.1:18790',
      targetAgentId: 'test-handoff-agent',
    });
    ok(markdown.includes('- **Mode**: commit-ok'), 'Markdown derives git policy mode from project context');
    ok(markdown.includes('- **Source**: project'), 'Markdown labels git policy as project-derived');
    ok(markdown.includes('must not push without explicit user approval'), 'Markdown includes project git policy instructions');
  } catch (err) {
    fail++;
    failures.push(`Project git policy override test failed: ${err.message}`);
  }

  // Cleanup
  try {
    if (fs.existsSync(HZL_DB_PATH)) fs.unlinkSync(HZL_DB_PATH);
    fs.rmSync(TEST_PROJECT_DIR, { recursive: true, force: true });
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
