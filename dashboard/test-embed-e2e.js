'use strict';

// T-499 F1 — real-browser proof of the dashboard embed mode.
//
// A tiny host page on its own reserved local origin (allow-listed through
// FLOWBOARD_FRAME_ANCESTORS) frames `/?embed=<surface>&host=<origin>` and
// records every message the frame posts. It proves:
//   - the framed surface renders without chrome and sends `ready` (exact
//     shape, delivered to the exact host origin),
//   - host `context` switches surface/project/file without a frame reload,
//   - forged messages (sandboxed sibling frame, the frame itself) are ignored,
//   - interceptors: openTaskDetail -> open-task (no DetailPanel), Files
//     "Back to Task" -> one coalesced open-task, project row -> open-project,
//     Specify surface -> specify-closed { project, task? } (direct create +
//     409 recovery path),
//   - the Projects surface fills the frame, also at phone width,
//   - an embed never writes flowboard_agent_id,
//   - standalone `/`, top-level `/?embed=ideas` and a framed page with a
//     non-allow-listed host keep the normal dashboard.

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { withDashboard, reporter } = require('./test-support/browser-harness.js');
const { reservePort } = require('./test-support/server-harness.js');

const r = reporter('Dashboard embed mode browser E2E (T-499 F1)');
const A = 'embed-a';
const B = 'embed-b';
const SHOTS = process.env.EMBED_E2E_SCREENSHOTS || '';

function startHostPage(port, dashboardOrigin) {
  // The host page reads its frame src from ?frame= so one server serves every
  // case. #evil is a sandboxed (opaque-origin) sibling used to forge messages.
  const page = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body{margin:0} #fb{width:900px;height:640px;border:0;display:block}
  </style></head><body>
  <iframe id="fb" name="fb"></iframe>
  <iframe id="evil" name="evil" sandbox="allow-scripts" srcdoc="<p>evil</p>"></iframe>
  <script>
    window.__msgs = [];
    var fb = document.getElementById('fb');
    window.addEventListener('message', function (e) {
      if (e.source === fb.contentWindow) window.__msgs.push({ origin: e.origin, data: e.data });
    });
    window.sendContext = function (msg) {
      fb.contentWindow.postMessage(Object.assign({ type: 'flowboard:embed', v: 1, kind: 'context' }, msg), ${JSON.stringify(dashboardOrigin)});
    };
    fb.src = new URLSearchParams(location.search).get('frame') || 'about:blank';
  </script></body></html>`;
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(page);
    });
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

const closeServer = (server) => new Promise((resolve) => server.close(() => resolve()));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function openHost(page, hostOrigin, frameSrc) {
  await page.goto(`${hostOrigin}/?frame=${encodeURIComponent(frameSrc)}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
  const handle = await page.waitForSelector('#fb', { timeout: 5000 });
  // Wait until the iframe has committed to the dashboard document.
  const deadline = Date.now() + 10000;
  let frame = null;
  while (Date.now() < deadline) {
    frame = await handle.contentFrame();
    if (frame && frame.url().startsWith(frameSrc.split('?')[0])) break;
    await sleep(100);
  }
  return frame;
}

async function waitForMessage(page, predicateSrc, timeout = 10000) {
  return page.waitForFunction(
    new Function('return window.__msgs.find(function (m) { var d = m.data; return ' + predicateSrc + '; }) || null;'),
    { timeout },
  ).then((h) => h.jsonValue()).catch(() => null);
}

const messages = (page) => page.evaluate(() => window.__msgs.slice());
const clearMessages = (page) => page.evaluate(() => { window.__msgs.length = 0; });

async function chrome(frame) {
  return frame.evaluate(() => {
    const vis = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const cs = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return cs.display !== 'none' && cs.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    return {
      attr: document.documentElement.getAttribute('data-fb-embed'),
      header: vis('#app > .header'),
      tabBar: vis('#tabBar'),
      sidebar: vis('#sidebar'),
      content: vis('#content'),
      detailPanel: !!document.querySelector('[data-detail-panel]'),
    };
  });
}

