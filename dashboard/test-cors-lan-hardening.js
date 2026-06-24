'use strict';

/**
 * T-417-20: CORS + S-13 LAN-bypass hardening (ClawHub Privilege Escalation /
 * Unrestricted Tool Access residuals).
 *  - No-auth (local-first) mode must NOT expose the API to arbitrary web
 *    origins: a cross-site Origin is not allowed; loopback origins are.
 *  - LOCAL_HOSTNAME alone must no longer enable the unauthenticated LAN bypass;
 *    it requires an explicit FLOWBOARD_ALLOW_LAN=true, and the server warns
 *    loudly at boot so the bypass is never silent.
 */

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = __dirname;
const PORT = 18837;

let pass = 0, fail = 0;
const failures = [];
function ok(c, m) { if (c) { pass++; console.log(`  ok - ${m}`); } else { fail++; failures.push(m); console.log(`  not ok - ${m}`); } }

async function waitForServer(base, child) {
  const t = Date.now();
  while (Date.now() - t < 10000) {
    if (child.exitCode !== null) throw new Error(`dashboard exited early with ${child.exitCode}`);
    try { if ((await fetch(base + '/api/health', { signal: AbortSignal.timeout(300) })).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('dashboard did not become ready');
}

async function run() {
  console.log('# CORS + S-13 LAN hardening (T-417-20)');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-cors-'));
  fs.mkdirSync(path.join(tmp, 'workspace/projects'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'projects'), { recursive: true });
  const base = `http://127.0.0.1:${PORT}`;
  let stderr = '';
  // No-auth (no bot token) local-first mode, with LOCAL_HOSTNAME set but
  // FLOWBOARD_ALLOW_LAN NOT set — the bypass must stay off and warn.
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, FLOWBOARD_PORT: String(PORT), FLOWBOARD_HOST: '127.0.0.1',
      OPENCLAW_WORKSPACE: path.join(tmp, 'workspace'), FLOWBOARD_PROJECTS_DIR: path.join(tmp, 'projects'),
      HZL_DB_PATH: path.join(tmp, 'fb.db'), NODE_ENV: 'test',
      TELEGRAM_BOT_TOKEN: '', TELEGRAM_BOT_TOKENS: '', DASHBOARD_ORIGIN: '',
      LOCAL_HOSTNAME: 'my-box.local', FLOWBOARD_ALLOW_LAN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', d => { stderr += d.toString(); });
  child.stdout.on('data', d => { stderr += d.toString(); });
  try {
    await waitForServer(base, child);

    // CORS: a cross-site origin must NOT be granted access in no-auth mode.
    const evil = 'https://evil.example';
    const evilRes = await fetch(base + '/api/health', { headers: { Origin: evil } });
    const acaoEvil = evilRes.headers.get('access-control-allow-origin');
    ok(acaoEvil !== '*' && acaoEvil !== evil, `no-auth CORS does not allow a cross-site origin (acao=${acaoEvil})`);

    // CORS: a loopback origin is still allowed (the dashboard itself).
    const loop = 'http://127.0.0.1:9999';
    const loopRes = await fetch(base + '/api/health', { headers: { Origin: loop } });
    const acaoLoop = loopRes.headers.get('access-control-allow-origin');
    ok(acaoLoop === loop, `no-auth CORS allows a loopback origin (acao=${acaoLoop})`);

    // Non-browser request (no Origin) still works.
    ok((await fetch(base + '/api/health')).status === 200, 'no-Origin request still served');

    // S-13: boot warns that LOCAL_HOSTNAME is set while the LAN bypass is disabled.
    ok(/S-13/.test(stderr) && /LOCAL_HOSTNAME/.test(stderr) && /FLOWBOARD_ALLOW_LAN/.test(stderr),
      'boot warns about LOCAL_HOSTNAME + disabled LAN bypass');
  } finally {
    child.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 300));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n# results: ${pass} passed, ${fail} failed`);
  if (fail > 0) { console.log('# failures:'); failures.forEach(f => console.log(`#   - ${f}`)); process.exitCode = 1; }
}
run().catch(e => { console.error('# fatal:', e.message); process.exitCode = 1; });
