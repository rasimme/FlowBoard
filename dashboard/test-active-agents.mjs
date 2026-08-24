import assert from 'node:assert/strict';
import {
  buildActiveAgentRows,
  groupActiveClaims,
  isValidActiveClaim,
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
  claim('T-duplicate', 'beta'),
  claim('T-duplicate', 'beta', { title: 'Duplicate row must not win' }),
];

assert.equal(isValidActiveClaim(claim('T-live', 'a'), NOW), true, 'future lease is valid');
assert.equal(isValidActiveClaim(claim('T-no-lease', 'a', { leaseUntil: null }), NOW), true, 'missing lease stays compatible');
assert.equal(isValidActiveClaim(claim('T-expired', 'a', { leaseUntil: '2026-08-24T11:59:59.000Z' }), NOW), false, 'expired lease is hidden');
assert.equal(isValidActiveClaim(claim('T-malformed', 'a', { leaseUntil: 'nope' }), NOW), false, 'malformed lease is hidden');
assert.equal(isValidActiveClaim(claim('T-archived', 'a', { status: 'archived' }), NOW), false, 'archived claim is hidden');

const grouped = groupActiveClaims(claims, NOW);
assert.deepEqual([...grouped.keys()], ['alpha', 'beta'], 'claims group by owner slug');
assert.deepEqual(grouped.get('alpha').map((task) => task.id), ['T-2', 'T-1'], 'all valid claims survive in project payload order');
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
assert.deepEqual(rows.find((row) => row.agentId === 'alpha').claims.map((task) => task.id), ['T-2', 'T-1'], 'multi-claim row retains every claim');
assert.equal(rows.find((row) => row.agentId === 'idle').claims.length, 0, 'active idle agent remains visible');
assert.equal(rows.find((row) => row.agentId === 'zeta').agent, null, 'unknown agent degrades to slug');

console.log('✅ Active Agents predicate/grouping tests passed');
