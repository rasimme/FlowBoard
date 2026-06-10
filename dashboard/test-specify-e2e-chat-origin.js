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

const PORT = 18798;
const HZL_DB_PATH = path.join(__dirname, 'test-workspace', '.hzl', 'flowboard-e2e-chat.db');
const TEST_PROJECT = 'e2e-chat-proj';
const WORKSPACE = path.join(__dirname, 'test-workspace');

if (fs.existsSync(HZL_DB_PATH)) {
  try { fs.unlinkSync(HZL_DB_PATH); } catch {}
}
fs.mkdirSync(path.join(WORKSPACE, 'projects'), { recursive: true });

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

function makeRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port: PORT,
      path,
      method,
      headers: { 'Content-Type': 'application/json' },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({
            statusCode: res.statusCode,
            body: data ? JSON.parse(data) : null,
          });
        } catch (e) {
          resolve({
            statusCode: res.statusCode,
            body: data,
          });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
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

  await waitForServer(server);

  try {
    section('E2E: Chat-Origin Flow');

    // Create session (chat origin, no canvas notes)
    const createRes = await makeRequest('POST', '/api/specify/sessions', {
      project: TEST_PROJECT,
      origin: 'chat',
      agentId: 'e2e-chat-agent',
      sourceNoteIds: [],
      sourceDescription: 'User description from chat',
      transport: 'chat-api',
    });

    ok(createRes.statusCode === 201, 'Chat-origin session created');
    ok(createRes.body.session.origin === 'chat', 'Origin is chat');
    ok(createRes.body.session.sourceNoteIds.length === 0, 'No source notes for chat-origin');

    const sessionId = createRes.body.session.id;

    // Full flow: next → answer → proposal → confirm
    const nextRes = await makeRequest('POST', `/api/specify/sessions/${sessionId}/next`);
    ok(nextRes.statusCode === 200, 'POST /next succeeds for chat-origin');

    const ansRes = await makeRequest('POST', `/api/specify/sessions/${sessionId}/answer`, {
      action: 'proposal',
      specContent: '# Feature from Chat\n\nUser requested via chat...',
      taskBreakdown: [
        { title: 'Implement feature', description: 'From chat request' },
      ],
    });

    ok(ansRes.statusCode === 200, 'Proposal recorded');

    const confirmRes = await makeRequest('POST', `/api/specify/sessions/${sessionId}/confirm`, {
      approved: true,
    });

    ok(confirmRes.statusCode === 200, 'Confirmation successful');
    ok(confirmRes.body.session.status === 'done', 'Chat-origin session completed');

    if (fail === 0) {
      console.log(`\n✅ All ${pass} tests passed`);
    } else {
      console.log(`\n❌ ${fail} failed, ${pass} passed`);
      failures.forEach(f => console.log(`  - ${f}`));
    }
  } finally {
    server.kill();
    process.exit(fail > 0 ? 1 : 0);
  }
}

runTests().catch(e => {
  console.error('Test error:', e);
  process.exit(1);
});
