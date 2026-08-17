'use strict';

// Browser-rendered T-443-4 coverage. The task API response is intercepted with
// the expected canonical fields and exact action contract so this test remains
// deterministic while the backend action routes are still an integration
// dependency. The real React shell must still fail closed for other shapes.

const { withDashboard, reporter } = require('./test-support/browser-harness.js');
const { expectedStuckIndicatorAction, expectedStuckIndicatorActionPath } = require('./test-fixtures/work-state-contract.cjs');

const PROJECT = 'work-state-ui';
const r = reporter('Work-state picker and living stuck indicator (T-443-4)');

function taskShape(id) {
  return {
    id,
    project: PROJECT,
    title: 'Canonical work-state task',
    status: 'in-progress',
    blocked: true,
    priority: 'high',
    parentId: null,
    subtaskIds: [],
    specFile: null,
    created: '2026-08-17',
    enteredStatusAt: '2026-08-17T10:00:00.000Z',
    completed: null,
    agent: null,
    claimedAt: null,
    leaseUntil: null,
    lastCheckpointAt: '2026-08-17T10:00:00.000Z',
    staleAfterMinutes: null,
    checkpointCount: 1,
    order: null,
    tags: [],
    description: '',
    routedAgent: null,
    trashedAt: null,
    specExists: false,
    workState: 'blocked',
    workStateDetails: {
      reason: 'Waiting on a service response',
      waitingFor: 'Platform team',
      responsible: 'platform',
      checkAgainAt: '2026-08-18T09:00:00.000Z',
      setAt: '2026-08-17T16:00:00.000Z',
    },
    stuckIndicator: {
      id: 'stuck-1',
      message: 'No checkpoint recently',
      reason: 'stale',
      detectedAt: '2026-08-17T16:00:00.000Z',
      actions: {
        retry: expectedStuckIndicatorAction(PROJECT, id, 'retry', { indicatorId: 'stuck-1', revision: 'r1' }),
        clear: expectedStuckIndicatorAction(PROJECT, id, 'clear', { indicatorId: 'stuck-1', revision: 'r1' }),
      },
    },
  };
}

async function setInput(page, selector, value) {
  await page.click(selector);
  await page.keyboard.press('End');
  await page.keyboard.down('Shift');
  await page.keyboard.press('Home');
  await page.keyboard.up('Shift');
  await page.keyboard.type(value);
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for browser API assertion');
}

