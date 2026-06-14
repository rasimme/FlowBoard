'use strict';

// T-345 follow-up — sidebar edit must persist on close-by-outside-click.
//
// Regression for the reported bug: open a long (truncated) note's sidebar,
// shorten the text, then dismiss the sidebar by clicking empty canvas — the
// edit was lost (the sidebar's unmount-persist read a note ref that CanvasView
// had already nulled, so it no-op'd). The note must save (and, being shorter,
// stop being truncated). Drives the real build headless (puppeteer-core + Edge).

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = __dirname;
const PORT = 18829;
const PROJECT = 'canvas-sidebar-save';
const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';

let pass = 0;
let fail = 0;
const failures = [];
function ok(c, m) { if (c) { pass++; console.log(`  ok - ${m}`); } else { fail++; failures.push(m); console.log(`  not ok - ${m}`); } }

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
async function waitFor(fn, label, timeout = 8000) {
  const t = Date.now();
  while (Date.now() - t < timeout) { try { const v = await fn(); if (v) return v; } catch {} await new Promise(r => setTimeout(r, 120)); }
  throw new Error(`timeout: ${label}`);
}

async function run() {
  console.log('# Canvas sidebar save-on-close regression');
  if (!fs.existsSync(EDGE)) { console.log('  skip - Edge not found'); return; }
  if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) throw new Error('dist missing — run npx vite build first');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-sbsave-'));
  fs.mkdirSync(path.join(tmp, 'workspace/projects'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'projects'), { recursive: true });
  const base = `http://127.0.0.1:${PORT}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, FLOWBOARD_PORT: String(PORT), FLOWBOARD_HOST: '127.0.0.1', OPENCLAW_WORKSPACE: path.join(tmp, 'workspace'), FLOWBOARD_PROJECTS_DIR: path.join(tmp, 'projects'), HZL_DB_PATH: path.join(tmp, 'fb.db'), NODE_ENV: 'test', TELEGRAM_BOT_TOKEN: '', TELEGRAM_BOT_TOKENS: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let browser = null;
  try {
    await waitForServer(base, child);
    await fetchJson(base, 'POST', '/api/projects', { name: PROJECT });
    const longText = 'Zeile A\n' + Array.from({ length: 24 }, (_, i) => `Zeile ${i + 1} mit genug Inhalt zum Abschneiden`).join('\n');
    await fetchJson(base, 'POST', `/api/projects/${PROJECT}/canvas/notes`, { text: longText, x: 300, y: 200, color: 'blue' });

    const puppeteer = require('puppeteer-core');
    browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(base + '/', { waitUntil: 'networkidle2' });
    await page.evaluate((p) => { window.appState.viewedProject = p; window.appState.currentTab = 'ideas'; window.dispatchEvent(new CustomEvent('appstate:change')); }, PROJECT);
    await page.waitForSelector('.note', { timeout: 8000 });
    await new Promise(r => setTimeout(r, 500));

    const truncated = await page.$eval('[data-note-body]', el => el.classList.contains('truncated'));
    ok(truncated, 'long note starts truncated (sidebar branch)');

    const nb = await (await page.$('.note')).boundingBox();
    // Double-click the visible top of the note → sidebar opens.
    await page.mouse.move(nb.x + nb.width / 2, nb.y + 30);
    await page.mouse.down(); await page.mouse.up();
    await page.mouse.down({ clickCount: 2 }); await page.mouse.up({ clickCount: 2 });
    await page.waitForSelector('.canvas-sidebar.open', { timeout: 5000 });
    ok(true, 'double-click opens the sidebar');

    // Replace the whole text with something short.
    await page.click('.canvas-sidebar .cm-content');
    await page.keyboard.down('Meta'); await page.keyboard.press('a'); await page.keyboard.up('Meta');
    await page.keyboard.type('Kurz jetzt');

    // Dismiss by clicking empty canvas (the previously-broken close path).
    await page.mouse.click(nb.x + 600, nb.y + 400);

    const saved = await waitFor(async () => {
      const r = await fetchJson(base, 'GET', `/api/projects/${PROJECT}/canvas`);
      const n = r.body?.notes?.[0];
      return n && n.text === 'Kurz jetzt' ? n : null;
    }, 'sidebar edit persisted').catch(() => null);
    ok(saved, 'sidebar edit persists after closing via outside click');

    // And the now-short note is no longer truncated.
    await new Promise(r => setTimeout(r, 300));
    const stillTruncated = await page.$eval('[data-note-body]', el => el.classList.contains('truncated')).catch(() => null);
    ok(stillTruncated === false, 'shortened note is no longer truncated (inline-edit branch again)');
  } finally {
    if (browser) await browser.close().catch(() => {});
    child.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 300));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n# results: ${pass} passed, ${fail} failed`);
  if (fail > 0) { console.log('# failures:'); failures.forEach(f => console.log(`#   - ${f}`)); process.exitCode = 1; }
}
run().catch(e => { console.error('# fatal:', e.message); process.exitCode = 1; });
