'use strict';

// T-447-5 API contract/integration coverage: task-discipline reads, attribution,
// and project isolation.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const jwt = require('jsonwebtoken');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const port = 18805;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-t447-5-api-'));
const workspace = path.join(root, 'workspace');
const projects = path.join(root, 'projects');
const db = path.join(root, 'flowboard.db');
const ledgerDir = path.join(root, 'audit');
const project = 'discipline-contract';
const jwtSecret = 't447-5-test-jwt-secret-long-enough';
const humanCookie = `flowboard_session=${jwt.sign({ id: 42, username: 'reviewer', agentId: 'main' }, jwtSecret, { algorithm: 'HS256' })}`;

function request(method, pathname, body = null, cookie = null) {
  return new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/json' };
    if (cookie) headers.cookie = cookie;
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method, headers }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        let parsed = text;
        try { parsed = text ? JSON.parse(text) : null; } catch {}
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.end(body === null ? undefined : JSON.stringify(body));
  });
}

async function waitReady(child) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode})`);
    try { if ((await request('GET', '/api/health')).status === 200) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('server readiness timeout');
}

async function main() {
  fs.mkdirSync(path.join(workspace, 'projects'), { recursive: true });
  fs.mkdirSync(projects, { recursive: true });
  const child = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    stdio: 'ignore',
    env: {
      ...process.env, NODE_ENV: 'test', FLOWBOARD_PORT: String(port),
      OPENCLAW_WORKSPACE: workspace, FLOWBOARD_PROJECTS_DIR: projects,
      HZL_DB_PATH: db, FLOWBOARD_POLICY_LEDGER_DIR: ledgerDir,
      JWT_SECRET: jwtSecret, ALLOWED_USER_IDS: '42', AUTH_ALWAYS: 'false',
      TELEGRAM_BOT_TOKEN: '123456:t447-5-test-bot', FLOWBOARD_TELEGRAM_AGENT_IDS: 'main',
    },
  });
  try {
    await waitReady(child);
    assert.equal((await request('POST', '/api/projects', { name: project })).status, 201);

    const initial = await request('GET', `/api/projects/${project}/task-discipline`);
    assert.equal(initial.status, 200);
    assert.equal(initial.body.discipline, 'list');
    assert.equal(initial.body.default, 'list');
    assert.deepEqual(initial.body.values, ['list', 'standard', 'development']);
    assert.equal(initial.body.canChange, true);
    assert.equal(initial.body.lastChange, null);
    assert.equal((await request('GET', `/api/projects/${project}/governance/mode`)).status, 404);

    const local = await request('PUT', `/api/projects/${project}/task-discipline`, {
      discipline: 'development', human: 'Ada', agentId: 'human', approved: true,
    });
    assert.equal(local.status, 200, 'loopback PUT remains available without auth');
    assert.equal(local.body.discipline, 'development');
    assert.equal(local.body.lastChange.actor, 'local:operator');
    assert.notEqual(local.body.lastChange.actor, 'Ada', 'body identity is descriptive only');

    const authenticated = await request('PUT', `/api/projects/${project}/task-discipline`, { discipline: 'standard' }, humanCookie);
    assert.equal(authenticated.status, 200);
    assert.equal(authenticated.body.lastChange.actor, 'session:42');
    assert.ok(authenticated.body.lastChange.changedAt);

    const isolated = await request('POST', '/api/projects', { name: 'governance-other' });
    assert.equal(isolated.status, 201);
    const isolatedDiscipline = await request('GET', '/api/projects/governance-other/task-discipline');
    assert.equal(isolatedDiscipline.status, 200);
    assert.equal(isolatedDiscipline.body.discipline, 'list');

    console.log('T-447-5 governance API tests: all passed');
  } finally {
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
