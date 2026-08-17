'use strict';

const assert = require('node:assert/strict');
const {
  WORK_STATES,
  DEFAULT_WORK_STATE,
  isValidDateString,
  normalizeStoredWorkState,
  normalizeWorkStateDetails,
  resolveWorkStatePayload,
} = require('./work-state.js');

assert.deepEqual(WORK_STATES, ['working', 'waiting', 'blocked', 'paused']);
assert.equal(DEFAULT_WORK_STATE, 'working');
assert.equal(isValidDateString('2026-08-17'), false, 'date-only values are not scheduler datetimes');
assert.equal(isValidDateString('2026-08-17T17:00:00.000Z'), true);
assert.equal(isValidDateString('2026-08-17T17:00:00'), false, 'timezone is required');

assert.deepEqual(normalizeStoredWorkState({ blocked: true }), {
  workState: 'blocked',
  blocked: true,
  workStateDetails: {
    reason: null,
    waitingFor: null,
    responsible: null,
    checkAgainAt: null,
    setAt: null,
  },
});

assert.deepEqual(normalizeStoredWorkState({ blocked: false }), {
  workState: 'working',
  blocked: false,
  workStateDetails: {
    reason: null,
    waitingFor: null,
    responsible: null,
    checkAgainAt: null,
    setAt: null,
  },
});

assert.equal(normalizeStoredWorkState({ workState: 'waiting', blocked: false }).blocked, false);
assert.equal(normalizeStoredWorkState({ workState: 'blocked', blocked: false }).blocked, true);

assert.deepEqual(normalizeWorkStateDetails({ reason: 'vendor' }), {
  reason: 'vendor',
  waitingFor: null,
  responsible: null,
  checkAgainAt: null,
  setAt: null,
});

const created = resolveWorkStatePayload({ workState: 'waiting', workStateDetails: { waitingFor: 'API' } }, null, {
  now: '2026-08-17T17:00:00.000Z',
});
assert.equal(created.workState, 'waiting');
assert.equal(created.blocked, false);
assert.equal(created.workStateDetails.waitingFor, 'API');
assert.equal(created.workStateDetails.setAt, '2026-08-17T17:00:00.000Z');

assert.equal(resolveWorkStatePayload({ blocked: false }, { workState: 'paused' }).workState, 'working');
assert.equal(resolveWorkStatePayload({ blocked: true }, { workState: 'working' }).workState, 'blocked');

assert.throws(
  () => resolveWorkStatePayload({ blocked: true, workState: 'waiting' }),
  error => error.code === 'WORK_STATE_CONTRADICTION' && error.status === 400
);
assert.throws(
  () => resolveWorkStatePayload({ workState: 'not-a-state' }),
  error => error.code === 'WORK_STATE_INVALID' && error.status === 400
);
assert.throws(
  () => resolveWorkStatePayload({ workStateDetails: { checkAgainAt: 'not-a-date' } }),
  error => error.code === 'WORK_STATE_DETAILS_INVALID' && error.status === 400
);
assert.throws(
  () => resolveWorkStatePayload({ workStateDetails: { checkAgainAt: '2026-08-17' } }),
  error => error.code === 'WORK_STATE_DETAILS_INVALID' && error.status === 400
);

console.log('✅ work-state pure helpers');
