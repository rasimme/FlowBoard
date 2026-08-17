'use strict';

// T-440 — real-browser coverage for fatal bootstrap/API states and degraded
// polling. Request interception controls only GET /api/projects; the rest of
// the shell talks to the throwaway real dashboard from browser-harness.

const { withDashboard, reporter } = require('./test-support/browser-harness.js');

const r = reporter('Dashboard connection states (T-440)');

async function main() {
  const res = await withDashboard(async ({ api, page, base }) => {
    let mode = 'pass';
    let releaseDelayedProjects;
    let delayedProjects = Promise.resolve();

    await page.setRequestInterception(true);
    page.on('request', async (request) => {
      const url = new URL(request.url());
      if (request.method() !== 'GET' || url.pathname !== '/api/projects') {
        await request.continue();
        return;
      }

      if (mode === 'delay-empty') {
        await delayedProjects;
        await request.respond({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ projects: [] }),
        });
      } else if (mode === 'auth') {
        await request.respond({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Tunnel authentication required' }),
        });
      } else if (mode === 'server') {
        await request.respond({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Synthetic server failure' }),
        });
      } else if (mode === 'offline') {
        await request.abort('failed');
      } else {
        await request.continue();
      }
    });

    const goto = async (caseName) => {
      await page.goto(`${base}/?agentId=e2e&case=${caseName}`, { waitUntil: 'domcontentloaded' });
    };
    const state = async () => page.$eval('[data-connection-state]', (el) => el.dataset.connectionState);
    const sidebarSaysNoProjects = async () => page.$$eval('.sidebar-empty',
      (els) => els.some((el) => el.textContent.trim() === 'No projects'));

    // Explicit Loading → Empty: "No projects" is allowed only after the
    // successful delayed 200 response resolves.
    mode = 'delay-empty';
    delayedProjects = new Promise((resolve) => { releaseDelayedProjects = resolve; });
    const loadingNavigation = goto('loading-empty');
    await page.waitForSelector('.connection-screen[data-connection-state="loading"]', { timeout: 8000 });
    r.ok(!(await sidebarSaysNoProjects()), 'loading does not masquerade as an empty board');
    releaseDelayedProjects();
    await loadingNavigation;
    await page.waitForFunction(() => document.querySelector('[data-connection-state]')?.dataset.connectionState === 'empty');
    r.ok(await sidebarSaysNoProjects(), 'successful 200 + [] renders the real No projects state');

    // 403 is a blocking auth state with Telegram-specific remediation. The
    // retry remains inside a phone viewport and recovers to the valid empty UI.
    await page.setViewport({ width: 390, height: 780 });
    mode = 'auth';
    await goto('auth');
    await page.waitForSelector('.connection-screen[data-connection-state="auth-error"]', { timeout: 8000 });
    r.ok(!(await sidebarSaysNoProjects()), '403 never renders No projects');
    r.ok(await page.$eval('.connection-screen', (el) => /Telegram/i.test(el.textContent)),
      'auth state explains Telegram remediation');
    const retryBox = await page.$eval('.connection-screen [data-action="retry-connection"]', (el) => {
      const box = el.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, height: box.height };
    });
    r.ok(retryBox.left >= 0 && retryBox.right <= 390 && retryBox.top >= 0 && retryBox.bottom <= 780 && retryBox.height >= 40,
      'retry is touch-sized and remains inside the Telegram/mobile viewport');
    mode = 'pass';
    await page.click('.connection-screen [data-action="retry-connection"]');
    await page.waitForFunction(() => document.querySelector('[data-connection-state]')?.dataset.connectionState === 'empty');
    r.ok(await sidebarSaysNoProjects(), 'retry recovers from auth failure to the successful empty state');

    // 5xx and a rejected fetch get distinct blocking states.
    mode = 'server';
    await goto('server');
    await page.waitForSelector('.connection-screen[data-connection-state="server-error"]', { timeout: 8000 });
    r.ok(await state() === 'server-error', '500 renders a blocking server-error state');
    r.ok(!(await sidebarSaysNoProjects()), '500 never renders No projects');

    mode = 'offline';
    await goto('offline');
    await page.waitForSelector('.connection-screen[data-connection-state="offline"]', { timeout: 8000 });
    r.ok(await state() === 'offline', 'connection failure renders a blocking offline state');

    // Once real data exists, a poll failure becomes a persistent banner and
    // must not replace the last valid project snapshot with an empty array.
    await api('POST', '/projects', { name: 'preserved-board' });
    await page.setViewport({ width: 1400, height: 900 });
    mode = 'pass';
    await goto('polling');
    await page.waitForFunction(() => document.querySelector('[data-connection-state]')?.dataset.connectionState === 'ready');
    await page.waitForSelector('[data-project="preserved-board"]');
    mode = 'server';
    await page.waitForSelector('.connection-banner[data-connection-state="server-error"]', { timeout: 8000 });
    r.ok(!!(await page.$('[data-project="preserved-board"]')), 'poll failure preserves the last valid project data');
    r.ok(!(await sidebarSaysNoProjects()), 'poll failure does not replace data with an empty board');
    mode = 'pass';
    await page.click('.connection-banner [data-action="retry-connection"]');
    await page.waitForFunction(() => document.querySelector('[data-connection-state]')?.dataset.connectionState === 'ready');
    r.ok(!(await page.$('.connection-banner')), 'banner retry returns the shell to ready');
  }, { port: 18869, viewport: { width: 1400, height: 900 } });

  if (res?.skipped) r.skip(res.reason);
  r.done();
}

main().catch((error) => { console.error(error); process.exit(1); });
