'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const doctor = require('./snippets-doctor.js');

const PORT = 18843;
const BASE_URL_PORT = 18844;

let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, msg) {
  if (cond) {
    pass++;
    console.log(`  ok - ${msg}`);
  } else {
    fail++;
    failures.push(msg);
    console.log(`  not ok - ${msg}`);
  }
}

async function waitForHealth(child, port = PORT) {
  const started = Date.now();
  while (Date.now() - started < 15000) {
    if (child.exitCode !== null) return false;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(500),
      });
      if (res.ok) return true;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return false;
}

async function run() {
  console.log('# /api/info and snippet doctor custom-port smoke');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-info-port-'));
  const workspace = path.join(tempRoot, 'workspace');
  const projectsDir = path.join(tempRoot, 'projects');
  fs.mkdirSync(workspace, { recursive: true });

  const env = {
    ...process.env,
    FLOWBOARD_PORT: String(PORT),
    FLOWBOARD_HOST: '127.0.0.1',
    FLOWBOARD_API: 'http://localhost:19999',
    FLOWBOARD_BASE_URL: '',
    OPENCLAW_WORKSPACE: workspace,
    FLOWBOARD_PROJECTS_DIR: projectsDir,
    HZL_DB_PATH: path.join(tempRoot, 'fb.db'),
    NODE_ENV: 'test',
    TELEGRAM_BOT_TOKEN: '',
    TELEGRAM_BOT_TOKENS: '',
  };

  let logs = '';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', d => { logs += d.toString(); });
  child.stderr.on('data', d => { logs += d.toString(); });

  try {
    ok(await waitForHealth(child), 'server boots on a non-default port');
    const infoRes = await fetch(`http://127.0.0.1:${PORT}/api/info`);
    const info = await infoRes.json();
    ok(infoRes.ok, '/api/info returns 200');
    ok(info.api_base === `http://localhost:${PORT}`, '/api/info advertises the runtime port');
    ok(info.api_base !== env.FLOWBOARD_API, '/api/info ignores legacy FLOWBOARD_API in the server environment');
    ok(
      info.trigger_snippet.includes(`http://localhost:${PORT}`),
      'external trigger snippet advertises the runtime port'
    );
    ok(
      !info.trigger_snippet.includes('http://localhost:18790'),
      'external trigger snippet does not leak the default port on custom-port installs'
    );
    ok(
      !info.trigger_snippet.includes('http://127.0.0.1:18790'),
      'external trigger snippet does not leak the default 127.0.0.1 URL on custom-port installs'
    );

    const current = doctor.readCurrent('AGENTS-trigger.md');
    fs.writeFileSync(
      path.join(workspace, 'AGENTS.md'),
      current.replace('http://127.0.0.1:18790', `http://127.0.0.1:${PORT}`)
    );
    const status = doctor.collectStatus(tempRoot);
    ok(status.counts.current === 1, 'snippets-doctor treats port-customized current snippet as current');
    ok(status.files.length === 0, 'port-customized current snippet is not surfaced as drift');

    const installRepo = path.join(tempRoot, 'install-repo');
    fs.mkdirSync(installRepo, { recursive: true });
    const installEnv = { ...env, FLOWBOARD_API: '' };
    const install = spawnSync(process.execPath, ['install-trigger.mjs', '--repo', installRepo, '--no-symlink'], {
      cwd: __dirname,
      env: installEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    ok(install.status === 0, 'install-trigger exits successfully with a custom port');
    const agentsContent = fs.readFileSync(path.join(installRepo, 'AGENTS.md'), 'utf8');
    const claudeContent = fs.readFileSync(path.join(installRepo, 'CLAUDE.md'), 'utf8');
    ok(agentsContent.includes(`http://localhost:${PORT}`), 'install-trigger writes the runtime port into AGENTS.md');
    ok(claudeContent.includes(`http://localhost:${PORT}`), 'install-trigger writes the runtime port into CLAUDE.md copy mode');
    ok(!agentsContent.includes('http://localhost:18790'), 'install-trigger AGENTS.md does not leak the default port');
    ok(!claudeContent.includes('http://localhost:18790'), 'install-trigger CLAUDE.md does not leak the default port');
    ok(!agentsContent.includes('http://127.0.0.1:18790'), 'install-trigger AGENTS.md does not leak the default 127.0.0.1 URL');
    ok(!claudeContent.includes('http://127.0.0.1:18790'), 'install-trigger CLAUDE.md does not leak the default 127.0.0.1 URL');

    const apiBaseRepo = path.join(tempRoot, 'api-base-repo');
    fs.mkdirSync(apiBaseRepo, { recursive: true });
    const explicitBase = 'https://flowboard.example.local/custom/';
    const installWithBase = spawnSync(process.execPath, ['install-trigger.mjs', '--repo', apiBaseRepo, '--api-base', explicitBase], {
      cwd: __dirname,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    ok(installWithBase.status === 0, 'install-trigger accepts an explicit --api-base');
    const apiBaseAgents = fs.readFileSync(path.join(apiBaseRepo, 'AGENTS.md'), 'utf8');
    const claudeLink = fs.lstatSync(path.join(apiBaseRepo, 'CLAUDE.md'));
    ok(apiBaseAgents.includes('https://flowboard.example.local/custom'), 'install-trigger writes explicit --api-base into AGENTS.md');
    ok(claudeLink.isSymbolicLink(), 'install-trigger default mode creates a CLAUDE.md symlink');
    ok(installWithBase.stdout.includes('https://flowboard.example.local/custom/api/info'), 'install-trigger prints a normalized discovery URL');
    ok(!installWithBase.stdout.includes('//api/info'), 'install-trigger discovery URL has no double slash');

    const baseEnv = {
      ...env,
      FLOWBOARD_PORT: String(BASE_URL_PORT),
      FLOWBOARD_BASE_URL: 'https://flowboard.example.local/custom/',
      OPENCLAW_WORKSPACE: path.join(tempRoot, 'base-workspace'),
      FLOWBOARD_PROJECTS_DIR: path.join(tempRoot, 'base-projects'),
      HZL_DB_PATH: path.join(tempRoot, 'base-fb.db'),
    };
    const baseChild = spawn(process.execPath, ['server.js'], {
      cwd: __dirname,
      env: baseEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    baseChild.stdout.on('data', d => { logs += d.toString(); });
    baseChild.stderr.on('data', d => { logs += d.toString(); });
    try {
      ok(await waitForHealth(baseChild, BASE_URL_PORT), 'server boots with FLOWBOARD_BASE_URL set');
      const baseInfoRes = await fetch(`http://127.0.0.1:${BASE_URL_PORT}/api/info`);
      const baseInfo = await baseInfoRes.json();
      ok(baseInfo.api_base === 'https://flowboard.example.local/custom', '/api/info advertises FLOWBOARD_BASE_URL when explicitly set');
      ok(baseInfo.trigger_snippet.includes('https://flowboard.example.local/custom'), '/api/info snippet uses FLOWBOARD_BASE_URL when explicitly set');
    } finally {
      baseChild.kill();
    }
  } finally {
    child.kill();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  if (fail === 0) console.log(`\n✅ All ${pass} checks passed`);
  else {
    console.log(`\n❌ ${fail} failed, ${pass} passed`);
    failures.forEach(f => console.log(`  - ${f}`));
    if (logs) console.log(logs.split('\n').slice(-20).join('\n'));
  }
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
