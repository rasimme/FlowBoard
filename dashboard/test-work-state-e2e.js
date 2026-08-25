'use strict';

// Browser-rendered T-443-4 coverage, translated for T-452-2/T-452-3: the
// always-visible four-field WorkStatePicker box is gone, replaced by the
// combo chip's state half (WorkStateChip) opening a two-step WorkStatePopover
// (list of four states -> one question for waiting/blocked). The task API
// response is intercepted with the expected canonical fields and exact
// action contract so this test remains deterministic while the backend
// action routes are still an integration dependency. The real React shell
// must still fail closed for other shapes.
//
// T-452-8 additionally merges the two attention banners (Zone-1
// client-computed AttentionWarning + Zone-4 backend-driven StuckIndicator,
// the latter deleted) into one, rendered in the header from
// task.stuckIndicator only. The coverage below for the merged banner is
// unchanged in substance from the old Zone-4 assertions — same message/
// Detected text, same backend-supplied clear descriptor — just retargeted
// at the single banner and its one remaining action (dismiss/"clear";
// Retry is gone from the UI).

const { withDashboard, reporter } = require('./test-support/browser-harness.js');
const { expectedStuckIndicatorAction, expectedStuckIndicatorActionPath } = require('./test-fixtures/work-state-contract.cjs');

const PROJECT = 'work-state-ui';
const r = reporter('Work-state popover and merged attention banner (T-443-4 / T-452-2 / T-452-3 / T-452-8)');

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

// Opens the combo chip's state popover (assumes it is currently closed).
// T-452-2 replaced the always-visible WorkStatePicker box with this
// click-to-open popover, so every interaction below opens it explicitly.
async function openWorkStatePopover(page) {
  await page.click('[data-work-state-trigger="true"]');
  await page.waitForSelector('[data-work-state-popover="true"]', { timeout: 3000 });
}

