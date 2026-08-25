import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getLeaseHealth, LEASE_HEALTH } from './src/utils/leaseHealth.js';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const leaseIndicator = read('./src/components/LeaseIndicator.jsx');
const claimStateLine = read('./src/components/ClaimStateLine.jsx');
const tasksView = read('./src/pages/TasksView.jsx');
const detailPanel = read('./src/components/DetailPanel.jsx');

const now = Date.parse('2026-08-25T12:00:00.000Z');
const task = {
  id: 'T-448-1',
  status: 'in-progress',
  agent: 'codex',
  claimedAt: '2026-08-25T11:00:00.000Z',
  lastCheckpointAt: '2026-08-25T11:40:00.000Z',
  leaseUntil: '2026-08-25T13:00:00.000Z',
};

assert.equal(
  getLeaseHealth(task, now),
  LEASE_HEALTH.CURRENT,
  'the 20-minute-old checkpoint is current under the default 30-minute test window',
);
assert.equal(
  getLeaseHealth(task, now, { staleThresholdMinutes: 10 }),
  LEASE_HEALTH.STALE,
  'the same checkpoint is stale under the configured 10-minute scheduler window',
);
assert.equal(
  getLeaseHealth({ ...task, staleAfterMinutes: 45 }, now, { staleThresholdMinutes: 10 }),
  LEASE_HEALTH.CURRENT,
  'per-task staleAfterMinutes still overrides the runtime scheduler threshold',
);

assert.match(
  leaseIndicator,
  /getLeaseHealth\(task, now, \{ staleThresholdMinutes \}\)/,
  'LeaseIndicator forwards the configured threshold to the shared health helper',
);
assert.match(
  leaseIndicator,
  /computeHealth\(task, Date\.now\(\), \{ staleThresholdMinutes \}\)/,
  'LeaseIndicator derives health from its runtime threshold prop',
);
assert.match(
  claimStateLine,
  /computeHealth\(task, Date\.now\(\), \{ staleThresholdMinutes \}\)/,
  'ClaimStateLine uses the same runtime threshold as LeaseIndicator',
);

assert.match(tasksView, /const \{ state \} = useAppState\(\);[\s\S]*?const staleThresholdMinutes = state\?\.staleThresholdMinutes;/,
  'TasksView obtains and threads the configured threshold into its board columns',
);
// T-452-5 removed the parent card's LeaseIndicator: the combo chip next to
// the priority pill states the same fact in words ("2d silent"), so the dot
// would have said it twice. Only SubtaskCard still draws one.
//
// Counting callsites was the wrong anchor — it pinned a layout decision, not
// the invariant. What has to hold is that EVERY health consumer receives the
// runtime threshold, however many there are. Asserted that way, adding or
// removing a card is free; forgetting to thread the threshold still fails.
const leaseIndicatorCallsites = tasksView.match(/<LeaseIndicator[^>]*>/g) || [];
assert.ok(
  leaseIndicatorCallsites.length >= 1,
  'TasksView still renders at least one LeaseIndicator',
);
for (const callsite of leaseIndicatorCallsites) {
  assert.match(
    callsite,
    /staleThresholdMinutes=\{staleThresholdMinutes\}/,
    `every TasksView LeaseIndicator receives the configured threshold: ${callsite}`,
  );
}

// The card chip took over the parent card's health display, so it inherits
// the same obligation.
const stateChipCallsites = tasksView.match(/<TaskCardStateChip[^>]*>/g) || [];
assert.ok(
  stateChipCallsites.length >= 1,
  'TasksView renders the card state chip that replaced the parent LeaseIndicator',
);
for (const callsite of stateChipCallsites) {
  assert.match(
    callsite,
    /staleThresholdMinutes=\{staleThresholdMinutes\}/,
    `every TaskCardStateChip receives the configured threshold: ${callsite}`,
  );
}
assert.match(detailPanel, /const staleThresholdMinutes = state\?\.staleThresholdMinutes;/,
  'DetailPanel reads the configured threshold from app state',
);
assert.equal(
  (detailPanel.match(/staleThresholdMinutes=\{staleThresholdMinutes\}/g) || []).length,
  2,
  'DetailPanel passes the threshold to ClaimStateLine and its subtask indicator',
);

console.log('✅ T-448-1 lease threshold stays aligned across task surfaces');
