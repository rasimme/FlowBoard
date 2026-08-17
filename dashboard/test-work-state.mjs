import assert from 'node:assert/strict';

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
    createdAt: '2026-08-17T16:00:00.000Z',
    actions: ['clear', 'retry'],
  },
});
assert.equal(activeIndicator.id, 'si-1');
assert.equal(activeIndicator.message, 'No checkpoint recently');
assert.equal(hasStuckAction(activeIndicator, 'clear'), true);
assert.equal(hasStuckAction(activeIndicator, 'retry'), true);
assert.equal(hasStuckAction(activeIndicator, 'ignore'), false);

assert.equal(getStuckIndicator({ status: 'done', stuckIndicator: { id: 'terminal' } }), null);
assert.equal(getStuckIndicator({ status: 'open', stuckIndicator: { id: 'cleared', active: false } }), null);
assert.equal(getStuckIndicator({ status: 'open', stuckIndicator: null }), null);
const nestedIndicatorTask = normalizeTaskWorkState({
  status: 'open',
  workStateDetails: {
    stuckIndicator: { summary: 'Nested attention', availableActions: { retry: true } },
  },
});
assert.equal(getStuckIndicator(nestedIndicatorTask).message, 'Nested attention');
assert.equal(hasStuckAction(getStuckIndicator(nestedIndicatorTask), 'retry'), true);

assert.deepEqual(buildStuckIndicatorActionUpdate({
  workState: 'blocked',
  workStateDetails: { reason: 'old', waitingFor: 'service', checkAgainAt: '2026-08-18T10:00:00.000Z' },
}, activeIndicator, 'retry'), {
  workState: 'working',
  workStateDetails: {
    reason: 'old',
    waitingFor: 'service',
    responsible: null,
    checkAgainAt: null,
  },
});
assert.deepEqual(buildStuckIndicatorActionUpdate({
  workState: 'blocked',
  workStateDetails: { reason: 'old', waitingFor: 'service', responsible: 'agent' },
}, activeIndicator, 'clear'), {
  workState: 'working',
  workStateDetails: {
    reason: null,
    waitingFor: null,
    responsible: null,
    checkAgainAt: null,
  },
});

const suppliedAction = {
  id: 'si-2',
  actions: { clear: { update: { workState: 'paused', workStateDetails: { reason: 'operator cleared' } } } },
};
assert.deepEqual(buildStuckIndicatorActionUpdate({ workState: 'waiting' }, suppliedAction, 'clear'), {
  workState: 'paused',
  workStateDetails: { reason: 'operator cleared' },
});

const iso = '2026-08-18T09:05:00.000Z';
const local = formatDateTimeLocal(iso);
assert.match(local, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
assert.equal(parseDateTimeLocal(local), iso);
assert.equal(formatDateTimeLocal(null), '');
assert.equal(parseDateTimeLocal(''), null);

console.log('✅ work-state helpers: all checks passed');
