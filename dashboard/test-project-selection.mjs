import assert from 'node:assert/strict'

const selection = await import('./src/utils/projectSelection.mjs')

assert.equal(selection.normalizeAgentId('dev-botti'), 'dev-botti')
assert.equal(selection.normalizeAgentId('Dev-Botti'), 'dev-botti')
assert.equal(selection.normalizeAgentId('bad id'), null)
assert.equal(selection.normalizeAgentId('codex_workspace'), null)

assert.equal(selection.agentIdFromStartParam('dev-botti'), 'dev-botti')
assert.equal(selection.agentIdFromStartParam('agent=design-botti'), 'design-botti')
assert.equal(selection.agentIdFromStartParam('open_agent:main'), 'main')
assert.equal(selection.agentIdFromStartParam(''), null)

assert.equal(
  selection.resolveDashboardAgentId({
    urlSearch: '?agentId=url-agent',
    telegramWebApp: { initDataUnsafe: { start_param: 'agent=main' } },
    authAgentId: 'design-botti',
  }),
  'design-botti',
  'T-428-5: auth agentId wins over Telegram start_param and URL'
)

assert.equal(
  selection.resolveDashboardAgentId({
    urlSearch: '?agentId=url-agent',
    telegramWebApp: null,
    authAgentId: 'design-botti',
  }),
  'design-botti',
  'T-428-5: auth agentId cannot be overridden by URL query param'
)

assert.equal(
  selection.resolveDashboardAgentId({
    telegramWebApp: { initDataUnsafe: { start_param: 'agent=dev-botti' } },
    authAgentId: 'main',
  }),
  'main',
  'T-428-5: auth agentId cannot be overridden by Telegram start_param'
)

assert.equal(
  selection.resolveDashboardAgentId({ authAgentId: 'design-botti' }),
  'design-botti',
  'auth agent fallback is used'
)

assert.deepEqual(
  selection.resolveDashboardAgentIdentity({ storedAgentId: 'dev-botti' }),
  { agentId: 'dev-botti', source: 'stored', chatBound: false },
  'stored agent id is remembered but not chat-bound'
)

assert.deepEqual(
  selection.resolveDashboardAgentIdentity({
    telegramWebApp: { initDataUnsafe: { start_param: 'agent=dev-botti' } },
  }),
  { agentId: 'dev-botti', source: 'telegram-start', chatBound: true },
  'telegram start_param is chat-bound when auth and stored are absent'
)

assert.deepEqual(
  selection.resolveDashboardAgentIdentity({
    urlSearch: '?agentId=url-agent',
    telegramWebApp: { initDataUnsafe: { start_param: 'agent=tg-agent' } },
    storedAgentId: 'stored-agent',
  }),
  { agentId: 'stored-agent', source: 'stored', chatBound: false },
  'stored agent takes priority over URL and Telegram when auth is absent'
)

assert.deepEqual(
  selection.resolveDashboardAgentIdentity({
    urlSearch: '?agentId=url-agent',
    authAgentId: 'auth-agent',
    storedAgentId: 'stored-agent',
  }),
  { agentId: 'auth-agent', source: 'auth', chatBound: false },
  'authAgentId takes priority over stored and URL'
)

const projects = [{ name: 'alpha' }, { name: 'flowboard' }, { name: 'zeta' }]
const agents = [
  { agent_id: 'main', active_project: null },
  { agent_id: 'dev-botti', active_project: 'flowboard' },
]

assert.equal(
  selection.selectViewedProject({ projects, agents, activeProject: 'alpha' }),
  'alpha',
  'caller active project wins'
)
assert.equal(
  selection.selectViewedProject({ projects, agents, activeProject: null }),
  'flowboard',
  'falls back to first agent-active project'
)
assert.equal(
  selection.selectViewedProject({ projects, agents, currentViewedProject: 'zeta', activeProject: 'alpha' }),
  'zeta',
  'keeps valid current viewed project during refresh'
)
assert.equal(
  selection.selectViewedProject({ projects, agents: [], activeProject: null }),
  'alpha',
  'falls back to first project'
)

// T-529 (ADR-0044): server-derived project activity drives the start project.
const act = (name, active, lastActivityAt) => ({
  name,
  activity: { active, lastActivityAt, claims: active ? 1 : 0, sessions: 0, agents: [] },
})
const activeProjects = [act('alpha', false, null), act('flowboard', true, '2026-11-17T10:00:00.000Z'), act('zeta', true, '2026-11-17T11:00:00.000Z')]
assert.equal(
  selection.selectViewedProject({ projects: activeProjects, agents, activeProject: 'alpha' }),
  'zeta',
  'T-529: fresh load opens the most recently active project'
)
assert.equal(
  selection.selectViewedProject({ projects: activeProjects, agents, currentViewedProject: 'alpha' }),
  'alpha',
  'T-529: an explicit view is never replaced by activity on a later poll'
)
assert.equal(
  selection.selectViewedProject({ projects: [act('alpha', false, null), act('zeta', false, null)], agents: [], activeProject: 'zeta' }),
  'zeta',
  'T-529: without activity the previous fallback holds'
)
assert.equal(
  selection.mostRecentActiveProject([{ ...act('zeta', true, '2026-11-17T11:00:00.000Z'), archived: true }]),
  null,
  'T-529: archived projects never win'
)

const activityUi = await import('./src/utils/projectActivity.mjs')
const label = (activity, extra = {}) => activityUi.projectActivityLabel({ name: 'p', activity, ...extra })
assert.equal(label({ active: true, claims: 2, sessions: 1 }), 'Active: 2 claims, 1 session')
assert.equal(label({ active: true, claims: 1, sessions: 0 }), 'Active: 1 claim')
assert.equal(label({ active: true, claims: 0, sessions: 3 }), 'Active: 3 sessions')
assert.equal(label({ active: false, claims: 0, sessions: 0 }), null, 'inactive project has no dot')
assert.equal(label(undefined), null, 'missing activity (older server) has no dot')
assert.equal(label({ active: true, claims: 1, sessions: 0 }, { archived: true }), null, 'archived project has no dot')

console.log('✅ project-selection tests passed')
