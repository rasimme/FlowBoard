'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const os = require('os');

let pass = 0, fail = 0, failures = [];

function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✅ ${msg}`); }
  else { fail++; failures.push(msg); console.log(`  ❌ ${msg}`); }
}

function section(title) { console.log(`\n## ${title}\n`); }

const PORT = 18793;
// Hermetic per-run workspace — shared test-workspace state leaks across
// tests via the m004 projects-dir import (T-291 finding).
const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-specify-next-'));
const PROJECTS_DIR = path.join(WORKDIR, 'projects');
fs.mkdirSync(PROJECTS_DIR, { recursive: true });
const HZL_DB_PATH = path.join(WORKDIR, 'flowboard.db');

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
      FLOWBOARD_PROJECTS_DIR: PROJECTS_DIR,
      NODE_ENV: 'test',
    },
    stdio: 'pipe',
  });

  // Wait for server to start
  await new Promise(r => setTimeout(r, 1000));

  try {
    // Session-create validates project existence against the canonical
    // registry (T-293) — a bare directory is not enough.
    const projRes = await makeRequest('POST', '/api/projects', { name: 'test-proj' });
    ok(projRes.statusCode === 201, `test project registered (got ${projRes.statusCode})`);

    section('POST /api/specify/sessions/:id/next Tests');

    // Create the session via HTTP — the spawned server owns the session store.
    const createRes = await makeRequest('POST', '/api/specify/sessions', {
      project: 'test-proj',
      origin: 'canvas',
      agentId: 'test-agent-1',
      sourceNoteIds: ['note-1'],
      sourceDescription: 'Test notes',
      transport: 'dashboard',
    });
    ok(createRes.statusCode === 201, `session created via API (got ${createRes.statusCode})`);
    const session = createRes.body.session;

    // NODE_ENV=test without adapter → gated fallback proposal
    const res = await makeRequest('POST', `/api/specify/sessions/${session.id}/next`);
    ok(res.statusCode === 200, `POST /next returns 200 (got ${res.statusCode})`);
    ok(res.body && res.body.session, 'Response includes session');
    ok(res.body.workerRequest, 'Response includes workerRequest');
    ok(res.body.action === 'proposal', `fallback proposal returned (got ${res.body.action})`);
    ok(res.body.session.status === 'proposal-ready', 'Status transitioned to proposal-ready');

    // Status guard: /next on a settled session must not run a worker step
    const guarded = await makeRequest('POST', `/api/specify/sessions/${session.id}/next`);
    ok(guarded.statusCode === 409, `POST /next on proposal-ready returns 409 (got ${guarded.statusCode})`);

    // Test 404 for non-existent session
    const res404 = await makeRequest('POST', `/api/specify/sessions/nonexistent/next`);
    ok(res404.statusCode === 404, `POST /next returns 404 for missing session`);

    if (fail === 0) {
      console.log(`\n✅ All ${pass} tests passed`);
    } else {
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

runTests().catch(e => {
  console.error('Test error:', e);
  process.exit(1);
});
