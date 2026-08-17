'use strict';

// T-440 review-round 4: run the React shell through Vite's development
// server, where React StrictMode rehearses effects. The production browser
// harness cannot catch an initial-load request that is aborted by that
// rehearsal and never restarted.

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { closeBrowser, stopProcessTree } = require('./test-support/browser-harness.js');

const puppeteer = (() => {
  try { return require('puppeteer-core'); } catch { return null; }
})();

const r = (() => {
  let pass = 0;
  let fail = 0;
  const failures = [];
  return {
    ok(condition, message) {
      if (condition) {
        pass += 1;
        console.log(`  ok - ${message}`);
      } else {
        fail += 1;
        failures.push(message);
        console.log(`  not ok - ${message}`);
      }
    },
    skip(reason) {
      console.log('# Dashboard Vite dev E2E (T-440)');
      console.log(`  skip - ${reason}`);
      process.exit(0);
    },
    done() {
      if (fail === 0) console.log(`\n✅ Dashboard Vite dev E2E (T-440): all ${pass} checks passed`);
      else {
        console.log(`\n❌ Dashboard Vite dev E2E (T-440): ${fail} failed, ${pass} passed`);
        failures.forEach((failure) => console.log(`  - ${failure}`));
      }
      process.exit(fail > 0 ? 1 : 0);
    },
  };
})();

