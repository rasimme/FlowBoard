'use strict';

// Tests for the in-dashboard self-update flow (T-353):
//   1. version-check.js — pure semver comparison (the update-available decision)
//   2. GET /api/update/status + POST /api/update/run — wiring + dry-run safety
//      (FLOWBOARD_UPDATE_DRY=1 means the run endpoint never actually rebuilds).

const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const vc = require('./version-check.js');

const ROOT = __dirname;
const PORT = 18833;

let pass = 0, fail = 0;
const failures = [];
function ok(c, m) { if (c) { pass++; console.log(`  ok - ${m}`); } else { fail++; failures.push(m); console.log(`  not ok - ${m}`); } }

// --- 1) version-check unit tests -------------------------------------------
console.log('# version-check (semver)');
ok(vc.parseSemver('5.1.0') && vc.parseSemver('5.1.0').minor === 1, 'parseSemver core');
ok(vc.parseSemver('v5.1.0')?.major === 5, 'parseSemver tolerates leading v');
ok(vc.parseSemver('5.1') === null, 'parseSemver rejects non-x.y.z');
ok(vc.parseSemver('garbage') === null, 'parseSemver rejects junk');

ok(vc.isNewer('5.1.0', '5.0.0'), 'minor bump is newer');
ok(vc.isNewer('5.0.1', '5.0.0'), 'patch bump is newer');
ok(vc.isNewer('6.0.0', '5.9.9'), 'major bump is newer');
ok(!vc.isNewer('5.0.0', '5.0.0'), 'same version is NOT newer');
ok(!vc.isNewer('5.0.0', '5.1.0'), 'older is NOT newer');
ok(vc.isNewer('5.1.0', '5.1.0-rc.1'), 'release outranks its pre-release');
ok(!vc.isNewer('5.1.0-rc.1', '5.1.0'), 'pre-release is older than release');
ok(vc.isNewer('5.1.0-rc.2', '5.1.0-rc.1'), 'later rc is newer');
// Bad on-disk version must never spuriously signal an update.
ok(!vc.isNewer('garbage', '5.0.0'), 'unparseable candidate is not newer (fail-safe)');
ok(vc.compareSemver('5.0.0', '5.0.0') === 0, 'compareSemver equality');

// --- 1b) update-env: PATH augmentation for the detached setup.mjs spawn (T-406)
console.log('# update-env (spawn PATH so npm resolves under launchd/systemd)');
const { updateSpawnEnv } = require('./update-env.js');
{
  const e = updateSpawnEnv({ PATH: '/usr/bin:/bin' }, '/opt/hb/bin/node');
  ok(e.PATH.split(path.delimiter)[0] === '/opt/hb/bin', 'prepends node bin dir so npm resolves');
  ok(e.PATH.includes('/usr/bin') && e.PATH.includes('/bin'), 'keeps the existing PATH entries');
  const e2 = updateSpawnEnv({ PATH: '/x:/opt/hb/bin' }, '/opt/hb/bin/node');
  ok(e2.PATH === '/x:/opt/hb/bin', 'no duplicate when node dir is already on PATH');
  const e3 = updateSpawnEnv({}, '/opt/hb/bin/node');
  ok(e3.PATH === '/opt/hb/bin', 'sets PATH even when the base env had none');
}

