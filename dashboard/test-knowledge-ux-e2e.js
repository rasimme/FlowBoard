'use strict';

// T-391 / T-392 — Knowledge widgets in the real rendered overview:
//  - empty Context Index / Links show a one-click action (active empty-state)
//  - Context Index orders files most-recently-edited first
// Uses the shared browser-E2E harness.

const { withDashboard, reporter } = require('./test-support/browser-harness.js');

const P = 'kux';
const r = reporter('Knowledge widgets UX (T-391/T-392)');

async function main() {
  const res = await withDashboard(async ({ api, page, base }) => {
    await api('POST', '/projects', { name: P });
    await api('PUT', `/projects/${P}/overview`, { preset: 'knowledge' });

    await page.goto(`${base}/?agentId=e2e`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('.app', { timeout: 8000 });
    await page.evaluate((p) => window._viewProject && window._viewProject(p), P);
    await page.waitForFunction((p) => window.appState?.viewedProject === p, { timeout: 8000 }, P);
    await page.click('#tabBar .tab[data-tab="overview"]');

    // T-391: empty-state CTAs render in the real overview.
    const hasBtn = (label) => page.waitForFunction(
      (t) => [...document.querySelectorAll('button')].some(b => (b.textContent || '').includes(t)),
      { timeout: 8000 }, label).then(() => true).catch(() => false);
    r.ok(await hasBtn('Browse files'), 'empty Context Index shows a "Browse files" action');
    r.ok(await hasBtn('Add a link'), 'empty Links shows an "Add a link" action');

    // T-392: add two context files (B newer) and assert recency order in the list.
    await api('POST', `/projects/${P}/files/context`, { filename: 'alpha.md', content: '# A' });
    await new Promise(res => setTimeout(res, 1100)); // ensure a distinct mtime second
    await api('POST', `/projects/${P}/files/context`, { filename: 'bravo.md', content: '# B' });
    await page.reload({ waitUntil: 'networkidle2' });
    await page.evaluate((p) => window._viewProject && window._viewProject(p), P);
    await page.click('#tabBar .tab[data-tab="overview"]');
    const firstCtx = await page.waitForFunction(() => {
      const row = document.querySelector('.ci-list .ci-row .nm');
      return row ? row.textContent.replace(/^★\s*/, '').trim() : null;
    }, { timeout: 8000 }).then(h => h.jsonValue()).catch(() => null);
    r.ok(firstCtx === 'bravo.md', `most-recently-edited context file is first (got ${firstCtx})`);

    // T-398: NOTES.md lives in context/ (writable zone) but has its own Notes
    // widget — it must NOT also clutter the Context Index list.
    await api('POST', `/projects/${P}/files/context`, { filename: 'NOTES.md', content: '# scratch' });
    await page.reload({ waitUntil: 'networkidle2' });
    await page.evaluate((p) => window._viewProject && window._viewProject(p), P);
    await page.click('#tabBar .tab[data-tab="overview"]');
    const ciNames = await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll('.ci-list .ci-row .nm')];
      return rows.length ? rows.map(n => n.textContent.replace(/^★\s*/, '').trim()) : null;
    }, { timeout: 8000 }).then(h => h.jsonValue()).catch(() => null);
    r.ok(Array.isArray(ciNames) && !ciNames.includes('NOTES.md'), `Context Index excludes NOTES.md (got ${JSON.stringify(ciNames)})`);
    r.ok(Array.isArray(ciNames) && ciNames.includes('bravo.md'), 'Context Index still lists regular context files');
  });

  if (res?.skipped) r.skip(res.reason);
  r.done();
}
main().catch(e => { console.error(e); process.exit(1); });
