'use strict';

// T-384 / T-379 — browser-rendered Kanban order. Proves end-to-end (real React
// board, not just the sort unit) that in custom mode a task MOVED into a column
// surfaces at the TOP by recency: an older task completed last sits above a
// newer task completed earlier. Uses the shared browser-E2E harness.

const { withDashboard, reporter } = require('./test-support/browser-harness.js');

const PROJECT = 'sortcheck';
const r = reporter('Kanban render order (T-384/T-379)');

async function main() {
  const res = await withDashboard(async ({ api, page, base }) => {
    await api('POST', '/projects', { name: PROJECT });
    // Three tasks created oldest→newest: T-001, T-002, T-003 (all in backlog).
    const ids = [];
    for (const t of ['oldest', 'middle', 'newest']) {
      ids.push((await api('POST', `/projects/${PROJECT}/tasks`, { title: t })).body?.task?.id);
    }
    r.ok(ids.every(Boolean), `seeded tasks ${ids.join(',')}`);

    await page.goto(`${base}/?agentId=e2e`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('.app', { timeout: 8000 });
    await page.evaluate((p) => window._viewProject && window._viewProject(p), PROJECT);
    await page.waitForFunction((p) => window.appState?.viewedProject === p, { timeout: 8000 }, PROJECT);
    await page.click('#tabBar .tab[data-tab="tasks"]');
    await page.waitForSelector('.kanban', { timeout: 8000 });

    const colIds = (status) => page.evaluate((s) =>
      Array.from(document.querySelectorAll(`.column[data-status="${s}"] [data-task-id]`)).map(e => e.dataset.taskId), status);
    const waitColFirst = async (status, id, label) => {
      try {
        await page.waitForFunction((s, want) => {
          const first = document.querySelector(`.column[data-status="${s}"] [data-task-id]`);
          return first && first.dataset.taskId === want;
        }, { timeout: 6000 }, status, id);
        return true;
      } catch { console.log(`  (debug) ${label}: ${status} order = ${JSON.stringify(await colIds(status))}`); return false; }
    };

    // 1) New tasks land at the top of backlog (newest id first while unranked).
    r.ok(await waitColFirst('backlog', ids[2], 'backlog-newest'),
      'newest created task is at the top of backlog');

    // 2) The recency case: complete the NEWEST first, then the OLDEST last, so
    //    the OLDER task entered Done most recently → it must render on top.
    await api('PUT', `/projects/${PROJECT}/tasks/${ids[2]}`, { status: 'done' });
    await new Promise(r => setTimeout(r, 40));
    await api('PUT', `/projects/${PROJECT}/tasks/${ids[0]}`, { status: 'done' });
    await page.evaluate(() => window.appState?._refreshBoard && window.appState._refreshBoard());

    r.ok(await waitColFirst('done', ids[0], 'done-recency'),
      'older task completed last renders at the TOP of Done (enteredStatusAt recency)');
    const done = await colIds('done');
    r.ok(done.indexOf(ids[0]) < done.indexOf(ids[2]),
      `older-just-completed ${ids[0]} is above earlier-completed ${ids[2]} in Done (${done.join(',')})`);
  });

  if (res?.skipped) r.skip(res.reason);
  r.done();
}

main().catch(e => { console.error(e); process.exit(1); });
