'use strict';

// T-447-5 browser coverage proves the real Overview renderer exposes the
// current mode and the human-only control. The harness is intentionally
// unauthenticated, so the final assertion also proves normal readers see the
// mode without receiving a mutation capability.
const { withDashboard, reporter } = require('./test-support/browser-harness.js');

const project = 'governance-browser';
const r = reporter('Governance mode Dashboard (T-447-5)');

async function main() {
  const result = await withDashboard(async ({ api, page, base }) => {
    await api('POST', '/projects', { name: project });
    await api('PUT', `/projects/${project}/overview`, { preset: 'default' });
    const mode = await api('GET', `/projects/${project}/governance/mode`);
    r.ok(mode.status === 200 && mode.body.mode === 'compat', 'normal callers can read the persisted default mode');
    r.ok(mode.body.canChange === false, 'normal callers do not receive a mutation capability');

    await page.goto(`${base}/?agentId=e2e`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('.app', { timeout: 8000 });
    await page.evaluate(p => window._viewProject && window._viewProject(p), project);
    await page.waitForFunction(p => window.appState?.viewedProject === p, { timeout: 8000 }, project);
    await page.click('#tabBar .tab[data-tab="overview"]');
    await page.waitForSelector('[data-testid="governance-mode-control"]', { timeout: 8000 });

    const rendered = await page.$eval('[data-testid="governance-mode-control"]', node => ({
      text: node.textContent,
      mode: node.dataset.governanceMode,
      hint: node.textContent.includes('Verified human required'),
    }));
    r.ok(rendered.mode === 'compat' && rendered.text.includes('Policy'), 'Overview visibly renders the current compat mode');
    r.ok(rendered.hint, 'agent-facing Dashboard control explains that a verified human is required');

    // The API contract test covers real authenticated mutation. Here the
    // browser harness supplies the server's verified-human capability shape so
    // the E2E also proves the authorized control renders and updates the
    // visible mode without coupling the harness to Telegram's HMAC exchange.
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      if (!url.pathname.endsWith(`/projects/${project}/governance/mode`)) return request.continue();
      if (request.method() === 'GET') {
        return request.respond({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({ ok: true, project, mode: 'compat', default: 'compat', modes: ['compat', 'enforce'], canChange: true, lastChange: null }),
        });
      }
      return request.respond({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ ok: true, project, mode: 'enforce', lastChange: { actor: 'telegram:42', changedAt: new Date().toISOString(), mode: 'enforce' } }),
      });
    });
    await page.reload({ waitUntil: 'networkidle2' });
    await page.waitForSelector('[aria-label="Switch to enforce mode"]', { timeout: 8000 });
    await page.click('[aria-label="Switch to enforce mode"]');
    await page.waitForFunction(() => document.querySelector('[data-testid="governance-mode-control"]')?.dataset.governanceMode === 'enforce', { timeout: 8000 });
    r.ok(true, 'verified-human control switches the visible mode in the real Dashboard');
  }, { viewport: { width: 1200, height: 850 } });

  if (result?.skipped) r.skip(result.reason);
  r.done();
}

main().catch(error => { console.error(error.stack || error); process.exit(1); });
