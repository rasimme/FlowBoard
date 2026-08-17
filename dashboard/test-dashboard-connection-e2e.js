'use strict';

// T-440 — real-browser coverage for fatal bootstrap/API states, bounded
// timeouts, partial refresh priority, and poll/retry serialization. Request
// interception controls only GET /api/projects; the rest of the shell talks to
// the throwaway real dashboard from browser-harness.

const net = require('net');
const { withDashboard, reporter } = require('./test-support/browser-harness.js');

const r = reporter('Dashboard connection states (T-440)');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function main() {
  const port = await getFreePort();
  const res = await withDashboard(async ({ api, page, base }) => {
    let mode = 'pass';
    let releaseDelayedProjects;
    let delayedProjects = Promise.resolve();
    let releaseStaleRace;
    let staleRaceResponse = Promise.resolve();
    let notifyRacePollStarted;
    let racePollStarted = Promise.resolve();
    let raceRequestCount = 0;

    const respond = (request, status, body, contentType = 'application/json') => request.respond({
      status,
      contentType,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

    await page.evaluateOnNewDocument(() => {
      const realFetch = window.fetch.bind(window);
      window.__flowboardProjectFetchProbe = { active: 0, overlapped: false };
      window.fetch = (...args) => {
        let pathname = '';
        try { pathname = new URL(typeof args[0] === 'string' ? args[0] : args[0]?.url, location.href).pathname; } catch {}
        if (pathname !== '/api/projects') return realFetch(...args);
        const probe = window.__flowboardProjectFetchProbe;
        if (probe.active > 0) probe.overlapped = true;
        probe.active += 1;
        return realFetch(...args).finally(() => { probe.active -= 1; });
      };
    });

    await page.setRequestInterception(true);
    page.on('request', (request) => {
      void (async () => {
        const url = new URL(request.url());
        if (request.method() !== 'GET' || url.pathname !== '/api/projects') {
          await request.continue();
          return;
        }

        if (mode === 'delay-empty') {
          await delayedProjects;
          await respond(request, 200, { ok: true, projects: [] });
        } else if (mode === 'malformed') {
          await respond(request, 200, '<html>not JSON</html>', 'text/html');
        } else if (mode === 'invalid-schema') {
          await respond(request, 200, {
            ok: true,
            projects: [{
              name: 'malformed-project',
              displayName: 'Malformed Project',
              status: 'mystery',
              archived: false,
              group: null,
              github: null,
              order: null,
              assignedAgents: [],
              description: '',
              createdAt: null,
              taskCounts: {
                open: 0,
                'in-progress': 0,
                review: 0,
                done: 0,
                backlog: 0,
                archived: 0,
                blocked: 0,
              },
            }],
          });
        } else if (mode === 'auth') {
          await respond(request, 403, { error: 'Tunnel authentication required' });
        } else if (mode === 'server') {
          await respond(request, 500, { error: 'Synthetic server failure' });
        } else if (mode === 'offline') {
          await request.abort('failed');
        } else if (mode === 'timeout') {
          // Intentionally leave the real browser request unresolved. apiFetch's
          // deadline must abort it and surface a retryable timeout state.
        } else if (mode === 'race') {
          raceRequestCount += 1;
          if (raceRequestCount === 1) {
            notifyRacePollStarted();
            await staleRaceResponse;
            await respond(request, 200, { ok: true, projects: [] });
          } else {
            await request.continue();
          }
        } else {
          await request.continue();
        }
      })().catch((error) => {
        // A retry deliberately aborts the intercepted stale poll. Puppeteer can
        // then reject the late respond() because the request no longer exists.
        if (!/intercept|Invalid Interception|already handled|Target closed/i.test(error.message)) {
          console.error('request interception failed:', error);
        }
      });
    });

    const goto = async (caseName) => {
      await page.goto(`${base}/?agentId=e2e&case=${caseName}`, { waitUntil: 'domcontentloaded' });
    };
    const state = async () => page.$eval('[data-connection-state]', (el) => el.dataset.connectionState);
    const sidebarSaysNoProjects = async () => page.$$eval('.sidebar-empty',
      (els) => els.some((el) => el.textContent.trim() === 'No projects'));

    // Explicit Loading → Empty: "No projects" is allowed only after the
    // successful delayed 200 response resolves. Loading itself has a manual
    // retry path instead of becoming an uninterruptible spinner.
    mode = 'delay-empty';
    delayedProjects = new Promise((resolve) => { releaseDelayedProjects = resolve; });
    const loadingNavigation = goto('loading-empty');
    await page.waitForSelector('.connection-screen[data-connection-state="loading"]', { timeout: 8000 });
    r.ok(!!(await page.$('.connection-screen [data-action="retry-connection"]')),
      'initial loading exposes a manual retry/abort action');
    r.ok(!(await sidebarSaysNoProjects()), 'loading does not masquerade as an empty board');
    releaseDelayedProjects();
    await loadingNavigation;
    await page.waitForFunction(() => document.querySelector('[data-connection-state]')?.dataset.connectionState === 'empty');
    r.ok(await sidebarSaysNoProjects(), 'successful 200 + [] renders the real No projects state');

    // Both syntactically malformed JSON and a schema-invalid JSON envelope are
    // protocol/server errors, never successful empty data.
    mode = 'malformed';
    await goto('malformed-2xx');
    await page.waitForSelector('.connection-screen[data-connection-state="server-error"]', { timeout: 8000 });
    r.ok(!(await sidebarSaysNoProjects()), 'non-JSON 2xx is a server error, not No projects');

    mode = 'invalid-schema';
    await goto('invalid-schema-2xx');
    await page.waitForSelector('.connection-screen[data-connection-state="server-error"]', { timeout: 8000 });
    r.ok(!(await sidebarSaysNoProjects()), 'schema-invalid 2xx is a server error, not No projects');

    // This is a real unresolved fetch, not a synthetic 504 response. The
    // 10-second apiJson deadline aborts it and renders a retryable timeout.
    mode = 'timeout';
    await goto('timeout');
    await page.waitForSelector('.connection-screen[data-connection-state="timeout"]', { timeout: 13000 });
    r.ok(await state() === 'timeout', 'an actual fetch deadline renders the timeout state');
    r.ok(!!(await page.$('.connection-screen [data-action="retry-connection"]')),
      'timeout state offers Retry');
    mode = 'pass';
    await page.click('.connection-screen [data-action="retry-connection"]');
    await page.waitForFunction(() => document.querySelector('[data-connection-state]')?.dataset.connectionState === 'empty');

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
    r.ok(retryBox.left >= 0 && retryBox.right <= 390 && retryBox.top >= 0 && retryBox.bottom <= 780 && retryBox.height >= 44,
      'retry is at least 44px tall and remains inside the Telegram/mobile viewport');
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

    // A successful task-only refresh is a partial recovery. It must not erase
    // the still-unrecovered global /projects failure.
    mode = 'pass';
    await page.evaluate(() => window.appState._refreshBoard());
    r.ok(!!(await page.$('.connection-banner[data-connection-state="server-error"]')),
      'task-only recovery cannot clear a global core API failure');

    // Coordinate the next poll so it remains in flight, then click the still
    // visible Retry button. Retry must abort/supersede that poll; releasing its
    // stale empty response later must not overwrite the retry result.
    mode = 'race';
    raceRequestCount = 0;
    await page.evaluate(() => {
      window.__flowboardProjectFetchProbe.active = 0;
      window.__flowboardProjectFetchProbe.overlapped = false;
    });
    racePollStarted = new Promise((resolve) => { notifyRacePollStarted = resolve; });
    staleRaceResponse = new Promise((resolve) => { releaseStaleRace = resolve; });
    await racePollStarted;
    await page.click('.connection-banner [data-action="retry-connection"]');
    await page.waitForFunction(() => document.querySelector('[data-connection-state]')?.dataset.connectionState === 'ready');
    releaseStaleRace();
    await new Promise((resolve) => setTimeout(resolve, 500));
    r.ok(await state() === 'ready', 'a stale poll cannot replace the newer retry connection state');
    r.ok(!(await page.evaluate(() => window.__flowboardProjectFetchProbe.overlapped)),
      'Retry starts network work only after the aborted poll fetch promise has settled');
    r.ok(!!(await page.$('[data-project="preserved-board"]')),
      'a stale poll cannot overwrite the project snapshot recovered by Retry');
    r.ok(!(await page.$('.connection-banner')), 'serialized retry returns the shell to ready');
  }, { port, viewport: { width: 1400, height: 900 } });

  if (res?.skipped) r.skip(res.reason);
  r.done();
}

main().catch((error) => { console.error(error); process.exit(1); });
