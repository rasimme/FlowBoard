import assert from 'node:assert/strict';
import {
  aggregateLeaseHealth,
  buildActiveAgentRows,
  canonicalAgentSlug,
  getLeaseHealth,
  groupActiveClaims,
  isValidActiveClaim,
  LEASE_HEALTH,
  normalizeStaleThresholdMinutes,
} from './src/utils/activeAgents.js';

const NOW = Date.parse('2026-08-24T12:00:00.000Z');
const claim = (id, agent, extra = {}) => ({
  id,
  title: `Task ${id}`,
  status: 'in-progress',
  agent,
  claimedAt: '2026-08-24T11:00:00.000Z',
  leaseUntil: '2026-08-24T13:00:00.000Z',
  ...extra,
});

const claims = [
  claim('T-2', 'alpha'),
  claim('T-1', 'alpha'),
  claim('T-3', 'beta', { leaseUntil: null }),
  claim('T-expired', 'alpha', { leaseUntil: '2026-08-24T11:59:59.000Z' }),
  claim('T-malformed', 'alpha', { leaseUntil: 'not-a-date' }),
  claim('T-archived', 'alpha', { status: 'archived' }),
  claim('T-trashed', 'alpha', { trashedAt: '2026-08-24T11:30:00.000Z' }),
  claim('T-done', 'alpha', { status: 'done' }),
  claim('T-duplicate', 'beta'),
  claim('T-duplicate', 'beta', { title: 'Duplicate row must not win' }),
];

assert.equal(isValidActiveClaim(claim('T-live', 'a'), NOW), true, 'future lease is valid');
assert.equal(isValidActiveClaim(claim('T-no-lease', 'a', { leaseUntil: null }), NOW), true, 'missing lease stays compatible');
assert.equal(isValidActiveClaim(claim('T-expired', 'a', { leaseUntil: '2026-08-24T11:59:59.000Z' }), NOW), true, 'expired lease stays visible for recovery');
assert.equal(isValidActiveClaim(claim('T-malformed', 'a', { leaseUntil: 'nope' }), NOW), true, 'malformed lease stays visible for recovery');
assert.equal(isValidActiveClaim(claim('T-archived', 'a', { status: 'archived' }), NOW), false, 'archived claim is hidden');
assert.equal(isValidActiveClaim(claim('T-trashed', 'a', { trashedAt: 'now' }), NOW), false, 'trashed claim is hidden');
assert.equal(isValidActiveClaim(claim('T-done', 'a', { status: 'done' }), NOW), false, 'done claim is hidden');

assert.equal(canonicalAgentSlug(' alpha '), 'alpha', 'task owner is normalized to its canonical slug');
assert.equal(canonicalAgentSlug({ agent_id: 'beta' }), 'beta', 'agent rows support their canonical id field');
assert.equal(normalizeStaleThresholdMinutes(undefined), 30, 'stale threshold defaults to the scheduler default');
assert.equal(normalizeStaleThresholdMinutes(0), 30, 'invalid runtime threshold safely falls back to the scheduler default');
assert.equal(normalizeStaleThresholdMinutes(10), 10, 'positive runtime threshold is preserved');

