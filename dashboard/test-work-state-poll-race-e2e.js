'use strict';

// T-454-7: reproduces (and, once fixed, guards against) a specific race
// between the dashboard's 5-second background poll (DashboardContext.jsx)
// and a canonical work-state mutation (taskMutations.mjs).
//
// state/taskMutations.mjs:200 deliberately does NOT patch the shared task
// list optimistically for work-state updates — the comment there explains
// why: a rejected 409 would otherwise overwrite a newer externally-published
// value. On SUCCESS it still publishes the server's canonical response via
// bridge.replaceTasks (mutate()'s `bridge.replaceTasks(next)` call). That
// canonical publish is real and happens synchronously once the PUT resolves.
//
// The bug Simeon reported ("the card doesn't update immediately after
// setting the state in the detail panel") is a race, not a missing publish:
// if a poll's snapshot GET was already in flight *before* the PUT started,
// its response reflects pre-mutation data. If that response arrives *after*
// the PUT's own canonical publish, DashboardContext.jsx's commitPollSnapshot
// has nothing telling it the poll's data is now stale, so it overwrites the
// just-applied canonical state with the older snapshot — the UI briefly (or
// until the *next* poll corrects it again) shows the old state.
//
// This test forces exactly that ordering with Puppeteer request
// interception: it holds a poll's GET /api/dashboard/snapshot/v1 response
// (the transport the background poll actually uses — see
// DashboardContext.jsx's runSnapshotRequest/fetchDashboardSnapshot), performs
// a real work-state change through the UI while it's held, then releases the
// held (deliberately pre-mutation) response and asserts the UI does not
// revert.
//
// GET /api/projects/:project/tasks (the endpoint viewProject's own
// coordinated fetch uses, and the one test-work-state-e2e.js mocks) is also
// intercepted here so the board's initial task list is deterministic, but it
// is never held — only the snapshot poll's response is.
//
// The snapshot envelope has a strict schema (utils/dashboardApi.js's
// validateProject/validateAgent/validateSnapshotStatus). Rather than
// hand-build a second parallel fixture for projects/agents/status, this test
// fetches one real snapshot directly from the server (outside the page, so
// Puppeteer's interception doesn't apply) and reuses its projects/agents/
// status verbatim — the only part it substitutes is `tasks`, which is what
// this race is actually about.

const { withDashboard, reporter } = require('./test-support/browser-harness.js');

const PROJECT = 'work-state-poll-race';
const r = reporter('Work-state combo chip survives a stale in-flight poll (T-454-7)');

function taskShape(id) {
  // Timestamps are relative to real wall-clock execution time, not a fixed
  // past date — computeHealth() (LeaseIndicator.jsx) treats a claim as
  // stale/expired once enough real time has elapsed since claimedAt/
  // lastCheckpointAt, and a stale/expired claim intentionally outranks the
  // workState label in TaskCardStateChip (see its module doc: "must I
  // intervene" outranks "what is it doing"). A fixed past date would make
  // this fixture read as stale by the time the test actually runs, masking
  // the Paused label this test needs to see on the card.
  const now = Date.now();
  return {
    id,
    project: PROJECT,
    title: 'Poll-race task',
    status: 'in-progress',
    priority: 'medium',
    parentId: null,
    subtaskIds: [],
    specFile: null,
    created: '2026-08-25',
    enteredStatusAt: new Date(now - 10 * 60000).toISOString(),
    completed: null,
    agent: 'claude-code',
    claimedAt: new Date(now - 5 * 60000).toISOString(),
    leaseUntil: new Date(now + 55 * 60000).toISOString(),
    lastCheckpointAt: new Date(now - 2 * 60000).toISOString(),
    staleAfterMinutes: null,
    checkpointCount: 1,
    order: null,
    tags: [],
    description: '',
    routedAgent: null,
    trashedAt: null,
    specExists: false,
    workState: 'working',
    workStateDetails: {
      reason: null,
      waitingFor: null,
      responsible: null,
      checkAgainAt: null,
      setAt: null,
    },
    stuckIndicator: null,
  };
}

