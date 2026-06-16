'use strict';

// T-389 — the task-stats 7-day trend shows on a roomy desktop card (so a 6x2
// doesn't look empty) but hides on a narrow mobile card (where the bars would
// otherwise overlap the KPI text). Browser-render regression guard.

const { withDashboard, reporter } = require('./test-support/browser-harness.js');

const PROJECT = 'tsguard';

async function run() {
  const r = reporter('Task-stats trend visibility (T-389)');
  const res = await withDashboard(async ({ api, page, base }) => {
    await api('POST', '/projects', { name: PROJECT });
    for (const t of ['a', 'b', 'c']) await api('POST', `/projects/${PROJECT}/tasks`, { title: t });
    await api('PUT', `/projects/${PROJECT}/overview`, {
      version: 1, layout: 'grid',
      widgets: [{ type: 'task-stats', id: 'ts', grid: { x: 0, y: 0, w: 6, h: 2 } }],
    });

    const trendShown = async (w, h) => {
      await page.setViewport({ width: w, height: h });
      await page.goto(`${base}/?agentId=e2e`, { waitUntil: 'networkidle2' });
      await page.waitForSelector('.app', { timeout: 8000 });
      await page.evaluate((p) => window._viewProject && window._viewProject(p), PROJECT);
      await page.waitForFunction((p) => window.appState?.viewedProject === p, { timeout: 8000 }, PROJECT);
      await page.evaluate(() => { const t = document.querySelector('#tabBar .tab[data-tab="overview"]'); t && t.click(); });
      await page.waitForSelector('.ov-widget', { timeout: 8000 });
      await new Promise(res2 => setTimeout(res2, 400));
      return page.evaluate(() => {
        const el = document.querySelector('.ts-trend');
        return !!el && getComputedStyle(el).display !== 'none';
      });
    };

    const desktop = await trendShown(1400, 900);
    r.ok(desktop === true, 'trend is visible on a roomy desktop 6x2 card (not empty)');

    const mobile = await trendShown(390, 844);
    r.ok(mobile === false, 'trend is hidden on a narrow mobile card (no overlap)');
  });
  if (res?.skipped) { r.skip(res.reason); return; }
  r.done();
}

run();
