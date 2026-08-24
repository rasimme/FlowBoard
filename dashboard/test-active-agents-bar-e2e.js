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
    r.ok(first && second && third && fourth, 'seeded four project tasks');
    await api('POST', `/projects/${PROJECT}/tasks/${first}/claim`, { agent: 'agent-a', lease: 30 });
    await api('POST', `/projects/${PROJECT}/tasks/${second}/claim`, { agent: 'agent-a', lease: 30 });
    await api('POST', `/projects/${PROJECT}/tasks/${third}/claim`, { agent: 'agent-b', lease: 30 });
    await api('POST', `/projects/${PROJECT}/tasks/${fourth}/claim`, { agent: 'agent-b', lease: 30 });
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

    const trigger = await page.$('.active-agents-pill[data-agent-id="agent-a"]');
    const triggerInfo = await trigger.evaluate((el) => ({
      tag: el.tagName,
      popup: el.getAttribute('aria-haspopup'),
      expanded: el.getAttribute('aria-expanded'),
      text: el.textContent,
    }));
    r.ok(triggerInfo.tag === 'BUTTON', 'multi-claim pill uses a native button');
    r.ok(triggerInfo.popup === 'dialog' && triggerInfo.expanded === 'false', 'multi-claim pill exposes dialog state');
    r.ok(triggerInfo.text.includes('2'), 'multi-claim pill shows exact task count');
    r.ok(await page.$('.active-agents-pill__caret'), 'multi-claim pill shows a caret');

    await page.evaluate(() => document.querySelector('.active-agents-pill[data-agent-id="agent-a"]')?.click());
    await waitFor(page, () => page.$('.active-agents-popover'), 'multi-claim popover opens');
    await waitFor(page, () => page.evaluate(() => (
      document.querySelector('.active-agents-popover')?.style.visibility === 'visible'
    )), 'popover positioning completes');
    const popover = await page.$('.active-agents-popover');
    const popupInfo = await popover.evaluate((el) => ({
      heading: el.querySelector('.active-agents-popover__header')?.textContent,
      rows: el.querySelectorAll('.active-agents-task-row').length,
      title: el.querySelector('.active-agents-task-row__title')?.textContent,
      status: el.querySelector('.active-agents-status-label')?.textContent,
      checkpoint: !!el.querySelector('[data-checkpoint]'),
      parent: el.parentElement?.tagName,
      contentOverflow: getComputedStyle(document.querySelector('.content')).overflow,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      rect: (() => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; })(),
    }));
    r.ok(popupInfo.heading.includes('Active tasks · 2'), 'popover heading includes exact count');
    r.ok(popupInfo.rows === 2, 'popover retains both task rows');
    r.ok(popupInfo.title.includes('complete accessible title'), 'task title remains available in the row');
    r.ok(popupInfo.status === 'In progress' && popupInfo.checkpoint, 'popover shows task status and checkpoint metadata from the task payload');
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
    r.ok(await page.evaluate(() => document.activeElement?.matches('.active-agents-pill[data-agent-id="agent-a"]')), 'Escape restores focus to the trigger');

    // Outside pointer interaction closes without leaving a stale popover.
    await page.evaluate(() => document.querySelector('.active-agents-pill[data-agent-id="agent-a"]')?.click());
    await page.evaluate(() => document.querySelector('.active-agents-bar__label')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
    r.ok(!(await page.$('.active-agents-popover')), 'outside click closes the popover');

    // If every claim for the focused owner disappears (expiry/reassignment),
    // the owner pill is removed/replaced. Focus must move to a live sibling,
    // never to body/document.
    await page.evaluate(() => document.querySelector('.active-agents-pill[data-agent-id="agent-a"]')?.click());
    await waitFor(page, () => page.$('.active-agents-popover'), 'popover before owner disappears');
    const released = await Promise.all([first, second].map((id) => (
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