// --- 2) endpoint tests ------------------------------------------------------
async function fetchJson(base, method, urlPath, body) {
  const res = await fetch(base + urlPath, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
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
  console.log('\n# /api/update endpoints (dry-run)');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-update-'));
  fs.mkdirSync(path.join(tmp, 'workspace/projects'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'projects'), { recursive: true });
  const base = `http://127.0.0.1:${PORT}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, FLOWBOARD_PORT: String(PORT), FLOWBOARD_HOST: '127.0.0.1',
      OPENCLAW_WORKSPACE: path.join(tmp, 'workspace'), FLOWBOARD_PROJECTS_DIR: path.join(tmp, 'projects'),
      HZL_DB_PATH: path.join(tmp, 'fb.db'), NODE_ENV: 'test', TELEGRAM_BOT_TOKEN: '', TELEGRAM_BOT_TOKENS: '',
      FLOWBOARD_UPDATE_DRY: '1', // never actually rebuild/restart during the test
      FLOWBOARD_ENABLE_SELF_UPDATE: 'true', // enable for authorized path tests
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await waitForServer(base, child);

    // status: shape + self-consistency. In a normal checkout the on-disk version
    // equals the running version, so no update is pending.
    const st = await fetchJson(base, 'GET', '/api/update/status');
    ok(st.status === 200 && st.body?.ok === true, 'GET /api/update/status -> 200 ok');
    ok(typeof st.body?.running === 'string', 'status carries running version');
    ok(typeof st.body?.installed === 'string', 'status carries installed version');
    ok(st.body?.updateAvailable === vc.isNewer(st.body.installed, st.body.running),
      'updateAvailable matches isNewer(installed, running)');
    ok(st.body?.running === st.body?.installed && st.body?.updateAvailable === false,
      'fresh checkout: running == installed, no update available');
    ok(st.body?.selfUpdateEnabled === true, 'status reports self-update enabled when env is true');

    // T-417-6: safety checks — missing confirmation returns 400
    const noConf = await fetchJson(base, 'POST', '/api/update/run', {});
    ok(noConf.status === 400 && noConf.body?.ok === false,
      'POST /api/update/run without confirmation -> 400 (missing confirmation)');

    // wrong confirmation returns 400
    const wrongConf = await fetchJson(base, 'POST', '/api/update/run', { confirmation: 'wrong' });
    ok(wrongConf.status === 400 && wrongConf.body?.ok === false,
      'POST /api/update/run with wrong confirmation -> 400 (invalid confirmation)');

    // correct confirmation + dry-run returns 202 with the exact fixed command, no rebuild.
    const rn = await fetchJson(base, 'POST', '/api/update/run', { confirmation: 'update-confirmed' });
    ok(rn.status === 202 && rn.body?.ok === true && rn.body?.dryRun === true && rn.body?.started === false,
      'POST /api/update/run (confirmed, dry-run) -> 202 dryRun, not started');
    const cmd = rn.body?.command || [];
    ok(Array.isArray(cmd) && cmd[cmd.length - 2] === path.join('scripts', 'setup.mjs') && cmd[cmd.length - 1] === '--update',
      'run command is setup.mjs --update');
    // The command must NOT carry any request-derived input (fixed command only).
    assert.deepEqual(cmd.slice(1), [path.join('scripts', 'setup.mjs'), '--update']);
    ok(true, 'run command takes no request input (fixed args)');
  } finally {
    child.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 300));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// T-417-6: Test disabled scenario (env var not set, should return 403)
async function runDisabled() {
  console.log('\n# /api/update/run — disabled (safety default)');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-update-disabled-'));
  fs.mkdirSync(path.join(tmp, 'workspace/projects'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'projects'), { recursive: true });
  const base = `http://127.0.0.1:${PORT + 1}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, FLOWBOARD_PORT: String(PORT + 1), FLOWBOARD_HOST: '127.0.0.1',
      OPENCLAW_WORKSPACE: path.join(tmp, 'workspace'), FLOWBOARD_PROJECTS_DIR: path.join(tmp, 'projects'),
      HZL_DB_PATH: path.join(tmp, 'fb.db'), NODE_ENV: 'test', TELEGRAM_BOT_TOKEN: '', TELEGRAM_BOT_TOKENS: '',
      FLOWBOARD_UPDATE_DRY: '1',
      FLOWBOARD_ENABLE_SELF_UPDATE: '', // explicit false even if parent shell has it set
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await waitForServer(base, child);

    const st = await fetchJson(base, 'GET', '/api/update/status');
    ok(st.status === 200 && st.body?.selfUpdateEnabled === false,
      'GET /api/update/status reports selfUpdateEnabled=false by default');

    // disabled: returns 403 regardless of confirmation
    const noEnv = await fetchJson(base, 'POST', '/api/update/run', { confirmation: 'update-confirmed' });
    ok(noEnv.status === 403 && noEnv.body?.ok === false,
      'POST /api/update/run without FLOWBOARD_ENABLE_SELF_UPDATE -> 403 (disabled)');
    ok(noEnv.body?.error?.includes('disabled'), 'error message mentions disabled');
    ok(typeof noEnv.body?.hint === 'string' && noEnv.body.hint.length > 0, 'provides remediation hint');
  } finally {
    child.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 300));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

run().then(() => runDisabled()).then(() => {
  console.log(`\n# results: ${pass} passed, ${fail} failed`);
  if (fail > 0) { console.log('# failures:'); failures.forEach(f => console.log(`#   - ${f}`)); process.exitCode = 1; }
}).catch(e => { console.error('# fatal:', e.message); process.exitCode = 1; });
