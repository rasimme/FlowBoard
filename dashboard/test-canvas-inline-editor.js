'use strict';

// T-345-9 — Inline card editor on CodeMirror (refined-B).
//
// The short-note inline editor is now the shared CodeMirror MarkdownEditor
// WITHOUT its built-in button toolbar; the floating CanvasToolbar above the
// card drives formatting. This drives the real dashboard build headless
// (puppeteer-core + Edge, same harness as test-canvas-dblclick.js /
// test-canvas-sidebar-save.js) against an isolated server/workspace.
//
// Cases:
//   1. double-click a short note      -> inline .cm-editor inside the card
//   2. the inline editor renders NO .markdown-editor-toolbar (the enge-cause)
//   3. the card keeps its width (optic unchanged)
//   4. floating-toolbar Bold wraps the selection in **…** in the editor
//   5. blur persists the formatted text (GET /canvas)
//   6. Escape persists too (save-on-cancel semantics)
// Build dist before running.

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = __dirname;
const PORT = 18830;
const PROJECT = 'canvas-inline-editor';
const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';

let pass = 0;
let fail = 0;
const failures = [];
function ok(c, m) {
  if (c) { pass++; console.log(`  ok - ${m}`); }
  else { fail++; failures.push(m); console.log(`  not ok - ${m}`); }
}

