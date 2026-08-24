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
    r.ok(first && second, 'seeded two project tasks');
    await api('POST', `/projects/${PROJECT}/tasks/${first}/claim`, { agent: 'agent-a', lease: 30 });
    await api('POST', `/projects/${PROJECT}/tasks/${second}/claim`, { agent: 'agent-a', lease: 30 });
    await api('POST', `/projects/${PROJECT}/tasks/${first}/checkpoint`, {
      agent: 'agent-a', message: 'Halfway there', progress: 50,
    });

    await page.goto(`${base}/?agentId=agent-a`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('.app', { timeout: 8000 });
    await page.click('#tabBar .tab[data-tab="tasks"]');
    await waitFor(page, () => page.$('.active-agents-pill[data-agent-id="agent-a"]'), 'multi-claim trigger');
    // Progress is optional task-payload data. Inject it into the loaded
    // project snapshot here to exercise the renderer without an API/schema
    // change (the checkpoint endpoint stores progress in its event payload).
    await page.evaluate((id) => {
      window.appState.tasks = (window.appState.tasks || []).map((task) => (
        task.id === id ? { ...task, progress: 50 } : task
      ));
    }, first);

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

    await trigger.click();
    await waitFor(page, () => page.$('.active-agents-popover'), 'multi-claim popover opens');
    const popover = await page.$('.active-agents-popover');
    const popupInfo = await popover.evaluate((el) => ({
      heading: el.querySelector('.active-agents-popover__header')?.textContent,
      rows: el.querySelectorAll('.active-agents-task-row').length,
      title: el.querySelector('.active-agents-task-row__title')?.textContent,
      progress: el.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow'),
      checkpoint: !!el.querySelector('[data-checkpoint]'),
    }));
    r.ok(popupInfo.heading.includes('Active tasks · 2'), 'popover heading includes exact count');
    r.ok(popupInfo.rows === 2, 'popover retains both task rows');
    r.ok(popupInfo.title.includes('complete accessible title'), 'task title remains available in the row');
    r.ok(popupInfo.progress === '50' && popupInfo.checkpoint, 'popover shows available progress and checkpoint data');
    r.ok(await page.$$eval('.active-agents-task-row', (els) => els.every((el) => el.tagName === 'BUTTON')), 'task rows use native buttons');

    // Task navigation is still the existing detail path and closes the list.
    await page.click('.active-agents-task-row');
    await waitFor(page, () => page.$('[data-detail-panel]'), 'task detail opens');
    r.ok(!(await page.$('.active-agents-popover')), 'task navigation closes the popover');
    // Reload the shell for the keyboard pass; this also exercises that the
    // bar can mount again after the detail surface has taken focus.
    await page.reload({ waitUntil: 'networkidle2' });
    await page.click('#tabBar .tab[data-tab="tasks"]');
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
    await page.click('.active-agents-pill[data-agent-id="agent-a"]');
    await page.click('.active-agents-bar__label');
    r.ok(!(await page.$('.active-agents-popover')), 'outside click closes the popover');
  }, { port: 18866 });

  if (result?.skipped) r.skip(result.reason);
  r.done();
})().catch((error) => {
  console.error('# fatal:', error.stack || error.message);
  process.exitCode = 1;
});
