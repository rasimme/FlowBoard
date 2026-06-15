'use strict';

// Dashboard-shell E2E safety net (T-356-1). Locks the cross-component behaviors
// that currently flow through window.appState + window._* bridges, so the
// state-layer refactor (T-356-2+) can be done without silently breaking the
// shell. Asserts OBSERVABLE behavior (which view is mounted, board contents,
// detail panel, highlight) rather than the global mechanism, so it stays valid
// as the bridges are replaced. Drives the real build headless (puppeteer-core +
// Edge), same harness as the canvas browser tests.

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = __dirname;
const PORT = 18836;
const PROJECT = 'shell-e2e';
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
  while (Date.now() - t < timeout) { try { const v = await fn(); if (v) return v; } catch {} await new Promise(r => setTimeout(r, 120)); }
  throw new Error(`timeout: ${label}`);
}

async function run() {
  console.log('# Dashboard shell E2E (T-356-1)');
  if (!fs.existsSync(EDGE)) { console.log('  skip - Edge not found'); return; }
  if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) throw new Error('dist missing — run npx vite build first');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-shell-'));
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
    // Register an agent so the agents fetch has something observable to propagate.
    await fetchJson(base, 'PUT', '/api/status', { agentId: 'shell-tester', project: PROJECT });
    const t1 = (await fetchJson(base, 'POST', `/api/projects/${PROJECT}/tasks`, { title: 'Shell task one' })).body?.task?.id;
    const t2 = (await fetchJson(base, 'POST', `/api/projects/${PROJECT}/tasks`, { title: 'Shell task two' })).body?.task?.id;
    ok(!!t1 && !!t2, `seed tasks created (${t1}, ${t2})`);

    const puppeteer = require('puppeteer-core');
    browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    await page.goto(base + '/?agentId=shell-tester', { waitUntil: 'networkidle2' });
    await page.waitForSelector('.app', { timeout: 8000 });
    await page.waitForSelector('#tabBar .tab', { timeout: 8000 });

    // Select the project (real sidebar click when present, else the documented
    // _viewProject entry point — both end in the same reactive update).
    const clicked = await page.evaluate((name) => {
      const items = Array.from(document.querySelectorAll('.project-item'));
      const hit = items.find(el => el.textContent && el.textContent.includes(name));
      if (hit) { hit.click(); return true; }
      if (window._viewProject) { window._viewProject(name); return true; }
      return false;
    }, PROJECT);
    ok(clicked, 'project selectable from the shell');
    await waitFor(() => page.evaluate((p) => window.appState?.viewedProject === p, PROJECT), 'viewedProject updates');
    ok(true, 'selecting a project updates viewedProject (reactive bridge)');

    // --- Flow 1: Tasks tab mounts the board with the seeded tasks ---
    await page.click('#tabBar .tab[data-tab="tasks"]');
    await waitFor(() => page.$('.kanban'), 'kanban mounts');
    ok(await page.evaluate(() => document.querySelector('.app')?.dataset.view === 'tasks'), 'tab switch → .app[data-view]=tasks');
    const cardCount = await waitFor(async () => {
      const n = await page.$$eval('[data-task-id]', els => els.length);
      return n >= 2 ? n : null;
    }, 'task cards render');
    ok(cardCount >= 2, `board shows the project's tasks (${cardCount})`);

    // --- Flow 2: Ideas tab mounts the canvas, then back to tasks ---
    await page.click('#tabBar .tab[data-tab="ideas"]');
    await waitFor(() => page.$('[data-react-canvas]'), 'canvas mounts');
    ok(await page.evaluate(() => document.querySelector('.app')?.dataset.view === 'ideas'), 'tab switch → ideas mounts canvas');
    await page.click('#tabBar .tab[data-tab="tasks"]');
    await waitFor(() => page.$('.kanban'), 'back to kanban');
    ok(true, 'tab switching mounts the right view both ways');

    // --- Flow 3: agents fetch propagated into appState ---
    const agentsOk = await page.evaluate(() => Array.isArray(window.appState?.agents) && window.appState.agents.some(a => a.agent_id === 'shell-tester'));
    ok(agentsOk, 'agents fetch propagated to appState (guards a direct-write path)');

    // --- Flow 4: a task created via API shows after a board refresh ---
    const t3 = (await fetchJson(base, 'POST', `/api/projects/${PROJECT}/tasks`, { title: 'Created after load' })).body?.task?.id;
    await page.evaluate(() => window.appState?._refreshBoard && window.appState._refreshBoard());
    await waitFor(() => page.$(`[data-task-id="${t3}"]`), 'new task appears after refresh');
    ok(true, `board refresh surfaces a newly-created task (${t3})`);

    // --- Flow 5: clicking a card opens the detail panel ---
    await page.click(`[data-task-id="${t1}"]`);
    await waitFor(() => page.$('[data-detail-panel]'), 'detail panel opens');
    ok(true, 'clicking a task opens the detail panel');
    await page.keyboard.press('Escape');
    await waitFor(async () => !(await page.$('[data-detail-panel]')), 'detail panel closes');

    // --- Flow 6: global search picks a task → switches to Tasks + highlights it
    //     (the real NavigationContext intent path; replaces the old window flag) ---
    await page.click('#tabBar .tab[data-tab="ideas"]'); // start off the Tasks tab
    await waitFor(() => page.$('[data-react-canvas]'), 'on ideas');
    await page.keyboard.down('Control'); await page.keyboard.press('k'); await page.keyboard.up('Control');
    await page.waitForSelector('input[aria-label="Search query"]', { timeout: 4000 });
    await page.type('input[aria-label="Search query"]', 'Shell task two');
    const picked = await waitFor(async () => page.evaluate((id) => {
      const opt = Array.from(document.querySelectorAll('[role="option"] button'))
        .find(b => (b.textContent || '').includes(id));
      if (opt) { opt.click(); return true; }
      return false;
    }, t2), 'task result appears in global search', 6000).catch(() => false);
    ok(picked, 'global search lists the task and it can be picked');
    const highlighted = await waitFor(async () => page.evaluate((id) => {
      const el = document.querySelector(`[data-task-id="${id}"]`);
      return el && el.classList.contains('highlighted-from-back');
    }, t2), 'search-picked task highlighted', 5000).catch(() => false);
    ok(highlighted, 'picking a task in search switches to Tasks and highlights it (NavigationContext intent)');

    // --- Flow 7: identity (agentId/authUser) propagated to React + rendered ---
    // This is the path the removed 5s watchdog used to cover (T-356). With
    // ?agentId=shell-tester + that agent active on the project, the ActiveAgentsBar
    // must render it — proving the identity reached React without polling.
    ok(await page.evaluate(() => window.appState?.agentId === 'shell-tester'), 'agentId resolved into appState');
    const idShown = await waitFor(async () => {
      return page.evaluate(() => {
        const bar = document.querySelector('.active-agents-bar');
        return bar && /shell-tester/.test(bar.textContent || '');
      });
    }, 'identity rendered in ActiveAgentsBar', 5000).catch(() => false);
    ok(idShown, 'agent identity is rendered (no watchdog needed to propagate it)');

    // --- Flow 8: a UI-created task appears IMMEDIATELY (< 1.5s, well under the
    // old 5s watchdog). If any local mutation now relied on the watchdog instead
    // of a dispatch, this fails. ---
    const probeTitle = 'Immediacy probe alpha';
    await page.click('.add-task-btn'); // backlog column "+ New Task"
    await page.waitForSelector('#newTaskTitle', { timeout: 4000 });
    await page.type('#newTaskTitle', probeTitle);
    await page.keyboard.press('Enter');
    const appearedFast = await waitFor(async () => {
      return page.evaluate((title) => {
        return Array.from(document.querySelectorAll('[data-task-id]'))
          .some(el => (el.textContent || '').includes(title));
      }, probeTitle);
    }, 'UI-created task appears', 1500).catch(() => false);
    ok(appearedFast, 'a task created in the UI shows on the board within 1.5s (optimistic dispatch, not the watchdog)');

    // --- Flow 9 (T-358): hard-deleted project shows in the sidebar Trash and restores ---
    const TP = 'shell-trash';
    await fetchJson(base, 'POST', '/api/projects', { name: TP });
    await fetchJson(base, 'PUT', `/api/projects/${TP}`, { archived: true }); // deactivate (required first)
    const delr = await fetchJson(base, 'DELETE', `/api/projects/${TP}?confirm=${TP}&hardDelete=true`);
    ok(delr.status === 200, 'seeded project deactivated + hard-deleted (two-step)');
    // A UI delete would dispatch appstate:change; nudge it so the Trash list reloads.
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('appstate:change')));
    const trashHeader = await waitFor(() => page.$('[data-sidebar-trash] > button'), 'Trash section appears', 4000).catch(() => null);
    ok(trashHeader, 'Trash section appears in the sidebar after a hard-delete');
    await page.click('[data-sidebar-trash] > button'); // expand (collapsed by default)
    const inTrash = await waitFor(() => page.$(`[data-trash-project="${TP}"]`), 'project row in Trash', 4000).catch(() => null);
    ok(inTrash, 'hard-deleted project appears in the sidebar Trash');
    await page.click(`[data-trash-project="${TP}"] button`); // Restore
    const restored = await waitFor(async () => {
      const r = await fetchJson(base, 'GET', '/api/projects');
      return (r.body?.projects || []).some(p => p.name === TP);
    }, 'project restored', 5000).catch(() => false);
    ok(restored, 'Restore brings the project back into the project list');
    const goneFromTrash = await waitFor(async () => !(await page.$(`[data-trash-project="${TP}"]`)), 'trash row gone', 4000).catch(() => false);
    ok(goneFromTrash, 'restored project no longer shown in Trash');
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