function snapshotBody(baseline, task) {
  return {
    ...baseline,
    generatedAt: new Date().toISOString(),
    viewedProject: PROJECT,
    tasks: [task],
    sections: {
      ...baseline.sections,
      tasks: { ok: true, data: [task] },
    },
  };
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for browser condition');
}

async function main() {
  const res = await withDashboard(async ({ api, page, base }) => {
    await api('POST', '/projects', { name: PROJECT });
    const created = await api('POST', `/projects/${PROJECT}/tasks`, { title: 'Poll-race task' });
    const taskId = created.body?.task?.id;
    r.ok(Boolean(taskId), 'seeded task for the poll-race scenario');

    // One real, unmocked snapshot — fetched directly (not through the page,
    // so Puppeteer interception below never sees this call) — supplies a
    // schema-valid projects/agents/status baseline to reuse verbatim.
    const baselineRes = await fetch(`${base}/api/dashboard/snapshot/v1?project=${encodeURIComponent(PROJECT)}&agentId=e2e`);
    const baseline = await baselineRes.json();
    r.ok(baseline?.ok === true, 'fetched a real baseline snapshot to reuse its projects/agents/status shape');

    let currentTask = taskShape(taskId);
    let lastWorkStateUpdate = null;
    let snapshotGetCount = 0;
    let holdNextSnapshotGet = false;
    let heldRequest = null;
    let heldStaleBody = null;

    await page.setRequestInterception(true);
    page.on('request', async (request) => {
      const url = new URL(request.url());
      if (url.pathname === '/api/dashboard/snapshot/v1' && request.method() === 'GET') {
        snapshotGetCount += 1;
        if (holdNextSnapshotGet && !heldRequest) {
          // Deliberately do NOT respond yet. Capture the body now (this is
          // the pre-mutation state at the moment the "network" read it) —
          // exactly what a slow real response would have carried.
          holdNextSnapshotGet = false;
          heldStaleBody = JSON.stringify(snapshotBody(baseline, currentTask));
          heldRequest = request;
          return;
        }
        await request.respond({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(snapshotBody(baseline, currentTask)),
        });
        return;
      }
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
          ...(body.workStateDetails
            ? { workStateDetails: { ...currentTask.workStateDetails, ...body.workStateDetails } }
            : {}),
        };
        await request.respond({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, task: currentTask }),
        });
        return;
      }
      await request.continue();
    });

    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto(`${base}/?agentId=e2e`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('.app', { timeout: 8000 });

    await page.evaluate((project) => window._viewProject && window._viewProject(project), PROJECT);
    await page.waitForFunction((project) => window.appState?.viewedProject === project, { timeout: 8000 }, PROJECT);
    // The default tab is 'overview' (src/state/appStore.mjs) — TasksView
    // (the Kanban board, and the card DOM this test inspects) is not
    // mounted until the Tasks tab is active.
    await page.click('#tabBar .tab[data-tab="tasks"]');
    await page.waitForFunction(() => document.querySelector('.app')?.dataset.view === 'tasks', { timeout: 3000 });
    await page.waitForSelector(`[data-task-id="${taskId}"]`, { timeout: 8000 });

    r.ok(await page.evaluate((id) => window.appState?.tasks?.find((t) => t.id === id)?.workState === 'working', taskId),
      'task starts in the default working state on the board');

    // Arm the hold, then wait for the *next* snapshot GET — the 5s
    // background poll's. (The initial page load already issued and consumed
    // one, unheld, before this point.)
    //
    // Also bump an unrelated field (checkpointCount) right now, *before*
    // arming. commitPollSnapshot only dispatches when the polled tasks JSON
    // differs from the last snapshot it committed (DashboardContext.jsx's
    // `tasksChanged = tasksJson !== prevTasksRef.current`) — a real
    // anti-thrash optimization, not an anti-staleness guard, but it means a
    // held response that is *byte-identical* to what was last recorded would
    // never dispatch at all and this race would go unobserved by accident.
    // On a live board something else is essentially always changing between
    // two 5s poll ticks (another checkpoint, another task) — this line
    // reproduces that ambient activity so the held response both (a) still
    // predates the work-state mutation below and (b) still differs from
    // prevTasksRef, exactly like the real world.
    currentTask = { ...currentTask, checkpointCount: currentTask.checkpointCount + 1 };
    const getsBeforeArm = snapshotGetCount;
    holdNextSnapshotGet = true;
    await waitFor(() => heldRequest !== null, 10000);
    r.ok(snapshotGetCount > getsBeforeArm, 'the background poll issued a new snapshot GET, now held unanswered');

    // With the poll's response deliberately withheld, change the work state
    // through the real UI — detail panel combo chip -> popover -> Paused —
    // exactly as a human would from the DetailPanel.
    await page.evaluate((id) => window.openTaskDetail && window.openTaskDetail(id), taskId);
    await page.waitForSelector('[data-work-state-trigger="true"]', { timeout: 8000 });
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-work-state-trigger="true"]');
      const rect = el?.getBoundingClientRect();
      return !!rect && rect.width > 0 && rect.right <= window.innerWidth + 1;
    }, { timeout: 3000 });
    await page.click('[data-work-state-trigger="true"]');
    await page.waitForSelector('[data-work-state-option="paused"]', { timeout: 3000 });
    await page.click('[data-work-state-option="paused"]');

    await waitFor(() => lastWorkStateUpdate?.workState === 'paused', 5000);
    await page.waitForFunction(
      () => document.querySelector('[data-work-state-trigger="true"]')?.getAttribute('title') === 'Work state: Paused',
      { timeout: 3000 },
    );
    r.ok(true, 'the mutation applied — the panel chip shows Paused right after the PUT resolves');

    r.ok(await page.evaluate((id) => {
      const chip = document.querySelector(`[data-task-id="${id}"] .task-combo-chip`);
      return !!chip && chip.textContent.includes('Paused');
    }, taskId), 'the Kanban card (underneath the open panel) shows Paused immediately too, before the stale poll lands');

    // Focus must not be sitting in a form field, or DashboardContext's
    // isUserInteracting() guard would itself suppress the poll's dispatch
    // and mask the very race this test exists to catch.
    r.ok(await page.evaluate(() => {
      const el = document.activeElement;
      return !(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'));
    }), 'focus is not in a form field when the stale poll resolves (would mask the race behind isUserInteracting)');

    r.ok(Boolean(heldRequest && heldStaleBody), 'a pre-mutation poll response is actually being held for release');
    // Release the held poll response with the STALE (pre-mutation) body
    // captured at hold-time — simulating a slow response that started
    // before, and lands after, the mutation's own canonical publish.
    await heldRequest.respond({ status: 200, contentType: 'application/json', body: heldStaleBody });

    // Give the poll's commit a moment to run, then everything must still
    // show the mutated state — not have reverted to the stale pre-mutation
    // snapshot the poll just delivered.
    await new Promise((resolve) => setTimeout(resolve, 400));
    r.ok(await page.evaluate((id) => window.appState?.tasks?.find((t) => t.id === id)?.workState === 'paused', taskId),
      'a stale in-flight poll response does not overwrite a newer canonical mutation (window.appState.tasks)');
    r.ok((await page.$eval('[data-work-state-trigger="true"]', (el) => el.getAttribute('title'))) === 'Work state: Paused',
      'the detail panel chip still shows Paused after the stale poll resolves');
    r.ok(await page.evaluate((id) => {
      const chip = document.querySelector(`[data-task-id="${id}"] .task-combo-chip`);
      return !!chip && chip.textContent.includes('Paused');
    }, taskId), 'the Kanban card still shows Paused after the stale poll resolves');

    r.ok(pageErrors.length === 0, `no uncaught page errors during the flow (saw: ${pageErrors.join(' | ')})`);
  });

  if (res?.skipped) r.skip(res.reason);
  r.done();
}

main().catch((error) => { console.error(error); process.exit(1); });