async function main() {
  const res = await withDashboard(async ({ api, page, base }) => {
    await api('POST', '/projects', { name: PROJECT });
    const created = await api('POST', `/projects/${PROJECT}/tasks`, { title: 'Canonical work-state task' });
    const taskId = created.body?.task?.id;
    r.ok(Boolean(taskId), 'seeded task for canonical UI response');

    let currentTask = taskShape(taskId);
    let lastWorkStateUpdate = null;
    let lastIndicatorAction = null;
    let commentPosts = 0;
    let raceMode = false;

    await page.setRequestInterception(true);
    page.on('request', async (request) => {
      const url = new URL(request.url());
      if (url.pathname === `/api/projects/${PROJECT}/tasks` && request.method() === 'GET') {
        await request.respond({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, tasks: [currentTask] }),
        });
        return;
      }
      if (url.pathname === `/api/projects/${PROJECT}/tasks/${taskId}` && request.method() === 'PUT') {
        const body = JSON.parse(request.postData() || '{}');
        lastWorkStateUpdate = body;
        if (raceMode && body.workState === 'waiting') {
          currentTask = {
            ...currentTask,
            workState: 'waiting',
            workStateDetails: {
              ...currentTask.workStateDetails,
              reason: 'newer external state',
            },
          };
          await page.evaluate((task) => {
            window.appState.tasks = window.appState.tasks.map((candidate) => candidate.id === task.id ? task : candidate);
            if (typeof window._notifyReact === 'function') window._notifyReact();
            else window.dispatchEvent(new CustomEvent('appstate:change'));
          }, currentTask);
          raceMode = false;
          await request.respond({
            status: 409,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'stale revision' }),
          });
          return;
        }
        currentTask = {
          ...currentTask,
          ...(body.workState ? { workState: body.workState } : {}),
          ...(body.workStateDetails ? { workStateDetails: { ...currentTask.workStateDetails, ...body.workStateDetails } } : {}),
        };
        currentTask.blocked = currentTask.workState === 'blocked';
        // The backend's authoritative response clears the transient signal
        // after a retry/clear update; the client never does this locally.
        if (body.workState === 'working') currentTask.stuckIndicator = null;
        await request.respond({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, task: currentTask }),
        });
        return;
      }
      if (url.pathname === `/api/projects/${PROJECT}/tasks/${taskId}/stuck-indicator/retry`
          || url.pathname === `/api/projects/${PROJECT}/tasks/${taskId}/stuck-indicator/clear`) {
        lastIndicatorAction = { path: url.pathname, body: JSON.parse(request.postData() || '{}') };
        currentTask = { ...currentTask, stuckIndicator: null };
        await request.respond({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, task: currentTask }),
        });
        return;
      }
      if (url.pathname === `/api/projects/${PROJECT}/tasks/${taskId}/comment` && request.method() === 'POST') {
        commentPosts += 1;
      }
      await request.continue();
    });

    await page.goto(`${base}/?agentId=e2e`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('.app', { timeout: 8000 });
    await page.evaluate((project) => window._viewProject && window._viewProject(project), PROJECT);
    await page.waitForFunction((project) => window.appState?.viewedProject === project, { timeout: 8000 }, PROJECT);
    await page.evaluate((id) => window.openTaskDetail && window.openTaskDetail(id), taskId);
    await page.waitForSelector('[data-work-state-picker="true"]', { timeout: 8000 });

    r.ok(await page.$('#work-state-select'), 'work-state select renders in task detail');
    r.ok(await page.$('label[for="work-state-select"]'), 'work-state select has an accessible label');
    r.ok(await page.$('[data-stuck-indicator="true"]'), 'living stuck indicator renders in activity area');
    r.ok((await page.$eval('[data-stuck-indicator="true"]', (el) => el.textContent)).includes('No checkpoint recently'),
      'stuck indicator renders current message, not a comment');
    r.ok((await page.$eval('[data-stuck-indicator="true"]', (el) => el.textContent)).includes('Detected'),
      'stuck indicator renders the canonical detectedAt timestamp');

    await page.select('#work-state-select', 'waiting');
    await waitFor(() => lastWorkStateUpdate?.workState === 'waiting');
    r.ok(lastWorkStateUpdate?.workState === 'waiting', 'picker sends canonical waiting workState');
    r.ok(!Object.prototype.hasOwnProperty.call(lastWorkStateUpdate || {}, 'blocked'),
      'picker does not write the legacy blocked projection');

    await setInput(page, 'input[name="workStateReason"]', 'Need an approval');
    await setInput(page, 'input[name="workStateWaitingFor"]', 'Release manager');
    await setInput(page, 'input[name="workStateResponsible"]', 'release');
    await page.click('[data-work-state-save="true"]');
    await waitFor(() => lastWorkStateUpdate?.workStateDetails?.reason === 'Need an approval');
    r.ok(lastWorkStateUpdate?.workState === 'waiting' && lastWorkStateUpdate?.workStateDetails?.reason === 'Need an approval',
      'details form persists reason through canonical task PUT');
    r.ok(lastWorkStateUpdate?.workStateDetails?.waitingFor === 'Release manager',
      'details form persists waitingFor through canonical task PUT');
    const pickerControlSizes = await page.$$eval(
      '#work-state-select, input[name^="workState"], button[data-work-state-save]',
      (elements) => elements.map((element) => {
        const box = element.getBoundingClientRect();
        return { name: element.getAttribute('name') || element.id, width: box.width, height: box.height };
      }),
    );
    r.ok(pickerControlSizes.length === 6 && pickerControlSizes.every((box) => box.width >= 44 && box.height >= 44),
      'work-state picker controls have 44px touch targets');

    // No executable action is invented from a string/boolean hint.  The
    // backend must provide an explicit non-destructive descriptor first; this
    // synthetic response includes exactly that agreed descriptor.
    const actionBoxes = await page.$$eval('[data-stuck-action]', (elements) => elements.map((el) => {
      const box = el.getBoundingClientRect();
      return { action: el.getAttribute('data-stuck-action'), width: box.width, height: box.height };
    }));
    r.ok(actionBoxes.length === 2 && actionBoxes.every((box) => box.width >= 44 && box.height >= 44),
      'Retry and Clear actions have 44px touch targets');
    await page.click('[data-stuck-action="retry"]');
    await waitFor(() => lastIndicatorAction?.path === expectedStuckIndicatorActionPath(PROJECT, taskId, 'retry'));
    r.ok(lastIndicatorAction?.path === expectedStuckIndicatorActionPath(PROJECT, taskId, 'retry'),
      'retry uses the exact project/task-bound endpoint');
    r.ok(lastIndicatorAction?.body?.indicatorId === 'stuck-1',
      'retry uses the backend-provided explicit action payload');
    r.ok(!lastWorkStateUpdate || lastWorkStateUpdate.workState === 'waiting',
      'retry does not issue a destructive workState PUT');
    r.ok(commentPosts === 0, 'retry/indicator lifecycle does not append a comment');
    await page.waitForSelector('[data-stuck-indicator="true"]', { hidden: true, timeout: 3000 });

    // Browser race: an external canonical update lands while a work-state
    // request is pending and then the request fails. The newer same-value
    // state/details must not be restored from the stale local snapshot.
    currentTask = {
      ...currentTask,
      workState: 'working',
      blocked: false,
      workStateDetails: {
        reason: null,
        waitingFor: null,
        responsible: null,
        checkAgainAt: null,
        setAt: currentTask.workStateDetails.setAt,
      },
      stuckIndicator: null,
    };
    await page.evaluate((task) => {
      window.appState.tasks = window.appState.tasks.map((candidate) => candidate.id === task.id ? task : candidate);
      if (typeof window._notifyReact === 'function') window._notifyReact();
      else window.dispatchEvent(new CustomEvent('appstate:change'));
    }, currentTask);
    await page.waitForFunction(() => document.querySelector('#work-state-select')?.value === 'working', { timeout: 3000 });
    raceMode = true;
    await page.select('#work-state-select', 'waiting');
    await page.waitForFunction(() => window.appState?.tasks?.[0]?.workState === 'waiting', { timeout: 3000 });
    await page.waitForFunction(() => document.querySelector('#work-state-select')?.value === 'waiting', { timeout: 3000 });
    await page.waitForFunction(
      () => document.querySelector('input[name="workStateReason"]')?.value === 'newer external state',
      { timeout: 3000 },
    );
    r.ok(await page.$eval('#work-state-select', (el) => el.value) === 'waiting',
      'failed mutation does not overwrite a newer external work state');
    r.ok(await page.$eval('input[name="workStateReason"]', (el) => el.value) === 'newer external state',
      'newer external details survive the rejected optimistic mutation');

    await page.setViewport({ width: 390, height: 844 });
    const mobile = await page.evaluate(() => ({
      viewport: window.innerWidth,
      pageWidth: document.documentElement.scrollWidth,
      selectWidth: document.querySelector('#work-state-select')?.getBoundingClientRect().width || 0,
    }));
    r.ok(mobile.pageWidth <= mobile.viewport + 1, 'work-state detail remains horizontally usable on mobile');
    r.ok(mobile.selectWidth <= mobile.viewport, 'work-state picker fits the mobile viewport');
  });

  if (res?.skipped) r.skip(res.reason);
  r.done();
}

main().catch((error) => { console.error(error); process.exit(1); });
