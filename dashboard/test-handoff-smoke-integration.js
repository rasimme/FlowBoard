'use strict';

/**
 * Regression and Smoke tests for FlowBoard Handoff Contract (T-263-5).
 *
 * Regression tests: Verify contract structure, API compliance, backward compatibility
 * Smoke tests: Quick validation of core handoff flow functionality
 *
 * Run: node test-handoff-smoke-integration.js
 */

const http = require('http');
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

const TEST_PROJECT = 'test-handoff-smoke';
const HZL_DB_PATH = path.join(__dirname, 'test-workspace', '.hzl', 'flowboard-test-smoke.db');
const PORT = 18792;

async function setup() {
  try {
    if (fs.existsSync(HZL_DB_PATH)) fs.unlinkSync(HZL_DB_PATH);
  } catch { /* ignored */ }

  await hzlService.init(HZL_DB_PATH);

  hzlService.createProject(TEST_PROJECT, 'Smoke testing handoff contract');
  const task = hzlService.createTask(TEST_PROJECT, {
    title: 'Handoff Contract Smoke Test Task',
    description: 'Task for regression and smoke testing',
    priority: 'critical',
    status: 'open',
  });

  // Add a checkpoint to test checkpoint inclusion
  hzlService.addCheckpoint(TEST_PROJECT, task.id, {
    message: 'Regression test checkpoint',
    progress: 25,
  });

  return task;
}

function makeRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port: PORT,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data,
        });
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function startServer() {
  const express = require('express');
  const app = express();

  // Health check endpoint
  app.get('/health', (req, res) => {
    res.json({ ok: true });
  });

  // Handoff endpoint
  app.get('/api/projects/:name/tasks/:id/handoff', (req, res) => {
    try {
      const format = req.query.format === 'json' ? 'json' : 'markdown';
      if (format === 'markdown') {
        const markdown = hzlService.buildHandoffMarkdown(req.params.name, req.params.id, {
          apiBase: `http://127.0.0.1:${PORT}`,
          targetAgentId: req.query.agentId || req.query.agent || undefined,
        });
        res.type('text/markdown; charset=utf-8').send(markdown);
      } else {
        const context = hzlService.getHandoffContext(req.params.name, req.params.id);
        res.json({ ok: true, ...context });
      }
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Status endpoint for agent activation
  app.put('/api/status', (req, res) => {
    res.json({
      ok: true,
      activeProject: req.body?.project || 'test-handoff-smoke',
      agentId: req.body?.agentId || 'test-agent',
    });
  });

  // Claim endpoint
  app.post('/api/projects/:name/tasks/:id/claim', (req, res) => {
    res.json({
      ok: true,
      task: {
        id: req.params.id,
        status: 'in-progress',
        agent: req.body?.agent || 'test-agent',
        claimedAt: new Date().toISOString(),
      },
    });
  });

  // Checkpoint endpoint
  app.post('/api/projects/:name/tasks/:id/checkpoint', (req, res) => {
    res.json({
      ok: true,
      checkpoint: {
        id: 9001,
        taskId: req.params.id,
        message: req.body?.message || 'Checkpoint',
        agent: req.body?.agent || 'test-agent',
        timestamp: new Date().toISOString(),
      },
    });
  });

  return new Promise((resolve) => {
    const server = app.listen(PORT, '127.0.0.1', () => {
      resolve(server);
    });
  });
}

async function runTests() {
  section('Smoke Tests: Basic Handoff Contract Functionality');

  const task = await setup();
  const taskId = task.id;
  const server = await startServer();

  // Give server a moment to start
  await new Promise(resolve => setTimeout(resolve, 100));

  // ===== SMOKE TESTS: Quick core functionality checks =====

  // Smoke 1: Server is accessible
  try {
    const res = await makeRequest('GET', '/health');
    ok(res.statusCode === 200, 'Server is accessible');
  } catch (err) {
    fail++;
    failures.push(`Server not accessible: ${err.message}`);
    console.log(`  ❌ Server not accessible: ${err.message}`);
  }

  // Smoke 2: Handoff endpoint is accessible
  try {
    const res = await makeRequest('GET', `/api/projects/${TEST_PROJECT}/tasks/${taskId}/handoff`);
    ok(res.statusCode === 200, 'Handoff endpoint accessible');
    ok(res.headers['content-type']?.includes('text/markdown'), 'Returns markdown content type');
  } catch (err) {
    fail++;
    failures.push(`Handoff endpoint not accessible: ${err.message}`);
  }

  // Smoke 3: Contract marker is present
  try {
    const res = await makeRequest('GET', `/api/projects/${TEST_PROJECT}/tasks/${taskId}/handoff`);
    ok(
      res.body.includes('flowboard-handoff-contract: v1'),
      'Contract marker v1 is present'
    );
    ok(
      res.body.startsWith('```'),
      'Contract marker is visible at document start'
    );
  } catch (err) {
    fail++;
    failures.push(`Contract marker check failed: ${err.message}`);
  }

  // Smoke 4: Basic required sections are present
  try {
    const res = await makeRequest('GET', `/api/projects/${TEST_PROJECT}/tasks/${taskId}/handoff`);
    ok(res.body.includes('# FlowBoard Task Handoff:'), 'Header section present');
    ok(res.body.includes('## Task'), 'Task section present');
    ok(res.body.includes('## Mandatory Startup Contract'), 'Startup contract section present');
    ok(res.body.includes('## API Contract'), 'API contract section present');
  } catch (err) {
    fail++;
    failures.push(`Required sections check failed: ${err.message}`);
  }

  section('Regression Tests: Contract Structure & Stability');

  // Regression 1: Contract marker format is stable
  try {
    const res = await makeRequest('GET', `/api/projects/${TEST_PROJECT}/tasks/${taskId}/handoff`);
    const markerMatch = res.body.match(/^```\nflowboard-handoff-contract: v1\n```/);
    ok(markerMatch, 'Contract marker format is exactly: ```\\nflowboard-handoff-contract: v1\\n```');
  } catch (err) {
    fail++;
    failures.push(`Marker format stability check failed: ${err.message}`);
  }

  // Regression 2: Project info is correctly included
  try {
    const res = await makeRequest('GET', `/api/projects/${TEST_PROJECT}/tasks/${taskId}/handoff`);
    ok(res.body.includes(`## Project\n- **Name**: ${TEST_PROJECT}`), 'Project name correctly formatted');
    ok(res.body.includes('## Task'), 'Task header present');
  } catch (err) {
    fail++;
    failures.push(`Project info regression test failed: ${err.message}`);
  }

  // Regression 3: Task details are correctly included
  try {
    const res = await makeRequest('GET', `/api/projects/${TEST_PROJECT}/tasks/${taskId}/handoff`);
    ok(res.body.includes(`- **ID**: ${taskId}`), 'Task ID correctly included');
    ok(res.body.includes('- **Title**: Handoff Contract Smoke Test Task'), 'Task title correctly included');
  } catch (err) {
    fail++;
    failures.push(`Task details regression test failed: ${err.message}`);
  }

  // Regression 4: API contract endpoints are correctly formatted
  try {
    const res = await makeRequest('GET', `/api/projects/${TEST_PROJECT}/tasks/${taskId}/handoff`);
    ok(res.body.includes('PUT http://127.0.0.1:' + PORT + '/api/status'), 'Status endpoint URL correct');
    ok(res.body.includes('POST http://127.0.0.1:' + PORT + '/api/projects/' + TEST_PROJECT + '/tasks/' + taskId + '/claim'), 'Claim endpoint URL correct');
    ok(res.body.includes('POST http://127.0.0.1:' + PORT + '/api/projects/' + TEST_PROJECT + '/tasks/' + taskId + '/checkpoint'), 'Checkpoint endpoint URL correct');
  } catch (err) {
    fail++;
    failures.push(`API endpoints regression test failed: ${err.message}`);
  }

  // Regression 5: Startup contract steps are stable
  try {
    const res = await makeRequest('GET', `/api/projects/${TEST_PROJECT}/tasks/${taskId}/handoff`);
    ok(res.body.includes('1. Activate/check this project for your own agent id.'), 'Step 1 present');
    ok(res.body.includes('2. Fetch the FlowBoard bootstrap and lazy-load required rules.'), 'Step 2 present');
    ok(res.body.includes('3. Claim this exact task.'), 'Step 3 present');
    ok(res.body.includes('4. Write a first checkpoint.'), 'Step 4 present');
    ok(res.body.includes('5. Only then start implementation or review work.'), 'Step 5 present');
    ok(res.body.includes('6. When the task is complete'), 'Step 6 terminal deactivation present');
  } catch (err) {
    fail++;
    failures.push(`Startup contract steps regression test failed: ${err.message}`);
  }

  // Regression 6: Task lifecycle protocol endpoints are present
  try {
    const res = await makeRequest('GET', `/api/projects/${TEST_PROJECT}/tasks/${taskId}/handoff`);
    ok(res.body.includes('### Status & Bootstrap'), 'Status & Bootstrap section present');
    ok(res.body.includes('### Claim Task'), 'Claim Task section present');
    ok(res.body.includes('### Record Checkpoint'), 'Record Checkpoint section present');
    ok(res.body.includes('### Set Task to Review'), 'Set Task to Review section present');
    ok(res.body.includes('### Deactivate Project Context'), 'Deactivate Project Context section present');
  } catch (err) {
    fail++;
    failures.push(`Task lifecycle sections regression test failed: ${err.message}`);
  }

  // Regression 7: Backward compatibility - JSON format still works
  try {
    const res = await makeRequest('GET', `/api/projects/${TEST_PROJECT}/tasks/${taskId}/handoff?format=json`);
    ok(res.statusCode === 200, 'JSON format request succeeds');
    ok(res.headers['content-type']?.includes('application/json'), 'JSON format returns correct content-type');
    const json = JSON.parse(res.body);
    ok(json.ok === true, 'JSON response has ok: true');
    ok('taskId' in json, 'JSON response includes taskId field');
  } catch (err) {
    fail++;
    failures.push(`Backward compatibility regression test failed: ${err.message}`);
  }

  // Regression 8: Agent ID in startup contract
  try {
    const res = await makeRequest('GET', `/api/projects/${TEST_PROJECT}/tasks/${taskId}/handoff?agentId=regression-test-agent`);
    ok(res.body.includes('"agentId": "regression-test-agent"'), 'Agent ID in status endpoint');
    ok(res.body.includes('"agent": "regression-test-agent"'), 'Agent ID in claim/checkpoint endpoints');
  } catch (err) {
    fail++;
    failures.push(`Agent ID regression test failed: ${err.message}`);
  }

  // Regression 9: Checkpoint data is included
  try {
    const res = await makeRequest('GET', `/api/projects/${TEST_PROJECT}/tasks/${taskId}/handoff`);
    ok(res.body.includes('## Checkpoints'), 'Checkpoints section present');
    ok(res.body.includes('Regression test checkpoint'), 'Checkpoint message included');
  } catch (err) {
    fail++;
    failures.push(`Checkpoint inclusion regression test failed: ${err.message}`);
  }

  // Regression 10: Contract version and timestamp present
  try {
    const res = await makeRequest('GET', `/api/projects/${TEST_PROJECT}/tasks/${taskId}/handoff`);
    ok(res.body.includes('**Contract Version**: 1'), 'Contract version 1 specified');
    ok(res.body.includes('**Generated**:'), 'Generation timestamp present');
    ok(res.body.match(/Generated.*\d{4}-\d{2}-\d{2}/), 'Timestamp in ISO format');
  } catch (err) {
    fail++;
    failures.push(`Contract metadata regression test failed: ${err.message}`);
  }

  // Regression 11: Quality marker present
  try {
    const res = await makeRequest('GET', `/api/projects/${TEST_PROJECT}/tasks/${taskId}/handoff`);
    ok(res.body.includes('**Quality**:'), 'Quality marker present');
  } catch (err) {
    fail++;
    failures.push(`Quality marker regression test failed: ${err.message}`);
  }

  // Regression 12: Git policy is explicit and context-derived/defaulted
  try {
    const res = await makeRequest('GET', `/api/projects/${TEST_PROJECT}/tasks/${taskId}/handoff`);
    ok(res.body.includes('## Git & External Action Policy'), 'Git policy section present');
    ok(res.body.includes('- **Source**:'), 'Git policy source present');
  } catch (err) {
    fail++;
    failures.push(`Git policy regression test failed: ${err.message}`);
  }

  // Regression 13: Error handling for non-existent tasks
  try {
    const res = await makeRequest('GET', `/api/projects/${TEST_PROJECT}/tasks/T-999999/handoff`);
    ok(res.statusCode === 400, 'Non-existent task returns 400');
  } catch (err) {
    fail++;
    failures.push(`Error handling regression test failed: ${err.message}`);
  }

  section('Smoke Tests: API Endpoint Validation');

  // Smoke 5: Agent activation endpoint works
  try {
    const res = await makeRequest('PUT', '/api/status', {
      project: TEST_PROJECT,
      agentId: 'smoke-test-agent',
    });
    ok(res.statusCode === 200, 'Agent activation endpoint accessible');
    const json = JSON.parse(res.body);
    ok(json.ok === true, 'Agent activation returns ok: true');
  } catch (err) {
    fail++;
    failures.push(`Agent activation smoke test failed: ${err.message}`);
  }

  // Smoke 6: Claim endpoint works
  try {
    const res = await makeRequest('POST', `/api/projects/${TEST_PROJECT}/tasks/${taskId}/claim`, {
      agent: 'smoke-test-agent',
    });
    ok(res.statusCode === 200, 'Task claim endpoint accessible');
    const json = JSON.parse(res.body);
    ok(json.ok === true && json.task?.status === 'in-progress', 'Claim returns expected structure');
  } catch (err) {
    fail++;
    failures.push(`Claim endpoint smoke test failed: ${err.message}`);
  }

  // Smoke 7: Checkpoint endpoint works
  try {
    const res = await makeRequest('POST', `/api/projects/${TEST_PROJECT}/tasks/${taskId}/checkpoint`, {
      agent: 'smoke-test-agent',
      message: 'Smoke test checkpoint',
    });
    ok(res.statusCode === 200, 'Checkpoint endpoint accessible');
    const json = JSON.parse(res.body);
    ok(json.ok === true && json.checkpoint?.id, 'Checkpoint returns expected structure');
  } catch (err) {
    fail++;
    failures.push(`Checkpoint endpoint smoke test failed: ${err.message}`);
  }

  // Cleanup
  server.close();
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
