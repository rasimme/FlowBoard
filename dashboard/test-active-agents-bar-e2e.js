'use strict';

const { withDashboard, reporter } = require('./test-support/browser-harness.js');

const r = reporter('Active Agents multi-claim bar (T-446)');
const PROJECT = 'active-agents-e2e';

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
    await api('PUT', '/status', { agentId: 'agent-a', project: PROJECT });

    const first = (await api('POST', `/projects/${PROJECT}/tasks`, {
      title: 'First active task with a complete accessible title',
      status: 'open',
    })).body?.task?.id;
    const second = (await api('POST', `/projects/${PROJECT}/tasks`, {
      title: 'Second active task',
      status: 'open',
    })).body?.task?.id;
    const third = (await api('POST', `/projects/${PROJECT}/tasks`, {
      title: 'Third active task for the surviving agent',
      status: 'open',
    })).body?.task?.id;
    const fourth = (await api('POST', `/projects/${PROJECT}/tasks`, {
      title: 'Fourth active task for the surviving agent',
      status: 'open',
    })).body?.task?.id;
    const stale = (await api('POST', `/projects/${PROJECT}/tasks`, {
      title: 'Stale active task',
      status: 'open',
    })).body?.task?.id;
    const expired = (await api('POST', `/projects/${PROJECT}/tasks`, {
      title: 'Expired active task',
      status: 'open',
    })).body?.task?.id;
    const malformed = (await api('POST', `/projects/${PROJECT}/tasks`, {
      title: 'Malformed lease active task',
      status: 'open',
    })).body?.task?.id;
    const missingLease = (await api('POST', `/projects/${PROJECT}/tasks`, {
      title: 'Missing lease active task',
      status: 'open',
    })).body?.task?.id;
    const direct = (await api('POST', `/projects/${PROJECT}/tasks`, {
      title: 'Single direct active task',
      status: 'open',
    })).body?.task?.id;
    const done = (await api('POST', `/projects/${PROJECT}/tasks`, {
      title: 'Done claim must be excluded',
      status: 'open',
    })).body?.task?.id;
    const archived = (await api('POST', `/projects/${PROJECT}/tasks`, {
      title: 'Archived claim must be excluded',
      status: 'open',
    })).body?.task?.id;
    const trashed = (await api('POST', `/projects/${PROJECT}/tasks`, {
      title: 'Trashed claim must be excluded',
      status: 'open',
    })).body?.task?.id;
    r.ok(
      [first, second, third, fourth, stale, expired, malformed, missingLease, direct, done, archived, trashed]
        .every(Boolean),
      'seeded active-agent and exclusion fixtures',
    );
    await api('POST', `/projects/${PROJECT}/tasks/${first}/claim`, { agent: 'agent-a', lease: 30 });
    await api('POST', `/projects/${PROJECT}/tasks/${second}/claim`, { agent: 'agent-a', lease: 30 });
    await api('POST', `/projects/${PROJECT}/tasks/${stale}/claim`, { agent: 'agent-a', lease: 30 });
    await api('POST', `/projects/${PROJECT}/tasks/${expired}/claim`, { agent: 'agent-a', lease: 30 });
    await api('POST', `/projects/${PROJECT}/tasks/${malformed}/claim`, { agent: 'agent-a', lease: 30 });
    await api('POST', `/projects/${PROJECT}/tasks/${missingLease}/claim`, { agent: 'agent-a', lease: 30 });
    await api('POST', `/projects/${PROJECT}/tasks/${third}/claim`, { agent: 'agent-b', lease: 30 });
    await api('POST', `/projects/${PROJECT}/tasks/${fourth}/claim`, { agent: 'agent-b', lease: 30 });
    await api('POST', `/projects/${PROJECT}/tasks/${direct}/claim`, { agent: 'agent-c', lease: 30 });
    await api('POST', `/projects/${PROJECT}/tasks/${first}/checkpoint`, {
      agent: 'agent-a', message: 'Checkpoint reached',
    });

    await page.goto(`${base}/?agentId=agent-a`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('.app', { timeout: 8000 });
    // At a 390px viewport the legacy mobile sidebar overlays the tab bar's
    // physical hit target; dispatch the real tab button event directly so
    // this test stays focused on the Active Agents surface.
    await page.evaluate(() => document.querySelector('#tabBar .tab[data-tab="tasks"]')?.click());
    await waitFor(page, () => page.$('.active-agents-pill[data-agent-id="agent-a"]'), 'multi-claim trigger');
    await waitFor(page, () => page.$('.active-agents-pill[data-agent-id="agent-c"]'), 'single-claim trigger');

    // The API intentionally clamps leases to a future minute boundary, so
    // render-only edge fixtures are injected through the app-state proxy. The
    // unit suite covers their pure predicate/health semantics; this proves the
    // real bar keeps those claims visible and excludes lifecycle/trash noise.
    await page.evaluate((ids) => {
      const now = Date.now();
      const future = new Date(now + 10 * 60 * 1000).toISOString();
      const activeFields = { agent: 'agent-a', claimedAt: new Date(now).toISOString(), leaseUntil: future };
      const fixtures = {
        [ids.stale]: { ...activeFields, lastCheckpointAt: new Date(now - 31 * 60 * 1000).toISOString() },
        [ids.expired]: { ...activeFields, leaseUntil: new Date(now - 60 * 1000).toISOString() },
        [ids.malformed]: { ...activeFields, leaseUntil: 'not-a-date' },
        [ids.missingLease]: { ...activeFields, leaseUntil: null },
        [ids.done]: { ...activeFields, status: 'done' },
        [ids.archived]: { ...activeFields, status: 'archived' },
        [ids.trashed]: { ...activeFields, trashedAt: new Date(now).toISOString() },
      };
      window.appState.tasks = (window.appState.tasks || []).map((task) => (
        fixtures[task.id] ? { ...task, ...fixtures[task.id] } : task
      ));
    }, { stale, expired, malformed, missingLease, done, archived, trashed });
    await waitFor(page, () => page.evaluate(() => (
      document.querySelector('.active-agents-pill[data-agent-id="agent-a"]')?.getAttribute('data-claim-count') === '6'
    )), 'edge-fixture claim count');

    const directTrigger = await page.$('.active-agents-pill[data-agent-id="agent-c"]');
    const directInfo = await directTrigger.evaluate((el) => ({
      count: el.getAttribute('data-claim-count'),
      popup: el.getAttribute('aria-haspopup'),
      caret: !!el.querySelector('.active-agents-pill__caret'),
      health: el.getAttribute('data-lease-health'),
      // T-453: the pill collapsed the lease-health word to a dot-only visual
      // (design template — "Zustandspunkt 6x6", no label). The word still
      // lives in the pill's accessible name, so read it from there instead
      // of a dedicated `.active-agents-health__label` span, which no longer
      // renders inside the pill (it still renders inside popover rows).
      healthLabel: el.getAttribute('aria-label'),
      lifecycleDot: !!el.querySelector('.active-agents-status-dot'),
    }));
    r.ok(directInfo.count === '1' && directInfo.popup === null && !directInfo.caret, 'single claim stays a direct navigation control');
    r.ok(directInfo.health === 'current' && directInfo.healthLabel?.includes('Lease health: Current'), 'single claim exposes current health via its accessible name');
    r.ok(!directInfo.lifecycleDot, 'single claim does not render a lifecycle-colored dot');
    await page.evaluate(() => document.querySelector('.active-agents-pill[data-agent-id="agent-c"]')?.click());
    await waitFor(page, () => page.$('[data-detail-panel]'), 'single-claim task detail opens');
    r.ok(await page.$eval('[data-detail-panel] h2', (el) => el.textContent === 'Single direct active task'), 'single claim navigates directly to its task');
    r.ok(!(await page.$('.active-agents-popover')), 'single claim does not open a popover');
    await page.keyboard.press('Escape');
    await waitFor(page, () => page.evaluate(() => !document.querySelector('[data-detail-panel]')), 'single detail closes');

    const trigger = await page.$('.active-agents-pill[data-agent-id="agent-a"]');
    const triggerInfo = await trigger.evaluate((el) => ({
      tag: el.tagName,
      popup: el.getAttribute('aria-haspopup'),
      expanded: el.getAttribute('aria-expanded'),
      text: el.textContent,
      count: el.getAttribute('data-claim-count'),
      health: el.getAttribute('data-lease-health'),
      // See the single-claim pill above: T-453 dropped the visible label
      // span from the pill, so read the word from the accessible name.
      healthLabel: el.getAttribute('aria-label'),
      lifecycleDot: !!el.querySelector('.active-agents-status-dot'),
    }));
    r.ok(triggerInfo.tag === 'BUTTON', 'multi-claim pill uses a native button');
    r.ok(triggerInfo.popup === 'dialog' && triggerInfo.expanded === 'false', 'multi-claim pill exposes dialog state');
    r.ok(triggerInfo.count === '6' && triggerInfo.text.includes('6'), 'multi-claim pill shows the exact active claim count');
    r.ok(await page.$('.active-agents-pill__caret'), 'multi-claim pill shows a caret');
    r.ok(triggerInfo.health === 'expired' && triggerInfo.healthLabel?.includes('Lease health: Expired'), 'pill exposes worst lease health independently of lifecycle status');
    r.ok(!triggerInfo.lifecycleDot, 'pill does not render lifecycle status dots');

    await page.evaluate(() => document.querySelector('.active-agents-pill[data-agent-id="agent-a"]')?.click());
    await waitFor(page, () => page.$('.active-agents-popover'), 'multi-claim popover opens');
    await waitFor(page, () => page.evaluate(() => (
      document.querySelector('.active-agents-popover')?.style.visibility === 'visible'
    )), 'popover positioning completes');
    const popover = await page.$('.active-agents-popover');
    const popupInfo = await popover.evaluate((el) => ({
      heading: el.querySelector('.active-agents-popover__header')?.textContent,
      rows: el.querySelectorAll('.active-agents-task-row').length,
      rowIds: [...el.querySelectorAll('.active-agents-task-row')].map((row) => row.dataset.taskId),
      title: el.querySelector('.active-agents-task-row__title')?.textContent,
      // T-453: the popover row's meta line now shows the per-row lease
      // health word (the whole point of the redesign — "which task is
      // silent" must be visible per row, not only aggregated on the pill),
      // reusing the same `.active-agents-health__label` class the pill used
      // to render. Lifecycle status (`In progress`, ...) moved into the
      // row's title/aria-label instead of a dedicated visible span.
      firstRowHealthLabel: el.querySelector('.active-agents-task-row .active-agents-health__label')?.textContent,
      firstRowTitleAttr: el.querySelector('.active-agents-task-row')?.getAttribute('title'),
      lifecycleDots: el.querySelectorAll('.active-agents-status-dot').length,
      checkpoint: !!el.querySelector('[data-checkpoint]'),
      parent: el.parentElement?.tagName,
      contentOverflow: getComputedStyle(document.querySelector('.content')).overflow,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      rect: (() => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; })(),
    }));
    r.ok(popupInfo.heading.includes('Active tasks · 6'), 'popover heading includes exact count');
    r.ok(popupInfo.rows === 6, 'popover retains every current, stale, expired, malformed, and missing-lease row');
    r.ok([first, second, stale, expired, malformed, missingLease].every((id) => popupInfo.rowIds.includes(id)), 'expired, malformed, and missing leases remain visible');
    r.ok([done, archived, trashed].every((id) => !popupInfo.rowIds.includes(id)), 'done, archived, and trashed claims are excluded');
    r.ok(popupInfo.title.includes('complete accessible title'), 'task title remains available in the row');
    r.ok(popupInfo.firstRowHealthLabel === 'Current', 'popover shows this row\'s own lease health, not just the pill aggregate');
    r.ok(popupInfo.firstRowTitleAttr?.includes('In progress') && popupInfo.checkpoint, 'popover row still carries lifecycle status and checkpoint metadata (now in title/aria-label)');
    r.ok(popupInfo.lifecycleDots === 0, 'popover keeps lifecycle status textual without lifecycle-colored dots');
    r.ok(popupInfo.parent === 'BODY' && popupInfo.contentOverflow === 'hidden', 'popover is portalled outside the overflowing content surface');
    r.ok(popupInfo.viewport.width === 390
      && popupInfo.rect.left >= 0
      && popupInfo.rect.top >= 0
      && popupInfo.rect.right <= popupInfo.viewport.width
      && popupInfo.rect.bottom <= popupInfo.viewport.height,
    'popover stays fully inside a 390px viewport');
    r.ok(await page.$$eval('.active-agents-task-row', (els) => els.every((el) => el.tagName === 'BUTTON')), 'task rows use native buttons');

    // Task navigation is still the existing detail path and closes the list.
    await page.evaluate(() => document.querySelector('.active-agents-task-row')?.click());
    await waitFor(page, () => page.$('[data-detail-panel]'), 'task detail opens');
    r.ok(!(await page.$('.active-agents-popover')), 'task navigation closes the popover');
    // Reload the shell for the keyboard pass; this also exercises that the
    // bar can mount again after the detail surface has taken focus.
    await page.reload({ waitUntil: 'networkidle2' });
    await page.evaluate(() => document.querySelector('#tabBar .tab[data-tab="tasks"]')?.click());
    await waitFor(page, () => page.$('.active-agents-pill[data-agent-id="agent-a"]'), 'trigger after detail navigation');

    // ArrowDown opens and places focus on the first task; Escape restores the
    // trigger focus. This is the keyboard path required by D1.
    await page.focus('.active-agents-pill[data-agent-id="agent-a"]');
    await page.keyboard.press('ArrowDown');
    await waitFor(page, () => page.evaluate(() => document.activeElement?.classList.contains('active-agents-task-row')), 'ArrowDown focuses first task');
    r.ok(await page.evaluate(() => document.activeElement?.classList.contains('active-agents-task-row')), 'ArrowDown opens and focuses the task list');
    await page.keyboard.press('Escape');
    await waitFor(page, () => page.evaluate(() => !document.querySelector('.active-agents-popover')), 'Escape closes the popover');
    r.ok(await page.evaluate(() => document.activeElement?.matches('.active-agents-pill[data-agent-id="agent-a"]')), 'Escape restores focus to the trigger');

    // Outside pointer interaction closes without leaving a stale popover.
    await page.evaluate(() => document.querySelector('.active-agents-pill[data-agent-id="agent-a"]')?.click());
    await page.evaluate(() => document.querySelector('.active-agents-bar__label')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
    await waitFor(page, () => page.evaluate(() => !document.querySelector('.active-agents-popover')), 'outside pointer closes the popover');
    r.ok(!(await page.$('.active-agents-popover')), 'outside click closes the popover');

    // If every claim for the focused owner disappears (expiry/reassignment),
    // the owner pill is removed/replaced. Focus must move to a live sibling,
    // never to body/document.
    await page.evaluate(() => document.querySelector('.active-agents-pill[data-agent-id="agent-a"]')?.click());
    await waitFor(page, () => page.$('.active-agents-popover'), 'popover before owner disappears');
    const released = await Promise.all([first, second, stale, expired, malformed, missingLease].map((id) => (
      api('POST', `/projects/${PROJECT}/tasks/${id}/release`, { agent: 'agent-a' })
    )));
    r.ok(released.every((response) => response.status === 200), 'released the focused owner claims');
    await page.evaluate(async (project) => {
      if (typeof window.appState?._refreshBoard !== 'function') throw new Error('refresh bridge unavailable');
      await window.appState._refreshBoard(project);
    }, PROJECT);
    await waitFor(page, () => page.evaluate(() => !document.querySelector('.active-agents-popover')), 'popover closes after owner disappears');
    await waitFor(page, () => page.evaluate(() => document.activeElement?.matches('.active-agents-pill[data-agent-id="agent-b"]')), 'focus moves to surviving agent');
    r.ok(await page.evaluate(() => document.activeElement?.matches('.active-agents-pill[data-agent-id="agent-b"]')), 'owner removal moves focus to a surviving agent control');
  }, { port: 18866, viewport: { width: 390, height: 844 } });

  if (result?.skipped) r.skip(result.reason);
  r.done();
})().catch((error) => {
  console.error('# fatal:', error.stack || error.message);
  process.exitCode = 1;
});
