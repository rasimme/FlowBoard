'use strict';

// T-447-5 browser coverage proves the real Overview renderer still mounts
// alongside the final task-discipline contract. The harness is intentionally
// unauthenticated, so the write also exercises the local-operator attribution
// path without trusting identity-shaped request fields.
const { withDashboard, reporter } = require('./test-support/browser-harness.js');

const project = 'task-discipline-browser';
const r = reporter('Task discipline Dashboard (T-447-5)');

async function main() {
  const result = await withDashboard(async ({ api, page, base }) => {
    await api('POST', '/projects', { name: project });
    await api('PUT', `/projects/${project}/overview`, { preset: 'default' });
    const initial = await api('GET', `/projects/${project}/task-discipline`);
    r.ok(initial.status === 200 && initial.body.discipline === 'list', 'normal callers read the task-discipline default');
    r.ok(initial.body.default === 'list', 'task-discipline reports list as its default');
    r.ok(JSON.stringify(initial.body.values) === JSON.stringify(['list', 'standard', 'development']), 'task-discipline reports the supported values');
    r.ok(initial.body.canChange === true, 'normal callers receive task-discipline mutation capability');
    r.ok(initial.body.lastChange === null, 'a new project has no task-discipline change provenance');

    const local = await api('PUT', `/projects/${project}/task-discipline`, {
      discipline: 'development', human: 'Ada', agentId: 'human', approved: true,
    });
    r.ok(local.status === 200 && local.body.discipline === 'development', 'local callers can set task discipline');
    r.ok(local.body.lastChange?.actor === 'local:operator', 'local task-discipline changes carry server-owned provenance');
    r.ok(local.body.lastChange?.actor !== 'Ada', 'task-discipline provenance ignores body identity fields');

    await page.goto(`${base}/?agentId=e2e`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('.app', { timeout: 8000 });
    await page.evaluate(p => window._viewProject && window._viewProject(p), project);
    await page.waitForFunction(p => window.appState?.viewedProject === p, { timeout: 8000 }, project);
    await page.click('#tabBar .tab[data-tab="overview"]');
    r.ok(await page.$('.app'), 'Overview renderer mounts for a task-discipline project');
  }, { viewport: { width: 1200, height: 850 } });

  if (result?.skipped) r.skip(result.reason);
  r.done();
}

main().catch(error => { console.error(error.stack || error); process.exit(1); });
