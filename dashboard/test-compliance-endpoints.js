'use strict';

/**
 * Integration test for compliance endpoints (T-263-4).
 * Verifies that GET /api/compliance, GET /api/tasks/stuck return routed-unclaimed detection.
 *
 * Run: node test-compliance-endpoints.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const hzlService = require('./hzl-service.js');
const express = require('express');

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

const TEST_PROJECT = `test-compliance-endpoints-${Date.now()}`;
const HZL_DB_PATH = path.join(__dirname, 'test-workspace-compliance-endpoints', '.hzl', 'flowboard-test-compliance-endpoints.db');
const PORT = 18792;

async function setup() {
  try {
    if (fs.existsSync(HZL_DB_PATH)) fs.unlinkSync(HZL_DB_PATH);
  } catch { /* ignored */ }

  await hzlService.init(HZL_DB_PATH);
  try {
    hzlService.createProject(TEST_PROJECT, 'Testing compliance endpoints');
  } catch (err) {
    // Project might already exist, that's OK
  }

  const task1 = hzlService.createTask(TEST_PROJECT, {
    title: 'Routed task',
    status: 'open',
  });
  hzlService.routeTask(TEST_PROJECT, task1.id, 'test-agent-1');

  const task2 = hzlService.createTask(TEST_PROJECT, {
    title: 'Claimed task',
    status: 'open',
  });
  hzlService.routeTask(TEST_PROJECT, task2.id, 'test-agent-2');
  hzlService.claimTask(TEST_PROJECT, task2.id, { agent: 'test-agent-2' });

  return { task1, task2 };
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
          json: () => {
            try { return JSON.parse(data); } catch { return null; }
          },
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
  const app = express();

  // Mount compliance endpoints from hzl-service
  app.get('/api/tasks/stuck', (req, res) => {
    try {
      const staleThreshold = req.query.staleThreshold !== undefined ? Math.max(0, parseInt(req.query.staleThreshold) || 0) : 10;
      const stuck = hzlService.getStuckTasks({ staleThreshold });
      res.json({ ok: true, stuck });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/projects/:name/tasks/:id/checkpoint-health', (req, res) => {
    try {
      const health = hzlService.getCheckpointHealth(req.params.name, req.params.id);
      if (health.error) return res.status(404).json({ error: health.error });
      res.json({ ok: true, health });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/compliance', (req, res) => {
    try {
      const project = req.query.project || null;
      const agent = req.query.agent || null;
      const includeDetails = req.query.includeDetails === 'true';
      const compliance = hzlService.getComplianceStatus({
        project,
        agent,
        includeDetails,
      });
      res.json({ ok: true, compliance });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return new Promise((resolve) => {
    const server = app.listen(PORT, '127.0.0.1', () => {
      resolve(server);
    });
  });
}

async function runTests() {
  section('Compliance Endpoints Integration Tests');

  const { task1, task2 } = await setup();
  const server = await startServer();

  // Give server a moment to start
  await new Promise(resolve => setTimeout(resolve, 100));

  // Test 1: GET /api/tasks/stuck includes routed-unclaimed
  try {
    const res = await makeRequest('GET', '/api/tasks/stuck');
    ok(
      res.statusCode === 200,
      `GET /api/tasks/stuck returns 200 (got ${res.statusCode})`
    );

    const body = res.json();
    const routedUnclaimed = body.stuck?.routedUnclaimed || [];
    const found = routedUnclaimed.find(t => t.taskId === task1.id);

    ok(
      found && found.reason === 'routed-unclaimed',
      'GET /api/tasks/stuck includes routed-unclaimed tasks'
    );
  } catch (err) {
    fail++;
    failures.push(`stuck endpoint test failed: ${err.message}`);
    console.log(`  ❌ stuck endpoint test failed: ${err.message}`);
  }

  // Test 2: GET /api/compliance detects routed-unclaimed
  try {
    const res = await makeRequest('GET', `/api/compliance?project=${TEST_PROJECT}&includeDetails=true`);
    ok(
      res.statusCode === 200,
      `GET /api/compliance returns 200 (got ${res.statusCode})`
    );

    const body = res.json();
    ok(
      body.compliance.summary.routedUnclaimedCount > 0,
      'Compliance endpoint counts routed-unclaimed tasks'
    );
  } catch (err) {
    fail++;
    failures.push(`compliance endpoint test failed: ${err.message}`);
    console.log(`  ❌ compliance endpoint test failed: ${err.message}`);
  }

  // Test 3: GET /api/compliance/checkpoint-health for specific task
  try {
    const res = await makeRequest('GET', `/api/projects/${TEST_PROJECT}/tasks/${task1.id}/checkpoint-health`);
    ok(
      res.statusCode === 200,
      `GET checkpoint-health returns 200 (got ${res.statusCode})`
    );

    const body = res.json();
    ok(
      body.health.issues.some(i => i.includes('routed-unclaimed')),
      'Checkpoint health endpoint detects routed-unclaimed'
    );
  } catch (err) {
    fail++;
    failures.push(`checkpoint-health endpoint test failed: ${err.message}`);
    console.log(`  ❌ checkpoint-health endpoint test failed: ${err.message}`);
  }

  // Test 4: Claimed task not in routed-unclaimed
  try {
    const res = await makeRequest('GET', '/api/tasks/stuck');
    const body = res.json();
    const routedUnclaimed = body.stuck?.routedUnclaimed || [];
    const found = routedUnclaimed.find(t => t.taskId === task2.id);

    ok(
      !found,
      'Claimed task not in routed-unclaimed'
    );
  } catch (err) {
    fail++;
    failures.push(`claimed task filter test failed: ${err.message}`);
    console.log(`  ❌ claimed task filter test failed: ${err.message}`);
  }

  // Test 5: Compliance filters by agent
  try {
    const res = await makeRequest('GET', `/api/compliance?agent=test-agent-1&includeDetails=true`);
    const body = res.json();
    const found = body.compliance.details.find(d => d.taskId === task1.id);

    ok(
      found && found.issues.includes('routed-unclaimed'),
      'Compliance endpoint filters by routed agent'
    );
  } catch (err) {
    fail++;
    failures.push(`agent filter test failed: ${err.message}`);
    console.log(`  ❌ agent filter test failed: ${err.message}`);
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
