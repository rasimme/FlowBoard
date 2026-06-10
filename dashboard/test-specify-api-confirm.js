'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

let pass = 0, fail = 0, failures = [];

function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✅ ${msg}`); }
  else { fail++; failures.push(msg); console.log(`  ❌ ${msg}`); }
}

function section(title) { console.log(`\n## ${title}\n`); }

const PORT = 18795;
const HZL_DB_PATH = path.join(__dirname, 'test-workspace', '.hzl', 'flowboard-t262-confirm.db');
const TEST_PROJECT = 'test-confirm-proj';
const WORKSPACE = path.join(__dirname, 'test-workspace');

fs.rmSync(path.join(WORKSPACE, 'projects', TEST_PROJECT), { recursive: true, force: true });
fs.mkdirSync(path.join(WORKSPACE, 'projects', TEST_PROJECT), { recursive: true });
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

async function createProposalSession(agentId, proposal = {}) {
  const createRes = await makeRequest('POST', '/api/specify/sessions', {
    project: TEST_PROJECT,
    origin: 'canvas',
    agentId,
    sourceNoteIds: ['note-1'],
    sourceDescription: 'Test notes',
  });
  ok(createRes.statusCode === 201, `Session created for ${agentId}`);
  const sessionId = createRes.body.session.id;
  const proposalRes = await makeRequest('POST', `/api/specify/sessions/${sessionId}/answer`, {
    action: 'proposal',
    specContent: proposal.specContent || '# Test Spec\n\nFunctionality',
    taskBreakdown: proposal.taskBreakdown || [{ title: 'Task 1', description: 'First task' }],
  });
  ok(proposalRes.statusCode === 200, `Proposal recorded for ${agentId}`);
  return sessionId;
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
    section('POST /api/specify/sessions/:id/confirm Tests');

    const sessionId = await createProposalSession('test-agent-3');
    const confirmRes = await makeRequest('POST', `/api/specify/sessions/${sessionId}/confirm`, { approved: true });

    ok(confirmRes.statusCode === 200, `POST /confirm returns 200 (got ${confirmRes.statusCode})`);
    ok(confirmRes.body?.session?.status === 'done', 'Status transitioned to done');
    ok(confirmRes.body.createdArtifacts.specFiles.length === 1, 'Spec file artifact recorded');
    ok(confirmRes.body.createdArtifacts.taskIds.length === 1, 'Task artifact recorded');

    const res404 = await makeRequest('POST', '/api/specify/sessions/nonexistent/confirm', { approved: true });
    ok(res404.statusCode === 404, 'POST /confirm returns 404 for missing session');

    const session2 = await createProposalSession('test-agent-4', {
      specContent: '# Rejected',
      taskBreakdown: [{ title: 'Rejected task' }],
    });
    const rejectRes = await makeRequest('POST', `/api/specify/sessions/${session2}/confirm`, { approved: false });
    ok(rejectRes.statusCode === 200, 'POST /confirm with approved=false returns 200');
    ok(rejectRes.body.session.status === 'aborted', 'Rejection aborts session');

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
