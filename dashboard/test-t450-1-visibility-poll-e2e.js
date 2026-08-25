'use strict';

// T-450-1: the background snapshot poll must not run while the tab/mini-app
// is not visible (document.hidden), and must reload immediately once it
// becomes visible again so the first look after returning is current.
//
// Drives the real built dashboard (server.js + dist/) via browser-harness.js
// and counts real GET /api/dashboard/snapshot/v1 requests through Puppeteer
// request interception — every request is allowed through unmodified, this
// test only observes timing, it never mocks a response. document.hidden is
// flipped from inside the page by shadowing it with an own-property getter
// plus a manual 'visibilitychange' dispatch — the standard technique for
// simulating tab backgrounding, since a real headless Puppeteer page cannot
// be told to natively background itself on demand.

const { withDashboard, reporter } = require('./test-support/browser-harness.js');

const r = reporter('Background poll pauses when hidden, reloads on visible (T-450-1)');

function setDocumentVisibility(hidden) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (hidden ? 'hidden' : 'visible'),
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

async function main() {
  const res = await withDashboard(async ({ api, page, base }) => {
    await api('POST', '/projects', { name: 'visibility-poll' });

    let snapshotGetCount = 0;
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname === '/api/dashboard/snapshot/v1' && request.method() === 'GET') {
        snapshotGetCount += 1;
      }
      request.continue().catch(() => {});
    });

    await page.goto(`${base}/?agentId=e2e-visibility`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('.app', { timeout: 8000 });
    await page.waitForFunction(
      () => window.appState?.connection && window.appState.connection.status !== 'loading',
      { timeout: 8000 },
    );

    const countAtMount = snapshotGetCount;
    r.ok(countAtMount >= 1, 'the initial mount issued its own unconditional snapshot fetch');

    // Background the tab *before* asserting — regardless of whether the very
    // first 5s poll tick already happened to fire while still visible, no
    // further request may be issued once hidden.
    await page.evaluate(setDocumentVisibility, true);
    const countAtHidden = snapshotGetCount;

    // DashboardContext.jsx's base poll interval is 5s. Waiting well past it
    // while hidden must not add a single request — if visibility were
    // ignored, at least one more tick would unambiguously have fired inside
    // this window.
    await new Promise((resolve) => setTimeout(resolve, 7000));
    r.ok(snapshotGetCount === countAtHidden,
      `no snapshot poll fired while document.hidden was true (stayed at ${countAtHidden}, `
      + `${snapshotGetCount - countAtHidden} extra requests observed)`);

    // Coming back into view must reload immediately, not wait for wherever
    // the (paused) interval had been.
    const beforeVisible = Date.now();
    await page.evaluate(setDocumentVisibility, false);

    let sawReload = false;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (snapshotGetCount > countAtHidden) { sawReload = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const reloadLatencyMs = Date.now() - beforeVisible;
    r.ok(sawReload, 'becoming visible again triggers an immediate snapshot reload');
    r.ok(reloadLatencyMs < 3000,
      `the reload after visibilitychange happened promptly (${reloadLatencyMs}ms), not on the old 5s cadence`);
  });

  if (res?.skipped) r.skip(res.reason);
  r.done();
}

main().catch((error) => { console.error(error); process.exit(1); });
