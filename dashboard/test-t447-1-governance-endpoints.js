'use strict';

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const port = 18797;
const workspace = path.join(__dirname, 'test-workspace');
const db = path.join(workspace, '.hzl', 'flowboard-t447-endpoints.db');
const project = 'test-t447-endpoints';
const botToken = '123456:t447-test-bot';
fs.rmSync(path.join(workspace, 'projects', project), { recursive: true, force: true });
for (const file of [db, `${db}-wal`, `${db}-shm`, db.replace(/\.db$/, '-cache.db'),
  db.replace(/\.db$/, '-cache.db-wal'), db.replace(/\.db$/, '-cache.db-shm')]) {
  try { fs.unlinkSync(file); } catch {}
}
fs.mkdirSync(path.join(workspace, 'projects'), { recursive: true });

function request(method, pathName, body, cookie = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/json', ...extraHeaders };
    if (cookie) headers.cookie = cookie;
    const req = http.request({ hostname: '127.0.0.1', port, path: pathName, method,
      headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let body = null;
        try { body = data ? JSON.parse(data) : null; } catch { body = data; }
        resolve({ status: res.statusCode, body, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (body) req.end(JSON.stringify(body)); else req.end();
  });
}

function buildTelegramInitData() {
  const params = new URLSearchParams({
    user: JSON.stringify({ id: 42, username: 'dashboard-human' }),
    auth_date: String(Math.floor(Date.now() / 1000)),
  });
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  params.set('hash', crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex'));
  return params.toString();
}

function sessionCookie(response) {
  const setCookie = response.headers['set-cookie'];
  const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return first ? String(first).split(';', 1)[0] : null;
}

async function waitReady(child) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('server exited before readiness');
    try { if ((await request('GET', '/api/health')).status === 200) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('server readiness timeout');
}

async function main() {
  const child = spawn('node', ['server.js'], { cwd: __dirname, stdio: 'ignore', env: {
    ...process.env, NODE_ENV: 'test', FLOWBOARD_PORT: String(port), HZL_DB_PATH: db,
    OPENCLAW_WORKSPACE: workspace, FLOWBOARD_PROJECTS_DIR: path.join(workspace, 'projects'),
    TELEGRAM_BOT_TOKEN: botToken, FLOWBOARD_TELEGRAM_AGENT_IDS: 'main',
    JWT_SECRET: 't447-test-jwt-secret-long-enough-for-hs256', ALLOWED_USER_IDS: '42',
    AUTH_ALWAYS: 'false',
  } });
  try {
    await waitReady(child);
    const dashboard = await request('GET', '/');
    assert.ok(!dashboard.headers['set-cookie'], 'GET / never mints a human capability');

    // A Dashboard human first obtains a server-issued session through the
    // authenticated Telegram exchange. The test deliberately does not sign a
    // JWT in the client, so this remains a real server-side auth context.
    const auth = await request('POST', '/api/auth', null, null, {
      'X-Telegram-Init-Data': buildTelegramInitData(),
    });
    assert.equal(auth.status, 200);
    const humanCookie = sessionCookie(auth);
    assert.ok(humanCookie, 'server-issued Dashboard session cookie is available');
    assert.equal((await request('POST', '/api/projects', { name: project }, humanCookie)).status, 201);
    const initial = await request('GET', `/api/projects/${project}/governance/mode`, null, humanCookie);
    assert.equal(initial.body.mode, 'compat');

    // A plain Node loopback client may reach the local API, but GET / must not
    // give it a human capability. Dashboard-shaped fields and the UI marker
    // header are descriptive only and cannot mint or confirm as human.
    const nodeSession = await request('POST', '/api/specify/sessions', {
      project, agentId: 'human', transport: 'dashboard', origin: 'canvas',
    }, null, { 'X-FlowBoard-Client': 'dashboard' });
    assert.equal(nodeSession.status, 201);
    assert.equal(nodeSession.body.session.agentId, 'dashboard-unverified');
    assert.equal(nodeSession.body.session.transport, 'api');
    const nodeProposal = await request('POST',
      `/api/specify/sessions/${nodeSession.body.session.id}/answer`, {
        action: 'proposal', specContent: '# Node proposal',
        taskBreakdown: [{ title: 'Node task' }],
      }, null, { 'X-FlowBoard-Client': 'dashboard' });
    assert.equal(nodeProposal.status, 200);
    const nodeConfirm = await request('POST',
      `/api/specify/sessions/${nodeSession.body.session.id}/confirm`, {
        approved: true, human: 'forged-agent', agentId: 'human', origin: 'dashboard',
      }, null, { 'X-FlowBoard-Client': 'dashboard' });
    assert.equal(nodeConfirm.status, 200);

    const mode = await request('PUT', `/api/projects/${project}/governance/mode`,
      { mode: 'enforce', human: 'forged-agent' });
    assert.equal(mode.status, 200);
    const verifiedMode = await request('PUT', `/api/projects/${project}/governance/mode`,
      { mode: 'enforce', human: 'forged-agent' }, humanCookie);
    assert.equal(verifiedMode.status, 200);
    assert.equal(verifiedMode.body.lastChange.actor, 'session:42');
    assert.ok(verifiedMode.body.lastChange.changedAt);
    const rollback = await request('PUT', `/api/projects/${project}/governance/mode`,
      { mode: 'compat' }, humanCookie);
    assert.equal(rollback.status, 200);

    // A session already prepared by the authenticated Dashboard still cannot
    // be confirmed by a plain loopback Node client: no cookie means no
    // server-verified human principal. The same session succeeds when the
    // authenticated Dashboard credential is present.
    const dashboardSession = await request('POST', '/api/specify/sessions', {
      project, agentId: 'human', transport: 'dashboard', origin: 'canvas',
    }, humanCookie);
    assert.equal(dashboardSession.status, 201);
    const proposal = await request('POST',
      `/api/specify/sessions/${dashboardSession.body.session.id}/answer`, {
        action: 'proposal', specContent: '# T-447 Dashboard proposal',
        taskBreakdown: [{ title: 'T-447 Dashboard task' }],
      }, humanCookie);
    assert.equal(proposal.status, 200);
    const legitimateConfirm = await request('POST',
      `/api/specify/sessions/${dashboardSession.body.session.id}/confirm`,
      { approved: true }, humanCookie);
    assert.equal(legitimateConfirm.status, 200);

    const spoofedSession = await request('POST', '/api/specify/sessions', {
      project, agentId: 'agent-spoof', transport: 'dashboard', origin: 'canvas',
      human: 'forged-agent', approved: true,
    }, humanCookie);
    assert.equal(spoofedSession.status, 201);
    assert.equal(spoofedSession.body.session.agentId, 'agent-spoof');
    assert.equal(spoofedSession.body.session.transport, 'api');
    assert.equal(spoofedSession.body.session.principalBinding.kind, 'agent');

    console.log('T-447-1 governance endpoint tests: all passed');
  } finally {
    child.kill();
  }
}

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
