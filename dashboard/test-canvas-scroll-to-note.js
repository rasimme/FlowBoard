'use strict';

// T-351 — Canvas consumes window._scrollToNoteId (header-search navigation):
// the camera pans/zooms onto the target note and flashes a 2s highlight.
// Drives the real build headless (puppeteer-core + Edge), mirroring
// test-canvas-sidebar-save.js. The consume effect runs on every CanvasView
// render; we trigger an in-place render via the 'flowboard:canvas-reload' event
// (same effect the real mount/tab-switch path runs).

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = __dirname;
const PORT = 18831;
const PROJECT = 'canvas-scroll-to-note';
const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';

let pass = 0, fail = 0;
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
  while (Date.now() - t < timeout) { try { const v = await fn(); if (v) return v; } catch {} await new Promise(r => setTimeout(r, 100)); }
  throw new Error(`timeout: ${label}`);
}

async function run() {
  console.log('# Canvas scroll-to-note (T-351)');
  if (!fs.existsSync(EDGE)) { console.log('  skip - Edge not found'); return; }
  if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) throw new Error('dist missing — run npx vite build first');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-s2n-'));
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
    // A note near the origin and a TARGET note far away, so a default fit/restore
    // would not already have it centered — the jump must move the camera.
    await fetchJson(base, 'POST', `/api/projects/${PROJECT}/canvas/notes`, { text: 'near origin', x: 80, y: 80, color: 'grey' });
    const created = await fetchJson(base, 'POST', `/api/projects/${PROJECT}/canvas/notes`, { text: 'find me', x: 3000, y: 2200, color: 'blue' });
    const targetId = created.body?.note?.id;
    ok(!!targetId, `target note created (${targetId})`);

    const puppeteer = require('puppeteer-core');
    browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(base + '/', { waitUntil: 'networkidle2' });
    await page.evaluate((p) => { window.appState.viewedProject = p; window.appState.currentTab = 'ideas'; window.dispatchEvent(new CustomEvent('appstate:change')); }, PROJECT);
    await page.waitForSelector('.note', { timeout: 8000 });
    await new Promise(r => setTimeout(r, 600));

    // Trigger the search-navigation: set the flag + force a CanvasView render.
    await page.evaluate((id) => {
      window._scrollToNoteId = id;
      window.dispatchEvent(new CustomEvent('flowboard:canvas-reload'));
    }, targetId);

    // The flag is consumed exactly once.
    const consumed = await waitFor(async () => {
      return await page.evaluate(() => window._scrollToNoteId === undefined);
    }, 'scrollToNoteId consumed', 4000).catch(() => false);
    ok(consumed, 'window._scrollToNoteId is consumed (deleted) by the canvas');

    // The target note element flashes the highlight class.
    const highlighted = await waitFor(async () => {
      return await page.evaluate((id) => {
        const el = document.querySelector(`[data-note-id="${id}"]`);
        return el && el.classList.contains('canvas-note-highlighted');
      }, targetId);
    }, 'note highlighted', 4000).catch(() => false);
    ok(highlighted, 'target note gets the canvas-note-highlighted flash class');

    // The camera centered on the note: its on-screen center is near the wrap center.
    const centered = await waitFor(async () => {
      const d = await page.evaluate((id) => {
        const wrap = document.querySelector('[data-react-canvas]');
        const el = document.querySelector(`[data-note-id="${id}"]`);
        if (!wrap || !el) return null;
        const w = wrap.getBoundingClientRect();
        const n = el.getBoundingClientRect();
        return {
          dx: Math.abs((n.left + n.width / 2) - (w.left + w.width / 2)),
          dy: Math.abs((n.top + n.height / 2) - (w.top + w.height / 2)),
        };
      }, targetId);
      // Tolerance: within ~120px of dead-center on each axis.
      return d && d.dx < 120 && d.dy < 120 ? d : null;
    }, 'note centered in viewport', 4000).catch(() => null);
    ok(centered, `target note is centered in the viewport (dx=${centered?.dx?.toFixed(0)}, dy=${centered?.dy?.toFixed(0)})`);

    // The flash clears itself (~2s).
    const cleared = await waitFor(async () => {
      return await page.evaluate((id) => {
        const el = document.querySelector(`[data-note-id="${id}"]`);
        return el && !el.classList.contains('canvas-note-highlighted');
      }, targetId);
    }, 'highlight cleared', 4000).catch(() => false);
    ok(cleared, 'highlight class is removed after ~2s');
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
