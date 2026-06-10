'use strict';

const assert = require('assert');
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = __dirname;
const DASHBOARD_PORT = 18791;
const TOKEN = 'test-hooks-token';
const PROJECT = 'canvas-promote-test';

let pass = 0;
let fail = 0;
const failures = [];

function ok(condition, message) {
  if (condition) {
    pass++;
    console.log(`  ok - ${message}`);
  } else {
    fail++;
    failures.push(message);
    console.log(`  not ok - ${message}`);
  }
}

async function fetchJson(base, method, urlPath, body) {
  const res = await fetch(base + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
}

async function waitForServer(base, child) {
  const started = Date.now();
  while (Date.now() - started < 10000) {
    if (child.exitCode !== null) throw new Error(`dashboard exited early with ${child.exitCode}`);
    try {
      const res = await fetch(base + '/api/health', { signal: AbortSignal.timeout(300) });
      if (res.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('dashboard did not become ready');
}

async function waitForGatewayCalls(gateway, count) {
  const started = Date.now();
  while (Date.now() - started < 3000) {
    if (gateway.calls.length >= count) return;
    await new Promise(r => setTimeout(r, 50));
  }
}

function createFakeGateway() {
  const calls = [];
  let mode = 'ok';
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/hooks/agent') {
      res.writeHead(404).end();
      return;
    }
    let raw = '';
    req.on('data', d => { raw += d; });
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(raw); } catch {}
      calls.push({ headers: req.headers, body });
      if (mode === 'fail') {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'fake gateway failure' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  return {
    calls,
    setMode(next) { mode = next; },
    listen() {
      return new Promise(resolve => {
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
      });
    },
    close() {
      return new Promise(resolve => server.close(resolve));
    },
  };
}

async function run() {
  console.log('# Canvas promote integration');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-canvas-promote-'));
  const workspace = path.join(tempRoot, 'workspace');
  const projectsDir = path.join(tempRoot, 'projects');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(path.join(workspace, 'projects'), { recursive: true });
  fs.mkdirSync(projectsDir, { recursive: true });
  fs.writeFileSync(path.join(projectsDir, '.keep'), '');

  const gateway = createFakeGateway();
  const gatewayPort = await gateway.listen();
  const base = `http://127.0.0.1:${DASHBOARD_PORT}`;

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      FLOWBOARD_PORT: String(DASHBOARD_PORT),
      FLOWBOARD_HOST: '127.0.0.1',
      OPENCLAW_WORKSPACE: workspace,
      FLOWBOARD_PROJECTS_DIR: projectsDir,
      HZL_DB_PATH: path.join(tempRoot, 'flowboard.db'),
      OPENCLAW_GATEWAY_URL: `http://127.0.0.1:${gatewayPort}`,
      OPENCLAW_HOOKS_TOKEN: TOKEN,
      TELEGRAM_BOT_TOKEN: '',
      TELEGRAM_BOT_TOKENS: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let logs = '';
  child.stdout.on('data', d => { logs += d.toString(); });
  child.stderr.on('data', d => { logs += d.toString(); });

  try {
    await waitForServer(base, child);

    let res = await fetchJson(base, 'POST', '/api/projects', { name: PROJECT });
    ok(res.status === 201 && res.body?.project?.name === PROJECT, 'creates isolated test project');

    res = await fetchJson(base, 'POST', `/api/projects/${PROJECT}/canvas/promote`, {
      notes: [{ id: 'n1', text: 'Build the release gate', color: 'yellow' }],
      connections: [],
      mode: 'single',
      agentId: 'test-canvas-agent',
    });
    ok(res.status === 200 && res.body?.sessionId, 'promote with valid agentId succeeds');
    await waitForGatewayCalls(gateway, 1);
    ok(gateway.calls.length === 1, 'gateway receives one promote hook');
    ok(gateway.calls[0].headers.authorization === `Bearer ${TOKEN}`, 'gateway hook uses hooks token');
    ok(gateway.calls[0].body?.agentId === 'test-canvas-agent', 'gateway hook targets request agentId');
    ok(gateway.calls[0].body?.sessionKey === 'agent:test-canvas-agent:main', 'gateway hook targets agent session key');

    const sessionId = res.body.sessionId;
    res = await fetchJson(base, 'GET', `/api/specify/sessions/${sessionId}`);
    ok(res.status === 200 && res.body?.agentId === 'test-canvas-agent', 'Specify session stores agentId');
    ok(res.body?.sourceNoteIds?.includes('n1'), 'Specify session stores source note ids');

    res = await fetchJson(base, 'POST', `/api/projects/${PROJECT}/canvas/promote`, {
      notes: [{ id: 'n1', text: 'Same note again', color: 'blue' }],
      connections: [],
      mode: 'single',
      agentId: 'test-other-agent',
    });
    ok(res.status === 409, 'duplicate active source note is rejected');

    res = await fetchJson(base, 'POST', `/api/projects/${PROJECT}/canvas/promote`, {
      notes: [{ id: 'bad1', text: 'Bad identity', color: 'yellow' }],
      connections: [],
      mode: 'single',
      agentId: 'default',
    });
    ok(res.status === 400, 'invalid placeholder agentId is rejected');

    res = await fetchJson(base, 'POST', `/api/projects/${PROJECT}/canvas/promote`, {
      notes: [{ id: 'missing-agent', text: 'No implicit broadcast', color: 'yellow' }],
      connections: [],
      mode: 'single',
    });
    ok(res.status === 200 && res.body?.sessionId, 'promote without agentId starts dashboard Specify session');
    const dashboardSessionId = res.body.sessionId;
    res = await fetchJson(base, 'GET', `/api/specify/sessions/${dashboardSessionId}`);
    ok(res.status === 200 && res.body?.agentId === 'human', 'dashboard session uses human agent id');
    ok(gateway.calls.length === 1, 'dashboard promote does not dispatch to gateway');

    gateway.setMode('fail');
    res = await fetchJson(base, 'POST', `/api/projects/${PROJECT}/canvas/promote`, {
      notes: [{ id: 'n2', text: 'Gateway failure should abort', color: 'red' }],
      connections: [],
      mode: 'single',
      agentId: 'test-failing-agent',
    });
    ok(res.status === 200 && res.body?.sessionId, 'explicit agent promote still returns session when async gateway fails');
    const failedSessionId = res.body.sessionId;
    res = await fetchJson(base, 'GET', `/api/specify/sessions/${failedSessionId}`);
    ok(res.status === 200 && res.body?.status === 'created', 'async gateway failure does not abort dashboard-owned session');
  } catch (err) {
    if (logs) console.error(logs);
    throw err;
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise(resolve => child.once('exit', resolve));
    }
    await gateway.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  const total = pass + fail;
  console.log(`\nPassed: ${pass}/${total}`);
  if (fail > 0) {
    console.log(`\nFailures:\n${failures.map(f => `  - ${f}`).join('\n')}`);
    process.exit(1);
  }
  if (logs.includes('Startup failed')) {
    throw new Error(logs);
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
