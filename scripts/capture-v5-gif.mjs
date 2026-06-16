#!/usr/bin/env node
// Capture an animated tour GIF (Overview -> Canvas -> Kanban -> Files) of the
// v5 demo fixture, with the sidebar anonymized on every frame so no real
// project names leak. Encodes with gifski (must be on PATH).
//
//   node scripts/v5-demo-fixture.mjs seed   # first
//   node scripts/capture-v5-gif.mjs
//
// Reuses the same headless-CDP approach as capture-v5-screenshots.mjs.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const demoMetaPath = resolve(repoRoot, '.flowboard-v5-demo.json');
const API = process.env.FLOWBOARD_API || 'http://127.0.0.1:18790';
const CDP = process.env.FLOWBOARD_CDP || 'http://127.0.0.1:18800';
const DASHBOARD_URL = process.env.FLOWBOARD_DASHBOARD_URL || API;
const VIEWPORT = { width: 1600, height: 900, deviceScaleFactor: 1 };
const FRAMES_DIR = resolve(repoRoot, '.tmp', 'gif-frames');
const OUT_GIF = resolve(repoRoot, 'docs', 'demo.gif');

if (!existsSync(demoMetaPath)) throw new Error('Missing .flowboard-v5-demo.json. Run: node scripts/v5-demo-fixture.mjs seed');
const demo = JSON.parse(readFileSync(demoMetaPath, 'utf8'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function cdpFetch(path, options = {}) {
  const res = await fetch(`${CDP}${path}`, options);
  if (!res.ok) throw new Error(`CDP ${path}: HTTP ${res.status}`);
  return res.json();
}
async function waitForCdp(timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try { const v = await cdpFetch('/json/version'); if (v.webSocketDebuggerUrl) return v; } catch {}
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
    'google-chrome', 'chromium', 'chromium-browser',
  ];
}
async function ensureBrowser() {
  if (await waitForCdp(1000)) return;
  const browser = candidateBrowsers().find((c) => (c.includes('/') ? existsSync(c) : true));
  if (!browser) throw new Error('No Chromium-compatible browser found. Set CHROME_PATH.');
  const userDataDir = resolve(repoRoot, '.tmp', 'flowboard-v5-browser');
  mkdirSync(userDataDir, { recursive: true });
  const spawned = spawn(browser, ['--headless=new', '--remote-debugging-port=18800', `--user-data-dir=${userDataDir}`, '--disable-gpu', '--no-first-run', 'about:blank'], { stdio: 'ignore', detached: true });
  spawned.unref();
  if (!(await waitForCdp())) throw new Error('Chromium CDP did not become ready on port 18800.');
}
async function createTarget() {
  try { return await cdpFetch(`/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' }); }
  catch {
    const targets = await cdpFetch('/json/list');
    const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (!page) throw new Error('No CDP page target available.');
    return page;
  }
}
class Client {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.nextId = 1; this.pending = new Map(); }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    this.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (!msg.id) return;
      const p = this.pending.get(msg.id); if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`)); else p.resolve(msg.result || {});
    });
    await new Promise((res, rej) => { this.ws.addEventListener('open', res, { once: true }); this.ws.addEventListener('error', rej, { once: true }); });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { resolve: res, reject: rej, method }));
  }
  eval(expression, { awaitPromise = true } = {}) { return this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }); }
  close() { try { this.ws.close(); } catch {} }
}
async function waitFor(client, expression, label, timeoutMs = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const r = await client.eval(expression).catch(() => null);
    if (r?.result?.value) return r.result.value;
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
async function clickText(client, text) {
  const escaped = JSON.stringify(text);
  await client.eval(`(() => {
    const c = [...document.querySelectorAll('button, [role="button"], .tab, .tree-item')];
    const el = c.find((n) => (n.innerText || n.textContent || '').trim() === ${escaped} || (n.innerText||'').includes(${escaped}));
    if (!el) return false; el.click(); return true;
  })()`);
}
// Replace the real project sidebar with a synthetic one (no real names leak).
async function anonymizeSidebar(client) {
  await client.eval(`(() => {
    const scroll = document.querySelector('.sidebar-scroll');
    if (!scroll) return false;
    const grip = '<span class="row-grip" aria-hidden="true"></span>';
    const kebab = '<button class="row-kebab" type="button" aria-label="Project actions"></button>';
    const item = (name, active=false) => '<div class="project-item'+(active?' viewed':'')+'">'+grip+'<span class="proj-name">'+name+'</span>'+kebab+'</div>';
    const folder = (name, ch) => '<div class="folder-group"><button class="folder-head" type="button"><span>'+name+'</span></button><div class="folder-body">'+ch.join('')+'</div></div>';
    const archive = (ch) => '<div class="archive-section"><button class="archive-head" type="button"><span>Archive</span></button><div class="folder-body">'+ch.join('')+'</div></div>';
    scroll.innerHTML = [
      folder('LAUNCH WORK', [item('Launch Demo', true), item('Core Platform'), item('Brand System'), item('Content Studio')]),
      folder('AGENT LAB', [item('QA Workspace'), item('Plugin Lab'), item('Research Notes')]),
      archive([item('Archived Sprint'), item('Discovery Notes')]),
    ].join('');
    for (const el of document.querySelectorAll('button')) {
      const t = (el.innerText || '').trim();
      if (/Migration required|Finish setup|Update available/i.test(t)) el.style.display = 'none';
    }
    for (const el of document.querySelectorAll('.archive-toggle')) el.style.display = 'none';
    return true;
  })()`);
}
async function frame(client, i) {
  const data = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
  writeFileSync(resolve(FRAMES_DIR, `f-${String(i).padStart(4, '0')}.png`), Buffer.from(data.data, 'base64'));
}

await ensureBrowser();
const target = await createTarget();
const client = new Client(target.webSocketDebuggerUrl);
await client.connect();

rmSync(FRAMES_DIR, { recursive: true, force: true });
mkdirSync(FRAMES_DIR, { recursive: true });

try {
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Emulation.setDeviceMetricsOverride', { width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: VIEWPORT.deviceScaleFactor, mobile: false });
  await client.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try {
      localStorage.setItem('sortMode','custom');
      localStorage.setItem('showArchived','false');
      sessionStorage.setItem('flowboard.kanban.view.${demo.project}', JSON.stringify({ expanded: ${JSON.stringify([demo.parentId])} }));
    } catch {}`,
  });
  await client.send('Page.navigate', { url: `${DASHBOARD_URL}/?agentId=release-lead` });
  await waitFor(client, `document.readyState === 'complete'`, 'document ready');
  await waitFor(client, `document.body.innerText.includes('Website Launch Demo')`, 'demo loaded');
  await client.eval(`document.getElementById('app')?.classList.remove('sidebar-collapsed')`);

  // Tour: dwell on each view, switching tabs at fixed frame marks. The sidebar
  // is re-anonymized before every frame so no real project name appears.
  const DWELL = 18;            // frames per view
  const INTERVAL = 160;        // ms between frames
  const tabs = ['Overview', 'Ideas', 'Tasks', 'Files'];
  // let the Overview's GitHub widgets settle before the first frame
  await clickText(client, 'Overview');
  await sleep(3500);
  let i = 0;
  for (const tab of tabs) {
    await clickText(client, tab);
    await sleep(1100);
    for (let d = 0; d < DWELL; d++) {
      await anonymizeSidebar(client);
      await frame(client, i++);
      await sleep(INTERVAL);
    }
  }
  console.log(`captured ${i} frames`);
} finally {
  client.close();
}

// Encode with gifski (sped up: ~12fps playback over the captured frames).
const gifski = ['gifski', resolve(process.env.HOME || '', 'homebrew/bin/gifski'), '/opt/homebrew/bin/gifski', '/usr/local/bin/gifski'].find((p) => p === 'gifski' || existsSync(p)) || 'gifski';
const args = ['--fps', '12', '--quality', '100', '--width', '1200', '-o', OUT_GIF, `${FRAMES_DIR}/f-*.png`];
const r = spawnSync('sh', ['-c', `${gifski} ${args.join(' ')}`], { stdio: 'inherit' });
if (r.status !== 0) throw new Error('gifski encode failed');
console.log(`wrote ${OUT_GIF}`);
