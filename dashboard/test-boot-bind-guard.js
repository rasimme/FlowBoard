'use strict';

/**
 * T-422-3 (5.0.5): boot bind guard.
 *
 * Local-first trust model: "loopback == the operator". Binding a non-loopback
 * interface (0.0.0.0 / a routable host) while auth is DISABLED would expose the
 * full unauthenticated FlowBoard control surface to the network. The server must
 * refuse to start in that configuration unless the operator explicitly accepts
 * the risk with FLOWBOARD_ALLOW_LAN=true — in which case it binds but warns
 * loudly. A loopback bind with auth off (the normal local-first default) is fine.
 */

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = __dirname;

let pass = 0, fail = 0;
const failures = [];
function ok(c, m) { if (c) { pass++; console.log(`  ok - ${m}`); } else { fail++; failures.push(m); console.log(`  not ok - ${m}`); } }

function makeTmp() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-bootguard-'));
  fs.mkdirSync(path.join(tmp, 'workspace/projects'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'projects'), { recursive: true });
  return tmp;
}

function noAuthEnv(tmp, port, extra) {
  return {
    ...process.env,
    FLOWBOARD_PORT: String(port),
    OPENCLAW_WORKSPACE: path.join(tmp, 'workspace'),
    FLOWBOARD_PROJECTS_DIR: path.join(tmp, 'projects'),
    HZL_DB_PATH: path.join(tmp, 'fb.db'),
    NODE_ENV: 'test',
    TELEGRAM_BOT_TOKEN: '', TELEGRAM_BOT_TOKENS: '', DASHBOARD_ORIGIN: '',
    LOCAL_HOSTNAME: '', FLOWBOARD_ALLOW_LAN: '',
    ...extra,
  };
}

function spawnServer(env) {
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', d => { out += d.toString(); });
  child.stderr.on('data', d => { out += d.toString(); });
  return { child, getOut: () => out };
}

function waitForExit(child, ms) {
  return new Promise(resolve => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(child.exitCode); } };
    child.on('exit', finish);
    setTimeout(finish, ms);
  });
}

