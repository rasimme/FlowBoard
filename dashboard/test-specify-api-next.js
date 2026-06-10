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

const PORT = 18793;
const HZL_DB_PATH = path.join(__dirname, 'test-workspace', '.hzl', 'flowboard-t262-next.db');

// Clean up DB
if (fs.existsSync(HZL_DB_PATH)) {
  try { fs.unlinkSync(HZL_DB_PATH); } catch {}
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
  // Start server
  const server = spawn('node', ['server.js'], {
    cwd: __dirname,
    env: {
      ...process.env,
      HZL_DB_PATH,
      FLOWBOARD_PORT: PORT,
      // Isolate from host/CI env (see m004 migration)
      FLOWBOARD_PROJECTS_DIR: path.join(__dirname, 'test-workspace', 'projects'),
      NODE_ENV: 'test',
    },
    stdio: 'pipe',
  });

  // Wait for server to start
  await new Promise(r => setTimeout(r, 1000));

  try {
    section('POST /api/specify/sessions/:id/next Tests');

    // Create a session first
    const session = specifySession.createSession({
      project: 'test-proj',
      origin: 'canvas',
      agentId: 'test-agent-1',
      sourceNoteIds: ['note-1'],
      sourceDescription: 'Test notes',
      transport: 'dashboard',
    });

    // Transition to analyzing
    specifySession.updateSession(session.id, { status: 'analyzing' });

    // Call /next endpoint
    const res = await makeRequest('POST', `/api/specify/sessions/${session.id}/next`);
    ok(res.statusCode === 200, `POST /next returns 200 (got ${res.statusCode})`);
    ok(res.body && res.body.session, 'Response includes session');
    ok(res.body.workerRequest, 'Response includes workerRequest');
    ok(res.body.session.status === 'clarifying', 'Status transitioned to clarifying');
    ok(res.body.workerRequest.action === 'ask' || res.body.workerRequest.action === 'propose', 'workerRequest has action');

    // Test 404 for non-existent session
    const res404 = await makeRequest('POST', `/api/specify/sessions/nonexistent/next`);
    ok(res404.statusCode === 404, `POST /next returns 404 for missing session`);

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
