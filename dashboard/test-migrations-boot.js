'use strict';

// T-291 — Startup migration coverage.
// migrations.js is startup-critical but had zero test coverage. This boots
// the server twice on the same fresh workspace and asserts that the first
// boot applies the registry migrations and the second boot treats them all
// as already applied (idempotence). A migration failure throws at startup,
// so a healthy second boot is the behavioral contract.

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = __dirname;
const PORT = 18804;

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

function bootServer(env) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', d => { logs += d.toString(); });
  child.stderr.on('data', d => { logs += d.toString(); });
  return { child, getLogs: () => logs };
}

async function waitForHealth(child) {
  const started = Date.now();
  while (Date.now() - started < 10000) {
    if (child.exitCode !== null) throw new Error(`server exited early with ${child.exitCode}`);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(300) });
      if (res.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not become ready');
}

function killAndWait(child) {
  return new Promise(resolve => {
    child.once('exit', resolve);
    child.kill();
  });
}

async function run() {
  console.log('# Startup migrations (T-291)');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-migrations-'));
  const workspace = path.join(tempRoot, 'workspace');
  const projectsDir = path.join(tempRoot, 'projects');
  fs.mkdirSync(path.join(workspace, 'projects'), { recursive: true });
  fs.mkdirSync(projectsDir, { recursive: true });

  const env = {
    ...process.env,
    FLOWBOARD_PORT: String(PORT),
    FLOWBOARD_HOST: '127.0.0.1',
    OPENCLAW_WORKSPACE: workspace,
    FLOWBOARD_PROJECTS_DIR: projectsDir,
    HZL_DB_PATH: path.join(tempRoot, 'flowboard.db'),
    NODE_ENV: 'test',
    TELEGRAM_BOT_TOKEN: '',
    TELEGRAM_BOT_TOKENS: '',
  };

  let boot1;
  let boot2;
  try {
    // Boot 1 — fresh DB, all migrations must apply
    boot1 = bootServer(env);
    await waitForHealth(boot1.child);
    ok(true, 'fresh workspace boots to healthy');

    // a fresh registry applies at least one migration, none may fail
    const logs1 = boot1.getLogs();
    ok(/\[migrations\] Applying m\d+/.test(logs1), 'first boot applies registry migrations');
    ok(!/\[migrations\] FAILED/.test(logs1), 'no migration fails on first boot');

    // task creation works on the migrated schema
    const res = await fetch(`http://127.0.0.1:${PORT}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'migration-smoke' }),
    });
    ok(res.status === 201, 'project creation works on migrated schema');

    await killAndWait(boot1.child);
    boot1 = null;

    // Boot 2 — same DB, migrations must be a no-op
    boot2 = bootServer(env);
    await waitForHealth(boot2.child);
    ok(true, 'second boot on same workspace is healthy');

    const logs2 = boot2.getLogs();
    ok(/\[migrations\] All migrations already applied\./.test(logs2), 'second boot treats migrations as applied (idempotent)');
    ok(!/\[migrations\] Applying/.test(logs2), 'second boot re-applies nothing');
    ok(!/\[migrations\] FAILED/.test(logs2), 'no migration fails on second boot');

    // previously created state survives the restart
    const list = await fetch(`http://127.0.0.1:${PORT}/api/projects`).then(r => r.json());
    ok((list.projects || []).some(p => p.name === 'migration-smoke'), 'state from boot 1 survives boot 2');
  } catch (err) {
    fail++;
    failures.push(err.message);
    console.log(`  not ok - ${err.message}`);
    const logs = (boot2 || boot1)?.getLogs?.() || '';
    if (logs) console.log(logs.split('\n').slice(-15).join('\n'));
  } finally {
    if (boot1) boot1.child.kill();
    if (boot2) boot2.child.kill();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  if (fail === 0) {
    console.log(`\n✅ All ${pass} checks passed`);
  } else {
    console.log(`\n❌ ${fail} failed, ${pass} passed`);
    failures.forEach(f => console.log(`  - ${f}`));
  }
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
