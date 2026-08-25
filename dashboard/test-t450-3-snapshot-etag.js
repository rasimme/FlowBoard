'use strict';

// T-450-3: the snapshot ETag is a digest of the read model, 304 responses are
// bodyless, changed content gets a new 200, and 304s consume the read budget.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const { spawn } = require('node:child_process');

const root = __dirname;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-t450-3-'));
const workspace = path.join(tmp, 'workspace');
const projects = path.join(tmp, 'projects');
const db = path.join(tmp, 'flowboard.db');
fs.mkdirSync(path.join(workspace, 'projects'), { recursive: true });
fs.mkdirSync(projects, { recursive: true });
const port = 18890 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${port}`;
const secret = 't450-3-test-secret-must-be-at-least-32-characters';
const cookie = `flowboard_session=${jwt.sign({ id: 42, username: 't450-3' }, secret)}`;
const changedCookie = `flowboard_session=${jwt.sign({ id: 43, username: 't450-3-changed' }, secret)}`;
const proxy = { 'cf-ray': 't450-3-ray', 'cf-connecting-ip': '203.0.113.9', Cookie: cookie };

function request(headers = proxy, url = '/api/dashboard/snapshot/v1') {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${url}`, { headers }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitReady(child) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${child.exitCode}`);
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('server readiness timeout');
}

async function main() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      FLOWBOARD_PORT: String(port),
      OPENCLAW_WORKSPACE: workspace,
      FLOWBOARD_PROJECTS_DIR: projects,
      HZL_DB_PATH: db,
      SPECIFY_WORKER_DISABLED: 'true',
      TELEGRAM_BOT_TOKEN: '123456:t450-3-dummy',
      JWT_SECRET: secret,
      ALLOWED_USER_IDS: '42,43',
      FLOWBOARD_TELEGRAM_AGENT_IDS: 'main',
      FLOWBOARD_TRUSTED_PROXY_IPS: '127.0.0.1,::1',
      FLOWBOARD_RATE_LIMIT_READ: '1',
      FLOWBOARD_RATE_LIMIT_BURST: '1',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  try {
    await waitReady(child);

    const first = await request();
    assert.equal(first.status, 200, 'initial snapshot is 200');
    assert.match(first.headers.etag, /^"[a-f0-9]{64}"$/, 'ETag is a quoted SHA-256 digest');
    assert.ok(first.body.length > 0, '200 response has a body');

    const notModified = await request({ ...proxy, 'If-None-Match': first.headers.etag });
    assert.equal(notModified.status, 304, 'matching If-None-Match returns 304');
    assert.equal(notModified.body.length, 0, '304 response has no body');
    assert.equal(notModified.headers.etag, first.headers.etag, '304 repeats the digest ETag');

    const budgetExhausted = await request({ ...proxy, 'If-None-Match': first.headers.etag });
    assert.equal(budgetExhausted.status, 429, '304 consumes the read-lane budget');

    // A different verified principal avoids the deliberately tiny test budget
    // and changes the status section without mutating project data.
    const changed = await request({
      ...proxy,
      Cookie: changedCookie,
    }, '/api/dashboard/snapshot/v1?agentId=main');
    assert.equal(changed.status, 200, 'changed snapshot returns 200');
    assert.notEqual(changed.headers.etag, first.headers.etag, 'changed snapshot gets a new ETag');
    assert.notDeepEqual(changed.body, first.body, 'changed snapshot has changed content');
    console.log('T-450-3 snapshot ETag contract tests passed');
  } finally {
    child.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
