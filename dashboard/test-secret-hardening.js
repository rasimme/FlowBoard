'use strict';

/**
 * T-417-21: GitHub-token at-rest hardening (ClawHub credential-access residual).
 *  - The local DB files (which hold github_token + settings) are owner-only (0600).
 *  - PUT /api/settings/github-token warns that the value is stored unencrypted
 *    and that the env var is the preferred, higher-precedence path.
 * (The full encrypt-at-rest / secret store is deliberately v5.1.)
 */

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const hzl = require('./hzl-service.js');

const ROOT = __dirname;
const PORT = 18838;

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
  console.log('# secret hardening (T-417-21)');

  // --- Part A: DB files are created owner-only (0600) ---
  const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-secdb-'));
  const dbPath = path.join(tmpA, 'fb.db');
  await hzl.init(dbPath);
  const cacheDbPath = dbPath.replace(/\.db$/, '-cache.db');
  for (const f of [dbPath, cacheDbPath]) {
    const mode = fs.statSync(f).mode & 0o777;
    ok(mode === 0o600, `${path.basename(f)} is owner-only 0600 (got ${mode.toString(8)})`);
  }

  // --- Part B: PUT github-token warns about unencrypted storage + env ---
  const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-sectok-'));
  fs.mkdirSync(path.join(tmpB, 'workspace/projects'), { recursive: true });
  fs.mkdirSync(path.join(tmpB, 'projects'), { recursive: true });
  const base = `http://127.0.0.1:${PORT}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, FLOWBOARD_PORT: String(PORT), FLOWBOARD_HOST: '127.0.0.1',
      OPENCLAW_WORKSPACE: path.join(tmpB, 'workspace'), FLOWBOARD_PROJECTS_DIR: path.join(tmpB, 'projects'),
      HZL_DB_PATH: path.join(tmpB, 'fb.db'), NODE_ENV: 'test',
      TELEGRAM_BOT_TOKEN: '', TELEGRAM_BOT_TOKENS: '',
      FLOWBOARD_GITHUB_TOKEN: '', GITHUB_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await waitForServer(base, child);
    const res = await fetch(base + '/api/settings/github-token', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'ghp_' + 'a'.repeat(36) }),
    });
    const body = await res.json();
    ok(res.status === 200 && body.ok === true, 'PUT github-token succeeds');
    ok(typeof body.warning === 'string' && /unencrypt/i.test(body.warning) && /env/i.test(body.warning),
      'PUT response warns about unencrypted storage + env preference');
  } finally {
    child.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 300));
    fs.rmSync(tmpA, { recursive: true, force: true });
    fs.rmSync(tmpB, { recursive: true, force: true });
  }

  console.log(`\n# results: ${pass} passed, ${fail} failed`);
  if (fail > 0) { console.log('# failures:'); failures.forEach(f => console.log(`#   - ${f}`)); process.exitCode = 1; }
}
run().catch(e => { console.error('# fatal:', e.message); process.exitCode = 1; });
