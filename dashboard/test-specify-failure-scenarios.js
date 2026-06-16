'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const specifySession = require('./specify-sessions');

let pass = 0, fail = 0, failures = [];

function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✅ ${msg}`); }
  else { fail++; failures.push(msg); console.log(`  ❌ ${msg}`); }
}

function section(title) { console.log(`\n## ${title}\n`); }

const PORT = 18799;
const HZL_DB_PATH = path.join(__dirname, 'test-workspace', '.hzl', 'flowboard-failure.db');
const TEST_PROJECT = 'failure-test-proj';
const WORKSPACE = path.join(__dirname, 'test-workspace');

fs.rmSync(path.join(WORKSPACE, 'projects', TEST_PROJECT), { recursive: true, force: true });
fs.mkdirSync(path.join(WORKSPACE, 'projects'), { recursive: true });
try { fs.unlinkSync(HZL_DB_PATH); } catch {}

function makeRequest(method, requestPath, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: PORT,
      path: requestPath,
      method,
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, body: data ? JSON.parse(data) : null });
        } catch {
          resolve({ statusCode: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function waitForServer(child) {
  const deadline = Date.now() + 5000;
  let stderr = '';
  child.stderr.on('data', d => { stderr += d.toString(); });
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${stderr}`);
    try {
      const res = await makeRequest('GET', '/api/health');
      if (res.statusCode === 200) return;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`server did not become ready: ${stderr}`);
}

async function createSession(agentId) {
  const res = await makeRequest('POST', '/api/specify/sessions', {
    project: TEST_PROJECT,
    origin: 'canvas',
    agentId,
    sourceDescription: 'Failure test input',
  });
  ok(res.statusCode === 201, `Session created for ${agentId}`);
  return res.body.session.id;
}

async function runTests() {
  const server = spawn('node', ['server.js'], {
    cwd: __dirname,
    env: {
      ...process.env,
      HZL_DB_PATH,
      FLOWBOARD_PORT: PORT,
      OPENCLAW_WORKSPACE: WORKSPACE,
      // Isolate from host/CI env — a global FLOWBOARD_PROJECTS_DIR would
      // leak into the spawned server and confuse the m004 migration.
      FLOWBOARD_PROJECTS_DIR: path.join(WORKSPACE, 'projects'),
      NODE_ENV: 'test',
    },
    stdio: 'pipe',
  });

  try {
    await waitForServer(server);
  // Register the project canonically — session-create validates project
  // existence against the registry (T-293); a bare directory is not enough.
  fs.rmSync(path.join(WORKSPACE, 'projects', TEST_PROJECT), { recursive: true, force: true });
  await makeRequest('POST', '/api/projects', { name: TEST_PROJECT });
    section('Worker Error Handling Tests');

    const sessionId = await createSession('fail-agent-1');
    const errRes = await makeRequest('POST', `/api/specify/sessions/${sessionId}/answer`, {
      action: 'error',
      error: 'Worker encountered unexpected input format',
    });

    ok(errRes.statusCode === 200, 'Error response recorded');
    ok(errRes.body.session.status === 'error', 'Session marked error state');
    ok(errRes.body.session.failureState?.action === 'worker-error', 'Failure action recorded');

    section('Rejection Tests');

    const session2 = await createSession('fail-agent-2');
    await makeRequest('POST', `/api/specify/sessions/${session2}/answer`, {
      action: 'proposal',
      specContent: '# Rejected',
      taskBreakdown: [{ title: 'Rejected task' }],
    });
    const rejectRes = await makeRequest('POST', `/api/specify/sessions/${session2}/confirm`, {
      approved: false,
    });

    ok(rejectRes.statusCode === 200, 'Rejection returns 200');
    ok(rejectRes.body.session.status === 'aborted', 'Rejected proposal aborts session');
    ok(rejectRes.body.session.draftProposal, 'Draft proposal remains inspectable');

    section('State Machine Validation Tests');

    const sess3 = specifySession.createSession({ project: TEST_PROJECT, agentId: 'fail-agent-3' });
    try {
      specifySession.updateSession(sess3.id, { status: 'done' });
      ok(false, 'Invalid transition should throw');
    } catch (e) {
      ok(e.message.includes('Invalid state transition'), 'Invalid transition rejected');
    }

    specifySession.createSession({ project: TEST_PROJECT, agentId: 'fail-agent-4' });
    try {
      specifySession.createSession({ project: TEST_PROJECT, agentId: 'fail-agent-4' });
      ok(false, 'Duplicate agent session should throw');
    } catch (e) {
      ok(e.message.includes('already has an active'), 'Duplicate agent rejected');
    }

    if (fail === 0) console.log(`\n✅ All ${pass} tests passed`);
    else {
      console.log(`\n❌ ${fail} failed, ${pass} passed`);
      failures.forEach(f => console.log(`  - ${f}`));
    }
  } catch (e) {
    fail++;
    console.error('Test error:', e.message);
  } finally {
    server.kill();
    process.exit(fail > 0 ? 1 : 0);
  }
}

runTests();
