'use strict';

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const STOP_TIMEOUT_MS = 2000;

function reservePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

async function waitForServer(base, child, readLogs, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`isolated dashboard exited early (${child.exitCode})\n${readLogs()}`);
    }
    try {
      const response = await fetch(`${base}/api/health`, {
        signal: AbortSignal.timeout(300),
      });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`isolated dashboard did not become ready\n${readLogs()}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, STOP_TIMEOUT_MS)),
  ]);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(resolve, STOP_TIMEOUT_MS)),
    ]);
  }
}

function isolatedEnvironment(parentEnv, paths, port) {
  const safeParent = {};
  for (const key of ['PATH', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'TZ', 'CI', 'NO_COLOR', 'FORCE_COLOR']) {
    if (typeof parentEnv?.[key] === 'string') safeParent[key] = parentEnv[key];
  }
  return {
    ...safeParent,
    NODE_ENV: 'test',
    FLOWBOARD_PORT: String(port),
    FLOWBOARD_HOST: '127.0.0.1',
    OPENCLAW_WORKSPACE: paths.workspace,
    FLOWBOARD_PROJECTS_DIR: paths.projectsDir,
    HZL_DB_PATH: paths.dbPath,
    FLOWBOARD_POLICY_LEDGER_DIR: paths.policyDir,
    AUTH_ALWAYS: 'false',
    SPECIFY_WORKER_DISABLED: 'true',
    FLOWBOARD_ENABLE_SELF_UPDATE: 'false',
    TELEGRAM_BOT_TOKEN: '',
    TELEGRAM_BOT_TOKENS: '',
    FLOWBOARD_TELEGRAM_AGENT_IDS: '',
    ALLOWED_USER_IDS: '',
    OPENCLAW_HOOKS_TOKEN: '',
    DASHBOARD_ORIGIN: '',
    FLOWBOARD_BASE_URL: '',
    FLOWBOARD_API: '',
    JWT_SECRET: 'isolated-flowboard-test-secret',
    GITHUB_TOKEN: '',
    GH_TOKEN: '',
    OPENAI_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    OPENROUTER_API_KEY: '',
  };
}

async function parseResponse(response) {
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json')
    ? await response.json().catch(() => null)
    : await response.text();
  return { status: response.status, contentType, body, headers: response.headers };
}

/**
 * Run a callback against a real FlowBoard server whose workspace, projects,
 * event DB, cache DB, policy ledger, port, and credentials are isolated.
 *
 * `prepare` runs before the child starts and may seed a restore fixture using
 * only the supplied temporary paths. The temporary tree is deleted by default.
 */
async function withIsolatedDashboard(fn, options = {}) {
  const prefix = options.prefix || 'flowboard-api-test-';
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const workspace = path.join(tempRoot, 'workspace');
  const projectsDir = path.join(tempRoot, 'projects');
  const dbPath = path.join(tempRoot, 'flowboard.db');
  const cacheDbPath = path.join(tempRoot, 'flowboard-cache.db');
  const policyDir = path.join(tempRoot, 'policy');
  const paths = { tempRoot, workspace, projectsDir, dbPath, cacheDbPath, policyDir };

  // m004 still scans <workspace>/projects even when FLOWBOARD_PROJECTS_DIR is
  // overridden. Keep both roots present so an isolated boot cannot fall back
  // to or infer the operator's real workspace.
  fs.mkdirSync(path.join(workspace, 'projects'), { recursive: true });
  fs.mkdirSync(projectsDir, { recursive: true });
  fs.mkdirSync(policyDir, { recursive: true });

  let child = null;
  let logs = '';
  try {
    if (typeof options.prepare === 'function') await options.prepare(paths);
    const port = options.port || await reservePort();
    const base = `http://127.0.0.1:${port}`;
    const env = isolatedEnvironment(options.parentEnv || process.env, paths, port);

    child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => { logs += chunk.toString(); });
    child.stderr.on('data', (chunk) => { logs += chunk.toString(); });
    const readLogs = () => logs;
    await waitForServer(base, child, readLogs, options.timeoutMs);

    const api = async (method, requestPath, body) => {
      const response = await fetch(`${base}/api${requestPath}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return parseResponse(response);
    };

    return await fn({ ...paths, port, base, api, child, readLogs, ROOT });
  } finally {
    await stopChild(child);
    if (!options.keepTemp) {
      try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
    }
  }
}

module.exports = {
  ROOT,
  isolatedEnvironment,
  reservePort,
  withIsolatedDashboard,
};
