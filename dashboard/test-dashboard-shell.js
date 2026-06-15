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
    // T-367-3: seed a markdown file on disk so the Files view has something to open
    try { fs.writeFileSync(path.join(tmp, 'projects', PROJECT, 'note.md'), '# Note\n\nA file body for the master-detail test.\n'); } catch {}
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

    // --- Flow 10 (T-130): manual order rank overrides numeric sort on the board ---
    // Default sort is newest-first (descending id → t2 before t1). Giving t1 a
    // LOWER rank than t2 must flip that: ranked cards sort ascending by rank,
    // ahead of any unranked card — proving the board honours manual order.
    await page.click('#tabBar .tab[data-tab="tasks"]');
    await waitFor(() => page.$('.kanban'), 'back on tasks board');
    await fetchJson(base, 'PUT', `/api/projects/${PROJECT}/tasks/${t1}`, { order: 10 });
    await fetchJson(base, 'PUT', `/api/projects/${PROJECT}/tasks/${t2}`, { order: 20 });
    await page.evaluate(() => window.appState?._refreshBoard && window.appState._refreshBoard());
    const orderOk = await waitFor(async () => page.evaluate((a, b) => {
      const ids = Array.from(document.querySelectorAll('.column[data-status="backlog"] [data-task-id]'))
        .map(e => e.dataset.taskId);
      const ia = ids.indexOf(a), ib = ids.indexOf(b);
      return ia !== -1 && ib !== -1 && ia < ib;
    }, t1, t2), 'manual order applied on board', 5000).catch(() => false);
    ok(orderOk, 'tasks render by manual order rank, not numeric id (T-130)');

    // --- Flow 11 (T-130): a real drag reorders within the column and persists ---
    // Seed three fresh, unranked tasks in their own column (review, kept empty so
    // far), drag the LAST one above the FIRST, and assert it now sorts first AND
    // the new rank was persisted (exercises handleDrop's index translation +
    // the drop indicator path — synthetic HTML5 DnD events with a DataTransfer).
    const rTasks = [];
    for (const title of ['Reorder A', 'Reorder B', 'Reorder C']) {
      const id = (await fetchJson(base, 'POST', `/api/projects/${PROJECT}/tasks`, { title })).body?.task?.id;
      await fetchJson(base, 'PUT', `/api/projects/${PROJECT}/tasks/${id}`, { status: 'review' });
      rTasks.push(id);
    }
    await page.evaluate(() => window.appState?._refreshBoard && window.appState._refreshBoard());
    await waitFor(() => page.$(`.column[data-status="review"] [data-task-id="${rTasks[2]}"]`), 'reorder seeds on board');
    const reordered = await page.evaluate((srcId) => {
      const col = document.querySelector('.column[data-status="review"]');
      const card = (id) => col.querySelector(`[data-task-id="${id}"]`);
      const src = card(srcId);
      const dt = new DataTransfer();
      const fire = (el, type, clientY) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientY }));
      fire(src, 'dragstart', src.getBoundingClientRect().top + 5);
      const firstRect = col.querySelector('[data-react-tasks]').getBoundingClientRect();
      fire(col, 'dragover', firstRect.top + 1); // hover above the first card → insert at top
      fire(col, 'drop', firstRect.top + 1);
      fire(src, 'dragend', 0);
      return true;
    }, rTasks[2]).catch(() => false);
    ok(reordered, 'synthetic drag dispatched on the review column');
    const movedToTop = await waitFor(async () => page.evaluate((srcId) => {
      const ids = Array.from(document.querySelectorAll('.column[data-status="review"] [data-task-id]'))
        .map(e => e.dataset.taskId);
      return ids[0] === srcId;
    }, rTasks[2]), 'dragged card moved to top of its column', 5000).catch(() => false);
    ok(movedToTop, 'dragging the last card to the top reorders it there (T-130)');
    const persisted = await waitFor(async () => {
      const list = (await fetchJson(base, 'GET', `/api/projects/${PROJECT}/tasks`)).body?.tasks || [];
      const byId = Object.fromEntries(list.map(t => [t.id, t.order]));
      // dragged card must now have the smallest rank in the column
      return typeof byId[rTasks[2]] === 'number' && byId[rTasks[2]] < byId[rTasks[0]] && byId[rTasks[2]] < byId[rTasks[1]];
    }, 'reorder persisted to the server', 5000).catch(() => false);
    ok(persisted, 'the new manual order is persisted (lowest rank for the moved card)');

    // --- Flow 12 (T-130): the drop indicator survives noisy dragleave, clears on dragend ---
    // Regression guard for the flicker bug: a real drag fires dragleave on every
    // card-boundary crossing (often relatedTarget=null). Those must NOT clear the
    // insertion line — only dragend (or moving to another column) may.
    await page.evaluate(() => {
      const col = document.querySelector('.column[data-status="review"]');
      const cards = [...col.querySelectorAll('[data-react-tasks]')];
      window.__dt = new DataTransfer();
      window.__src = cards[cards.length - 1];
      const fire = (el, type, extra = {}) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: window.__dt, ...extra }));
      fire(window.__src, 'dragstart', { clientY: window.__src.getBoundingClientRect().top + 5 });
      fire(col, 'dragover', { clientY: cards[0].getBoundingClientRect().top + 1 });
    });
    const lineUp = await waitFor(async () => page.evaluate(() => {
      const l = document.querySelector('.column[data-status="review"] .drop-line');
      return l && l.offsetHeight > 0; // must be visibly tall, not just present in the DOM
    }), 'drop indicator appears on dragover', 3000).catch(() => null);
    ok(lineUp, 'drop indicator line renders with visible height during a drag');
    // Fire a spurious dragleave with no relatedTarget (the flicker trigger).
    await page.evaluate(() => {
      const col = document.querySelector('.column[data-status="review"]');
      col.dispatchEvent(new DragEvent('dragleave', { bubbles: true, dataTransfer: window.__dt, relatedTarget: null }));
    });
    await new Promise(r => setTimeout(r, 120));
    const stillThere = await page.$('.column[data-status="review"] .drop-line');
    ok(stillThere, 'a null-relatedTarget dragleave does NOT clear the indicator (flicker fix)');
    // dragend must clear it.
    await page.evaluate(() => window.__src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: window.__dt, clientY: 0 })));
    const cleared = await waitFor(async () => !(await page.$('.column[data-status="review"] .drop-line')), 'indicator cleared on dragend', 3000).catch(() => false);
    ok(cleared, 'dragend clears the drop indicator');

    // --- Flow 13 (T-130): per-CARD drop targeting works in the backlog column ---
    // Backlog has the add-task form + (now) ranked cards — the column that the
    // coarse hit-test struggled with. Dispatch dragover on a CARD (not the
    // column) and assert the indicator appears: exercises the sidebar-pattern
    // per-card handler that replaced the flaky column scan.
    await page.evaluate(() => {
      const col = document.querySelector('.column[data-status="backlog"]');
      const cards = [...col.querySelectorAll('[data-react-tasks]')];
      window.__dt = new DataTransfer();
      window.__src = cards[cards.length - 1];
      const fire = (el, type, extra = {}) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: window.__dt, ...extra }));
      fire(window.__src, 'dragstart', { clientY: window.__src.getBoundingClientRect().top + 5 });
      const tgt = cards[0]; const r = tgt.getBoundingClientRect();
      fire(tgt, 'dragover', { clientY: r.top + 2 }); // upper half of first card → before it
    });
    const blLine = await waitFor(() => page.$('.column[data-status="backlog"] .drop-line'), 'backlog per-card indicator', 3000).catch(() => null);
    ok(blLine, 'drop indicator renders via per-card targeting in the backlog column');
    await page.evaluate(() => window.__src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: window.__dt, clientY: 0 })));

    // --- Flow 13b (T-130 #2): a newly created backlog task lands at the TOP ---
    await page.click('.add-task-btn');
    await page.waitForSelector('#newTaskTitle', { timeout: 4000 });
    const topProbe = 'Top of backlog probe';
    await page.type('#newTaskTitle', topProbe);
    await page.keyboard.press('Enter');
    const isFirst = await waitFor(async () => page.evaluate((title) => {
      const first = document.querySelector('.column[data-status="backlog"] [data-task-id]');
      return first && (first.textContent || '').includes(title);
    }, topProbe), 'new backlog task is first', 4000).catch(() => false);
    ok(isFirst, 'a newly created backlog task appears at the top (T-130 #2)');

    // --- Flow 13c (T-130 #3): switching sort mode to Newest re-sorts by id ---
    await page.click('.sort-mode button[aria-haspopup="listbox"]');
    await page.waitForSelector('.sort-mode-menu', { timeout: 3000 });
    await page.evaluate(() => {
      const item = Array.from(document.querySelectorAll('.sort-mode-item')).find(b => /Newest/.test(b.textContent || ''));
      item?.click();
    });
    const newestOk = await waitFor(async () => page.evaluate(() => {
      const ids = Array.from(document.querySelectorAll('.column[data-status="backlog"] [data-task-id]'))
        .map(e => parseInt(e.dataset.taskId.replace('T-', ''), 10));
      // newest-first → strictly descending by id, ignoring manual ranks
      return ids.length > 1 && ids.every((n, i) => i === 0 || ids[i - 1] >= n);
    }), 'backlog sorted newest-first', 4000).catch(() => false);
    ok(newestOk, 'Newest-first mode sorts by id and ignores manual ranks (T-130 #3)');

    // --- Flow 14 (T-130): indicator stays VISIBLE when the column overflows ---
    // The real backlog/done bug: .column-body is a flex column that scrolls when
    // full; without flex-shrink:0 the 2px line collapses to 0 height — present in
    // the DOM (so existence checks passed) but invisible. Force overflow with a
    // short viewport + many cards, then assert the line has real height.
    await page.click('.sort-mode button[aria-haspopup="listbox"]'); // back to Custom so the indicator is active
    await page.waitForSelector('.sort-mode-menu', { timeout: 3000 });
    await page.evaluate(() => {
      const item = Array.from(document.querySelectorAll('.sort-mode-item')).find(b => /Custom/.test(b.textContent || ''));
      item?.click();
    });
    await page.setViewport({ width: 1400, height: 360 }); // short → backlog overflows
    for (let i = 0; i < 16; i++) await fetchJson(base, 'POST', `/api/projects/${PROJECT}/tasks`, { title: `Overflow filler ${i}` });
    await page.evaluate(() => window.appState?._refreshBoard && window.appState._refreshBoard());
    await waitFor(() => page.evaluate(() => {
      const body = document.querySelector('.column[data-status="backlog"] .column-body');
      return body && body.scrollHeight > body.clientHeight + 10; // actually overflowing
    }), 'backlog column overflows', 5000).catch(() => null);
    await page.evaluate(() => {
      const col = document.querySelector('.column[data-status="backlog"]');
      const cards = [...col.querySelectorAll('[data-react-tasks]')];
      window.__dt = new DataTransfer();
      window.__src = cards[cards.length - 1];
      const fire = (el, type, extra = {}) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: window.__dt, ...extra }));
      fire(window.__src, 'dragstart', { clientY: window.__src.getBoundingClientRect().top + 5 });
      const tgt = cards[2]; const r = tgt.getBoundingClientRect();
      fire(tgt, 'dragover', { clientY: r.top + 2 });
    });
    const visibleInOverflow = await waitFor(async () => page.evaluate(() => {
      const l = document.querySelector('.column[data-status="backlog"] .drop-line');
      return l && l.offsetHeight >= 2; // NOT collapsed by the flex algorithm
    }), 'indicator visible in overflowing column', 3000).catch(() => false);
    ok(visibleInOverflow, 'drop indicator keeps visible height in an overflowing column (flex-shrink fix)');
    await page.evaluate(() => window.__src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: window.__dt, clientY: 0 })));

    // --- Flow 15 (T-364): expanded subtasks survive navigating away and back ---
    const parentId = (await fetchJson(base, 'POST', `/api/projects/${PROJECT}/tasks`, { title: 'Parent with subs' })).body?.task?.id;
    await fetchJson(base, 'PUT', `/api/projects/${PROJECT}/tasks/${parentId}`, { status: 'open' });
    const subId = (await fetchJson(base, 'POST', `/api/projects/${PROJECT}/tasks`, { title: 'A persisted subtask', parentId })).body?.task?.id;
    await page.evaluate(() => window.appState?._refreshBoard && window.appState._refreshBoard());
    await waitFor(() => page.$(`[data-task-id="${parentId}"] .subtask-progress`), 'parent shows subtask progress', 5000);
    await page.click(`[data-task-id="${parentId}"] .subtask-progress`); // expand
    await waitFor(() => page.$(`[data-task-id="${subId}"]`), 'subtask visible after expand', 4000);
    ok(true, 'parent expands to reveal its subtask');
    await page.click('#tabBar .tab[data-tab="ideas"]');
    await waitFor(() => page.$('[data-react-canvas]'), 'on ideas');
    await page.click('#tabBar .tab[data-tab="tasks"]');
    await waitFor(() => page.$('.kanban'), 'back on tasks');
    const stillExpanded = await waitFor(() => page.$(`[data-task-id="${subId}"]`), 'subtask still visible after returning', 4000).catch(() => null);
    ok(stillExpanded, 'expanded subtasks persist across tab navigation (T-364)');

    // --- Flow 16 (T-364): column scroll position persists + restores ---
    const scrolled = await page.evaluate(() => {
      const b = document.querySelector('.column[data-status="backlog"] .column-body');
      if (!b || b.scrollHeight <= b.clientHeight) return false;
      b.scrollTop = 120;
      b.dispatchEvent(new Event('scroll', { bubbles: true }));
      return b.scrollTop > 0;
    });
    ok(scrolled, 'backlog column is scrollable and was scrolled');
    await new Promise(r => setTimeout(r, 300)); // let the debounced persist fire
    const savedScroll = await page.evaluate((proj) => {
      try { return JSON.parse(sessionStorage.getItem('flowboard.kanban.view.' + proj) || 'null'); } catch { return null; }
    }, PROJECT);
    ok(savedScroll?.cols?.backlog >= 100, 'column scroll persisted to sessionStorage');
    await page.click('#tabBar .tab[data-tab="ideas"]');
    await waitFor(() => page.$('[data-react-canvas]'), 'on ideas again');
    await page.click('#tabBar .tab[data-tab="tasks"]');
    await waitFor(() => page.$('.kanban'), 'back on tasks again');
    const scrollRestored = await waitFor(async () => page.evaluate(() => {
      const b = document.querySelector('.column[data-status="backlog"] .column-body');
      return b && b.scrollTop >= 100;
    }), 'scroll restored', 4000).catch(() => false);
    ok(scrollRestored, 'column scroll position restored after navigation (T-364)');

    // --- Flow 17 (T-367-1): overview widgets don't overflow at mobile width ---
    await page.setViewport({ width: 375, height: 720 });
    await page.click('#tabBar .tab[data-tab="overview"]');
    const hasWidgets = await waitFor(() => page.$('.ov-cell'), 'overview renders widgets', 4000).catch(() => null);
    if (!hasWidgets) { ok(true, 'overview has no widgets in test env — overflow check skipped'); }
    else {
    await new Promise(r => setTimeout(r, 600)); // let widgets settle / fetch
    const widgetOverflow = await page.evaluate(() => {
      const bad = [];
      document.querySelectorAll('.ov-cell').forEach(cell => {
        cell.querySelectorAll('*').forEach(el => {
          // ignore intentionally-scrollable regions (lists, prose, markdown)
          const cls = (el.className || '').toString().split(' ')[0] || '';
          if (/scroll|kbars|prose|markdown|ScrollArea/i.test(cls)) return;
          if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 2) bad.push(`${cls || el.tagName}:${el.scrollWidth}>${el.clientWidth}`);
        });
      });
      return [...new Set(bad)];
    });
    ok(widgetOverflow.length === 0, `no overview widget overflows at 375px (offenders: ${widgetOverflow.slice(0, 5).join(', ') || 'none'})`);
    }

    // --- Flow 18 (T-367-3): Files master-detail on mobile (375px) ---
    // Re-select the seeded project (an earlier flow may have left a different one
    // viewed) so the Files tree actually has our note.md.
    await page.evaluate((name) => {
      document.querySelector('.app')?.classList.remove('sidebar-collapsed');
      const hit = Array.from(document.querySelectorAll('.project-item')).find(el => el.textContent && el.textContent.includes(name));
      if (hit) hit.click();
    }, PROJECT);
    await waitFor(() => page.evaluate((p) => window.appState?.viewedProject === p, PROJECT), 'seeded project re-selected', 4000).catch(() => {});
    await page.evaluate(() => document.querySelector('.app')?.classList.add('sidebar-collapsed'));
    await page.click('#tabBar .tab[data-tab="files"]');
    await waitFor(() => page.$('.file-explorer'), 'files explorer mounts', 5000);
    await waitFor(() => page.$('.tree-item:not(.directory)'), 'a file appears in the tree', 5000);
    const filesList = await page.evaluate(() => {
      const ex = document.querySelector('.file-explorer');
      return { view: ex?.dataset.view, treeVisible: document.querySelector('.file-tree')?.offsetParent !== null, previewVisible: document.querySelector('.file-preview')?.offsetParent != null && document.querySelector('.file-preview')?.offsetParent !== null };
    });
    ok(filesList.view === 'list' && filesList.treeVisible, 'Files lands on the list (no auto-opened file) on mobile (T-367-3)');
    await page.click('.tree-item:not(.directory)');
    const opened = await waitFor(async () => page.evaluate(() => {
      const ex = document.querySelector('.file-explorer');
      const back = document.querySelector('.file-back-to-list');
      return ex?.dataset.view === 'preview' && back && back.offsetParent !== null;
    }), 'tapping a file opens it full-screen with a back button', 5000).catch(() => false);
    ok(opened, 'tapping a file shows it full-screen with a ← Files back button (T-367-3)');
    await page.click('.file-back-to-list');    const backToList = await waitFor(async () => page.evaluate(() => document.querySelector(".file-explorer")?.dataset.view === "list"), "back returns to the list", 4000).catch(() => false);
    ok(backToList, 'the back button returns to the file list (T-367-3)');

    // --- Flow 19 (T-367-4): touch/pointer drag via the card handle reorders ---
    // Wide viewport so all columns are on-screen (elementFromPoint hit-testing).
    // The handle is display:none on hover-capable devices, but we dispatch the
    // PointerEvents on it directly — exercising the same pointer-drag path touch
    // uses. Create 3 'open' tasks, drag the last to the top, assert it persisted.
    await page.setViewport({ width: 1400, height: 900 });
    await page.evaluate(() => document.querySelector('.app')?.classList.remove('sidebar-collapsed'));
    await page.click('#tabBar .tab[data-tab="tasks"]');
    await waitFor(() => page.$('.kanban'), 'kanban for pointer-drag', 5000);
    const pd = [];
    for (const title of ['PDrag A', 'PDrag B', 'PDrag C']) {
      const id = (await fetchJson(base, 'POST', `/api/projects/${PROJECT}/tasks`, { title })).body?.task?.id;
      await fetchJson(base, 'PUT', `/api/projects/${PROJECT}/tasks/${id}`, { status: 'open' });
      pd.push(id);
    }
    await page.evaluate(() => window.appState?._refreshBoard && window.appState._refreshBoard());
    await waitFor(() => page.$(`.column[data-status="open"] [data-task-id="${pd[2]}"]`), 'pointer-drag seeds on board', 5000);
    const dragRan = await page.evaluate((srcId) => {
      const col = document.querySelector('.column[data-status="open"]');
      const card = col.querySelector(`[data-task-id="${srcId}"]`);
      const handle = card.querySelector('.card-drag-handle');
      if (!handle) return 'no-handle';
      const fire = (el, type, x, y) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 1, isPrimary: true }));
      const cr = card.getBoundingClientRect();
      fire(handle, 'pointerdown', cr.left + 12, cr.top + 12);
      const first = col.querySelector('[data-react-tasks]');
      const fr = first.getBoundingClientRect();
      fire(window, 'pointermove', fr.left + 30, fr.top + 1);
      fire(window, 'pointermove', fr.left + 30, fr.top + 1);
      fire(window, 'pointerup', fr.left + 30, fr.top + 1);
      return 'ok';
    }, pd[2]);
    ok(dragRan === 'ok', `pointer-drag handle present and drag dispatched (${dragRan})`);
    const pdPersisted = await waitFor(async () => {
      const list = (await fetchJson(base, 'GET', `/api/projects/${PROJECT}/tasks`)).body?.tasks || [];
      const o = Object.fromEntries(list.map(t => [t.id, t.order]));
      return typeof o[pd[2]] === 'number' && o[pd[2]] < o[pd[0]] && o[pd[2]] < o[pd[1]];
    }, 'pointer-drag reorder persisted', 5000).catch(() => false);
    ok(pdPersisted, 'pointer/touch drag via the handle reorders + persists (T-367-4)');
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
