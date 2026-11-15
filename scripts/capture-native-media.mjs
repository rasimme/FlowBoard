#!/usr/bin/env node
// Capture the demo media of FlowBoard running as a native page inside the
// OpenClaw Control UI: the tour GIF (Overview -> Ideas -> Tasks -> Files) and
// three stills (page, "Needs me" widget, session task panel).
//
// Run it against a DISPOSABLE Gateway and dashboard, never your own instance:
//
//   1. an isolated dashboard seeded with `node scripts/v5-demo-fixture.mjs seed`
//      (and, for a two-week history, `node scripts/v5-demo-backdate.mjs`)
//   2. an isolated Gateway (own OPENCLAW_STATE_DIR, config and TMPDIR) with this
//      plugin installed, the Custom plugin UI lab on and `dashboardBaseUrl`
//      pointing at that dashboard
//
//   FLOWBOARD_GATEWAY_URL=http://localhost:18880 OPENCLAW_GATEWAY_TOKEN=... \
//     node scripts/capture-native-media.mjs [--gif] [--stills]
//
// Names the host shows (operator, session titles) are replaced on every frame.
// Set FLOWBOARD_CAPTURE_FORBIDDEN to a regex of text that must never appear;
// the run fails if a frame still contains it. Encoding needs gifski on PATH.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(repoRoot, 'dashboard', 'package.json'));
const puppeteer = require('puppeteer-core');

const GW = (process.env.FLOWBOARD_GATEWAY_URL || 'http://localhost:18880').replace(/\/$/, '');
const TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || '';
const PROJECT = process.env.FLOWBOARD_DEMO_PROJECT || 'flowboard-v5-demo';
const FORBIDDEN = process.env.FLOWBOARD_CAPTURE_FORBIDDEN || '';
const FRAMES = resolve(repoRoot, '.tmp', 'native-gif-frames');
const DOCS = resolve(repoRoot, 'docs');
const ROOT = '.fb-native-root';
const args = process.argv.slice(2);
const wantGif = args.length === 0 || args.includes('--gif');
const wantStills = args.length === 0 || args.includes('--stills');

