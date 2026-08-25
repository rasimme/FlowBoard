import assert from 'node:assert/strict';
import {
  aggregateLeaseHealth,
  activeAgentLeaseHealthLabel,
  buildActiveAgentRows,
  buildActiveAgentWidgetRows,
  buildRoutableAgentRows,
  canonicalAgentSlug,
  getLeaseHealth,
  groupActiveClaims,
  isRoutableAgent,
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

assert.equal(activeAgentLeaseHealthLabel(LEASE_HEALTH.CURRENT), 'Current', 'current lease health has a visible label');
assert.equal(activeAgentLeaseHealthLabel(LEASE_HEALTH.STALE), 'Stale', 'stale lease health has a visible label');
assert.equal(activeAgentLeaseHealthLabel(LEASE_HEALTH.EXPIRED), 'Expired', 'expired lease health has a visible label');

// T-455-3: isRoutableAgent / buildRoutableAgentRows — the Route popover's
// filter down from "every agent ever registered" to the same "still live"
// set the backend's own idle-expiry (isAgentIdleExpired, flowboard-metadata.js)
// already tolerates: active_project set, or a currently-claimed task whose
// lease has not expired.
assert.equal(
  isRoutableAgent({ agent_id: 'active', active_project: 'flowboard' }, [], NOW),
  true,
  'agent with active_project set is routable with no claims at all',
);
assert.equal(
  isRoutableAgent({ agent_id: 'idle', active_project: null }, [], NOW),
  false,
  'agent with no active_project and no claims is not routable',
);
assert.equal(
  isRoutableAgent(
    { agent_id: 'live-claimer', active_project: null },
    [claim('T-live', 'live-claimer')],
    NOW,
  ),
  true,
  'agent with no active_project but a live (unexpired-lease) claim is routable',
);
assert.equal(
  isRoutableAgent(
    { agent_id: 'live-claimer-no-lease', active_project: null },
    [claim('T-live', 'live-claimer-no-lease', { leaseUntil: null })],
    NOW,
  ),
  true,
  'a claim with no lease at all is conservatively treated as live, mirroring countLiveClaims',
);
assert.equal(
  isRoutableAgent(
    { agent_id: 'expired-claimer', active_project: null },
    [claim('T-expired-only', 'expired-claimer', { leaseUntil: '2026-08-24T11:59:59.000Z' })],
    NOW,
  ),
  false,
  'an expired-lease claim does not count as live — expired claims are dead work, not a routability signal',
);
assert.equal(
  isRoutableAgent(
    { agent_id: 'done-claimer', active_project: null },
    [claim('T-done-only', 'done-claimer', { status: 'done' })],
    NOW,
  ),
  false,
  'a done task keeps `agent` as historical attribution — isActivelyClaimed excludes it, so it grants no routability',
);
assert.equal(
  isRoutableAgent('bare-string-agent', [], NOW),
  false,
  'a bare agent slug (no active_project field) with no claims is not routable',
);

const routableRows = buildRoutableAgentRows({
  viewedProject: 'flowboard',
  now: NOW,
  agents: [
    { agent_id: 'idle-1', active_project: null },
    { agent_id: 'other-project', active_project: 'creon' },
    { agent_id: 'here-1', active_project: 'flowboard' },
    { agent_id: 'idle-2', active_project: null },
    { agent_id: 'here-2', active_project: 'flowboard' },
    { agent_id: 'live-claim-elsewhere', active_project: null },
  ],
  tasks: [claim('T-live-elsewhere', 'live-claim-elsewhere')],
});
assert.deepEqual(
  routableRows.map((a) => a.agent_id),
  ['here-1', 'here-2', 'other-project', 'live-claim-elsewhere'],
  'idle agents with neither active_project nor a live claim are dropped; agents active on the viewed project sort first, both groups keeping their original (alphabetical /api/agents) order',
);

// ---------------------------------------------------------------------------
// T-457 — the Overview widgets (ActiveAgentsWidget, CurrentFocusWidget)
// consume `buildActiveAgentWidgetRows`, an adapter around the same
// predicate/health used above, instead of re-filtering `claimedAt`
// themselves. The regression this fixed: both widgets filtered
// `t.agent && t.claimedAt` with no archived/done/trashed check, so a task
// that had been archived while still carrying its old `claimedAt` rendered
// as an active claim — exactly the shape of T-074 on the live instance
// (archived 2026-08-12, claimedAt/leaseUntil from before that still set).
// ---------------------------------------------------------------------------
const widgetFixtures = [
  claim('T-w-current', 'alpha', { lastCheckpointAt: '2026-08-24T11:55:00.000Z' }),
  claim('T-w-stale', 'alpha', { lastCheckpointAt: '2026-08-24T11:00:00.000Z' }),
  claim('T-w-expired-lease', 'alpha', {
    leaseUntil: '2026-08-24T11:59:59.000Z',
    lastCheckpointAt: '2026-08-24T11:58:00.000Z',
  }),
  // The T-457 regression case: an archived task that still carries its old
  // agent/claimedAt/leaseUntil — this is exactly T-074's shape in production.
  claim('T-w-archived', 'codex', {
    status: 'archived',
    lastCheckpointAt: '2026-08-12T00:00:00.000Z',
    leaseUntil: '2026-08-12T00:20:00.000Z',
  }),
  claim('T-w-done', 'alpha', { status: 'done' }),
  claim('T-w-trashed', 'alpha', { trashedAt: '2026-08-24T11:30:00.000Z' }),
];

const widgetRows = buildActiveAgentWidgetRows({
  viewedProject: 'flowboard',
  now: NOW,
  agents: [
    { agent_id: 'alpha', active_project: 'flowboard' },
    { agent_id: 'codex', active_project: null },
    { agent_id: 'idle-agent', active_project: 'flowboard' },
  ],
  tasks: widgetFixtures,
});

const workingIds = widgetRows.working.map((e) => e.task.id);
const attentionIds = widgetRows.needsAttention.map((e) => e.task.id);
const shownIds = [...workingIds, ...attentionIds];

assert.ok(
  !shownIds.includes('T-w-archived'),
  'T-457: an archived task with claimedAt still set does not appear in the widget rows (this is the T-074 production bug, reproduced)',
);
assert.ok(!shownIds.includes('T-w-done'), 'a done claim does not appear in the widget rows');
assert.ok(!shownIds.includes('T-w-trashed'), 'a trashed claim does not appear in the widget rows');
assert.deepEqual(workingIds, ['T-w-current'], 'only the healthy claim lands in the working group');
assert.deepEqual(
  attentionIds.sort(),
  ['T-w-expired-lease', 'T-w-stale'],
  'a stale-activity claim and an expired-lease claim both land in needs-attention — one amber signal, not split by severity (T-452-6)',
);
assert.equal(widgetRows.working[0].leaseHealth, LEASE_HEALTH.CURRENT, 'working row exposes CURRENT health');
assert.ok(
  widgetRows.needsAttention.every((e) => e.leaseHealth === LEASE_HEALTH.STALE || e.leaseHealth === LEASE_HEALTH.EXPIRED),
  'needs-attention rows are always stale or expired health, never current',
);
assert.deepEqual(
  widgetRows.idle.map((e) => e.agentId),
  ['idle-agent'],
  'an agent active on the project with no claim appears in the idle group, not mixed into the claim groups',
);
assert.equal(widgetRows.idle[0].task, null, 'idle rows carry no task');
assert.equal(widgetRows.idle[0].leaseHealth, null, 'idle rows carry no lease health');
assert.ok(
  !widgetRows.idle.some((e) => e.agentId === 'codex'),
  'codex has no active_project and (after the archived claim is excluded) no valid claim, so it does not appear in idle either — it disappears entirely, not "no reason shown"',
);

console.log('✅ Active Agents predicate/grouping tests passed');
console.log('✅ Overview widget claim rows (T-457) tests passed');
