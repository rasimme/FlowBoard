'use strict';

/**
 * Integration test for handoff endpoint (T-263).
 * Verifies that GET /api/projects/:name/tasks/:id/handoff returns
 * markdown with correct content-type and backward compatibility.
 *
 * Run: node test-handoff-endpoint.js
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

const TEST_PROJECT = 'test-endpoint-handoff';
const HZL_DB_PATH = path.join(__dirname, 'test-workspace-endpoint', '.hzl', 'flowboard-test-endpoint.db');
const TEST_ROOT = path.join(__dirname, 'test-workspace-endpoint');
const PORT = 18791;

async function setup() {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });

  await hzlService.init(HZL_DB_PATH);

  hzlService.createProject(TEST_PROJECT, 'Testing handoff endpoint');
  const task = hzlService.createTask(TEST_PROJECT, {
    title: 'Test Task',
    description: 'Testing',
    priority: 'high',
    status: 'in-progress',
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

  return new Promise((resolve) => {
    const server = app.listen(PORT, '127.0.0.1', () => {
      resolve(server);
    });
  });
}

async function runTests() {
  section('Test Handoff Endpoint');

  const task = await setup();
  const taskId = task.id;
  const server = await startServer();

  // Give server a moment to start
  await new Promise(resolve => setTimeout(resolve, 100));

  // Test 1: Markdown format returns correct content-type
  try {
    const res = await makeRequest('GET', `/api/projects/${TEST_PROJECT}/tasks/${taskId}/handoff`);
    ok(
      res.statusCode === 200,
      `Markdown request returns 200 (got ${res.statusCode})`
    );
    ok(
      res.headers['content-type'] && res.headers['content-type'].includes('text/markdown'),
      `Markdown request returns text/markdown content-type`
    );
  } catch (err) {
    fail++;
    failures.push(`Markdown request failed: ${err.message}`);
    console.log(`  ❌ Markdown request failed: ${err.message}`);
  }

  // Test 2: Markdown response includes contract marker
  try {
    const res = await makeRequest('GET', `/api/projects/${TEST_PROJECT}/tasks/${taskId}/handoff?agentId=test-target-agent`);
    ok(
      res.body.includes('flowboard-handoff-contract: v1'),
      'Markdown response includes contract marker'
    );
    ok(
      res.body.includes('"agentId": "test-target-agent"') && res.body.includes('"agent": "test-target-agent"'),
      'Markdown response embeds concrete target agent startup contract'
    );
  } catch (err) {
    fail++;
    failures.push(`Marker check failed: ${err.message}`);
  }

  // Test 3: JSON format backward compatibility
  try {
    const res = await makeRequest('GET', `/api/projects/${TEST_PROJECT}/tasks/${taskId}/handoff?format=json`);
    ok(
      res.statusCode === 200,
      `JSON request returns 200 (got ${res.statusCode})`
    );
    ok(
      res.headers['content-type'] && res.headers['content-type'].includes('application/json'),
      `JSON request returns application/json content-type`
    );
    const json = JSON.parse(res.body);
    ok(json.ok === true, 'JSON response has ok: true');
    ok('taskId' in json, 'JSON response includes taskId');
  } catch (err) {
    fail++;
    failures.push(`JSON backward compatibility failed: ${err.message}`);
    console.log(`  ❌ JSON backward compatibility failed: ${err.message}`);
  }

  // Test 4: 400 for non-existent task
  try {
    const res = await makeRequest('GET', `/api/projects/${TEST_PROJECT}/tasks/T-999999/handoff`);
    ok(
      res.statusCode === 400,
      `Non-existent task returns 400 (got ${res.statusCode})`
    );
  } catch (err) {
    fail++;
    failures.push(`404 test failed: ${err.message}`);
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