if (!TOKEN) throw new Error('Set OPENCLAW_GATEWAY_TOKEN to the disposable Gateway\'s token.');
const browserPath = [
  process.env.FLOWBOARD_BROWSER,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((candidate) => candidate && existsSync(candidate));
if (!browserPath) throw new Error('No Chromium-based browser found; set FLOWBOARD_BROWSER.');

const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const hash = `#token=${TOKEN}`;
// Query through shadow roots: host panels and widgets live in them.
const deep = `(sel) => { const acc = []; const walk = (root) => { for (const el of root.querySelectorAll(sel)) acc.push(el); for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot); }; walk(document); return acc; }`;
const MASK = `((forbidden) => {
  const all = ${deep};
  const set = (sel, text) => all(sel).forEach((e) => { if (e.textContent !== text) e.textContent = text; });
  set('.sidebar-identity-card__name .hover-marquee__text', 'Operator');
  set('.sidebar-online__person-name', 'Operator');
  set('.sidebar-recent-session__name .hover-marquee__text', 'launch-review');
  set('.chat-pane__session-title-text', 'launch-review');
  all('.community-invite-card').forEach((e) => { e.style.display = 'none'; });
  all('.sidebar-identity-card img, .sidebar-online__person img').forEach((e) => { e.style.visibility = 'hidden'; });
  return forbidden ? new RegExp(forbidden).test(document.body.innerText) : false;
})(${JSON.stringify(FORBIDDEN)})`;

const browser = await puppeteer.launch({ executablePath: browserPath, headless: 'new', args: ['--no-sandbox', '--window-size=1600,900', '--lang=en-US'] });
let leaks = 0;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1.5 });
  // The Control UI picks its language from the browser locale on first load.
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'language', { get: () => 'en-US' });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  });
  const go = async (path, settle) => {
    await page.goto(`${GW}${path}${hash}`, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
    await wait(settle);
  };
  const shot = async (file) => {
    if (await page.evaluate(MASK)) leaks += 1;
    await page.screenshot({ path: file });
  };
  const clickDeep = (pattern) => page.evaluate(`((re) => { const el = (${deep})('button,[role="menuitem"],[role="tab"],a').find((e) => new RegExp(re, 'i').test((e.getAttribute('aria-label') || '') + ' ' + (e.title || '') + ' ' + (e.innerText || '')) && e.getBoundingClientRect().width > 0); el?.click(); return !!el; })(${JSON.stringify(pattern)})`);
  const tab = async (name) => { await page.click(`${ROOT} [data-tab="${name}"]`); await wait(2500); };
  const openPage = async () => {
    await go('/', 5000);
    await page.keyboard.press('Escape'); // first-run dialog of a fresh Gateway
    await wait(800);
    await go(`/plugin?plugin=flowboard&id=flowboard&p.project=${PROJECT}`, 8000);
  };

  if (wantGif) {
    rmSync(FRAMES, { recursive: true, force: true });
    mkdirSync(FRAMES, { recursive: true });
    let n = 0;
    const frames = async (count, gap = 120) => {
      for (let i = 0; i < count; i += 1) { await shot(`${FRAMES}/f${String(n).padStart(4, '0')}.png`); n += 1; await wait(gap); }
    };
    const scrollOverview = (y) => page.evaluate((root, top) => {
      const sc = [...document.querySelectorAll(`${root} *`)].find((e) => e.scrollHeight > e.clientHeight + 150 && /auto|scroll/.test(getComputedStyle(e).overflowY) && e.getBoundingClientRect().height > 500);
      if (sc) sc.scrollTop = top;
    }, ROOT, y);

    await openPage();
    await wait(4000);
    // Overview: dwell, scroll to the lower widgets, dwell
    await frames(14);
    for (let i = 1; i <= 12; i += 1) { await scrollOverview(i * 40); await frames(1, 40); }
    await frames(12);
    // Ideas: select a note, open "create task"
    await tab('ideas'); await frames(10);
    await page.click(`${ROOT} .note.color-teal`); await wait(600); await frames(6);
    await page.click(`${ROOT} .canvas-promote-btn`); await wait(900); await frames(10);
    await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Cancel')?.click());
    await wait(500);
    // Tasks: expand the first parent with subtasks
    await tab('tasks'); await frames(10);
    await page.evaluate((root) => document.querySelector(`${root} .expand-chevron`)?.click(), ROOT); await wait(700);
    for (let i = 1; i <= 8; i += 1) {
      await page.evaluate((root, k) => { const body = document.querySelector(`${root} .subtask-container`)?.closest('.column-body'); if (body) body.scrollTop = ((body.scrollHeight - body.clientHeight) * k) / 8; }, ROOT, i);
      await frames(1, 40);
    }
    await frames(12);
    // Files: open a task spec
    await tab('files'); await frames(7);
    await page.evaluate((root) => [...document.querySelectorAll(`${root} .tree-item.directory`)].find((e) => /^specs/.test(e.textContent.trim()))?.click(), ROOT);
    await wait(700); await frames(4);
    await page.evaluate((root) => [...document.querySelectorAll(`${root} .tree-item`)].find((e) => /release-smoke/.test(e.textContent))?.click(), ROOT);
    await wait(1500); await frames(14);

    const out = resolve(DOCS, 'demo.gif');
    rmSync(out, { force: true });
    const encode = spawnSync('sh', ['-c', `gifski --fps 8 --width 1280 --quality 100 -o "${out}" "${FRAMES}"/f*.png`], { stdio: 'inherit' });
    if (encode.status !== 0) throw new Error('gifski encode failed (is gifski on PATH?)');
    rmSync(FRAMES, { recursive: true, force: true });
    console.log(`wrote ${out} (${n} frames)`);
  }

  if (wantStills) {
    await openPage();
    await wait(3000);
    await shot(resolve(DOCS, 'screenshot-openclaw-page.png'));
    // A session: the dashboard with the "Needs me" widget, then the task panel.
    await go('/', 5000);
    await page.keyboard.press('Escape'); await wait(800);
    await page.evaluate(`(() => { (${deep})('.sidebar-recent-session__name')[0]?.closest('a,button')?.click(); })()`);
    await wait(5000);
    const session = page.url().split('#')[0].replace(GW, '');
    await go(`${session}?dashboard=expanded`, 8000);
    await shot(resolve(DOCS, 'screenshot-openclaw-widget.png'));
    await go(session, 5000);
    await clickDeep('^\\s*Side panel'); await wait(2000);
    await clickDeep('^\\s*FlowBoard task'); await wait(6000);
    await shot(resolve(DOCS, 'screenshot-openclaw-panel.png'));
    console.log('wrote docs/screenshot-openclaw-{page,widget,panel}.png');
  }
} finally {
  await browser.close();
}
if (leaks > 0) {
  console.error(`${leaks} frame(s) contained text matching FLOWBOARD_CAPTURE_FORBIDDEN — do not publish this media.`);
  process.exit(1);
}
