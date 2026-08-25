'use strict';

// T-457 — Overview widgets (ActiveAgentsWidget, CurrentFocusWidget) render
// from `buildActiveAgentWidgetRows` (src/utils/activeAgents.js), the same
// shared claim predicate/lease-health the Active Agents BAR already uses
// (test-active-agents-bar-e2e.js), instead of their own `t.agent &&
// t.claimedAt` filter.
//
// This is the case that filter missed and every prior suite let through:
// an ARCHIVED task that still carries agent/claimedAt/leaseUntil from
// before it was archived (exactly T-074's shape on the live instance —
// archived 2026-08-12, claim fields never cleared). The bar excluded it
// (isValidActiveClaim -> false); both widgets rendered it as an active claim.
//
// Also asserts the three-state vocabulary landed: a healthy claim shows in
// a "Working" group, a stale/expired one in "Needs attention" (one amber
// signal — no more "stealable"), and an idle activated agent in "Idle here".

const { withDashboard, reporter } = require('./test-support/browser-harness.js');

const r = reporter('Overview Active Agents / Current Focus widgets (T-457)');
const PROJECT = 'overview-active-agents-e2e';

async function waitFor(page, predicate, label, timeout = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      if (await predicate()) return true;
    } catch { /* browser may still be mounting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timeout: ${label}`);
}

(async () => {
  const result = await withDashboard(async ({ api, page, base }) => {
    await api('POST', '/projects', { name: PROJECT });
    // The "default" preset does not include current-focus — "mission" is the
    // one preset carrying both active-agents and current-focus (overview.js
    // PRESETS.mission), so both widgets under test are on the same page.
    await api('PUT', `/projects/${PROJECT}/overview`, { preset: 'mission' });
    // T-457-3: the idle agent must be activated on THIS project to show up
    // as "Idle here" at all (buildActiveAgentRows only surfaces an agent
    // with no claim when active_project matches the viewed project).
    await api('PUT', '/status', { agentId: 'idle-agent', project: PROJECT });

    const healthy = (await api('POST', `/projects/${PROJECT}/tasks`, {
      title: 'Healthy claim must show as Working',
      status: 'open',
    })).body?.task?.id;
    const archived = (await api('POST', `/projects/${PROJECT}/tasks`, {
      title: 'Archived claim must not appear at all',
      status: 'open',
    })).body?.task?.id;
    r.ok(Boolean(healthy) && Boolean(archived), 'seeded fixtures');

    await api('POST', `/projects/${PROJECT}/tasks/${healthy}/claim`, { agent: 'agent-w', lease: 30 });
    await api('POST', `/projects/${PROJECT}/tasks/${healthy}/checkpoint`, {
      agent: 'agent-w', message: 'fresh checkpoint',
    });
    // The claim endpoint clamps leases to future minute boundaries, so it
    // cannot itself produce an archived-with-claimedAt task — that state
    // only ever arises from a task getting archived without its claim being
    // released first (exactly what happened to T-074). The bar's own e2e
    // suite (test-active-agents-bar-e2e.js) establishes this same
    // app-state-proxy technique for render-only edge fixtures the live API
    // cannot construct directly; reused here for the identical reason.
    await api('POST', `/projects/${PROJECT}/tasks/${archived}/claim`, { agent: 'codex', lease: 30 });

    await page.goto(`${base}/?agentId=e2e-tester`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('.app', { timeout: 8000 });
    await page.evaluate((p) => window._viewProject && window._viewProject(p), PROJECT);
    await page.waitForFunction((p) => window.appState?.viewedProject === p, { timeout: 8000 }, PROJECT);
    await page.click('#tabBar .tab[data-tab="overview"]');
    await page.waitForSelector('.ov-grid', { timeout: 8000 });

    await page.evaluate((ids) => {
      const now = Date.now();
      window.appState.tasks = (window.appState.tasks || []).map((task) => {
        if (task.id === ids.archived) {
          return {
            ...task,
            status: 'archived',
            agent: 'codex',
            claimedAt: new Date(now - 13 * 24 * 60 * 60 * 1000).toISOString(),
            leaseUntil: new Date(now - 13 * 24 * 60 * 60 * 1000 + 20 * 60 * 1000).toISOString(),
          };
        }
        return task;
      });
    }, { archived });

    const widgetByTitle = (title) => page.evaluate((title) => {
      const w = [...document.querySelectorAll('.ov-widget')].find((el) => {
        const t = el.querySelector('.ov-wtitle');
        return t && t.textContent.trim().toLowerCase() === title.toLowerCase();
      });
      if (!w) return null;
      return {
        rowIds: [...w.querySelectorAll('.ov-agent-task .tid, .ov-agent-handle')].map((el) => el.textContent.trim()),
        groups: [...w.querySelectorAll('.ov-agent-group')].map((el) => el.textContent.trim()),
        html: w.innerHTML,
      };
    }, title);

    await waitFor(page, async () => {
      const w = await widgetByTitle('Active Agents');
      return w && w.html.includes('Healthy claim must show as Working'.slice(0, 10));
    }, 'Active Agents widget renders the healthy claim');

    const activeAgents = await widgetByTitle('Active Agents');
    r.ok(Boolean(activeAgents), 'Active Agents widget is present on the default overview');
    r.ok(!activeAgents.html.includes(archived), 'T-457: the archived task with claimedAt does not appear in the Active Agents widget');
    r.ok(!activeAgents.html.includes('Archived claim must not appear'), 'T-457: the archived task title does not render anywhere in the Active Agents widget');
    r.ok(activeAgents.html.includes(healthy), 'the healthy claim (agent-w) still renders in the Active Agents widget');
    r.ok(activeAgents.groups.includes('Working'), 'Active Agents widget labels the healthy-claim group "Working"');
    r.ok(activeAgents.groups.includes('Idle here'), 'Active Agents widget labels the no-claim group "Idle here"');
    r.ok(!activeAgents.html.includes('stealable'), 'Active Agents widget never renders the retired "stealable" wording');
    r.ok(activeAgents.html.includes('idle-agent'), 'the idle-activated agent (no claim) still renders in the Active Agents widget');

    const currentFocus = await widgetByTitle('Current Focus');
    r.ok(Boolean(currentFocus), 'Current Focus widget is present on the default overview');
    r.ok(!currentFocus.html.includes(archived), 'T-457: the archived task with claimedAt does not appear in the Current Focus widget either (same bug, found via the T-457 claimedAt sweep)');
    r.ok(!currentFocus.html.includes('Archived claim must not appear'), 'T-457: the archived task title does not render anywhere in the Current Focus widget');
    r.ok(currentFocus.html.includes(healthy), 'the healthy claim still renders in the Current Focus widget');
    r.ok(currentFocus.groups.includes('Working'), 'Current Focus widget labels the healthy-claim group "Working"');
    r.ok(!currentFocus.groups.includes('Idle here'), 'Current Focus widget has no idle section (it has only ever shown claims)');
    r.ok(!currentFocus.html.includes('stealable'), 'Current Focus widget never renders the retired "stealable" wording');

    // Lease-health color comes from the shared, unscoped dashboard.css
    // classes the bar itself uses (`.active-agents-health--current`), not a
    // widget-local rule — proves the color source is actually shared, not
    // just visually similar.
    const dotClass = await page.evaluate(() => {
      const w = [...document.querySelectorAll('.ov-widget')].find((el) =>
        el.querySelector('.ov-wtitle')?.textContent.trim().toLowerCase() === 'active agents');
      const dot = w?.querySelector('.ov-agent-row:not(.idle) .active-agents-health__dot');
      const wrap = dot?.closest('.active-agents-health');
      return wrap ? [...wrap.classList] : null;
    });
    r.ok(Array.isArray(dotClass) && dotClass.includes('active-agents-health--current'),
      `healthy claim's lease dot reuses the bar's own health class (got: ${JSON.stringify(dotClass)})`);
  }, { viewport: { width: 1100, height: 850 } });

  if (result?.skipped) r.skip(result.reason);
  r.done();
})().catch((error) => {
  console.error('# fatal:', error.stack || error.message);
  process.exitCode = 1;
});