async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

async function main() {
  const dashboardPort = await reservePort();
  const base = `http://127.0.0.1:${dashboardPort}`;
  const hostPort = await reservePort();
  const hostOrigin = `http://127.0.0.1:${hostPort}`;
  const hostServer = await startHostPage(hostPort, base);
  const embedUrl = (params) => `${base}/?${new URLSearchParams({ ...params, host: hostOrigin }).toString()}`;

  try {
    const res = await withDashboard(async ({ api, page }) => {
      await api('POST', '/projects', { name: A });
      await api('POST', '/projects', { name: B });
      await api('POST', `/projects/${A}/files/context`, { filename: 'alpha.md', content: '# Alpha' });
      await api('POST', `/projects/${B}/files/context`, { filename: 'beta.md', content: '# Beta' });
      const created = await api('POST', `/projects/${A}/tasks`, { title: 'Embed seed task', status: 'backlog' });
      const seedTaskId = created.body?.task?.id;
      r.ok(!!seedTaskId, `seed task created (${seedTaskId})`);

      // ---------------------------------------------------------------
      // 1. Ideas surface: no chrome, ready, forged messages, context.
      // ---------------------------------------------------------------
      let frame = await openHost(page, hostOrigin, embedUrl({ embed: 'ideas', project: A, agentId: 'e2e-embed' }));
      const ready = await waitForMessage(page, "d && d.kind === 'ready'");
      r.ok(!!ready, 'framed Ideas surface posts ready');
      r.ok(ready && ready.origin === base, `ready comes from the dashboard origin (${ready && ready.origin})`);
      r.ok(ready && JSON.stringify(ready.data) === JSON.stringify({ type: 'flowboard:embed', v: 1, kind: 'ready', surface: 'ideas', project: A }),
        `ready has the exact v1 shape (${ready && JSON.stringify(ready.data)})`);
      await frame.waitForSelector('[data-react-canvas]', { timeout: 8000 }).catch(() => null);
      let c = await chrome(frame);
      r.ok(c.attr === 'ideas', `html[data-fb-embed="ideas"] (got ${c.attr})`);
      r.ok(!c.header && !c.tabBar && !c.sidebar, `chrome hidden (header=${c.header} tabBar=${c.tabBar} sidebar=${c.sidebar})`);
      r.ok(c.content && !!(await frame.$('[data-react-canvas]')), 'Ideas canvas renders as the only surface');
      r.ok(await frame.evaluate(() => window.appState.viewedProject) === A, 'project param opens that project');
      r.ok(await frame.evaluate(() => localStorage.getItem('flowboard_agent_id')) === null,
        'embed mode never writes flowboard_agent_id');
      await shot(page, 'embed-ideas');

      await frame.evaluate(() => { window.__loadMarker = 'same-document'; });
      await clearMessages(page);

      // Forged context messages: a sandboxed sibling (opaque origin, wrong
      // source) and the frame posting to itself (source !== parent).
      const evil = page.frames().find((f) => f.name() === 'evil');
      r.ok(!!evil, 'sandboxed sibling frame is available for forging');
      if (evil) {
        await evil.evaluate(() => {
          parent.frames.fb.postMessage({ type: 'flowboard:embed', v: 1, kind: 'context', surface: 'projects' }, '*');
        });
      }
      await frame.evaluate(() => {
        window.postMessage({ type: 'flowboard:embed', v: 1, kind: 'context', surface: 'projects' }, '*');
      });
      await sleep(600);
      c = await chrome(frame);
      r.ok(c.attr === 'ideas' && !c.sidebar, `forged context messages are ignored (surface still ${c.attr})`);

      // Real host context: switch to Files of project B with a file, no reload.
      await page.evaluate((p) => window.sendContext({ surface: 'files', project: p, file: 'context/beta.md' }), B);
      const switched = await frame.waitForFunction((p) => document.documentElement.getAttribute('data-fb-embed') === 'files'
        && window.appState.viewedProject === p
        && /beta\.md/.test(document.querySelector('.tree-item.selected')?.textContent || ''), { timeout: 10000 }, B)
        .then(() => true).catch(() => false);
      r.ok(switched, 'host context switches to Files of another project and opens the file');
      r.ok(await frame.evaluate(() => window.__loadMarker) === 'same-document', 'context applied without a frame reload');
      c = await chrome(frame);
      r.ok(!c.header && !c.tabBar && !c.sidebar, 'Files surface also renders without chrome');
      await shot(page, 'embed-files');

      // window.openTaskDetail -> open-task (DetailPanel is not rendered).
      await clearMessages(page);
      await frame.evaluate(() => window.openTaskDetail('T-42'));
      const openTask = await waitForMessage(page, "d && d.kind === 'open-task'");
      r.ok(openTask && openTask.data.project === B && openTask.data.task === 'T-42',
        `openTaskDetail posts open-task (${openTask && JSON.stringify(openTask.data)})`);
      await sleep(200);
      r.ok(!(await chrome(frame)).detailPanel, 'DetailPanel does not render in embed mode');

      // Projects surface via context: full width, project click -> open-project.
      await page.evaluate(() => window.sendContext({ surface: 'projects' }));
      await frame.waitForFunction(() => document.documentElement.getAttribute('data-fb-embed') === 'projects', { timeout: 5000 }).catch(() => null);
      await frame.waitForSelector(`#sidebar .project-item[data-project="${A}"]`, { timeout: 5000 }).catch(() => null);
      c = await chrome(frame);
      const wide = await frame.evaluate(() => ({
        sidebar: document.getElementById('sidebar').getBoundingClientRect().width,
        viewport: document.documentElement.clientWidth,
      }));
      r.ok(c.sidebar && !c.content && !c.header, `Projects surface shows only the project list (sidebar=${c.sidebar} content=${c.content})`);
      r.ok(wide.sidebar >= wide.viewport - 1, `project list fills the frame width (${wide.sidebar}/${wide.viewport})`);
      await shot(page, 'embed-projects');
      await clearMessages(page);
      await frame.click(`#sidebar .project-item[data-project="${A}"]`);
      const openProject = await waitForMessage(page, "d && d.kind === 'open-project'");
      r.ok(openProject && openProject.data.project === A, `project click posts open-project (${openProject && JSON.stringify(openProject.data)})`);

      // Phone width: still full width, no horizontal overflow.
      await page.evaluate(() => { document.getElementById('fb').style.width = '360px'; });
      await sleep(400);
      const narrow = await frame.evaluate(() => ({
        sidebar: document.getElementById('sidebar').getBoundingClientRect().width,
        viewport: document.documentElement.clientWidth,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        visible: getComputedStyle(document.getElementById('sidebar')).display !== 'none',
      }));
      r.ok(narrow.visible && narrow.sidebar >= narrow.viewport - 1 && narrow.overflow <= 0,
        `project list at 360px: full width, no horizontal scroll (${JSON.stringify(narrow)})`);
      await shot(page, 'embed-projects-360');

      // ---------------------------------------------------------------
      // 2. Files "Back to Task": switchTab + goToTask coalesce to one open-task.
      // ---------------------------------------------------------------
      frame = await openHost(page, hostOrigin, embedUrl({ embed: 'files', project: A, file: 'context/alpha.md', task: seedTaskId }));
      await waitForMessage(page, "d && d.kind === 'ready'");
      const back = await frame.waitForFunction(
        () => [...document.querySelectorAll('button.file-back-btn')].find((b) => /back to task/i.test(b.textContent || '')) || null,
        { timeout: 8000 }).catch(() => null);
      r.ok(!!back, 'file opened with a task context shows "Back to Task"');
      if (back) {
        await clearMessages(page);
        await back.asElement().click();
        await waitForMessage(page, "d && d.kind === 'open-task'");
        await sleep(300);
        const burst = (await messages(page)).map((m) => m.data);
        r.ok(burst.length === 1 && burst[0].kind === 'open-task' && burst[0].task === seedTaskId && burst[0].project === A,
          `"Back to Task" posts exactly one open-task (${JSON.stringify(burst)})`);
      }
      r.ok((await chrome(frame)).attr === 'files', 'frame stays on its Files surface');

      // ---------------------------------------------------------------
      // 3. Specify surface: direct create, then the 409 recovery path.
      // ---------------------------------------------------------------
      frame = await openHost(page, hostOrigin, embedUrl({ embed: 'specify', project: A, title: 'Embed specify task', priority: 'high' }));
      await waitForMessage(page, "d && d.kind === 'ready'");
      await frame.waitForSelector('[data-embed-specify-start]', { timeout: 8000 });
      r.ok(await frame.$eval('#embedSpecifyTitle', (el) => el.value) === 'Embed specify task', 'title param prefills the Specify form');
      await shot(page, 'embed-specify');
      await clearMessages(page);
      await frame.click('[data-embed-specify-start]');
      const closedDirect = await waitForMessage(page, "d && d.kind === 'specify-closed'");
      r.ok(closedDirect && closedDirect.data.project === A && typeof closedDirect.data.task === 'string',
        `compat project: task created directly, specify-closed carries it (${closedDirect && JSON.stringify(closedDirect.data)})`);
      const createdId = closedDirect && closedDirect.data.task;
      const createdOpen = await waitForMessage(page, "d && d.kind === 'open-task'");
      r.ok(createdOpen && createdOpen.data.task === createdId, 'and the created task is opened on the host board');
      const createdTask = createdId ? await api('GET', `/projects/${A}/tasks/${createdId}`) : null;
      const taskBody = createdTask?.body?.task || createdTask?.body;
      r.ok(taskBody && taskBody.title === 'Embed specify task' && taskBody.priority === 'high',
        `task exists with the prefilled title + priority (${taskBody && taskBody.priority})`);

      // 409 SPECIFY_REQUIRED recovery (the same path AddTaskForm uses).
      frame = await openHost(page, hostOrigin, embedUrl({ embed: 'specify', project: A, title: 'Needs specify' }));
      await waitForMessage(page, "d && d.kind === 'ready'");
      await frame.waitForSelector('[data-embed-specify-start]', { timeout: 8000 });
      await page.setRequestInterception(true);
      const onRequest = (req) => {
        if (req.method() === 'POST' && req.url() === `${base}/api/projects/${A}/tasks`) {
          req.respond({
            status: 409,
            contentType: 'application/json',
            body: JSON.stringify({ code: 'SPECIFY_REQUIRED', error: 'Specify required', specifyRequest: { project: A, description: 'Needs specify' } }),
          });
        } else {
          req.continue();
        }
      };
      page.on('request', onRequest);
      await clearMessages(page);
      await frame.click('[data-embed-specify-start]');
      const dialog = await frame.waitForSelector('[role="dialog"]', { timeout: 8000 }).catch(() => null);
      r.ok(!!dialog, '409 SPECIFY_REQUIRED opens the Specify stepper inside the frame');
      page.off('request', onRequest);
      await page.setRequestInterception(false);
      await shot(page, 'embed-specify-stepper');
      if (dialog) {
        const closedBtn = await frame.waitForFunction(
          () => [...document.querySelectorAll('[role="dialog"] button')].find((b) => /^(cancel|close)$/i.test((b.textContent || '').trim())) || null,
          { timeout: 8000 }).catch(() => null);
        if (closedBtn) await closedBtn.asElement().click();
        else await frame.keyboard?.press?.('Escape');
        const closedCancel = await waitForMessage(page, "d && d.kind === 'specify-closed'");
        r.ok(closedCancel && closedCancel.data.project === A && !('task' in closedCancel.data),
          `closing the stepper posts specify-closed without a task (${closedCancel && JSON.stringify(closedCancel.data)})`);
        const status = await frame.waitForSelector('[data-embed-specify-status]', { timeout: 5000 }).catch(() => null);
        r.ok(!!status, 'Specify surface shows the closed state');
      }

      // ---------------------------------------------------------------
      // 4. Standalone unchanged.
      // ---------------------------------------------------------------
      // Framed, but the host param is not allow-listed: normal dashboard.
      // (The Telegram WebApp SDK itself posts string messages to any parent;
      // only flowboard:embed envelopes count.)
      frame = await openHost(page, hostOrigin, `${base}/?${new URLSearchParams({ embed: 'ideas', project: A, host: 'http://127.0.0.1:9' })}`);
      await frame.waitForSelector('#app > .header', { visible: true, timeout: 8000 }).catch(() => null);
      await sleep(500);
      c = await chrome(frame);
      r.ok(c.attr === null && c.header && c.tabBar, `framed with a non-allow-listed host: normal chrome (attr=${c.attr} header=${c.header})`);
      r.ok((await messages(page)).filter((m) => m.data && m.data.type === 'flowboard:embed').length === 0,
        'and no embed messages are posted');

      // Top-level standalone.
      await page.goto(`${base}/?agentId=e2e-standalone`, { waitUntil: 'networkidle2', timeout: 15000 });
      await page.waitForSelector('#app > .header', { visible: true, timeout: 8000 }).catch(() => null);
      c = await chrome(page.mainFrame());
      r.ok(c.attr === null && c.header && c.tabBar && c.sidebar, `standalone "/" keeps header, tabs and sidebar (${JSON.stringify(c)})`);
      r.ok(await page.evaluate(() => localStorage.getItem('flowboard_agent_id')) === 'e2e-standalone',
        'standalone still remembers the agent id');

      // Regression: the Specify stepper sat outside DashboardProvider and
      // opening it unmounted the whole standalone app. The board's 409
      // SPECIFY_REQUIRED recovery must now open it with the chrome intact.
      await page.click(`#sidebar .project-item[data-project="${A}"]`);
      await page.waitForFunction((p) => window.appState.viewedProject === p, { timeout: 8000 }, A);
      await page.click('#tabBar .tab[data-tab="tasks"]');
      await page.waitForSelector('.add-task-btn', { timeout: 8000 });
      await page.setRequestInterception(true);
      page.on('request', onRequest);
      await page.click('.add-task-btn');
      await page.type('#newTaskTitle', 'Standalone needs specify');
      await page.keyboard.press('Enter');
      const standaloneDialog = await page.waitForSelector('[role="dialog"]', { timeout: 8000 }).then(() => true).catch(() => false);
      page.off('request', onRequest);
      await page.setRequestInterception(false);
      c = await chrome(page.mainFrame());
      r.ok(standaloneDialog && c.header && c.tabBar, `standalone 409 recovery opens the stepper without unmounting the app (${standaloneDialog})`);

      // Top-level with ?embed= params: ignored (not framed).
      await page.goto(embedUrl({ embed: 'ideas', project: A }), { waitUntil: 'networkidle2', timeout: 15000 });
      await page.waitForSelector('#app > .header', { visible: true, timeout: 8000 }).catch(() => null);
      c = await chrome(page.mainFrame());
      r.ok(c.attr === null && c.header && c.tabBar && c.sidebar, `top-level /?embed=ideas is the normal dashboard (${JSON.stringify(c)})`);
    }, { port: dashboardPort, env: { FLOWBOARD_FRAME_ANCESTORS: hostOrigin } });
    if (res?.skipped) { r.skip(res.reason); return; }
  } finally {
    await closeServer(hostServer);
  }
  r.done();
}

main().catch((error) => { console.error(error); process.exit(1); });
