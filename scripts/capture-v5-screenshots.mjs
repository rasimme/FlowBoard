#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const demoMetaPath = resolve(repoRoot, '.flowboard-v5-demo.json');
const API = process.env.FLOWBOARD_API || 'http://127.0.0.1:18790';
const CDP = process.env.FLOWBOARD_CDP || 'http://127.0.0.1:18800';
const DASHBOARD_URL = process.env.FLOWBOARD_DASHBOARD_URL || API;
const VIEWPORT = { width: 1600, height: 900, deviceScaleFactor: 1 };

if (!existsSync(demoMetaPath)) {
  throw new Error('Missing .flowboard-v5-demo.json. Run: node scripts/v5-demo-fixture.mjs seed');
}

const demo = JSON.parse(readFileSync(demoMetaPath, 'utf8'));
const screenshotDir = resolve(repoRoot, 'docs');

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function cdpFetch(path, options = {}) {
  const res = await fetch(`${CDP}${path}`, options);
  if (!res.ok) throw new Error(`CDP ${path}: HTTP ${res.status}`);
  return res.json();
}

async function waitForCdp(timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const version = await cdpFetch('/json/version');
      if (version.webSocketDebuggerUrl) return version;
    } catch {
      // keep waiting
    }
    await sleep(250);
  }
  return null;
}

function candidateBrowsers() {
  if (process.env.CHROME_PATH) return [process.env.CHROME_PATH];
  return [
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'google-chrome',
    'chromium',
    'chromium-browser',
  ];
}

async function ensureBrowser() {
  const existing = await waitForCdp(1000);
  if (existing) return { spawned: null };

  const browser = candidateBrowsers().find((candidate) => candidate.includes('/') ? existsSync(candidate) : true);
  if (!browser) throw new Error('No Chromium-compatible browser found. Set CHROME_PATH.');

  const userDataDir = resolve(repoRoot, '.tmp', 'flowboard-v5-browser');
  mkdirSync(userDataDir, { recursive: true });
  const spawned = spawn(browser, [
    '--headless=new',
    '--remote-debugging-port=18800',
    `--user-data-dir=${userDataDir}`,
    '--disable-gpu',
    '--no-first-run',
    'about:blank',
  ], { stdio: 'ignore', detached: true });
  spawned.unref();

  const ready = await waitForCdp();
  if (!ready) throw new Error('Chromium CDP did not become ready on port 18800.');
  return { spawned };
}

async function createTarget() {
  try {
    return await cdpFetch(`/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' });
  } catch {
    const targets = await cdpFetch('/json/list');
    const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
    if (!page) throw new Error('No CDP page target available.');
    return page;
  }
}

class Client {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    this.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (!msg.id) return;
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(`${pending.method}: ${msg.error.message}`));
      else pending.resolve(msg.result || {});
    });
    await new Promise((resolveConnect, rejectConnect) => {
      this.ws.addEventListener('open', resolveConnect, { once: true });
      this.ws.addEventListener('error', rejectConnect, { once: true });
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolveSend, rejectSend) => {
      this.pending.set(id, { resolve: resolveSend, reject: rejectSend, method });
    });
  }

  async eval(expression, { awaitPromise = true } = {}) {
    return this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
    });
  }

  close() {
    try { this.ws.close(); } catch {
      // noop
    }
  }
}

async function waitFor(client, expression, label, timeoutMs = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await client.eval(expression).catch(() => null);
    if (result?.result?.value) return result.result.value;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function capture(client, file) {
  const data = await client.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  const out = resolve(repoRoot, file);
  writeFileSync(out, Buffer.from(data.data, 'base64'));
  console.log(`wrote ${file}`);
}

async function preparePage(client) {
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    deviceScaleFactor: VIEWPORT.deviceScaleFactor,
    mobile: false,
  });
  await client.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.kanbanState = {
        expandedParents: new Set(${JSON.stringify([demo.parentId])}),
        sortNewestFirst: false,
        showArchived: false
      };
      try {
        localStorage.setItem('sortNewestFirst', 'false');
        localStorage.setItem('showArchived', 'false');
      } catch {}
    `,
  });
}

async function openDashboard(client) {
  await client.send('Page.navigate', { url: `${DASHBOARD_URL}/?agentId=release-lead` });
  await waitFor(client, `document.readyState === 'complete'`, 'document ready');
  await waitFor(
    client,
    `document.body.innerText.includes('Website Launch Demo') && document.body.innerText.includes('${demo.parentId}')`,
    'demo project tasks'
  );
}

async function clickText(client, text) {
  const escaped = JSON.stringify(text);
  await client.eval(`(() => {
    const candidates = [...document.querySelectorAll('button, [role="button"], .tab, .tree-item, .file-tree-item, .file-row, .project-item')];
    const el = candidates.find((node) => (node.innerText || node.textContent || '').includes(${escaped}));
    if (!el) return false;
    el.click();
    return true;
  })()`);
}

async function captureKanban(client) {
  await clickText(client, 'Tasks');
  await waitFor(client, `document.body.innerText.includes('Launch landing page for Atelier Nova')`, 'kanban content');
  await client.eval(`(() => {
    document.getElementById('app')?.classList.remove('sidebar-collapsed');
    document.querySelector('.kanban')?.scrollTo({ left: 0, top: 0 });
    for (const column of document.querySelectorAll('.column-body')) column.scrollTo({ top: 0, left: 0 });
    return true;
  })()`);
  await sleep(500);
  await capture(client, 'docs/screenshot-kanban.png');
}

async function captureFiles(client) {
  await clickText(client, 'Files');
  await waitFor(client, `document.body.innerText.includes('launch-playbook.md')`, 'files tree');
  await clickText(client, 'launch-playbook.md');
  await waitFor(client, `document.body.innerText.includes('Launch Checklist')`, 'markdown preview');
  await client.eval(`(() => {
    const edit = [...document.querySelectorAll('button')].find((node) => node.title === 'Edit');
    edit?.click();
    return !!edit;
  })()`);
  await waitFor(client, `document.body.innerText.includes('Content Matrix')`, 'markdown editor content');
  await sleep(500);
  await capture(client, 'docs/screenshot-files.png');
}

async function captureCanvas(client) {
  await clickText(client, 'Ideas');
  await waitFor(client, `document.body.innerText.includes('Hero: single promise') || document.querySelector('canvas') || document.querySelector('.canvas-note')`, 'canvas content');
  await sleep(800);
  await capture(client, 'docs/screenshot-canvas.png');
}

await ensureBrowser();
const target = await createTarget();
const client = new Client(target.webSocketDebuggerUrl);
await client.connect();

try {
  await preparePage(client);
  await openDashboard(client);
  await captureKanban(client);
  await captureFiles(client);
  await captureCanvas(client);
} finally {
  client.close();
}
