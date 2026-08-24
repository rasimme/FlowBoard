'use strict';

// T-447-5 API contract/integration coverage: normal reads, human-only switch,
// project isolation, compat observation, enforce rejection, and rollback.
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
const project = 'governance-api';
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

    const initial = await request('GET', `/api/projects/${project}/governance/mode`);
    assert.equal(initial.status, 200);
    assert.equal(initial.body.mode, 'compat');
    assert.equal(initial.body.canChange, false);
    assert.equal(initial.body.lastChange, null);

    const forged = await request('PUT', `/api/projects/${project}/governance/mode`, {
      mode: 'enforce', human: 'Ada', agentId: 'human', approved: true,
    });
    assert.equal(forged.status, 403, 'spoofed/ambiguous body claims cannot change mode');
    assert.equal(forged.body.code, 'mode_change_requires_verified_human');

    const enabled = await request('PUT', `/api/projects/${project}/governance/mode`, { mode: 'enforce' }, humanCookie);
    assert.equal(enabled.status, 200);
    assert.equal(enabled.body.lastChange.actor, 'telegram:42');
    assert.ok(enabled.body.lastChange.changedAt);

    const isolated = await request('POST', '/api/projects', { name: 'governance-other' });
    assert.equal(isolated.status, 201);
    assert.equal((await request('GET', '/api/projects/governance-other/governance/mode')).body.mode, 'compat');

    const before = await request('GET', `/api/projects/${project}/tasks`);
    const blocked = await request('POST', `/api/projects/${project}/tasks`, {
      title: 'Must go through Specify', sourceContext: { requestId: 't447-5' },
    });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, 'SPECIFY_REQUIRED');
    assert.equal(blocked.body.specifyRequest.title, 'Must go through Specify');
    assert.equal((await request('GET', `/api/projects/${project}/tasks`)).body.tasks.length, before.body.tasks.length);

    let ledger = JSON.parse(fs.readFileSync(path.join(ledgerDir, 'policy-ledger.jsonl'), 'utf8').trim());
    assert.equal(ledger.governanceMode, 'enforce');
    assert.equal(ledger.decision, 'would_block');

    const rollback = await request('PUT', `/api/projects/${project}/governance/mode`, { mode: 'compat' }, humanCookie);
    assert.equal(rollback.status, 200);
    assert.equal((await request('GET', `/api/projects/${project}/governance/mode`)).body.mode, 'compat');

    const allowed = await request('POST', `/api/projects/${project}/tasks`, { title: 'Compatibility observation' });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.task.creationAudit.policyDecision, 'would_block');
    ledger = fs.readFileSync(path.join(ledgerDir, 'policy-ledger.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(ledger.at(-1).governanceMode, 'compat');
    assert.equal(ledger.at(-1).decision, 'would_block');

    console.log('T-447-5 governance API tests: all passed');
  } finally {
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
