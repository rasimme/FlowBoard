'use strict';

// T-407 — A fresh install whose projects dir does not exist yet must still boot.
// m005 writes a legacy-redirect symlink into the projects dir; if nothing
// creates that dir first, fs.symlinkSync throws ENOENT and the server refuses
// to start. The existing test-migrations-boot.js pre-creates the dir, so it
// never caught this. Here we deliberately leave the projects dir absent.

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = __dirname;
const PORT = 18837;

let pass = 0, fail = 0;
const failures = [];
function ok(c, m) { if (c) { pass++; console.log(`  ok - ${m}`); } else { fail++; failures.push(m); console.log(`  not ok - ${m}`); } }

function waitForHealth(child) {
  return new Promise((resolve) => {
    const t = Date.now();
    (function poll() {
      if (child.exitCode !== null) return resolve(false);
      fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(500) })
        .then(r => resolve(r.ok))
        .catch(() => { if (Date.now() - t > 15000) return resolve(false); setTimeout(poll, 300); });
    })();
  });
}

async function run() {
  console.log('# Fresh-install boot with missing projects dir (T-407)');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-fresh-'));
  const workspace = path.join(tempRoot, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });        // workspace exists…
  const projectsDir = path.join(tempRoot, 'projects'); // …but the projects dir does NOT
  const env = {
    ...process.env,
    FLOWBOARD_PORT: String(PORT), FLOWBOARD_HOST: '127.0.0.1',
    OPENCLAW_WORKSPACE: workspace, FLOWBOARD_PROJECTS_DIR: projectsDir,
    HZL_DB_PATH: path.join(tempRoot, 'fb.db'),
    NODE_ENV: 'test', TELEGRAM_BOT_TOKEN: '', TELEGRAM_BOT_TOKENS: '',
  };

  let logs = '';
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', d => { logs += d.toString(); });
  child.stderr.on('data', d => { logs += d.toString(); });

  try {
    const healthy = await waitForHealth(child);
    ok(healthy, 'server boots to healthy even though the projects dir did not exist');
    ok(!/\[migrations\] FAILED/.test(logs), 'no migration fails on fresh boot');
    ok(fs.existsSync(projectsDir), 'projects dir is created during startup');
  } finally {
    child.kill();
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  }

  if (fail === 0) console.log(`\n✅ All ${pass} checks passed`);
  else { console.log(`\n❌ ${fail} failed, ${pass} passed`); failures.forEach(f => console.log('  - ' + f)); if (logs) console.log(logs.split('\n').slice(-12).join('\n')); }
  process.exit(fail > 0 ? 1 : 0);
}
run().catch(e => { console.error(e); process.exit(1); });
