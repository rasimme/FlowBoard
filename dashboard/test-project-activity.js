'use strict';

/**
 * T-529 (ADR-0044): project activity derivation and the start-project choice.
 *
 *   1. deriveProjectActivity — claims live/expired, sessions fresh/old, legacy
 *      agent binding, archived projects, several active projects at once
 *   2. activityWindowMinutes — env parsing
 *   3. mostRecentActiveProject + buildDashboardSnapshot viewedProject order
 *
 * Run: node test-project-activity.js
 */

const assert = require('node:assert/strict');
const {
  DEFAULT_ACTIVITY_WINDOW_MINUTES,
  activityWindowMinutes,
  deriveProjectActivity,
  mostRecentActiveProject,
} = require('./project-activity.js');
const { buildDashboardSnapshot } = require('./dashboard-snapshot.js');

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const MIN = 60 * 1000;
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✅ ${name}`);
}

const projects = [
  { name: 'alpha', archived: false },
  { name: 'beta', archived: false },
  { name: 'gamma', archived: false },
  { name: 'old', archived: true },
];

function derive(overrides = {}) {
  return deriveProjectActivity({ projects, nowMs: NOW, windowMinutes: 30, ...overrides });
}

const liveClaim = (over = {}) => ({
  project: 'alpha',
  id: 'T-1',
  agent: 'codex',
  status: 'in-progress',
  claimedAt: iso(-60 * MIN),
  leaseUntil: iso(10 * MIN),
  lastCheckpointAt: iso(-5 * MIN),
  ...over,
});

console.log('\n## deriveProjectActivity');

check('no sources → every project inactive with the full shape', () => {
  const result = derive();
  assert.equal(result.size, 4);
  for (const activity of result.values()) {
    assert.deepEqual(activity, { active: false, lastActivityAt: null, claims: 0, sessions: 0, agents: [] });
  }
});

check('live claim makes a project active; lastActivityAt = max(claimedAt, lastCheckpointAt)', () => {
  const alpha = derive({ claims: [liveClaim()] }).get('alpha');
  assert.deepEqual(alpha, {
    active: true,
    lastActivityAt: iso(-5 * MIN),
    claims: 1,
    sessions: 0,
    agents: ['codex'],
  });
});

check('expired lease does not count', () => {
  const alpha = derive({ claims: [liveClaim({ leaseUntil: iso(-1 * MIN) })] }).get('alpha');
  assert.equal(alpha.active, false);
  assert.equal(alpha.claims, 0);
});

check('a claim without a lease counts as live (same rule as countLiveClaims)', () => {
  assert.equal(derive({ claims: [liveClaim({ leaseUntil: null })] }).get('alpha').active, true);
});

check('only in-progress claims with agent and claimedAt count; trashed tasks never', () => {
  const claims = [
    liveClaim({ status: 'review' }),
    liveClaim({ agent: null }),
    liveClaim({ claimedAt: null }),
    liveClaim({ trashedAt: iso(-1 * MIN) }),
  ];
  assert.equal(derive({ claims }).get('alpha').active, false);
});

check('fresh session binding makes a project active; old one does not', () => {
  const result = derive({
    sessionBindings: [
      { agent_id: 'dev-botti', session_key: 's1', active_project: 'beta', last_seen: iso(-29 * MIN) },
      { agent_id: 'dev-botti', session_key: 's2', active_project: 'gamma', last_seen: iso(-31 * MIN) },
    ],
  });
  assert.deepEqual(result.get('beta'), {
    active: true,
    lastActivityAt: iso(-29 * MIN),
    claims: 0,
    sessions: 1,
    agents: ['dev-botti'],
  });
  assert.equal(result.get('gamma').active, false);
});

check('window boundary is inclusive and configurable', () => {
  const sessionBindings = [{ agent_id: 'a', session_key: 's', active_project: 'beta', last_seen: iso(-30 * MIN) }];
  assert.equal(derive({ sessionBindings }).get('beta').active, true, '30 min old in a 30 min window');
  assert.equal(derive({ sessionBindings, windowMinutes: 10 }).get('beta').active, false, 'outside a 10 min window');
});

check('legacy agent-wide binding counts when recently seen', () => {
  const result = derive({
    agents: [
      { agent_id: 'main', active_project: 'gamma', last_seen: iso(-2 * MIN) },
      { agent_id: 'stale', active_project: 'beta', last_seen: iso(-3 * 60 * MIN) },
      { agent_id: 'idle', active_project: null, last_seen: iso(0) },
    ],
  });
  assert.deepEqual(result.get('gamma'), {
    active: true, lastActivityAt: iso(-2 * MIN), claims: 0, sessions: 1, agents: ['main'],
  });
  assert.equal(result.get('beta').active, false);
});

check('legacy binding is ignored for an agent working elsewhere (claim or session) and never counted twice', () => {
  const result = derive({
    claims: [liveClaim({ project: 'beta', agent: 'worker' })],
    sessionBindings: [{ agent_id: 'dev', session_key: 's', active_project: 'gamma', last_seen: iso(-1 * MIN) }],
    agents: [
      { agent_id: 'worker', active_project: 'alpha', last_seen: iso(0) },
      { agent_id: 'dev', active_project: 'gamma', last_seen: iso(0) },
    ],
  });
  assert.equal(result.get('alpha').active, false, 'heartbeat from the claim in beta does not revive alpha');
  assert.equal(result.get('beta').claims, 1);
  assert.equal(result.get('gamma').sessions, 1, 'session + agent-wide binding of one agent count once');
});

check('archived projects are never active', () => {
  const result = derive({
    claims: [liveClaim({ project: 'old' })],
    sessionBindings: [{ agent_id: 'a', session_key: 's', active_project: 'old', last_seen: iso(0) }],
    agents: [{ agent_id: 'a', active_project: 'old', last_seen: iso(0) }],
  });
  assert.equal(result.get('old').active, false);
});

check('several projects active at once; agents deduplicated and sorted', () => {
  const result = derive({
    claims: [
      liveClaim({ id: 'T-1', agent: 'zed' }),
      liveClaim({ id: 'T-2', agent: 'codex', lastCheckpointAt: iso(-1 * MIN) }),
      liveClaim({ id: 'T-3', project: 'beta', agent: 'codex' }),
    ],
    sessionBindings: [
      { agent_id: 'codex', session_key: 's1', active_project: 'alpha', last_seen: iso(-10 * MIN) },
      { agent_id: 'codex', session_key: 's2', active_project: 'alpha', last_seen: iso(-20 * MIN) },
    ],
  });
  assert.deepEqual(result.get('alpha'), {
    active: true, lastActivityAt: iso(-1 * MIN), claims: 2, sessions: 2, agents: ['codex', 'zed'],
  });
  assert.equal(result.get('beta').active, true);
  assert.equal(result.get('gamma').active, false);
});

check('bindings to unknown projects are ignored', () => {
  const result = derive({
    sessionBindings: [{ agent_id: 'a', session_key: 's', active_project: 'deleted', last_seen: iso(0) }],
  });
  assert.equal(result.has('deleted'), false);
});

check('same inputs at a later time give identical non-boolean fields (ETag stability)', () => {
  const input = {
    claims: [liveClaim({ leaseUntil: iso(60 * MIN) })],
    sessionBindings: [{ agent_id: 'a', session_key: 's', active_project: 'beta', last_seen: iso(-1 * MIN) }],
  };
  const first = JSON.stringify([...derive(input)]);
  const later = JSON.stringify([...derive({ ...input, nowMs: NOW + 5 * MIN })]);
  assert.equal(later, first);
});

console.log('\n## activityWindowMinutes');

check('default 30, positive numbers accepted, garbage falls back', () => {
  assert.equal(DEFAULT_ACTIVITY_WINDOW_MINUTES, 30);
  assert.equal(activityWindowMinutes(undefined), 30);
  assert.equal(activityWindowMinutes('45'), 45);
  assert.equal(activityWindowMinutes('0.5'), 0.5);
  for (const bad of ['0', '-5', 'abc', '']) {
    assert.equal(activityWindowMinutes(bad), 30, bad);
  }
});

console.log('\n## start project');

const withActivity = (name, active, lastActivityAt, extra = {}) => ({
  name,
  archived: false,
  activity: { active, lastActivityAt, claims: active ? 1 : 0, sessions: 0, agents: [] },
  ...extra,
});

check('mostRecentActiveProject picks the newest active project', () => {
  const list = [
    withActivity('alpha', true, iso(-20 * MIN)),
    withActivity('beta', true, iso(-1 * MIN)),
    withActivity('gamma', false, null),
  ];
  assert.equal(mostRecentActiveProject(list), 'beta');
  assert.equal(mostRecentActiveProject([withActivity('a', false, null)]), null);
  assert.equal(mostRecentActiveProject([withActivity('a', true, iso(0), { archived: true })]), null);
});

function snapshot({ list, requestedProject = null, activeProject = null, agents = [] }) {
  return buildDashboardSnapshot({
    agentId: activeProject ? 'viewer' : null,
    requestedProject,
    now: () => NOW,
    listProjects: () => list,
    listAgents: () => agents,
    getStatus: (id) => ({ agentId: id, activeProject, contextReady: false }),
    listTasks: () => [],
  });
}

check('snapshot: explicit view wins over activity', () => {
  const list = [withActivity('alpha', false, null), withActivity('beta', true, iso(0))];
  assert.equal(snapshot({ list, requestedProject: 'alpha' }).viewedProject, 'alpha');
});

check('snapshot: fresh load opens the most recently active project', () => {
  const list = [withActivity('alpha', false, null), withActivity('beta', true, iso(-9 * MIN)), withActivity('gamma', true, iso(-2 * MIN))];
  assert.equal(snapshot({ list, activeProject: 'alpha' }).viewedProject, 'gamma');
});

check('snapshot: without activity the old fallback order holds', () => {
  const list = [withActivity('alpha', false, null), withActivity('beta', false, null), withActivity('gamma', false, null)];
  assert.equal(snapshot({ list, activeProject: 'beta' }).viewedProject, 'beta');
  assert.equal(snapshot({ list, agents: [{ agent_id: 'x', active_project: 'gamma' }] }).viewedProject, 'gamma');
  assert.equal(snapshot({ list }).viewedProject, 'alpha');
});

console.log(`\n✅ project-activity tests passed (${passed})`);
