'use strict';

// Reusable browser-E2E harness for FlowBoard dashboard tests (T-384).
//
// Spins up the real built dashboard (server.js on a temp DB + projects dir),
// drives it in headless Microsoft Edge via puppeteer-core, and tears it all
// down — so a test can assert what the React app ACTUALLY renders, not just
// the underlying logic/API. Extracted from the per-test boilerplate that the
// canvas + dashboard-shell browser tests each duplicated.
//
// Usage:
//
//   const { withDashboard, reporter } = require('./test-support/browser-harness.js');
//   const r = reporter('My feature (T-123)');
//   await withDashboard(async ({ api, page, base }) => {
//     await api('POST', '/projects', { name: 'p' });
//     await page.goto(`${base}/?agentId=tester`, { waitUntil: 'networkidle2' });
//     r.ok(await page.$('.app'), 'app shell mounts');
//   });
//   r.done(); // prints summary + process.exit
//
// Requires a prior `npx vite build` (dist/) and Microsoft Edge. When either is
// missing the run is SKIPPED (exit 0) — same policy as the existing browser
// tests, so CI without a browser stays green.

const { spawn, execFileSync } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..'); // the dashboard/ dir (server.js, dist/)
const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const CLEANUP_TIMEOUT_MS = 2000;

function reporter(title) {
  let pass = 0, fail = 0;
  const failures = [];
  return {
    ok(cond, msg) {
      if (cond) { pass++; console.log(`  ok - ${msg}`); }
      else { fail++; failures.push(msg); console.log(`  not ok - ${msg}`); }
    },
    skip(reason) { console.log(`# ${title}\n  skip - ${reason}`); process.exit(0); },
    done() {
      if (fail === 0) console.log(`\n✅ ${title}: all ${pass} checks passed`);
      else { console.log(`\n❌ ${title}: ${fail} failed, ${pass} passed`); failures.forEach(f => console.log(`  - ${f}`)); }
      process.exit(fail > 0 ? 1 : 0);
    },
    get pass() { return pass; },
    get fail() { return fail; },
  };
}

/** True when the prerequisites (built dist + Edge) are present. */
function browserAvailable() {
  return fs.existsSync(EDGE) && fs.existsSync(path.join(ROOT, 'dist', 'index.html'));
}

async function _waitForServer(base, child, timeoutMs = 10000) {
  const t = Date.now();
  while (Date.now() - t < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`dashboard server exited early (${child.exitCode})`);
    try { if ((await fetch(base + '/api/health', { signal: AbortSignal.timeout(300) })).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('dashboard server did not become ready');
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function descendantsOf(pid) {
  if (!pid || process.platform === 'win32') return [];
  try {
    const rows = execFileSync('ps', ['-Ao', 'pid=,ppid='], { encoding: 'utf8' });
    const children = new Map();
    for (const line of rows.split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
      if (!match) continue;
      const childPid = Number(match[1]);
      const parentPid = Number(match[2]);
      if (!children.has(parentPid)) children.set(parentPid, []);
      children.get(parentPid).push(childPid);
    }
    const found = [];
    const pending = [pid];
    while (pending.length) {
      const parent = pending.pop();
      for (const child of children.get(parent) || []) {
        found.push(child);
        pending.push(child);
      }
    }
    return found;
  } catch {
    return [];
  }
}

function signalTree(pid, signal) {
  if (!pid) return;
  // Kill descendants first.  Edge's crashpad/helper processes can otherwise
  // become orphaned when the browser parent is force-killed after a hung CDP
  // close attempt.
  for (const child of descendantsOf(pid).reverse()) {
    try { process.kill(child, signal); } catch {}
  }
  try { process.kill(pid, signal); } catch {}
}

async function waitForExit(pid, timeoutMs = CLEANUP_TIMEOUT_MS) {
  if (!pid) return;
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function stopProcessTree(child, timeoutMs = CLEANUP_TIMEOUT_MS) {
  if (!child?.pid) return;
  const pid = child.pid;
  if (!isAlive(pid)) return;
  signalTree(pid, 'SIGTERM');
  await waitForExit(pid, timeoutMs);
  if (isAlive(pid)) {
    signalTree(pid, 'SIGKILL');
    await waitForExit(pid, timeoutMs);
  }
}

async function closeBrowser(browser, timeoutMs = CLEANUP_TIMEOUT_MS) {
  if (!browser) return;
  const edgeProcess = typeof browser.process === 'function' ? browser.process() : null;
  const edgePid = edgeProcess?.pid;
  // Capture helpers before a normal close can orphan them; this list is only
  // ever used for the Edge process created by this harness.
  const trackedPids = edgePid ? [edgePid, ...descendantsOf(edgePid)] : [];
  let closed = false;
  try {
    await Promise.race([
      Promise.resolve().then(() => browser.close()).catch(() => null),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
    closed = !isAlive(edgePid);
  } catch {}

  if (!closed && typeof browser.disconnect === 'function') {
    try { browser.disconnect(); } catch {}
  }
  if (!closed && edgePid) {
    signalTree(edgePid, 'SIGTERM');
    await waitForExit(edgePid, timeoutMs);
  }
  if (!closed && edgePid && isAlive(edgePid)) {
    signalTree(edgePid, 'SIGKILL');
    await waitForExit(edgePid, timeoutMs);
  }
  // Helpers may have re-parented while the browser was closing.  Reap the
  // exact PIDs captured above so a successful test cannot leak Edge/crashpad.
  for (const pid of trackedPids.reverse()) {
    if (isAlive(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
      await waitForExit(pid, 250);
    }
  }
}

/**
 * Boot a throwaway dashboard, hand a fn `{ api, page, base, ROOT }`, tear down.
 * If the browser prerequisites are missing, returns { skipped: true } without
 * running fn (the caller should reporter.skip()).
 *
 * @param {(ctx: {api, page, base, ROOT}) => Promise<void>} fn
 * @param {{ port?: number, viewport?: {width,height} }} [opts]
 */
async function withDashboard(fn, opts = {}) {
  if (!browserAvailable()) return { skipped: true, reason: 'Edge or dist/ missing' };
  const port = opts.port || 18860;
  const base = `http://127.0.0.1:${port}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-e2e-'));
  fs.mkdirSync(path.join(tmp, 'ws', 'projects'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'projects'), { recursive: true });

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, FLOWBOARD_PORT: String(port), FLOWBOARD_HOST: '127.0.0.1',
      OPENCLAW_WORKSPACE: path.join(tmp, 'ws'), FLOWBOARD_PROJECTS_DIR: path.join(tmp, 'projects'),
      HZL_DB_PATH: path.join(tmp, 'fb.db'), NODE_ENV: 'test', TELEGRAM_BOT_TOKEN: '', TELEGRAM_BOT_TOKENS: '' },
    stdio: 'ignore',
  });

  const api = async (m, p, b) => {
    const res = await fetch(`${base}/api${p}`, {
      method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  let browser = null;
  try {
    await _waitForServer(base, child);
    const puppeteer = require('puppeteer-core');
    browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport(opts.viewport || { width: 1400, height: 900 });
    await fn({ api, page, base, ROOT });
    return { skipped: false };
  } finally {
    await closeBrowser(browser);
    await stopProcessTree(child);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

module.exports = {
  withDashboard,
  reporter,
  browserAvailable,
  closeBrowser,
  stopProcessTree,
  EDGE,
  ROOT,
};
