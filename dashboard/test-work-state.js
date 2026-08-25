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
assert.equal(isValidDateString('2026-02-29T17:00:00.000Z'), false, 'calendar overflow is rejected');
assert.equal(isValidDateString('2024-02-29T17:00:00.000Z'), true, 'leap-day is accepted');
assert.equal(isValidDateString('2026-08-17T17:00:00+24:00'), false, 'timezone overflow is rejected');
assert.equal(isValidDateString('2026-08-17T17:00:00+14:00'), true, 'maximum positive timezone offset is accepted');
assert.equal(isValidDateString('2026-08-17T17:00:00-14:00'), true, 'maximum negative timezone offset is accepted');
assert.equal(isValidDateString('2026-08-17T17:00:00+14:01'), false, 'offset minutes beyond the ±14:00 boundary are rejected');
assert.equal(isValidDateString('2026-08-17T17:00:00+15'), false, 'short offset +15 is rejected');
assert.equal(isValidDateString('2026-08-17T17:00:00+23'), false, 'short offset +23 is rejected');
assert.equal(isValidDateString('2026-08-17T17:00:00+15:00'), false, 'offset hours beyond ±14 are rejected');
assert.equal(isValidDateString('2026-08-17T17:00:00+23:00'), false, 'large offset hours are rejected');

assert.deepEqual(normalizeStoredWorkState({ blocked: true }), {
  workState: 'working',
  workStateDetails: {
    reason: null,
    waitingFor: null,
    responsible: null,
    checkAgainAt: null,
    setAt: null,
  },
});

assert.equal(normalizeStoredWorkState({ workState: 'waiting', blocked: false }).workState, 'waiting');
assert.equal(normalizeStoredWorkState({ workState: 'blocked', blocked: false }).workState, 'blocked');

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
assert.equal(created.workStateDetails.waitingFor, 'API');
assert.equal(created.workStateDetails.setAt, '2026-08-17T17:00:00.000Z');

const clientSetAt = resolveWorkStatePayload({
  workState: 'waiting',
  workStateDetails: {
    reason: 'server owns this timestamp',
    setAt: '2000-01-01T00:00:00.000Z',
  },
}, null, { now: '2026-08-17T18:00:00.000Z' });
assert.equal(clientSetAt.workStateDetails.setAt, '2026-08-17T18:00:00.000Z',
  'client setAt is ignored and replaced with the server timestamp');

const malformedClientSetAt = resolveWorkStatePayload({
  workState: 'waiting',
  workStateDetails: { setAt: 'not-a-server-timestamp' },
}, null, { now: '2026-08-17T18:01:00.000Z' });
assert.equal(malformedClientSetAt.workStateDetails.setAt, '2026-08-17T18:01:00.000Z',
  'malformed client setAt is ignored rather than persisted');

assert.equal(resolveWorkStatePayload({ workState: 'working' }, { workState: 'paused' }).workState, 'working');
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