const ROOT = path.resolve(__dirname);
const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForHttp(url, child, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`process exited early (${child.exitCode})`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(300) });
      if (response.ok) return;
    } catch { /* startup race */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function withViteDashboard(run) {
  if (!fs.existsSync(EDGE) || !puppeteer) return { skipped: true, reason: 'Edge or puppeteer-core missing' };

  const apiPort = await getFreePort();
  const vitePort = await getFreePort();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-vite-e2e-'));
  fs.mkdirSync(path.join(tmp, 'ws', 'projects'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'projects'), { recursive: true });

  const env = {
    ...process.env,
    FLOWBOARD_PORT: String(apiPort),
    FLOWBOARD_HOST: '127.0.0.1',
    OPENCLAW_WORKSPACE: path.join(tmp, 'ws'),
    FLOWBOARD_PROJECTS_DIR: path.join(tmp, 'projects'),
    HZL_DB_PATH: path.join(tmp, 'flowboard.db'),
    NODE_ENV: 'test',
    TELEGRAM_BOT_TOKEN: '',
    TELEGRAM_BOT_TOKENS: '',
  };
  const dashboard = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const vite = spawn(process.execPath, [
    path.join(ROOT, 'node_modules/vite/bin/vite.js'),
    '--host', '127.0.0.1',
    '--port', String(vitePort),
  ], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let browser = null;
  try {
    const apiBase = `http://127.0.0.1:${apiPort}`;
    const viteBase = `http://127.0.0.1:${vitePort}`;
    await waitForHttp(`${apiBase}/api/health`, dashboard);
    await waitForHttp(viteBase, vite);
    browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    const processLogs = [];
    for (const [label, child] of [['dashboard', dashboard], ['vite', vite]]) {
      child.stdout.on('data', (chunk) => processLogs.push(`[${label}] ${chunk}`));
      child.stderr.on('data', (chunk) => processLogs.push(`[${label}] ${chunk}`));
    }
    const browserLogs = [];
    page.on('console', (message) => browserLogs.push(`[browser:${message.type()}] ${message.text()}`));
    page.on('pageerror', (error) => browserLogs.push(`[pageerror] ${error.stack || error.message}`));

    const api = async (method, route, body) => {
      const response = await fetch(`${apiBase}/api${route}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    };

    try {
      await run({ api, page, base: viteBase });
    } catch (error) {
      const state = await page.evaluate(() => ({
        connection: window.appState?.connection,
        projects: window.appState?.projects,
        body: document.body?.innerText?.slice(0, 1000),
      })).catch(() => null);
      console.error('Vite E2E diagnostics:', { state, browserLogs, processLogs });
      throw error;
    }
  } finally {
    await closeBrowser(browser);
    await stopProcessTree(vite);
    await stopProcessTree(dashboard);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

async function main() {
  const result = await withViteDashboard(async ({ api, page, base }) => {
    const created = await api('POST', '/projects', { name: 'vite-success' });
    if (![200, 201].includes(created.status)) throw new Error(`could not create Vite E2E project (${created.status})`);

    let mode = 'success';
    let projectsRequests = 0;
    let authRequests = 0;

    const respond = (request, status, body) => request.respond({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });

    await page.evaluateOnNewDocument(() => {
      const caseName = new URL(window.location.href).searchParams.get('case');
      const initData = caseName === 'strictmode-success' ? '' : 'synthetic-vite-init-data';
      window.Telegram = {
        WebApp: {
          initData,
          initDataUnsafe: {},
          ready() {},
          expand() {},
          disableVerticalSwipes() {},
          openLink() {},
        },
      };
    });

    await page.setRequestInterception(true);
    page.on('request', (request) => {
      void (async () => {
        const url = new URL(request.url());
        if (url.hostname === 'telegram.org' && url.pathname.endsWith('/telegram-web-app.js')) {
          await request.respond({
            status: 200,
            contentType: 'application/javascript',
            body: `window.Telegram={WebApp:{initData:new URL(location.href).searchParams.get('case')==='strictmode-success'?'':'synthetic-vite-init-data',initDataUnsafe:{},ready(){},expand(){},disableVerticalSwipes(){},openLink(){}}};`,
          });
          return;
        }

        if (request.method() === 'POST' && url.pathname === '/api/auth') {
          authRequests += 1;
          if (mode === 'auth') {
            await respond(request, 403, { error: 'Synthetic Telegram authentication denial' });
          } else {
            await respond(request, 200, { ok: true, user: { username: 'vite-e2e' }, agentId: 'e2e' });
          }
          return;
        }

        if (request.method() === 'GET' && url.pathname === '/api/projects') {
          projectsRequests += 1;
          console.log(`[vite-e2e] /api/projects #${projectsRequests} mode=${mode}`);
          if (mode === 'auth') {
            await request.continue();
            return;
          }
          if (mode === 'api-error') {
            await respond(request, 500, { error: 'Synthetic Vite API failure' });
            return;
          }
          // Delay only the first development request. StrictMode's rehearsal
          // cleanup must abort it, while the immediately re-mounted effect
          // starts the second request without waiting for the 5s poll timer.
          if (projectsRequests === 1) await new Promise((resolve) => setTimeout(resolve, 6000));
        }

        await request.continue();
      })().catch((error) => {
        if (!/intercept|Invalid Interception|already handled|Target closed/i.test(error.message)) {
          console.error('Vite request interception failed:', error);
        }
      });
    });

    const goto = (caseName) => page.goto(`${base}/?agentId=e2e&case=${caseName}`, { waitUntil: 'domcontentloaded' });
    const waitState = (expected, timeout = 4500) => page.waitForFunction(
      (state) => document.querySelector('[data-connection-state]')?.dataset.connectionState === state,
      { timeout },
      expected,
    );
    const saysNoProjects = () => page.$$eval('.sidebar-empty',
      (elements) => elements.some((element) => element.textContent.trim() === 'No projects'));

    // Success must recover from the first StrictMode rehearsal immediately;
    // a 5s interval tick is not an acceptable initial-load mechanism.
    mode = 'success';
    projectsRequests = 0;
    authRequests = 0;
    const startedAt = Date.now();
    await goto('strictmode-success');
    await waitState('ready');
    const successElapsed = Date.now() - startedAt;
    r.ok(successElapsed < 5000,
      `Vite StrictMode success reloads immediately (${successElapsed}ms, not after the poll interval)`);
    r.ok(projectsRequests >= 1,
      'Vite StrictMode completes a fresh core load after the rehearsal cleanup');
    r.ok(!!(await page.$('[data-project="vite-success"]')), 'Vite StrictMode success renders the project board');

    // Auth failures must still be fatal in dev mode, not hidden by the late
    // second effect or converted into an empty board.
    mode = 'auth';
    projectsRequests = 0;
    authRequests = 0;
    await goto('strictmode-auth-error');
    await waitState('auth-error');
    r.ok(authRequests >= 1, 'Vite StrictMode auth error performs the auth request');
    r.ok(!(await saysNoProjects()), 'Vite StrictMode auth error never renders No projects');
    r.ok(await page.$eval('.connection-screen', (element) => /Telegram/i.test(element.textContent)),
      'Vite StrictMode auth error keeps Telegram remediation visible');

    // Core API failures are likewise visible after the dev-only rehearsal.
    mode = 'api-error';
    projectsRequests = 0;
    authRequests = 0;
    await goto('strictmode-api-error');
    await waitState('server-error');
    r.ok(projectsRequests >= 1, 'Vite StrictMode API error reaches the core projects endpoint');
    r.ok(!(await saysNoProjects()), 'Vite StrictMode API error never renders No projects');
  });

  if (result?.skipped) r.skip(result.reason);
  r.done();
}

main().catch((error) => { console.error(error); process.exit(1); });
