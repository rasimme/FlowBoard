'use strict';

// Auth-middleware behavior lock + rate-limiter regression (T-355).
// There was no coverage of telegramAuthMiddleware before the dedup refactor, so
// this pins the externally-observable contract:
//   - tunnel (cf-ray) requests require a valid HS256 session cookie or 403
//   - a wrong-secret or alg!=HS256 token is rejected (algorithm is pinned)
//   - direct localhost (no cf-ray) is allowed for dev/ops without a cookie
//   - the rate limiter is NOT skipped for tunnel traffic (the cf-ray fix), but
//     IS skipped for genuinely-local traffic

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');

const ROOT = __dirname;
const PORT = 18834;
const SECRET = 'test-jwt-secret-please-be-at-least-32-chars-long';

let pass = 0, fail = 0;
const failures = [];
function ok(c, m) { if (c) { pass++; console.log(`  ok - ${m}`); } else { fail++; failures.push(m); console.log(`  not ok - ${m}`); } }

async function req(base, urlPath, headers = {}) {
  const res = await fetch(base + urlPath, { headers });
  return { status: res.status };
}
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
  console.log('# auth middleware + rate-limiter (T-355)');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-auth-'));
  fs.mkdirSync(path.join(tmp, 'workspace/projects'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'projects'), { recursive: true });
  const base = `http://127.0.0.1:${PORT}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, FLOWBOARD_PORT: String(PORT), FLOWBOARD_HOST: '127.0.0.1',
      OPENCLAW_WORKSPACE: path.join(tmp, 'workspace'), FLOWBOARD_PROJECTS_DIR: path.join(tmp, 'projects'),
      HZL_DB_PATH: path.join(tmp, 'fb.db'), NODE_ENV: 'test',
      // Turn AUTH_ENABLED on.
      TELEGRAM_BOT_TOKEN: '123456:dummy', JWT_SECRET: SECRET, ALLOWED_USER_IDS: '42',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await waitForServer(base, child);

    const goodCookie = 'flowboard_session=' + jwt.sign({ id: 42, username: 't' }, SECRET, { algorithm: 'HS256' });
    const wrongSecret = 'flowboard_session=' + jwt.sign({ id: 42 }, 'a-totally-different-secret-32-characters', { algorithm: 'HS256' });
    const noneAlg = 'flowboard_session=' + jwt.sign({ id: 42 }, null, { algorithm: 'none' });
    const CF = { 'cf-ray': 'test-ray-1', 'cf-connecting-ip': '203.0.113.9' };

    // health/info are public even over the tunnel.
    ok((await req(base, '/api/health', CF)).status === 200, 'cf-ray: /api/health is public');

    // Protected route over the tunnel: needs a valid session.
    ok((await req(base, '/api/projects', CF)).status === 403, 'cf-ray + no cookie → 403');
    ok((await req(base, '/api/projects', { ...CF, Cookie: wrongSecret })).status === 403, 'cf-ray + wrong-secret token → 403');
    ok((await req(base, '/api/projects', { ...CF, Cookie: noneAlg })).status === 403, 'cf-ray + alg=none token → 403 (algorithm pinned)');
    ok((await req(base, '/api/projects', { ...CF, Cookie: goodCookie })).status === 200, 'cf-ray + valid HS256 cookie → 200');

    // Direct localhost (no cf-ray) is allowed for dev/ops without a cookie.
    ok((await req(base, '/api/projects', {})).status === 200, 'direct localhost (no cf-ray) → 200 without cookie');

    // --- Rate limiter: NOT skipped for tunnel traffic, skipped for local ---
    // Authed tunnel requests share one key (cf-connecting-ip) → limited after 60.
    let saw429 = false;
    for (let i = 0; i < 75; i++) {
      const s = (await req(base, '/api/projects', { ...CF, Cookie: goodCookie })).status;
      if (s === 429) { saw429 = true; break; }
    }
    ok(saw429, 'tunnel (cf-ray) traffic IS rate-limited (cf-ray skip bug fixed)');

    // Genuinely-local traffic (no cf-ray) is skipped → never 429 even past the cap.
    let localAll2xx = true;
    for (let i = 0; i < 75; i++) {
      const s = (await req(base, '/api/projects', {})).status;
      if (s === 429) { localAll2xx = false; break; }
    }
    ok(localAll2xx, 'genuinely-local traffic is still skipped (never rate-limited)');
  } finally {
    child.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 300));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n# results: ${pass} passed, ${fail} failed`);
  if (fail > 0) { console.log('# failures:'); failures.forEach(f => console.log(`#   - ${f}`)); process.exitCode = 1; }
}
run().catch(e => { console.error('# fatal:', e.message); process.exitCode = 1; });
