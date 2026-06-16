'use strict';

// T-345-8 — Open links from note cards (single-click, with double-click guard).
//
// Follow-on to T-345-6. A clean single click on a rendered link inside a note
// card opens the link via window.open after a ~280ms guard window; a
// double-click on the same link must NOT open the link but instead open the
// editor / sidebar (the T-345-6 behaviour). A single click on plain note text
// (not a link) opens nothing.
//
// The hard part: the rendered markdown (.note-text) is pointer-events:none
// (T-345-6), so the inner <a> is never an event target and elementFromPoint
// never returns it. CanvasView resolves the link by geometrically hit-testing
// the click point against the <a> getClientRects of the clicked note, and
// opens the href only after the double-click guard timer elapses.
//
// Drives the real dashboard build headless (puppeteer-core + Edge, same harness
// as test-canvas-dblclick.js / test-canvas-inline-editor.js) against an
// isolated server + temp workspace. window.open is stubbed so no real tab is
// opened and the test can assert the exact URL.
//
// Cases (short card with a link, and a long/truncated card with a link):
//   1. single-click ON the link in a short card   -> window.open(http url)
//   2. single-click on NON-link text in the card   -> no window.open
//   3. double-click ON the link                     -> NO window.open, editor opens
//   4. single-click ON the link in a long card      -> window.open (works for long cards too)
//   5. double-click ON the link in a long card       -> NO window.open, sidebar opens
// Run twice for stability. Build dist before running.

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = __dirname;
const DASHBOARD_PORT = 18831;
const PROJECT = 'canvas-links';
const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const LINK_URL = 'https://example.com/';
const GUARD_MS = 280; // must match LINK_OPEN_DELAY in CanvasView.jsx

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

// Install / reset a window.open stub that records every call. Returns nothing;
// read calls back via getOpenCalls().
async function resetOpenStub(page) {
  await page.evaluate(() => {
    window.__openCalls = [];
    if (!window.__openStubbed) {
      window.open = (url, target, features) => {
        window.__openCalls.push({ url, target, features });
        return null; // never actually open a tab in headless
      };
      window.__openStubbed = true;
    }
  });
}

async function getOpenCalls(page) {
  return page.evaluate(() => window.__openCalls.slice());
}

// H1 — capture window.showToast calls so we can assert the pop-up-blocked
// warning. window.open already returns null in the stub above (headless never
// opens a tab), which is exactly the "pop-up blocked" signal CanvasView checks.
async function resetToastStub(page) {
  await page.evaluate(() => {
    window.__toastCalls = [];
    window.showToast = (msg, type) => { window.__toastCalls.push({ msg, type }); };
  });
}

async function getToastCalls(page) {
  return page.evaluate(() => (window.__toastCalls || []).slice());
}

// CDP-correct double click (two down/up pairs with rising clickCount).
async function doubleClickAt(page, x, y) {
  await page.mouse.move(x, y);
  await page.mouse.down({ clickCount: 1 });
  await page.mouse.up({ clickCount: 1 });
  await page.mouse.down({ clickCount: 2 });
  await page.mouse.up({ clickCount: 2 });
}

async function singleClickAt(page, x, y) {
  await page.mouse.move(x, y);
  await page.mouse.down({ clickCount: 1 });
  await page.mouse.up({ clickCount: 1 });
}

async function editorState(page) {
  return page.evaluate(() => {
    const inline = !!document.querySelector('.note-editor-inline .cm-editor');
    const sidebarOpen = !!document.querySelector('.canvas-sidebar.open');
    return { inline, sidebarOpen };
  });
}

async function closeEditors(page) {
  await page.evaluate(() => {
    const cm = document.querySelector('.note-editor-inline .cm-content');
    if (cm) cm.blur();
    const close = document.querySelector('.canvas-sidebar.open .canvas-sidebar-close');
    if (close) close.click();
  });
  await page.keyboard.press('Escape');
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
  const ids = await page.$$eval('.note', els => els.map(e => e.dataset.noteId));
  return ids[ids.length - 1];
}

// Center of the first rendered <a> in a note (client coords).
async function linkCenter(page, id) {
  return page.evaluate((nid) => {
    const a = document.querySelector(`[data-note-id="${nid}"] .note-text a`);
    if (!a) return null;
    const r = a.getBoundingClientRect();
    return { cx: r.x + r.width / 2, cy: r.y + r.height / 2, w: r.width, h: r.height };
  }, id);
}

