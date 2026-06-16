'use strict';

// T-345-6 — Double-click / edit-open robustness regression (Intermittenz-Fix).
//
// Reproduces the user-reported flakiness "double-clicking directly on the note
// text does not always open the edit". Drives the real dashboard build headless
// (puppeteer-core + Edge, same browser as test-canvas-browser-smoke.js) against
// an isolated server/workspace.
//
// The intermittence comes from the note-drag heuristic stealing the gesture:
// a tiny pointer jitter between the two clicks crosses the 5px drag threshold,
// the note is physically repositioned and a notes-moved commit re-renders the
// element, so the browser never synthesizes the native `dblclick`. CanvasView
// must open edit/sidebar reliably regardless of that micro-movement.
//
// Cases covered (each must open the editor / sidebar):
//   1. clean double-click on the note text          -> inline editor (short note)
//   2. double-click with a few px jitter between clicks (the reported bug)
//   3. double-click on an already-selected note
//   4. double-click on formatted content (a rendered link)
//   5. double-click on a long (truncated) note       -> sidebar, not inline
// Run twice for stability (flake catcher). Build dist before running.

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = __dirname;
const DASHBOARD_PORT = 18824;
const PROJECT = 'canvas-dblclick';
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

async function waitFor(fn, label, timeout = 8000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for ${label}`);
}

// CDP-correct double click: two down/up pairs with increasing clickCount. A
// plain mouse.click({clickCount:2}) does not synthesize a `dblclick` event.
// `jitter` displaces the pointer by N px between the first up and the second
// down (and slightly during), reproducing the human micro-movement that used
// to cross the 5px drag threshold and eat the gesture.
async function doubleClickAt(page, x, y, jitter = 0) {
  await page.mouse.move(x, y);
  await page.mouse.down({ clickCount: 1 });
  await page.mouse.up({ clickCount: 1 });
  if (jitter) {
    // Move within the OS double-click distance budget but past the app's 5px
    // L1 drag threshold so moveNoteDrag would historically set moved=true.
    await page.mouse.move(x + jitter, y + jitter);
  }
  await page.mouse.down({ clickCount: 2 });
  if (jitter) await page.mouse.move(x + jitter + 1, y + jitter, { steps: 2 });
  await page.mouse.up({ clickCount: 2 });
}

// Editor is "open" when an inline textarea exists OR the sidebar editor is open.
async function editorState(page) {
  return page.evaluate(() => {
    // T-345-9: the inline card editor is now the CodeMirror MarkdownEditor
    // (.note-editor-inline > .cm-editor), no longer a <textarea>.
    const inline = !!document.querySelector('.note-editor-inline .cm-editor');
    // The sidebar (MarkdownEditor) is always mounted; it is "open" only when it
    // carries the .open class (CanvasView dispatches the sidebar action).
    const sidebarOpen = !!document.querySelector('.canvas-sidebar.open');
    return { inline, sidebarOpen };
  });
}

async function closeEditors(page) {
  // Blur any inline editor and close the sidebar via its close button (the
  // sidebar swallows Escape internally), then clear selection.
  await page.evaluate(() => {
    // T-345-9: blur the inline CodeMirror editor (commits on blur).
    const cm = document.querySelector('.note-editor-inline .cm-content');
    if (cm) cm.blur();
    const close = document.querySelector('.canvas-sidebar.open .canvas-sidebar-close');
    if (close) close.click();
  });
  await page.keyboard.press('Escape'); // clear selection
  await waitFor(async () => {
    const st = await editorState(page);
    return (!st.inline && !st.sidebarOpen);
  }, 'editors closed', 4000).catch(() => {});
}

async function makeNote(page, base, box, x, y, text) {
  const before = await page.$$eval('.note', els => els.length);
  await doubleClickAt(page, box.x + x, box.y + y);
  await waitFor(() => page.$$('.note').then(els => els.length === before + 1), 'note created');
  await page.waitForSelector('.note-editor-inline .cm-editor', { timeout: 4000 });
  if (text) await page.keyboard.type(text);
  await page.keyboard.press('Escape');
  await waitFor(async () => {
    const st = await editorState(page);
    return !st.inline && !st.sidebarOpen;
  }, 'editor closed after create');
  // Return the id of the most-recently created note.
  const ids = await page.$$eval('.note', els => els.map(e => e.dataset.noteId));
  return ids[ids.length - 1];
}

async function dblClickNoteText(page, id, jitter = 0) {
  const textBox = await page.evaluate((nid) => {
    const el = document.querySelector(`[data-note-id="${nid}"] [data-note-body]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { cx: r.x + r.width / 2, cy: r.y + Math.min(r.height / 2, 18) };
  }, id);
  if (!textBox) throw new Error(`note ${id} body not found`);
  await doubleClickAt(page, textBox.cx, textBox.cy, jitter);
}

