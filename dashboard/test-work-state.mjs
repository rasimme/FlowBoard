import assert from 'node:assert/strict';

// The UI must reject local wall-clock values that do not round-trip in the
// browser's configured timezone (notably the Europe/Berlin spring-forward
// gap).  The production dashboard runs in this timezone in the test harness.
process.env.TZ = 'Europe/Berlin';

import {
  WORK_STATE_OPTIONS,
  WORK_STATE_DETAIL_FIELDS,
  EMPTY_WORK_STATE_DETAILS,
  normalizeWorkState,
  normalizeWorkStateDetails,
  normalizeTaskWorkState,
  buildWorkStateUpdate,
  getStuckIndicator,
  hasStuckAction,
  buildStuckIndicatorActionUpdate,
  formatDateTimeLocal,
  parseDateTimeLocal,
} from './src/utils/workState.js';

assert.deepEqual(WORK_STATE_OPTIONS, ['working', 'waiting', 'blocked', 'paused']);
assert.deepEqual(WORK_STATE_DETAIL_FIELDS, ['reason', 'waitingFor', 'responsible', 'checkAgainAt', 'setAt']);
assert.deepEqual(EMPTY_WORK_STATE_DETAILS, {
  reason: null,
  waitingFor: null,
  responsible: null,
  checkAgainAt: null,
  setAt: null,
});

assert.equal(normalizeWorkState('waiting'), 'waiting');
assert.equal(normalizeWorkState('unknown'), 'working');
assert.equal(normalizeWorkState(undefined, true), 'blocked');
assert.equal(normalizeWorkState(undefined, false), 'working');

assert.deepEqual(normalizeWorkStateDetails({
  reason: '  waiting for review  ',
  waitingFor: '',
  responsible: 12,
  checkAgainAt: '2026-08-18T08:00:00.000Z',
  setAt: '2026-08-17T17:00:00.000Z',
  ignored: 'not part of the contract',
}), {
  reason: 'waiting for review',
  waitingFor: null,
  responsible: null,
  checkAgainAt: '2026-08-18T08:00:00.000Z',
  setAt: '2026-08-17T17:00:00.000Z',
});

const legacyBlocked = normalizeTaskWorkState({ id: 'T-legacy', blocked: true });
assert.equal(legacyBlocked.workState, 'blocked');
assert.equal(legacyBlocked.blocked, true);
assert.deepEqual(legacyBlocked.workStateDetails, EMPTY_WORK_STATE_DETAILS);

const canonical = normalizeTaskWorkState({
  id: 'T-canonical',
  blocked: false,
  workState: 'paused',
  workStateDetails: { reason: 'maintenance', setAt: '2026-08-17T17:00:00.000Z' },
});
assert.equal(canonical.workState, 'paused');
assert.equal(canonical.blocked, false);
assert.equal(canonical.workStateDetails.reason, 'maintenance');
assert.equal(canonical.workStateDetails.setAt, '2026-08-17T17:00:00.000Z');

assert.deepEqual(buildWorkStateUpdate('waiting', {
  reason: 'Need approval',
  waitingFor: 'Simeon',
  responsible: 'human',
  checkAgainAt: '2026-08-18T09:00:00.000Z',
  setAt: 'client must not write this',
}), {
  workState: 'waiting',
  workStateDetails: {
    reason: 'Need approval',
    waitingFor: 'Simeon',
    responsible: 'human',
    checkAgainAt: '2026-08-18T09:00:00.000Z',
  },
});

const activeIndicator = getStuckIndicator({
  status: 'in-progress',
  stuckIndicator: {
    id: 'si-1',
    message: 'No checkpoint recently',
    reason: 'stale',
    detectedAt: '2026-08-17T16:00:00.000Z',
    actions: {
      clear: {
        method: 'POST',
        path: '/api/projects/demo/tasks/T-1/stuck-indicator/clear',
        body: { indicatorId: 'si-1', revision: 'r1' },
      },
      retry: {
        method: 'POST',
        path: '/api/projects/demo/tasks/T-1/stuck-indicator/retry',
        body: { indicatorId: 'si-1', revision: 'r1' },
      },
    },
  },
});
assert.equal(activeIndicator.id, 'si-1');
assert.equal(activeIndicator.detectedAt, '2026-08-17T16:00:00.000Z');
assert.equal(activeIndicator.message, 'No checkpoint recently');
assert.equal(hasStuckAction(activeIndicator, 'clear'), true);
assert.equal(hasStuckAction(activeIndicator, 'retry'), true);
assert.equal(hasStuckAction(activeIndicator, 'ignore'), false);

assert.equal(getStuckIndicator({
  status: 'open',
  stuckIndicator: [{ id: 'not-a-single-indicator' }],
}), null, 'indicator arrays fail closed instead of selecting a phantom item');
assert.equal(hasStuckAction({ actions: ['retry'] }, 'retry'), false,
  'string action names are not treated as executable API actions');

