import assert from 'node:assert/strict'

const selection = await import('./js/project-selection.mjs')

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
    urlSearch: '?agentId=dev-botti',
    telegramWebApp: { initDataUnsafe: { start_param: 'agent=main' } },
    authAgentId: 'design-botti',
  }),
  'dev-botti',
  'URL agentId wins'
)

assert.equal(
  selection.resolveDashboardAgentId({
    telegramWebApp: { initDataUnsafe: { start_param: 'agent=dev-botti' } },
    authAgentId: 'main',
  }),
  'dev-botti',
  'Telegram start_param wins over auth fallback'
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
    storedAgentId: 'old-agent',
  }),
  { agentId: 'dev-botti', source: 'telegram-start', chatBound: true },
  'telegram start_param is chat-bound'
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

console.log('✅ project-selection tests passed')
