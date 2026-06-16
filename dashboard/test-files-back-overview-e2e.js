'use strict';

// T-399 — File editor:
//   1. Files opened from an overview widget (Context Index, Recent Decisions,
//      Project Goals, File Viewer) show a "← Back to Overview" button that
//      returns to the Overview tab — mirrors the task spec "← Back to Task".
//   2. The obsolete context-size bar (.context-bar, went red past a byte
//      threshold) is gone; the "{n} files · {size} · Show hidden" footer stays.
// Uses the shared browser-E2E harness.

const { withDashboard, reporter } = require('./test-support/browser-harness.js');

const P = 'fback';
const r = reporter('File editor: back-to-overview + no context bar (T-399)');

async function main() {
  const res = await withDashboard(async ({ api, page, base }) => {
    await api('POST', '/projects', { name: P });
    await api('PUT', `/projects/${P}/overview`, { preset: 'default' });
    await api('POST', `/projects/${P}/files/context`, { filename: 'alpha.md', content: '# Alpha' });

    await page.goto(`${base}/?agentId=e2e`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('.app', { timeout: 8000 });
    await page.evaluate((p) => window._viewProject && window._viewProject(p), P);
    await page.waitForFunction((p) => window.appState?.viewedProject === p, { timeout: 8000 }, P);
    await page.click('#tabBar .tab[data-tab="overview"]');
    await page.waitForSelector('.ov-grid', { timeout: 8000 });

    // --- #1: open a context file from the Context Index widget ---
    await page.waitForSelector('.ci-list .ci-row', { timeout: 8000 });
    await page.click('.ci-list .ci-row');

    const hasBackToOverview = await page.waitForFunction(
      () => [...document.querySelectorAll('button')].some(b => /back to overview/i.test(b.textContent || '')),
      { timeout: 8000 }).then(() => true).catch(() => false);
    r.ok(hasBackToOverview, 'widget-opened file shows a "Back to Overview" button');

    // it actually returns to the Overview
    if (hasBackToOverview) {
      await page.evaluate(() => {
        const b = [...document.querySelectorAll('button')].find(x => /back to overview/i.test(x.textContent || ''));
        b && b.click();
      });
      const backOnOverview = await page.waitForSelector('.ov-grid', { timeout: 8000 }).then(() => true).catch(() => false);
      r.ok(backOnOverview, 'clicking it returns to the Overview tab');
    } else {
      r.ok(false, 'clicking it returns to the Overview tab (skipped — no button)');
    }

    // --- #2: the context-size bar is gone, footer info + toggle stay ---
    await page.click('#tabBar .tab[data-tab="files"]');
    // wait until the tree has loaded and the footer is populated (it's gated on fileTree)
    await page.waitForFunction(
      () => /\bfiles\b/i.test(document.querySelector('.file-tree-footer')?.textContent || ''),
      { timeout: 8000 });
    const footer = await page.evaluate(() => {
      const bar = document.querySelectorAll('.context-bar').length;
      const txt = document.querySelector('.file-tree-footer')?.textContent || '';
      const toggle = [...document.querySelectorAll('.file-tree-footer button')]
        .some(b => /show hidden|hide operational/i.test(b.textContent || ''));
      return { bar, hasFilesInfo: /files/i.test(txt), toggle };
    });
    r.ok(footer.bar === 0, `context-size bar is removed (found ${footer.bar})`);
    r.ok(footer.hasFilesInfo, 'footer still shows the files/size info');
    r.ok(footer.toggle, 'footer still has the Show hidden toggle');
  });

  if (res?.skipped) r.skip(res.reason);
  r.done();
}
main().catch(e => { console.error(e); process.exit(1); });