assert.equal(getStuckIndicator({ status: 'done', stuckIndicator: { id: 'terminal' } }), null);
assert.equal(getStuckIndicator({ status: 'open', stuckIndicator: { id: 'cleared', active: false } }), null);
assert.equal(getStuckIndicator({ status: 'open', stuckIndicator: null }), null);
const nestedIndicatorTask = normalizeTaskWorkState({
  status: 'open',
  workStateDetails: {
    stuckIndicator: {
      summary: 'Nested attention',
      availableActions: {
        retry: {
          method: 'POST',
          path: '/api/projects/demo/tasks/T-nested/stuck-indicator/retry',
          body: { indicatorId: 'nested', revision: 'r1' },
        },
      },
    },
  },
});
assert.equal(getStuckIndicator(nestedIndicatorTask).message, 'Nested attention');
assert.equal(hasStuckAction(getStuckIndicator(nestedIndicatorTask), 'retry'), true);

assert.deepEqual(buildStuckIndicatorActionUpdate({
  workState: 'blocked',
  workStateDetails: { reason: 'old', waitingFor: 'service', checkAgainAt: '2026-08-18T10:00:00.000Z' },
}, activeIndicator, 'retry'), {
  action: 'retry',
  method: 'POST',
  path: '/api/projects/demo/tasks/T-1/stuck-indicator/retry',
  body: { indicatorId: 'si-1', revision: 'r1' },
});
assert.deepEqual(buildStuckIndicatorActionUpdate({
  workState: 'blocked',
  workStateDetails: { reason: 'old', waitingFor: 'service', responsible: 'agent' },
}, activeIndicator, 'clear'), {
  action: 'clear',
  method: 'POST',
  path: '/api/projects/demo/tasks/T-1/stuck-indicator/clear',
  body: { indicatorId: 'si-1', revision: 'r1' },
});

assert.equal(buildStuckIndicatorActionUpdate({
  workState: 'waiting',
  workStateDetails: { reason: 'must stay intact' },
}, { id: 'si-2', actions: { clear: true } }, 'clear'), null,
  'missing explicit non-destructive action endpoint never falls back to a task PUT');
assert.deepEqual(getStuckIndicator({
  status: 'open',
  stuckIndicator: {
    actions: {
      retry: { method: 'POST', path: '/api/tasks/T-1/stuck/retry', body: { workState: 'working' } },
    },
  },
}).actions, [], 'destructive action descriptors fail closed');
assert.deepEqual(getStuckIndicator({
  status: 'open',
  stuckIndicator: {
    actions: {
      retry: { method: 'POST', path: '/api/tasks/T-1/stuck/retry', body: 'not-json-object' },
    },
  },
}).actions, [], 'malformed action bodies fail closed');

const iso = '2026-08-18T09:05:00.000Z';
const local = formatDateTimeLocal(iso);
assert.match(local, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
assert.equal(parseDateTimeLocal(local), iso);
assert.equal(formatDateTimeLocal(null), '');
assert.equal(parseDateTimeLocal(''), null);
assert.equal(parseDateTimeLocal('2026-03-29T02:30'), null,
  'DST spring-forward gap is rejected instead of normalized to 03:30');
assert.equal(parseDateTimeLocal('2026-03-29T01:30'), '2026-03-29T00:30:00.000Z',
  'valid pre-gap local time round-trips');

// Mutation integration is fail-closed too: a 2xx response without the
// canonical task shape cannot count as success, and an external state that
// arrives before a rejected request must survive the rollback.
{
  const mutations = await import('./src/state/taskMutations.mjs');
  const baseline = {
    id: 'T-mutation',
    title: 'Mutation task',
    status: 'in-progress',
    blocked: false,
    workState: 'working',
    workStateDetails: { reason: null, waitingFor: null, responsible: null, checkAgainAt: null, setAt: null },
    stuckIndicator: null,
  };
  globalThis.window = {
    appState: { viewedProject: 'demo', agentId: 'main', tasks: [baseline] },
    dispatchEvent() {},
  };
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, task: { id: baseline.id } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  const malformed = await mutations.updateTaskWorkState('demo', baseline.id, 'waiting', { reason: 'phantom' });
  assert.equal(malformed.ok, false, 'missing canonical mutation response is not reported as success');
  assert.equal(window.appState.tasks[0].workState, 'working', 'malformed response leaves the baseline state intact');

  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, task: { id: baseline.id } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  const malformedAction = await mutations.runTransientIndicatorAction('demo', baseline.id, {
    action: 'retry',
    method: 'POST',
    path: '/api/projects/demo/tasks/T-mutation/stuck-indicator/retry',
    body: { indicatorId: 'si-1' },
  });
  assert.equal(malformedAction.ok, false, 'malformed action response is not reported as success');
  assert.equal(window.appState.tasks[0].stuckIndicator, null,
    'malformed action response cannot synthesize a local indicator clear');

  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.workState === 'waiting') {
      window.appState.tasks = [{
        ...baseline,
        workState: 'paused',
        workStateDetails: { ...baseline.workStateDetails, reason: 'newer external state' },
      }];
    }
    return new Response(JSON.stringify({ error: 'stale revision' }), {
      status: 409,
      headers: { 'content-type': 'application/json' },
    });
  };
  const raced = await mutations.updateTaskWorkState('demo', baseline.id, 'waiting', { reason: 'optimistic' });
  assert.equal(raced.ok, false, 'stale mutation failure is surfaced');
  assert.equal(window.appState.tasks[0].workState, 'paused', 'newer external work state survives mutation error');
  assert.equal(window.appState.tasks[0].workStateDetails.reason, 'newer external state',
    'newer external details survive mutation error');
}

console.log('✅ work-state helpers: all checks passed');
