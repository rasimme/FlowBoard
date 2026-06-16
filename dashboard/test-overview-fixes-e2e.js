'use strict';

// T-394 — review fixes on the Knowledge/Milestones overview work:
//   1. Context Index date (.ci-when) renders small, not at the inherited
//      default size that blew up the row layout.
//   2. Milestones empty-state hint is short so the CTA isn't pinned to the edge.
//   3. Milestone "create" and Links "add" forms both offer a visible cancel.
//   4. Quick Actions buttons keep their labels at normal widget widths — the
//      icon-only collapse only kicks in for genuinely tiny widgets.
// Uses the shared browser-E2E harness; finding 4 also has a browser-free guard
// on the CSS threshold so the regression is caught even when Edge is absent.

const fs = require('fs');
const path = require('path');
const { withDashboard, reporter } = require('./test-support/browser-harness.js');

const P = 'ovfix';
const r = reporter('Overview review fixes (T-394)');

// --- finding 4, deterministic: the label-hide container query is not aggressive ---
const css = fs.readFileSync(path.join(__dirname, 'styles/overview.css'), 'utf8');
{
  // isolate the @container block that hides quick-link labels
  const chunks = css.split('@container');
  const hideChunk = chunks.find(c => /\.ov-links\s+span\s*\{[^}]*display:\s*none/.test(c));
  const m = hideChunk && hideChunk.match(/widget\s*\(max-width:\s*(\d+)px\)/);
  const thresh = m ? Number(m[1]) : null;
  r.ok(thresh !== null && thresh <= 180,
    `quick-link labels only collapse below a small width (max-width ${thresh ?? '?'}px <= 180)`);
}

async function main() {
  const res = await withDashboard(async ({ api, page, base }) => {
    await api('POST', '/projects', { name: P });
    await api('PUT', `/projects/${P}/overview`, { preset: 'default' });
    // a context file so the Context Index renders a dated row (finding 1)
    await api('POST', `/projects/${P}/files/context`, { filename: 'alpha.md', content: '# A' });

    await page.goto(`${base}/?agentId=e2e`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('.app', { timeout: 8000 });
    await page.evaluate((p) => window._viewProject && window._viewProject(p), P);
    await page.waitForFunction((p) => window.appState?.viewedProject === p, { timeout: 8000 }, P);
    await page.click('#tabBar .tab[data-tab="overview"]');
    await page.waitForSelector('.ov-grid', { timeout: 8000 });

    // helper: click a button (by visible text) inside the widget with `title`
    const clickInWidget = (title, btnText) => page.evaluate((title, btnText) => {
      const w = [...document.querySelectorAll('.ov-widget')].find(el => {
        const t = el.querySelector('.ov-wtitle');
        return t && t.textContent.trim().toLowerCase() === title.toLowerCase();
      });
      if (!w) return false;
      const b = [...w.querySelectorAll('button')].find(x => (x.textContent || '').includes(btnText));
      if (!b) return false; b.click(); return true;
    }, title, btnText);

    // --- finding 1: the date next to a context file is small, not body-size ---
    await page.waitForSelector('.ci-list .ci-row', { timeout: 8000 });
    const ciFont = await page.evaluate(() => {
      const el = document.querySelector('.ci-row .ci-when');
      return el ? parseFloat(getComputedStyle(el).fontSize) : null;
    });
    r.ok(ciFont !== null && ciFont <= 11, `Context Index date is small (${ciFont ?? '?'}px <= 11)`);

    // --- finding 2: Milestones empty hint is short ---
    const msHint = await page.evaluate(() => {
      const w = [...document.querySelectorAll('.ov-widget')].find(el =>
        el.querySelector('.ov-wtitle')?.textContent.trim().toLowerCase() === 'milestones');
      return w?.querySelector('.ov-empty-hint')?.textContent.trim() || null;
    });
    r.ok(msHint !== null && msHint.length <= 70, `Milestones empty hint is concise (${msHint ? msHint.length : '?'} chars <= 70)`);

    // --- finding 3a: milestone create flow has a visible cancel ---
    r.ok(await clickInWidget('Milestones', 'Create your first milestone'), 'opened milestone create flow');
    const msCancel = await page.waitForSelector('[aria-label="Cancel new milestone"]', { timeout: 4000 })
      .then(() => true).catch(() => false);
    r.ok(msCancel, 'milestone create flow offers a cancel before a name is typed');

    // --- finding 3b: links add form has a visible cancel ---
    r.ok(await clickInWidget('Links', 'Add a link'), 'opened links add form');
    const lkCancel = await page.waitForSelector('.lk-add [aria-label="Cancel adding link"]', { timeout: 4000 })
      .then(() => true).catch(() => false);
    r.ok(lkCancel, 'links add form offers a cancel');

    // --- finding 4 (rendered): labels visible once the widget clears the small threshold ---
    const ql = await page.evaluate(() => {
      const w = [...document.querySelectorAll('.ov-widget')].find(el => el.querySelector('.ov-links'));
      const span = w?.querySelector('.ov-link span:not(.sub)');
      return { width: w ? Math.round(w.clientWidth) : 0, shown: !!(span && span.offsetWidth > 0 && (span.textContent || '').trim()) };
    });
    r.ok(ql.width < 170 || ql.shown, `Quick Actions labels visible at >=170px widget width (w=${ql.width}px, shown=${ql.shown})`);
  }, { viewport: { width: 1100, height: 850 } });

  if (res?.skipped) console.log(`  # browser checks skipped: ${res.reason}`);
  r.done();
}
main().catch(e => { console.error(e); process.exit(1); });