assert.equal(
  getLeaseHealth(claim('T-current', 'a', { lastCheckpointAt: '2026-08-24T11:55:00.000Z' }), NOW),
  LEASE_HEALTH.CURRENT,
  'future lease with recent activity is current',
);
assert.equal(
  getLeaseHealth(claim('T-no-lease', 'a', {
    leaseUntil: null,
    lastCheckpointAt: '2026-08-24T11:55:00.000Z',
  }), NOW),
  LEASE_HEALTH.CURRENT,
  'missing lease remains compatible and current when activity is fresh',
);
assert.equal(
  getLeaseHealth(claim('T-stale', 'a', {
    lastCheckpointAt: '2026-08-24T11:29:59.999Z',
  }), NOW),
  LEASE_HEALTH.STALE,
  'checkpoint one millisecond beyond the 30-minute default is stale',
);
assert.equal(
  getLeaseHealth(claim('T-default-boundary', 'a', {
    lastCheckpointAt: '2026-08-24T11:30:00.000Z',
  }), NOW),
  LEASE_HEALTH.CURRENT,
  'checkpoint exactly at the 30-minute default boundary is current',
);
assert.equal(
  getLeaseHealth(claim('T-expired', 'a', { leaseUntil: '2026-08-24T11:59:59.000Z' }), NOW),
  LEASE_HEALTH.EXPIRED,
  'expired lease is red-state health, not a hidden claim',
);
assert.equal(
  getLeaseHealth(claim('T-malformed', 'a', { leaseUntil: 'not-a-date' }), NOW),
  LEASE_HEALTH.EXPIRED,
  'malformed lease is treated as expired health',
);
assert.equal(
  getLeaseHealth(claim('T-custom-threshold', 'a', {
    lastCheckpointAt: '2026-08-24T11:40:00.000Z',
    staleAfterMinutes: 20,
  }), NOW),
  LEASE_HEALTH.CURRENT,
  'per-task stale threshold keeps an exactly-boundary claim current',
);
assert.equal(
  getLeaseHealth(claim('T-custom-threshold-over', 'a', {
    lastCheckpointAt: '2026-08-24T11:39:59.999Z',
    staleAfterMinutes: 20,
  }), NOW),
  LEASE_HEALTH.STALE,
  'per-task stale threshold marks a claim stale one millisecond beyond its boundary',
);
assert.equal(
  getLeaseHealth(claim('T-configured-threshold', 'a', {
    lastCheckpointAt: '2026-08-24T11:50:00.000Z',
  }), NOW, { staleThresholdMinutes: 10 }),
  LEASE_HEALTH.CURRENT,
  'configured scheduler threshold keeps an exactly-boundary claim current',
);
assert.equal(
  getLeaseHealth(claim('T-configured-threshold-over', 'a', {
    lastCheckpointAt: '2026-08-24T09:49:59.999Z',
  }), Date.parse('2026-08-24T10:00:00.000Z'), { staleThresholdMinutes: 10 }),
  LEASE_HEALTH.STALE,
  'configured scheduler threshold marks a claim stale beyond its boundary',
);
assert.equal(
  aggregateLeaseHealth([
    claim('T-current', 'a', { lastCheckpointAt: '2026-08-24T11:55:00.000Z' }),
    claim('T-stale', 'a', { lastCheckpointAt: '2026-08-24T11:29:59.999Z' }),
  ], NOW),
  LEASE_HEALTH.STALE,
  'agent health aggregates stale over current',
);
assert.equal(
  aggregateLeaseHealth([
    claim('T-current', 'a', { lastCheckpointAt: '2026-08-24T11:55:00.000Z' }),
    claim('T-stale', 'a', { lastCheckpointAt: '2026-08-24T11:29:59.999Z' }),
    claim('T-expired', 'a', { leaseUntil: '2026-08-24T11:59:59.000Z' }),
  ], NOW),
  LEASE_HEALTH.EXPIRED,
  'agent health aggregates expired over stale and current',
);

const grouped = groupActiveClaims(claims, NOW);
assert.deepEqual([...grouped.keys()], ['alpha', 'beta'], 'claims group by owner slug');
assert.deepEqual(grouped.get('alpha').map((task) => task.id), ['T-2', 'T-1', 'T-expired', 'T-malformed'], 'all non-done claims survive in project payload order');
assert.deepEqual(grouped.get('beta').map((task) => task.id), ['T-3', 'T-duplicate'], 'duplicate task ids are deduplicated');

const rows = buildActiveAgentRows({
  viewedProject: 'flowboard',
  now: NOW,
  agents: [
    { agent_id: 'beta', active_project: 'flowboard' },
    { agent_id: 'alpha', active_project: 'flowboard' },
    { agent_id: 'idle', active_project: 'flowboard' },
  ],
  tasks: [...claims, claim('T-unknown', 'zeta')],
});
assert.deepEqual(rows.map((row) => row.agentId), ['beta', 'alpha', 'idle', 'zeta'], 'known agent order is retained and unknown owner is deterministic');
assert.deepEqual(rows.find((row) => row.agentId === 'alpha').claims.map((task) => task.id), ['T-2', 'T-1', 'T-expired', 'T-malformed'], 'multi-claim row retains every non-done claim');
assert.equal(rows.find((row) => row.agentId === 'alpha').leaseHealth, LEASE_HEALTH.EXPIRED, 'row exposes worst lease health');
assert.equal(rows.find((row) => row.agentId === 'beta').leaseHealth, LEASE_HEALTH.STALE, 'row exposes stale health from an old claim');
assert.equal(rows.find((row) => row.agentId === 'idle').claims.length, 0, 'active idle agent remains visible');
assert.equal(rows.find((row) => row.agentId === 'idle').leaseHealth, null, 'idle agent has no lease health');
assert.equal(rows.find((row) => row.agentId === 'zeta').agent, null, 'unknown agent degrades to slug');

const configuredRows = buildActiveAgentRows({
  viewedProject: 'flowboard',
  now: NOW,
  staleThresholdMinutes: 10,
  agents: [{ agent_id: 'configured', active_project: 'flowboard' }],
  tasks: [claim('T-configured-row', 'configured', {
    lastCheckpointAt: '2026-08-24T11:49:59.999Z',
  })],
});
assert.equal(
  configuredRows[0].leaseHealth,
  LEASE_HEALTH.STALE,
  'buildActiveAgentRows forwards the configured scheduler threshold to lease health',
);

console.log('✅ Active Agents predicate/grouping tests passed');
