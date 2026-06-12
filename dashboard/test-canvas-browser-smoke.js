'use strict';

// T-340-8 — Browser smoke for the React canvas (CanvasView).
// Drives the real dashboard build headless (puppeteer-core + Edge, same
// browser as tools/ov-audit.mjs) against an isolated server/workspace:
// create notes via double-click, edit text, drag a connection between port
// dots, cluster frame + lasso multi-select + promote button, Ctrl+wheel zoom.
// Deliberately coarse — fine-grained behavior parity lives in the unit tests
// and the manual checklist (epic spec T-340).

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = __dirname;
const DASHBOARD_PORT = 18811;
const PROJECT = 'canvas-browser-smoke';
const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';

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

async function fetchJson(base, method, urlPath, body) {
  const res = await fetch(base + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
}

async function waitForServer(base, child) {
  const started = Date.now();
  while (Date.now() - started < 10000) {
    if (child.exitCode !== null) throw new Error(`dashboard exited early with ${child.exitCode}`);
    try {
      const res = await fetch(base + '/api/health', { signal: AbortSignal.timeout(300) });
      if (res.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('dashboard did not become ready');
}

// CDP-correct double click: two down/up pairs with increasing clickCount —
// a plain mouse.click({clickCount: 2}) does not synthesize a dblclick event.
async function doubleClick(page, x, y) {
  await page.mouse.move(x, y);
  await page.mouse.down({ clickCount: 1 });
  await page.mouse.up({ clickCount: 1 });
  await page.mouse.down({ clickCount: 2 });
  await page.mouse.up({ clickCount: 2 });
}

async function waitFor(fn, label, timeout = 8000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch {}
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function run() {
  console.log('# Canvas browser smoke (T-340-8)');

  if (!fs.existsSync(EDGE)) {
    console.log('  skip - Microsoft Edge not found; browser smoke skipped');
    return;
  }
  if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    throw new Error('dist/index.html missing — run `npx vite build` first');
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-canvas-browser-'));
  const workspace = path.join(tempRoot, 'workspace');
  const projectsDir = path.join(tempRoot, 'projects');
  fs.mkdirSync(path.join(workspace, 'projects'), { recursive: true });
  fs.mkdirSync(projectsDir, { recursive: true });

  const base = `http://127.0.0.1:${DASHBOARD_PORT}`;

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      FLOWBOARD_PORT: String(DASHBOARD_PORT),
      FLOWBOARD_HOST: '127.0.0.1',
      OPENCLAW_WORKSPACE: workspace,
      FLOWBOARD_PROJECTS_DIR: projectsDir,
      HZL_DB_PATH: path.join(tempRoot, 'flowboard.db'),
      NODE_ENV: 'test',
      TELEGRAM_BOT_TOKEN: '',
      TELEGRAM_BOT_TOKENS: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', d => { logs += d.toString(); });
  child.stderr.on('data', d => { logs += d.toString(); });

  let browser = null;
  try {
    await waitForServer(base, child);

    let res = await fetchJson(base, 'POST', '/api/projects', { name: PROJECT });
    ok(res.status === 201, 'creates isolated test project');

    const puppeteer = require('puppeteer-core');
    browser = await puppeteer.launch({
      executablePath: EDGE,
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1280,900'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(base + '/', { waitUntil: 'networkidle2' });

    // Route into the hidden React canvas view for the test project.
    await page.evaluate((project) => {
      window.appState.viewedProject = project;
      window.appState.currentTab = 'ideas';
      window.dispatchEvent(new CustomEvent('appstate:change'));
    }, PROJECT);

    await page.waitForSelector('[data-react-canvas]', { timeout: 8000 });
    ok(true, 'React canvas view renders');

    const wrap = await page.$('[data-react-canvas]');
    const box = await wrap.boundingBox();

    // --- Create note A via double-click, type text, escape to save ---
    await doubleClick(page, box.x + 300, box.y + 300);
    await page.waitForSelector('.note', { timeout: 8000 });
    ok(true, 'double-click creates a note');

    await page.waitForSelector('.note-textarea', { timeout: 4000 });
    await page.keyboard.type('Erste Idee');
    await page.keyboard.press('Escape');
    await waitFor(async () => {
      const r = await fetchJson(base, 'GET', `/api/projects/${PROJECT}/canvas`);
      return r.body?.notes?.some(n => n.text === 'Erste Idee');
    }, 'note A text persisted');
    ok(true, 'inline edit persists note text');

    // --- Create note B ---
    await doubleClick(page, box.x + 700, box.y + 320);
    await waitFor(() => page.$$('.note').then(els => els.length === 2), 'second note');
    await page.waitForSelector('.note-textarea', { timeout: 4000 });
    await page.keyboard.type('Zweite Idee');
    await page.keyboard.press('Escape');
    ok(true, 'second note created');

    const canvasAfterCreate = await fetchJson(base, 'GET', `/api/projects/${PROJECT}/canvas`);
    ok(canvasAfterCreate.body?.notes?.length === 2, 'both notes persisted via API');

    // --- Connect A → B by dragging from A's right free dot onto B ---
    const noteIds = await page.$$eval('.note', els => els.map(e => e.dataset.noteId));
    const [idA, idB] = noteIds;
    // Select A so its free dots are interactable.
    await page.click(`[data-note-id="${idA}"] .note-header`);
    const dot = await page.$(`[data-note-id="${idA}"] .conn-dot-free.conn-dot-right`);
    ok(!!dot, 'selected note exposes a free right port dot');

    const dotBox = await dot.boundingBox();
    const targetEl = await page.$(`[data-note-id="${idB}"]`);
    const targetBox = await targetEl.boundingBox();
    await page.mouse.move(dotBox.x + dotBox.width / 2, dotBox.y + dotBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(targetBox.x - 2, targetBox.y + targetBox.height / 2, { steps: 12 });
    await page.mouse.up();

    await waitFor(async () => {
      const r = await fetchJson(base, 'GET', `/api/projects/${PROJECT}/canvas`);
      return (r.body?.connections || []).length === 1;
    }, 'connection persisted');
    ok(true, 'port drag creates a connection');
    await waitFor(() => page.$('.conn-path'), 'connection path rendered');
    ok(true, 'connection path renders in the SVG layer');
    await waitFor(() => page.$('.cluster-frame'), 'cluster frame rendered');
    ok(true, 'cluster frame appears for connected notes');

    // --- Lasso both notes (shift+drag on empty space), promote button shows ---
    await page.keyboard.down('Shift');
    await page.mouse.move(box.x + 150, box.y + 150);
    await page.mouse.down();
    await page.mouse.move(box.x + 1000, box.y + 700, { steps: 8 });
    await page.mouse.up();
    await page.keyboard.up('Shift');
    const selectedCount = await page.$$eval('.note.selected', els => els.length);
    ok(selectedCount === 2, 'lasso selects both notes');

    await waitFor(() => page.$('.canvas-promote-btn'), 'promote button');
    const promoteLabel = await page.$eval('.canvas-promote-btn', el => el.textContent);
    ok(/Task/.test(promoteLabel), 'promote button appears for the selection');

    // Promote opens the confirm modal (cancel — the Specify pipeline has its
    // own API-level tests).
    await page.click('.canvas-promote-btn');
    await waitFor(() => page.evaluate(() =>
      [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Create Task')
    ), 'promote confirm modal');
    ok(true, 'promote opens the Create Task confirmation');
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Cancel');
      btn?.click();
    });

    // --- Ctrl+wheel zoom changes the viewport transform ---
    const before = await page.$eval('.canvas-viewport', el => el.style.transform);
    await page.mouse.move(box.x + 500, box.y + 400);
    await page.keyboard.down('Control');
    await page.mouse.wheel({ deltaY: -120 });
    await page.keyboard.up('Control');
    const after = await waitFor(async () => {
      const t = await page.$eval('.canvas-viewport', el => el.style.transform);
      return t !== before ? t : null;
    }, 'zoom transform change');
    ok(/scale\(1\.1/.test(after), 'Ctrl+wheel zooms toward the cursor (scale 1.1)');
  } finally {
    if (browser) await browser.close().catch(() => {});
    child.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 300));
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log(`\n# results: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log('# failures:');
    for (const f of failures) console.log(`#   - ${f}`);
    process.exitCode = 1;
  }
}

run().catch(err => {
  console.error('# fatal:', err.message);
  process.exitCode = 1;
});
