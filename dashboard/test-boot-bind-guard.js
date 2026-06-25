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

  console.log(`\n# results: ${pass} passed, ${fail} failed`);
  if (fail > 0) { console.log('# failures:'); failures.forEach(f => console.log(`#   - ${f}`)); process.exitCode = 1; }
}
run().catch(e => { console.error('# fatal:', e.message); process.exitCode = 1; });