// A point inside the note body that is NOT over any link.
async function nonLinkPoint(page, id) {
  return page.evaluate((nid) => {
    const body = document.querySelector(`[data-note-id="${nid}"] [data-note-body]`);
    const a = document.querySelector(`[data-note-id="${nid}"] .note-text a`);
    if (!body) return null;
    const br = body.getBoundingClientRect();
    const ar = a ? a.getBoundingClientRect() : null;
    // Sample points within the body; pick the first that misses the link rect.
    for (const fy of [0.85, 0.7, 0.55, 0.4, 0.25]) {
      const px = br.x + br.width * 0.5;
      const py = br.y + br.height * fy;
      const inLink = ar && px >= ar.left && px <= ar.right && py >= ar.top && py <= ar.bottom;
      if (!inLink) return { cx: px, cy: py };
    }
    return null;
  }, id);
}

async function runPass(page, base, box, label) {
  console.log(`\n## ${label}`);

  // Short card: a single short line containing a link (renders inline editor on
  // dblclick, link is the only content so it is easy to hit).
  const shortText = `See [the docs](${LINK_URL}) here.`;
  const shortId = await makeNote(page, base, box, 300, 240, shortText);

  // Long card: a link near the top plus many lines so the body is truncated
  // (sidebar branch on dblclick) — proves the link open works for long cards.
  const longText = `Start [the docs](${LINK_URL}) link.\n`
    + Array.from({ length: 24 }, (_, i) => `Zeile ${i + 1} mit genug Inhalt damit der Body abgeschnitten wird.`).join('\n');
  const longId = await makeNote(page, base, box, 780, 300, longText);

  const isTruncated = await page.evaluate((nid) =>
    !!document.querySelector(`[data-note-id="${nid}"] [data-note-body].truncated`), longId);
  ok(isTruncated, `${label}: long note is truncated (sidebar branch active)`);

  const shortHasLink = await page.evaluate((nid) =>
    !!document.querySelector(`[data-note-id="${nid}"] .note-text a`), shortId);
  ok(shortHasLink, `${label}: short note renders a link`);

  // --- Case 1: single-click ON the link in the short card -> window.open ---
  await resetOpenStub(page);
  let lc = await linkCenter(page, shortId);
  ok(lc, `${label}: short-card link rect resolved`);
  await singleClickAt(page, lc.cx, lc.cy);
  let calls = await waitFor(async () => {
    const c = await getOpenCalls(page);
    return c.length > 0 ? c : null;
  }, 'case1 window.open', 2000).catch(() => []);
  ok(calls.length === 1, `${label}: single-click on link calls window.open once`);
  ok(calls[0] && /^https?:\/\//.test(calls[0].url || ''), `${label}: window.open got an http(s) url (${calls[0]?.url})`);
  ok(calls[0] && calls[0].url === LINK_URL, `${label}: window.open url matches the link href`);
  ok(calls[0] && calls[0].target === '_blank', `${label}: window.open target is _blank`);
  ok(calls[0] && /noopener/.test(calls[0].features || ''), `${label}: window.open features include noopener`);
  let st = await editorState(page);
  ok(!st.inline && !st.sidebarOpen, `${label}: single-click on link did not open the editor`);
  await closeEditors(page);

  // --- Case 2: single-click on NON-link text -> NO window.open ---
  await resetOpenStub(page);
  const np = await nonLinkPoint(page, shortId);
  ok(np, `${label}: found a non-link point in the short card`);
  if (np) {
    await singleClickAt(page, np.cx, np.cy);
    await new Promise(r => setTimeout(r, GUARD_MS + 220));
    calls = await getOpenCalls(page);
    ok(calls.length === 0, `${label}: single-click on non-link text opens nothing`);
  }
  await closeEditors(page);

  // --- Case 3: double-click ON the link -> NO window.open, editor opens ---
  await resetOpenStub(page);
  lc = await linkCenter(page, shortId);
  await doubleClickAt(page, lc.cx, lc.cy);
  st = await waitFor(async () => {
    const s = await editorState(page);
    return (s.inline || s.sidebarOpen) ? s : null;
  }, 'case3 editor opens', 3000).catch(() => null);
  ok(st && st.inline, `${label}: double-click on link opens the inline editor (short card)`);
  // Wait past the guard window: the cancelled timer must never fire.
  await new Promise(r => setTimeout(r, GUARD_MS + 220));
  calls = await getOpenCalls(page);
  ok(calls.length === 0, `${label}: double-click on link does NOT open the link`);
  await closeEditors(page);

  // --- Case 4: single-click ON the link in the LONG card -> window.open ---
  await resetOpenStub(page);
  lc = await linkCenter(page, longId);
  ok(lc, `${label}: long-card link rect resolved`);
  await singleClickAt(page, lc.cx, lc.cy);
  calls = await waitFor(async () => {
    const c = await getOpenCalls(page);
    return c.length > 0 ? c : null;
  }, 'case4 window.open', 2000).catch(() => []);
  ok(calls.length === 1 && calls[0].url === LINK_URL,
    `${label}: single-click on link in long card opens the link`);
  st = await editorState(page);
  ok(!st.inline && !st.sidebarOpen, `${label}: single-click on long-card link did not open the sidebar`);
  await closeEditors(page);

  // --- Case 5: double-click ON the link in the LONG card -> sidebar, no open ---
  await resetOpenStub(page);
  lc = await linkCenter(page, longId);
  await doubleClickAt(page, lc.cx, lc.cy);
  st = await waitFor(async () => {
    const s = await editorState(page);
    return (s.inline || s.sidebarOpen) ? s : null;
  }, 'case5 sidebar opens', 3000).catch(() => null);
  ok(st && st.sidebarOpen && !st.inline,
    `${label}: double-click on link in long card opens the sidebar (not inline)`);
  await new Promise(r => setTimeout(r, GUARD_MS + 220));
  calls = await getOpenCalls(page);
  ok(calls.length === 0, `${label}: double-click on long-card link does NOT open the link`);
  await closeEditors(page);

  // --- Case 6 (H1): pop-up blocked → window.open returns null → warn toast,
  //     no crash. The stub returns null (blocked); CanvasView must surface a
  //     warning toast and keep working (a follow-up click still opens). ---
  await resetOpenStub(page);
  await resetToastStub(page);
  lc = await linkCenter(page, shortId);
  ok(lc, `${label}: short-card link rect resolved (H1)`);
  await singleClickAt(page, lc.cx, lc.cy);
  let toasts = await waitFor(async () => {
    const t = await getToastCalls(page);
    return t.length > 0 ? t : null;
  }, 'case6 popup-blocked toast', 2000).catch(() => []);
  ok(toasts.some(t => t.type === 'warn' && /pop-?up blocked/i.test(t.msg || '')),
    `${label}: blocked window.open shows a 'warn' pop-up-blocked toast`);
  calls = await getOpenCalls(page);
  ok(calls.length === 1, `${label}: window.open was still attempted once when blocked`);
  // No crash: the canvas is still interactive (a second click still attempts open).
  await closeEditors(page);
  lc = await linkCenter(page, shortId);
  await singleClickAt(page, lc.cx, lc.cy);
  calls = await waitFor(async () => {
    const c = await getOpenCalls(page);
    return c.length >= 2 ? c : null;
  }, 'case6 second open after block', 2000).catch(() => []);
  ok(calls.length >= 2, `${label}: canvas still works after a blocked pop-up (no crash)`);
  await closeEditors(page);

  // Cleanup so the next pass starts clean.
  for (const id of [shortId, longId]) {
    await fetchJson(base, 'DELETE', `/api/projects/${PROJECT}/canvas/notes/${id}`).catch(() => {});
  }
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('flowboard:canvas-reload')));
  await waitFor(() => page.$$('.note').then(els => els.length === 0), 'notes cleared');
}

async function run() {
  console.log('# Canvas open-link single-click + double-click guard (T-345-8)');

  if (!fs.existsSync(EDGE)) {
    console.log('  skip - Microsoft Edge not found; links test skipped');
    return;
  }
  if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    throw new Error('dist/index.html missing — run `npx vite build` first');
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-canvas-links-'));
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

    // Two passes — stability.
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
