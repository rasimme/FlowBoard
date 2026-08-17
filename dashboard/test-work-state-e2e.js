'use strict';

// Browser-rendered T-443-4 coverage. The task API response is intercepted with
// the approved canonical fields so this test runs before/after the backend
// work-state branch lands while still exercising the real React shell.

const { withDashboard, reporter } = require('./test-support/browser-harness.js');

const PROJECT = 'work-state-ui';
const r = reporter('Work-state picker and living stuck indicator (T-443-4)');

function taskShape(id) {
  return {
    id,
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
      createdAt: '2026-08-17T16:00:00.000Z',
      actions: ['clear', 'retry'],
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
    let commentPosts = 0;

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

    await page.click('[data-stuck-action="retry"]');
    await waitFor(() => lastWorkStateUpdate?.workState === 'working');
    r.ok(lastWorkStateUpdate?.workState === 'working', 'retry affordance uses a canonical API update');
    r.ok(commentPosts === 0, 'retry/indicator lifecycle does not append a comment');
    await page.waitForSelector('[data-stuck-indicator="true"]', { hidden: true, timeout: 3000 });

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
