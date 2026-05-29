import assert from 'node:assert/strict';
import { CLAIM_PULSE_MS, getActiveSubtaskClaims, getSyncedPulseDelayMs } from './src/parentActivity.mjs';

const parent = { id: 'T-100', title: 'Parent' };
const tasks = [
  parent,
  { id: 'T-100-1', parentId: 'T-100', title: 'Claimed child', agent: 'dev-botti', claimedAt: '2026-05-29T12:00:00Z', status: 'in-progress' },
  { id: 'T-100-2', parentId: 'T-100', title: 'Same agent later child', agent: 'dev-botti', claimedAt: '2026-05-29T12:01:00Z', status: 'in-progress' },
  { id: 'T-100-3', parentId: 'T-100', title: 'Other active child', agent: 'claude', claimedAt: '2026-05-29T12:02:00Z', status: 'open' },
  { id: 'T-100-4', parentId: 'T-100', title: 'Historical owner only', agent: 'design-botti', status: 'in-progress' },
  { id: 'T-100-5', parentId: 'T-100', title: 'Done child', agent: 'review-botti', claimedAt: '2026-05-29T12:03:00Z', status: 'done' },
  { id: 'T-100-6', parentId: 'T-100', title: 'Trashed child', agent: 'trash-botti', claimedAt: '2026-05-29T12:04:00Z', status: 'in-progress', trashedAt: '2026-05-29T12:05:00Z' },
  { id: 'T-101-1', parentId: 'T-101', title: 'Other parent', agent: 'other-botti', claimedAt: '2026-05-29T12:06:00Z', status: 'in-progress' },
];

const claims = getActiveSubtaskClaims(parent, tasks);
assert.deepEqual(
  claims.map(c => ({ agent: c.agent, taskId: c.taskId, title: c.title })),
  [
    { agent: 'dev-botti', taskId: 'T-100-1', title: 'Claimed child' },
    { agent: 'claude', taskId: 'T-100-3', title: 'Other active child' },
  ],
  'active subtask claims are unique per agent and ignore historical/done/trashed tasks',
);

assert.deepEqual(
  getActiveSubtaskClaims({ id: 'T-100-1', parentId: 'T-100' }, tasks),
  [],
  'subtasks do not derive nested activity from siblings',
);

assert.deepEqual(
  getActiveSubtaskClaims(parent, tasks, 1).map(c => c.agent),
  ['dev-botti'],
  'limit caps visible derived agents',
);

assert.equal(getSyncedPulseDelayMs(0), 0, 'pulse delay starts at zero on cycle boundary');
assert.equal(getSyncedPulseDelayMs(600), -600, 'pulse delay offsets to current cycle phase');
assert.equal(getSyncedPulseDelayMs(CLAIM_PULSE_MS + 50), -50, 'pulse delay wraps on cycle boundaries');

console.log('✅ parent activity derivation tests passed');