// Opens the popover and clicks one of its four list entries. Waits for the
// specific option (not just the popover wrapper) before clicking it: the
// wrapper and its four Popover.Option children commit in the same React
// render, but Puppeteer's click needs a settled layout/paint, not just a
// matching selector, so this closes that gap explicitly rather than relying
// on incidental delays elsewhere in the flow.
async function chooseWorkStateOption(page, state) {
  await openWorkStatePopover(page);
  await page.waitForSelector(`[data-work-state-option="${state}"]`, { timeout: 3000 });
  await page.click(`[data-work-state-option="${state}"]`);
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
    let failNextWorkStatePut = false;
    let workStatePutCount = 0;

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
        workStatePutCount += 1;
        if (failNextWorkStatePut) {
          failNextWorkStatePut = false;
          await request.respond({
            status: 409,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'stale revision' }),
          });
          return;
        }
        if (raceMode && body.workState === 'waiting') {
          // A second, newer canonical update lands the moment this PUT goes
          // out, then this PUT itself is rejected. The field that changes is
          // `waitingFor` (not `reason`) because the new popover's one
          // question for `waiting` maps onto `waitingFor` — see
          // WorkStatePopover.jsx's QUESTION_FIELD.
          currentTask = {
            ...currentTask,
            workState: 'waiting',
            workStateDetails: {
              ...currentTask.workStateDetails,
              waitingFor: 'newer external waiting reason',
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

    // Regression guard for the class of bug this suite's development turned
    // up: an uncaught render error (e.g. indexing a lookup table with a
    // value it doesn't cover) unmounts the whole React tree with no visible
    // trace beyond a browser console error, and every subsequent selector
    // wait times out with a confusing "element not found" instead of
    // pointing at the real cause. Collect page errors and assert none fired.
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    await page.goto(`${base}/?agentId=e2e`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('.app', { timeout: 8000 });
    await page.evaluate((project) => window._viewProject && window._viewProject(project), PROJECT);
    await page.waitForFunction((project) => window.appState?.viewedProject === project, { timeout: 8000 }, PROJECT);
    await page.evaluate((id) => window.openTaskDetail && window.openTaskDetail(id), taskId);
    await page.waitForSelector('[data-work-state-trigger="true"]', { timeout: 8000 });
    // The panel slides in via CSS animation (animate-slide-in-right,
    // ~0.35s); clicking before it settles hits Puppeteer's "not clickable"
    // guard because the element is still translated off-screen mid-animation.
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-work-state-trigger="true"]');
      const rect = el?.getBoundingClientRect();
      return !!rect && rect.width > 0 && rect.right <= window.innerWidth + 1;
    }, { timeout: 3000 });

    r.ok(await page.$('[data-work-state-trigger="true"]'), 'work-state trigger renders in task detail');
    r.ok(await page.$eval('[data-work-state-trigger="true"]', (el) => !!el.getAttribute('aria-label')),
      'work-state trigger has an accessible label');
    // T-452-8: the two attention banners (Zone-1 client-computed and Zone-4
    // backend-driven) were merged into one, sourced exclusively from
    // task.stuckIndicator and rendered in the header (Zone 1) — data-attribute
    // stays data-stuck-indicator="true" since the backend indicator remains
    // the single source of truth.
    r.ok(await page.$('[data-stuck-indicator="true"]'), 'merged attention banner renders in the task detail header');
    r.ok((await page.$eval('[data-stuck-indicator="true"]', (el) => el.textContent)).includes('No checkpoint recently'),
      "attention banner renders the backend's current message, not a comment");
    r.ok((await page.$eval('[data-stuck-indicator="true"]', (el) => el.textContent)).includes('Detected'),
      'attention banner renders the canonical detectedAt timestamp');

    // Popover basics (T-452-2): the current state is checked and no other;
    // Escape closes it and returns focus to the trigger chip (a11y contract
    // shared with the Status/Priority popovers).
    await openWorkStatePopover(page);
    const markedOptions = await page.$$eval('[data-work-state-option]', (elements) => elements
      .filter((el) => el.querySelector('svg')?.classList.contains('opacity-100'))
      .map((el) => el.getAttribute('data-work-state-option')));
    r.ok(markedOptions.length === 1 && markedOptions[0] === 'blocked', 'popover marks the current state and no other');
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-work-state-popover="true"]', { hidden: true, timeout: 3000 });
    r.ok(await page.evaluate(() => document.activeElement?.matches('[data-work-state-trigger="true"]')),
      'Escape closes the work-state popover and returns focus to its trigger chip');

    // Waiting: exactly one question, optional More-context, one combined PUT
    // (T-452-3). NOTE on scope vs. the old test: the old picker fired a bare
    // state-only PUT the instant `waiting` was selected, then a second PUT
    // when "Save details" was clicked. T-452-3 deliberately collapses that
    // into a single atomic write ("Ein Feld, Enter, fertig") — selecting
    // `waiting` only opens the question, it does not write anything until
    // Save/Enter. That two-PUT sequence is therefore not translated as two
    // steps; this block asserts the one combined PUT carries everything the
    // two old ones together used to prove (canonical fields, no legacy
    // `blocked`, the answer, and the More-context field).
    await chooseWorkStateOption(page, 'waiting');
    await page.waitForSelector('[data-work-state-question="true"]', { timeout: 3000 });
    r.ok(await page.$('label[for="work-state-question-input"]'), 'work-state question input has an accessible label');

    // T-454-5: the question form used to hard-code 288px; it now derives
    // from the DetailPanel's actual measured width (minus a margin), so it
    // should read close to the sidebar's width instead of the old fixed
    // guess — and noticeably wider than 288 at this desktop viewport.
    const widthCheck = await page.evaluate(() => {
      const panel = document.querySelector('[data-detail-panel]')?.getBoundingClientRect().width || 0;
      const form = document.querySelector('[data-work-state-question="true"]')?.getBoundingClientRect().width || 0;
      return { panel, form };
    });
    r.ok(widthCheck.form > 288, `question form (${widthCheck.form}px) is wider than the old fixed 288px guess`);
    r.ok(widthCheck.form >= widthCheck.panel - 80,
      `question form (${widthCheck.form}px) tracks the panel's measured width (${widthCheck.panel}px), not a fixed constant`);

    // The seed task already has `responsible`/`checkAgainAt` set, so
    // More-context is auto-expanded on open — no click needed to reach it.
    r.ok(await page.$('input[name="workStateResponsible"]'),
      'More context auto-expands when responsible/check-again values already exist');
    await setInput(page, '[data-work-state-answer="true"]', 'Release manager');
    await setInput(page, 'input[name="workStateResponsible"]', 'release');

    // T-454-6: the answer field is a <textarea> now, not an <input> — match
    // both element kinds via the shared `name` prefix so this keeps covering
    // every canonical work-state control (answer, responsible, check-again,
    // save) rather than silently dropping to 3 once the tag changed.
    const pickerControlSizes = await page.$$eval(
      '[name^="workState"], button[data-work-state-save]',
      (elements) => elements.map((element) => {
        const box = element.getBoundingClientRect();
        return { name: element.getAttribute('name') || 'save', width: box.width, height: box.height };
      }),
    );
    r.ok(pickerControlSizes.length === 4 && pickerControlSizes.every((box) => box.width >= 44 && box.height >= 44),
      'work-state popover controls have 44px touch targets');

    await page.click('[data-work-state-save="true"]');
    await waitFor(() => lastWorkStateUpdate?.workState === 'waiting');
    r.ok(lastWorkStateUpdate?.workState === 'waiting', 'popover sends canonical waiting workState');
    r.ok(!Object.prototype.hasOwnProperty.call(lastWorkStateUpdate || {}, 'blocked'),
      'popover does not write the legacy blocked projection');
    r.ok(lastWorkStateUpdate?.workStateDetails?.waitingFor === 'Release manager',
      'the one question answer persists as waitingFor through the canonical task PUT');
    r.ok(lastWorkStateUpdate?.workStateDetails?.responsible === 'release',
      'More-context responsible persists through the same canonical task PUT');
    await page.waitForSelector('[data-work-state-popover="true"]', { hidden: true, timeout: 3000 });

    // No executable action is invented from a string/boolean hint. The
    // backend must provide an explicit non-destructive descriptor first;
    // this synthetic response includes exactly that agreed descriptor.
    // T-452-8 merged the two attention banners into one and dropped Retry
    // from the UI entirely — the scheduler's own reevaluateStuckIndicator
    // already covers that path, so a second, UI-triggered path onto the
    // same mutation would just be upkeep without benefit. Only the
    // dismiss ("x", data-stuck-action="clear") remains clickable; the
    // retry mock route above stays wired (it is part of the shared
    // backend contract) but nothing in the UI can trigger it anymore.
    const actionBoxes = await page.$$eval('[data-stuck-action]', (elements) => elements.map((el) => {
      const box = el.getBoundingClientRect();
      return { action: el.getAttribute('data-stuck-action'), width: box.width, height: box.height };
    }));
    r.ok(actionBoxes.length === 1 && actionBoxes[0].action === 'clear'
      && actionBoxes[0].width >= 44 && actionBoxes[0].height >= 44,
      'the merged banner exposes exactly one action — dismiss ("x") — with a 44px touch target, no Retry button');
    await page.click('[data-stuck-action="clear"]');
    await waitFor(() => lastIndicatorAction?.path === expectedStuckIndicatorActionPath(PROJECT, taskId, 'clear'));
    r.ok(lastIndicatorAction?.path === expectedStuckIndicatorActionPath(PROJECT, taskId, 'clear'),
      'dismiss uses the exact project/task-bound clear endpoint');
    r.ok(lastIndicatorAction?.body?.indicatorId === 'stuck-1',
      'dismiss uses the backend-provided explicit action payload');
    r.ok(!lastWorkStateUpdate || lastWorkStateUpdate.workState === 'waiting',
      'dismiss does not issue a destructive workState PUT');
    r.ok(commentPosts === 0, 'clear/indicator lifecycle does not append a comment');
    await page.waitForSelector('[data-stuck-indicator="true"]', { hidden: true, timeout: 3000 });

    // Browser race: an external canonical update lands while a work-state
    // request is pending and then that request fails. The newer same-value
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
    // `working`/Active is invisible: the chip falls back to its bare,
    // unlabeled chevron once the external reset lands.
    await page.waitForFunction(
      () => document.querySelector('[data-work-state-trigger="true"]')?.getAttribute('title') === 'Change work state',
      { timeout: 3000 },
    );

    await chooseWorkStateOption(page, 'waiting');
    await page.waitForSelector('[data-work-state-question="true"]', { timeout: 3000 });
    r.ok(!(await page.$('input[name="workStateResponsible"]')),
      'More context starts collapsed for a task with no existing responsible/check-again values');
    await page.click('[data-work-state-more="true"]');
    r.ok(await page.$('input[name="workStateResponsible"]'),
      'the More-context toggle expands the collapsed technical fields');
    await setInput(page, '[data-work-state-answer="true"]', 'stale local answer');

    raceMode = true;
    await page.click('[data-work-state-save="true"]');
    await page.waitForFunction(
      () => window.appState?.tasks?.[0]?.workStateDetails?.waitingFor === 'newer external waiting reason',
      { timeout: 3000 },
    );
    await page.waitForFunction(
      () => document.querySelector('[data-work-state-answer="true"]')?.value === 'newer external waiting reason',
      { timeout: 3000 },
    );
    r.ok(await page.$eval('[data-work-state-answer="true"]', (el) => el.value) === 'newer external waiting reason',
      'failed mutation does not overwrite a newer external work state with the stale local draft');
    r.ok(await page.$('[data-work-state-question="true"]'),
      'the popover stays open on a failed write instead of silently closing on a lost mutation');

    // Close explicitly before the next scenario. The popover is deliberately
    // left open above (a failed write must not silently close), and it stays
    // mounted with `open` unchanged across renders — WorkStatePopover only
    // resets its list/question step on a false->true `open` transition (so a
    // background poll mid-edit can't clobber an in-progress answer), so
    // reopening it without first closing would not refresh its draft from
    // the next external update.
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-work-state-popover="true"]', { hidden: true, timeout: 3000 });

    // A rejected PUT with no external publication mid-flight must still roll
    // the draft back to the true canonical state (not a stale earlier one),
    // and the same choice must be retryable immediately afterward. This is
    // the exact bug the old WorkStatePicker's rollbackDraft() comment guards
    // against: a rejected selection must not get stuck and become impossible
    // to submit again.
    currentTask = {
      ...currentTask,
      workState: 'waiting',
      blocked: false,
      workStateDetails: {
        reason: null,
        waitingFor: 'canonical waiting reason',
        responsible: 'canonical owner',
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
    await page.waitForFunction(
      () => document.querySelector('[data-work-state-trigger="true"]')?.getAttribute('title') === 'Work state: Waiting',
      { timeout: 3000 },
    );

    const failedPutCount = workStatePutCount;
    failNextWorkStatePut = true;
    await chooseWorkStateOption(page, 'paused');
    await waitFor(() => workStatePutCount > failedPutCount);
    // The failed attempt rolls back to the true canonical state. Since that
    // is `waiting`, the popover lands on its question step pre-filled with
    // the canonical answer — not the abandoned "paused" attempt, and not a
    // blank/stale draft.
    await page.waitForSelector('[data-work-state-question="true"]', { timeout: 3000 });
    r.ok(await page.$eval('[data-work-state-answer="true"]', (el) => el.value) === 'canonical waiting reason',
      'failed PUT rolls the popover back to the canonical shared answer, not a stale local one');

    // The same choice (paused) is retryable right after. Unlike the old
    // always-visible box, the rolled-back popover parked on the question
    // step rather than the list, so retrying means closing and reopening —
    // the property under test (a rejected choice is not permanently stuck)
    // is unchanged.
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-work-state-popover="true"]', { hidden: true, timeout: 3000 });
    const retryPutCount = workStatePutCount;
    await chooseWorkStateOption(page, 'paused');
    await waitFor(() => workStatePutCount > retryPutCount && lastWorkStateUpdate?.workState === 'paused');
    r.ok(lastWorkStateUpdate?.workState === 'paused',
      'same work-state selection can be saved again after a rejected PUT');
    await page.waitForSelector('[data-work-state-popover="true"]', { hidden: true, timeout: 3000 });
    await page.waitForFunction(
      () => document.querySelector('[data-work-state-trigger="true"]')?.getAttribute('title') === 'Work state: Paused',
      { timeout: 3000 },
    );

    await page.setViewport({ width: 390, height: 844 });
    await chooseWorkStateOption(page, 'waiting');
    await page.waitForSelector('[data-work-state-question="true"]', { timeout: 3000 });
    const mobile = await page.evaluate(() => ({
      viewport: window.innerWidth,
      pageWidth: document.documentElement.scrollWidth,
      formWidth: document.querySelector('[data-work-state-question="true"]')?.getBoundingClientRect().width || 0,
    }));
    r.ok(mobile.pageWidth <= mobile.viewport + 1, 'work-state popover remains horizontally usable on mobile');
    r.ok(mobile.formWidth <= mobile.viewport, 'work-state question form fits the mobile viewport');
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-work-state-popover="true"]', { hidden: true, timeout: 3000 });

    // T-454-6: the answer field is a growing <textarea> now, not a
    // single-line <input>. Enter must still submit the form ("Ein Feld,
    // Enter, fertig" from the spec); Shift+Enter must insert a newline
    // instead, and the field must visibly grow with its content
    // (scrollHeight-driven) rather than clip it.
    await page.setViewport({ width: 1400, height: 900 });
    await chooseWorkStateOption(page, 'blocked');
    await page.waitForSelector('[data-work-state-question="true"]', { timeout: 3000 });
    const collapsedHeight = await page.$eval('[data-work-state-answer="true"]', (el) => el.getBoundingClientRect().height);

    await page.click('[data-work-state-answer="true"]');
    await page.keyboard.type('First line of the blocker explanation');
    await page.keyboard.down('Shift');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Shift');
    await page.keyboard.type('Second line after an explicit Shift+Enter');
    await page.keyboard.down('Shift');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Shift');
    await page.keyboard.type('Third line, long enough that the field must grow');

    const answerAfterTyping = await page.$eval('[data-work-state-answer="true"]', (el) => el.value);
    r.ok((answerAfterTyping.match(/\n/g) || []).length === 2,
      'Shift+Enter inserts a newline in the answer instead of submitting');
    r.ok(await page.$('[data-work-state-question="true"]'),
      'Shift+Enter keeps the popover open — no submit fired');

    const grownHeight = await page.$eval('[data-work-state-answer="true"]', (el) => el.getBoundingClientRect().height);
    r.ok(grownHeight > collapsedHeight,
      `answer field grows with its content (${collapsedHeight}px collapsed -> ${grownHeight}px grown)`);

    const beforeEnterSubmitCount = workStatePutCount;
    await page.keyboard.press('Enter');
    await waitFor(() => workStatePutCount > beforeEnterSubmitCount);
    r.ok(lastWorkStateUpdate?.workState === 'blocked',
      'plain Enter submits the work-state form from the growing answer field');
    r.ok(lastWorkStateUpdate?.workStateDetails?.reason?.includes('First line')
      && lastWorkStateUpdate?.workStateDetails?.reason?.includes('Third line'),
      'the full multi-line answer is sent intact on Enter-submit');
    await page.waitForSelector('[data-work-state-popover="true"]', { hidden: true, timeout: 3000 });

    r.ok(pageErrors.length === 0, `no uncaught page errors during the flow (saw: ${pageErrors.join(' | ')})`);
  });

  if (res?.skipped) r.skip(res.reason);
  r.done();
}

main().catch((error) => { console.error(error); process.exit(1); });