async function waitForReady(base, child, ms = 8000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (child.exitCode !== null) return false;
    try { if ((await fetch(base + '/api/health', { signal: AbortSignal.timeout(300) })).ok) return true; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

async function run() {
  console.log('# boot bind guard (T-422-3)');

  // Case 1 (REFUSE): non-loopback bind + auth off + no explicit accept → fatal exit.
  {
    const tmp = makeTmp();
    const { child, getOut } = spawnServer(noAuthEnv(tmp, 18841, { FLOWBOARD_HOST: '0.0.0.0' }));
    const code = await waitForExit(child, 6000);
    const out = getOut();
    if (child.exitCode === null) child.kill('SIGKILL');
    ok(code !== null && code !== 0, `non-loopback + auth-off refuses to start (exit code=${code})`);
    ok(/FATAL/.test(out), 'refusal is a FATAL message');
    ok(/0\.0\.0\.0/.test(out), 'refusal names the offending host');
    ok(/FLOWBOARD_ALLOW_LAN/.test(out), 'refusal points to the explicit-accept escape hatch');
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // Case 2 (ACCEPT): non-loopback bind + auth off + FLOWBOARD_ALLOW_LAN=true → starts, but warns loudly.
  {
    const tmp = makeTmp();
    const port = 18842;
    const { child, getOut } = spawnServer(noAuthEnv(tmp, port, { FLOWBOARD_HOST: '0.0.0.0', FLOWBOARD_ALLOW_LAN: 'true' }));
    const ready = await waitForReady(`http://127.0.0.1:${port}`, child);
    const out = getOut();
    ok(ready, 'non-loopback + auth-off + ALLOW_LAN=true starts the server');
    ok(/S-24/.test(out) && /auth/i.test(out), 'explicit-accept boot warns loudly about unauthenticated LAN exposure');
    child.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 300));
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // Case 2b (REFUSE IPv6 bind-all): '::' is non-loopback → same fail-closed refusal.
  {
    const tmp = makeTmp();
    const { child, getOut } = spawnServer(noAuthEnv(tmp, 18846, { FLOWBOARD_HOST: '::' }));
    const code = await waitForExit(child, 6000);
    const out = getOut();
    if (child.exitCode === null) child.kill('SIGKILL');
    ok(code !== null && code !== 0, `IPv6 bind-all '::' + auth-off refuses to start (exit code=${code})`);
    ok(/FATAL/.test(out), 'IPv6 bind-all refusal is a FATAL message');
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // Case 3 (DEFAULT loopback): auth off + loopback bind → starts normally, no false refusal.
  {
    const tmp = makeTmp();
    const port = 18843;
    const { child, getOut } = spawnServer(noAuthEnv(tmp, port, { FLOWBOARD_HOST: '127.0.0.1' }));
    const ready = await waitForReady(`http://127.0.0.1:${port}`, child);
    const out = getOut();
    ok(ready, 'loopback bind + auth-off starts normally (no false refusal)');
    ok(!/FATAL/.test(out), 'loopback default does not emit a FATAL boot refusal');
    child.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 300));
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // --- T-509: NODE_ENV=production does not imply Telegram auth. ---

  // Case 4 (PROD loopback, auth off): starts, warns once, and serves the
  // dashboard end-to-end — list projects, create a task, move it — with the
  // same-origin Origin header a browser sends on mutations.
  {
    const tmp = makeTmp();
    const port = 18820;
    const base = `http://127.0.0.1:${port}`;
    const { child, getOut } = spawnServer(noAuthEnv(tmp, port, { FLOWBOARD_HOST: '127.0.0.1', NODE_ENV: 'production' }));
    const ready = await waitForReady(base, child);
    ok(ready, 'production + loopback + auth-off starts');
    const out = getOut();
    ok(!/FATAL/.test(out), 'production loopback start emits no FATAL');
    ok(/NODE_ENV=production with AUTH DISABLED/.test(out) && /loopback-only/.test(out),
      'production loopback start warns that the dashboard is unauthenticated and loopback-only');
    if (ready) {
      const origin = { Origin: base, 'Content-Type': 'application/json' };
      const list = await fetch(`${base}/api/projects`);
      ok(list.status === 200, `production loopback serves GET /api/projects (status=${list.status})`);
      const created = await fetch(`${base}/api/projects`, { method: 'POST', headers: origin, body: JSON.stringify({ name: 't509-prod' }) });
      ok(created.status === 200 || created.status === 201, `same-origin project create is admitted (status=${created.status})`);
      const task = await fetch(`${base}/api/projects/t509-prod/tasks`, { method: 'POST', headers: origin, body: JSON.stringify({ title: 'Move me' }) });
      const taskBody = await task.json().catch(() => ({}));
      const taskId = taskBody.id || taskBody.task?.id;
      ok((task.status === 200 || task.status === 201) && taskId, `same-origin task create is admitted (status=${task.status})`);
      const moved = await fetch(`${base}/api/projects/t509-prod/tasks/${encodeURIComponent(taskId)}`, { method: 'PUT', headers: origin, body: JSON.stringify({ status: 'in-progress' }) });
      ok(moved.status === 200, `same-origin task move is admitted (status=${moved.status})`);
      const tunnel = await fetch(`${base}/api/projects`, { headers: { 'cf-ray': 'test' } });
      ok(tunnel.status === 403, `tunnel request is still refused without auth (status=${tunnel.status})`);
    }
    child.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 300));
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // Case 5 (PROD non-loopback, auth off): still refused.
  {
    const tmp = makeTmp();
    const { child, getOut } = spawnServer(noAuthEnv(tmp, 18821, { FLOWBOARD_HOST: '0.0.0.0', NODE_ENV: 'production' }));
    const code = await waitForExit(child, 6000);
    const out = getOut();
    if (child.exitCode === null) child.kill('SIGKILL');
    ok(code !== null && code !== 0, `production + non-loopback + auth-off refuses to start (exit code=${code})`);
    ok(/FATAL/.test(out) && /0\.0\.0\.0/.test(out), 'production non-loopback refusal is a FATAL naming the host');
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // Case 6 (PROD non-loopback, auth off, ALLOW_LAN): the LAN opt-in does not
  // open production — refused exactly as before T-509.
  {
    const tmp = makeTmp();
    const { child, getOut } = spawnServer(noAuthEnv(tmp, 18822, { FLOWBOARD_HOST: '0.0.0.0', NODE_ENV: 'production', FLOWBOARD_ALLOW_LAN: 'true' }));
    const code = await waitForExit(child, 6000);
    const out = getOut();
    if (child.exitCode === null) child.kill('SIGKILL');
    ok(code !== null && code !== 0, `production + non-loopback + auth-off + ALLOW_LAN still refuses (exit code=${code})`);
    ok(/FATAL/.test(out), 'production ALLOW_LAN refusal is a FATAL message');
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // Case 7 (PROD auth on): unchanged — starts without the auth-off warning,
  // and a weak JWT secret is still fatal.
  {
    const { createCredentialFixtures } = require('./test-support/credential-fixtures.js');
    const creds = createCredentialFixtures('boot-bind-guard');
    const authEnv = {
      NODE_ENV: 'production',
      FLOWBOARD_HOST: '127.0.0.1',
      TELEGRAM_BOT_TOKEN: creds.botTokens[0],
      FLOWBOARD_TELEGRAM_AGENT_IDS: 'botti',
      JWT_SECRET: creds.jwtSecret,
      ALLOWED_USER_IDS: '42',
    };
    const tmp = makeTmp();
    const port = 18823;
    const { child, getOut } = spawnServer(noAuthEnv(tmp, port, authEnv));
    const ready = await waitForReady(`http://127.0.0.1:${port}`, child);
    const out = getOut();
    ok(ready, 'production + auth on starts');
    ok(!/AUTH DISABLED/.test(out), 'production + auth on does not warn about disabled auth');
    child.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 300));
    fs.rmSync(tmp, { recursive: true, force: true });

    const tmp2 = makeTmp();
    const weak = spawnServer(noAuthEnv(tmp2, 18825, { ...authEnv, JWT_SECRET: 'short' }));
    const code = await waitForExit(weak.child, 6000);
    if (weak.child.exitCode === null) weak.child.kill('SIGKILL');
    ok(code !== null && code !== 0 && /JWT_SECRET must be at least 32/.test(weak.getOut()),
      'production + auth on + weak JWT secret is still FATAL');
    fs.rmSync(tmp2, { recursive: true, force: true });
  }

  console.log(`\n# results: ${pass} passed, ${fail} failed`);
  if (fail > 0) { console.log('# failures:'); failures.forEach(f => console.log(`#   - ${f}`)); process.exitCode = 1; }
}
run().catch(e => { console.error('# fatal:', e.message); process.exitCode = 1; });
