'use strict';

// T-393 — milestones widget: at a small (3x2) card with 2+ active milestones a
// compact switcher lets you flip between them (the roadmap is hidden there);
// the create-view name input keeps its natural height (no tall field that hides
// the task picker). Browser-render regression guard.

const { withDashboard, reporter } = require('./test-support/browser-harness.js');

const PROJECT = 'msguard';

async function run() {
  const r = reporter('Milestones widget (T-393)');
  const res = await withDashboard(async ({ api, page, base }) => {
    await api('POST', '/projects', { name: PROJECT });
    const t1 = (await api('POST', `/projects/${PROJECT}/tasks`, { title: 'a' })).body.task.id;
    const t2 = (await api('POST', `/projects/${PROJECT}/tasks`, { title: 'b' })).body.task.id;
    await api('PUT', `/projects/${PROJECT}/tasks/${t1}`, { tags: ['milestone:Alpha'] });
    await api('PUT', `/projects/${PROJECT}/tasks/${t2}`, { tags: ['milestone:Beta'] });
    await api('PUT', `/projects/${PROJECT}/overview`, {
      version: 1, layout: 'grid', widgets: [{ type: 'milestones', id: 'm', grid: { x: 0, y: 0, w: 3, h: 2 } }],
    });

    await page.setViewport({ width: 1200, height: 800 });
    await page.goto(`${base}/?agentId=e2e`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('.app', { timeout: 8000 });
    await page.evaluate((p) => window._viewProject && window._viewProject(p), PROJECT);
    await page.waitForFunction((p) => window.appState?.viewedProject === p, { timeout: 8000 }, PROJECT);
    await page.evaluate(() => { const t = document.querySelector('#tabBar .tab[data-tab="overview"]'); t && t.click(); });
    await page.waitForSelector('.ms-focus', { timeout: 8000 });
    await new Promise(res2 => setTimeout(res2, 400));

    const switchVisible = await page.evaluate(() => {
      const sw = document.querySelector('.ms-switch');
      return !!sw && getComputedStyle(sw).display !== 'none';
    });
    r.ok(switchVisible, 'switcher is visible on a 3x2 card with 2 active milestones');

    const before = await page.evaluate(() => document.querySelector('.ms-focus .ms-name')?.textContent || '');
    await page.evaluate(() => { const btns = document.querySelectorAll('.ms-switch-btn'); btns[btns.length - 1]?.click(); });
    await new Promise(res2 => setTimeout(res2, 200));
    const after = await page.evaluate(() => document.querySelector('.ms-focus .ms-name')?.textContent || '');
    r.ok(before && after && before !== after, `next button switches the shown milestone (${before.trim()} -> ${after.trim()})`);

    // create view: the name input must keep its natural height (was a tall field)
    await page.evaluate(() => { const b = document.querySelector('.ms-add-head'); b && b.click(); });
    await page.waitForSelector('.ms-create .lk-in', { timeout: 8000 });
    const inputH = await page.evaluate(() => Math.round(document.querySelector('.ms-create .lk-in').getBoundingClientRect().height));
    r.ok(inputH > 0 && inputH < 60, `create input keeps natural height (${inputH}px, not a tall field)`);
    const ph = await page.evaluate(() => document.querySelector('.ms-create .lk-in').placeholder);
    r.ok(!/v?5\.1/i.test(ph), `placeholder carries no project reference ("${ph}")`);
  });
  if (res?.skipped) { r.skip(res.reason); return; }
  r.done();
}

run();