async function fetchJson(base, method, urlPath, body) {
  const res = await fetch(base + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
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
  let last;
  while (Date.now() - t < timeout) {
    try { last = await fn(); if (last) return last; } catch {}
    await new Promise(r => setTimeout(r, 120));
  }
  throw new Error(`timeout: ${label} (last=${JSON.stringify(last)})`);
}

// CDP-correct double click (see test-canvas-dblclick.js): two down/up pairs.
async function doubleClickAt(page, x, y) {
  await page.mouse.move(x, y);
  await page.mouse.down({ clickCount: 1 });
  await page.mouse.up({ clickCount: 1 });
  await page.mouse.down({ clickCount: 2 });
  await page.mouse.up({ clickCount: 2 });
}

async function inlineEditorState(page, id) {
  return page.evaluate((nid) => {
    const card = document.querySelector(`[data-note-id="${nid}"]`);
    if (!card) return { cm: false, toolbar: false, width: 0 };
    return {
      // CodeMirror present inside the card (the editor mounted inline)
      cm: !!card.querySelector('.cm-editor'),
      // The built-in MarkdownEditor toolbar must NOT render inline (the
      // hideToolbar prop). This is what used to make the 160px card too tight.
      toolbar: !!card.querySelector('.markdown-editor-toolbar'),
      width: card.getBoundingClientRect().width,
    };
  }, id);
}

async function makeShortNote(page, base, box, x, y, text) {
  const before = await page.$$eval('.note', els => els.length);
  await doubleClickAt(page, box.x + x, box.y + y);
  await waitFor(() => page.$$('.note').then(els => els.length === before + 1), 'note created');
  await page.waitForSelector('.note .cm-editor', { timeout: 5000 });
  if (text) await page.keyboard.type(text);
  await page.keyboard.press('Escape');
  await waitFor(() => page.$('.note .cm-editor').then(e => !e), 'editor closed after create');
  const ids = await page.$$eval('.note', els => els.map(e => e.dataset.noteId));
  return ids[ids.length - 1];
}

async function openInlineEditor(page, id) {
  const textBox = await page.evaluate((nid) => {
    const el = document.querySelector(`[data-note-id="${nid}"] [data-note-body]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { cx: r.x + r.width / 2, cy: r.y + Math.min(r.height / 2, 14) };
  }, id);
  if (!textBox) throw new Error(`note ${id} body not found`);
  await doubleClickAt(page, textBox.cx, textBox.cy);
  await waitFor(() => page.$(`[data-note-id="${id}"] .cm-editor`), 'inline editor opens');
}

async function run() {
  console.log('# Canvas inline CodeMirror editor (T-345-9)');

  if (!fs.existsSync(EDGE)) { console.log('  skip - Microsoft Edge not found'); return; }
  if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    throw new Error('dist/index.html missing — run `npx vite build` first');
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-inline-editor-'));
  fs.mkdirSync(path.join(tmp, 'workspace/projects'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'projects'), { recursive: true });
  const base = `http://127.0.0.1:${PORT}`;

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      FLOWBOARD_PORT: String(PORT),
      FLOWBOARD_HOST: '127.0.0.1',
      OPENCLAW_WORKSPACE: path.join(tmp, 'workspace'),
      FLOWBOARD_PROJECTS_DIR: path.join(tmp, 'projects'),
      HZL_DB_PATH: path.join(tmp, 'fb.db'),
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
    const created = await fetchJson(base, 'POST', '/api/projects', { name: PROJECT });
    ok(created.status === 201, 'creates isolated test project');

    const puppeteer = require('puppeteer-core');
    browser = await puppeteer.launch({
      executablePath: EDGE,
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1280,900'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(base + '/', { waitUntil: 'networkidle2' });
    await page.evaluate((p) => {
      window.appState.viewedProject = p;
      window.appState.currentTab = 'ideas';
      window.dispatchEvent(new CustomEvent('appstate:change'));
    }, PROJECT);
    await page.waitForSelector('[data-react-canvas]', { timeout: 8000 });
    ok(true, 'React canvas view renders');

    const wrap = await page.$('[data-react-canvas]');
    const box = await wrap.boundingBox();

    // --- Setup: a short note ---
    const shortId = await makeShortNote(page, base, box, 300, 260, 'hello world');
    const widthClosed = await page.evaluate((nid) =>
      document.querySelector(`[data-note-id="${nid}"]`).getBoundingClientRect().width, shortId);

    // --- Case 1+2+3: open inline editor ---
    await openInlineEditor(page, shortId);
    const st = await inlineEditorState(page, shortId);
    ok(st.cm, 'double-click opens an inline CodeMirror (.cm-editor) in the card');
    ok(!st.toolbar, 'inline editor renders NO .markdown-editor-toolbar (hideToolbar)');
    ok(Math.abs(st.width - widthClosed) < 2, 'card keeps its width while editing (optic unchanged)');

    // The floating toolbar must be visible with a format section while editing.
    await waitFor(() => page.$('.canvas-floating-toolbar .toolbar-format'), 'floating toolbar format section visible');

    // --- Case 4: select all text, click the floating Bold button -> **...** ---
    await page.focus(`[data-note-id="${shortId}"] .cm-content`).catch(() => {});
    await page.evaluate((nid) => {
      const card = document.querySelector(`[data-note-id="${nid}"]`);
      card.querySelector('.cm-content')?.focus();
    }, shortId);
    await page.keyboard.down('Meta'); await page.keyboard.press('a'); await page.keyboard.up('Meta');

    // Click the Bold button in the floating toolbar (title "Bold").
    const boldClicked = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('.canvas-floating-toolbar .toolbar-format .toolbar-btn')];
      const bold = btns.find(b => (b.getAttribute('title') || '').toLowerCase() === 'bold') || btns[0];
      if (!bold) return false;
      // Mimic the real interaction: mousedown (preventDefault keeps editor
      // focus) then click.
      bold.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      bold.click();
      return true;
    });
    ok(boldClicked, 'floating toolbar exposes a Bold button in edit mode');

    const editorText = await waitFor(async () => {
      const txt = await page.evaluate((nid) =>
        document.querySelector(`[data-note-id="${nid}"] .cm-content`)?.textContent || '', shortId);
      return txt.includes('**') ? txt : null;
    }, 'bold wraps selection').catch(() => null);
    ok(editorText && editorText.includes('**hello world**'),
      'Bold wraps the selection in **…** in the inline editor');

    // --- Case 5: blur persists the formatted text ---
    // Real click on empty canvas → moves focus out of CodeMirror → focusout →
    // the container onBlur commits (same path as the old textarea).
    // Click empty canvas well away from the card AND from the bottom-right
    // minimap / top toolbar (both are data-canvas-ui and would not blur).
    await page.mouse.click(box.x + box.width - 120, box.y + 120);
    const saved = await waitFor(async () => {
      const r = await fetchJson(base, 'GET', `/api/projects/${PROJECT}/canvas`);
      const n = r.body?.notes?.find(x => x.id === shortId);
      return n && n.text.includes('**hello world**') ? n : null;
    }, 'blur persists formatted text').catch(() => null);
    ok(saved, 'blur persists the bold-formatted text (GET /canvas)');
    // Editor must have closed on blur.
    await waitFor(() => page.$(`[data-note-id="${shortId}"] .cm-editor`).then(e => !e),
      'editor closed on blur').then(() => ok(true, 'inline editor closes on blur'))
      .catch(() => ok(false, 'inline editor closes on blur'));

    // --- Case 6: Escape also persists (save-on-cancel) ---
    await openInlineEditor(page, shortId);
    await page.evaluate((nid) => {
      document.querySelector(`[data-note-id="${nid}"] .cm-content`)?.focus();
    }, shortId);
    await page.keyboard.down('Meta'); await page.keyboard.press('a'); await page.keyboard.up('Meta');
    await page.keyboard.type('escaped text');
    await page.keyboard.press('Escape');
    const escSaved = await waitFor(async () => {
      const r = await fetchJson(base, 'GET', `/api/projects/${PROJECT}/canvas`);
      const n = r.body?.notes?.find(x => x.id === shortId);
      return n && n.text === 'escaped text' ? n : null;
    }, 'escape persists text').catch(() => null);
    ok(escSaved, 'Escape persists the inline edit (save-on-cancel)');
  } catch (err) {
    ok(false, `unexpected error: ${err.message}`);
    if (logs) console.log('--- server logs ---\n' + logs.slice(-2000));
  } finally {
    if (browser) await browser.close().catch(() => {});
    child.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 300));
    fs.rmSync(tmp, { recursive: true, force: true });
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