async function runPass(page, base, box, label) {
  console.log(`\n## ${label}`);

  // --- Setup: one short note and one long (truncated) note ---
  const shortId = await makeNote(page, base, box, 280, 260, 'Kurz');
  // Long note: a leading link line plus many lines so the body exceeds the
  // 200px max-height and is actually truncated (sidebar branch).
  const longText = 'Notiz mit [einem Link](https://example.com) am Anfang.\n'
    + Array.from({ length: 24 }, (_, i) => `Zeile ${i + 1} mit genug Inhalt damit der Body abgeschnitten wird.`).join('\n');
  const longId = await makeNote(page, base, box, 760, 300, longText);

  // The long note must actually be truncated for the sidebar branch to apply.
  const isTruncated = await page.evaluate((nid) =>
    !!document.querySelector(`[data-note-id="${nid}"] [data-note-body].truncated`), longId);
  ok(isTruncated, `${label}: long note is truncated (sidebar branch active)`);

  // Record initial positions so we can assert the note did NOT move during dblclick.
  const posBefore = await fetchJson(base, 'GET', `/api/projects/${PROJECT}/canvas`);
  const shortPosBefore = posBefore.body.notes.find(n => n.id === shortId);

  // --- Case 1: clean double-click on short note text -> inline editor ---
  await dblClickNoteText(page, shortId, 0);
  let st = await waitFor(async () => {
    const s = await editorState(page);
    return (s.inline || s.sidebarOpen) ? s : null;
  }, 'case1 editor opens').catch(() => null);
  ok(st && st.inline, `${label}: clean dblclick on short note opens inline editor`);
  await closeEditors(page);

  // --- Case 2: double-click WITH jitter (the reported intermittence) ---
  // 7px diagonal jitter > the app's 5px L1 drag threshold.
  await dblClickNoteText(page, shortId, 7);
  st = await waitFor(async () => {
    const s = await editorState(page);
    return (s.inline || s.sidebarOpen) ? s : null;
  }, 'case2 editor opens').catch(() => null);
  ok(st && st.inline, `${label}: jittered dblclick on short note still opens inline editor`);
  await closeEditors(page);

  // Note must not have drifted from the jitter being mistaken for a drag.
  const posAfter = await fetchJson(base, 'GET', `/api/projects/${PROJECT}/canvas`);
  const shortPosAfter = posAfter.body.notes.find(n => n.id === shortId);
  ok(shortPosAfter.x === shortPosBefore.x && shortPosAfter.y === shortPosBefore.y,
    `${label}: jittered dblclick did not move the note`);

  // --- Case 3: double-click on an already-selected note ---
  await page.evaluate((nid) => {
    const el = document.querySelector(`[data-note-id="${nid}"] .note-header`);
    el?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    el?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
  }, shortId);
  await waitFor(() => page.$(`[data-note-id="${shortId}"].selected`), 'note selected');
  await dblClickNoteText(page, shortId, 3);
  st = await waitFor(async () => {
    const s = await editorState(page);
    return (s.inline || s.sidebarOpen) ? s : null;
  }, 'case3 editor opens').catch(() => null);
  ok(st && st.inline, `${label}: dblclick on already-selected note opens inline editor`);
  await closeEditors(page);

  // --- Case 4: double-click directly on a rendered link inside the long note ---
  const hasLink = await page.evaluate((nid) =>
    !!document.querySelector(`[data-note-id="${nid}"] .note-text a`), longId);
  ok(hasLink, `${label}: long note renders a formatted link`);
  const linkBox = await page.evaluate((nid) => {
    const a = document.querySelector(`[data-note-id="${nid}"] .note-text a`);
    if (!a) return null;
    const r = a.getBoundingClientRect();
    return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
  }, longId);
  if (linkBox) {
    await doubleClickAt(page, linkBox.cx, linkBox.cy, 4);
    st = await waitFor(async () => {
      const s = await editorState(page);
      return (s.inline || s.sidebarOpen) ? s : null;
    }, 'case4 editor opens').catch(() => null);
    ok(st && st.sidebarOpen, `${label}: dblclick on link in long note opens the sidebar`);
    await closeEditors(page);
  }

  // --- Case 5: double-click on long (truncated) note text -> sidebar ---
  await dblClickNoteText(page, longId, 6);
  st = await waitFor(async () => {
    const s = await editorState(page);
    return (s.inline || s.sidebarOpen) ? s : null;
  }, 'case5 editor opens').catch(() => null);
  ok(st && st.sidebarOpen && !st.inline,
    `${label}: jittered dblclick on long note opens sidebar (not inline)`);
  await closeEditors(page);

  // --- Regression guards: single-click select + drag-to-move still work ---
  // Single click selects (does not open editor).
  await page.evaluate((nid) => {
    const el = document.querySelector(`[data-note-id="${nid}"] .note-header`);
    const r = el.getBoundingClientRect();
    const opts = { bubbles: true, button: 0, clientX: r.x + 5, clientY: r.y + 5 };
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
  }, shortId);
  await new Promise(r => setTimeout(r, 150));
  st = await editorState(page);
  ok(!st.inline && !st.sidebarOpen, `${label}: single click selects without opening editor`);
  ok(await page.$(`[data-note-id="${shortId}"].selected`), `${label}: single click selects the note`);

  // Drag-to-move: grab the header and move > threshold; position must change.
  const dragStart = await page.evaluate((nid) => {
    const el = document.querySelector(`[data-note-id="${nid}"] .note-header`);
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, shortId);
  await page.mouse.move(dragStart.x, dragStart.y);
  await page.mouse.down();
  await page.mouse.move(dragStart.x + 60, dragStart.y + 40, { steps: 8 });
  await page.mouse.up();
  const moved = await waitFor(async () => {
    const r = await fetchJson(base, 'GET', `/api/projects/${PROJECT}/canvas`);
    const n = r.body.notes.find(x => x.id === shortId);
    return (n && (n.x !== shortPosBefore.x || n.y !== shortPosBefore.y)) ? n : null;
  }, 'drag moves note').catch(() => null);
  ok(!!moved, `${label}: drag-to-move still repositions the note`);

  // Cleanup: delete both notes so the next pass starts clean.
  for (const id of [shortId, longId]) {
    await fetchJson(base, 'DELETE', `/api/projects/${PROJECT}/canvas/notes/${id}`).catch(() => {});
  }
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('flowboard:canvas-reload')));
  await waitFor(() => page.$$('.note').then(els => els.length === 0), 'notes cleared');
}

async function run() {
  console.log('# Canvas double-click / edit-open robustness (T-345-6)');

  if (!fs.existsSync(EDGE)) {
    console.log('  skip - Microsoft Edge not found; dblclick test skipped');
    return;
  }
  if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    throw new Error('dist/index.html missing — run `npx vite build` first');
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-canvas-dblclick-'));
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

    const res = await fetchJson(base, 'POST', '/api/projects', { name: PROJECT });
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

    await page.evaluate((project) => {
      window.appState.viewedProject = project;
      window.appState.currentTab = 'ideas';
      window.dispatchEvent(new CustomEvent('appstate:change'));
    }, PROJECT);

    await page.waitForSelector('[data-react-canvas]', { timeout: 8000 });
    ok(true, 'React canvas view renders');

    const wrap = await page.$('[data-react-canvas]');
    const box = await wrap.boundingBox();

    // Two passes — flake catcher (the bug was intermittent).
    await runPass(page, base, box, 'run 1');
    await runPass(page, base, box, 'run 2');
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
