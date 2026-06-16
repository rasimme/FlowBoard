import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = process.cwd()
const srcRoot = join(root, 'src')

function walk(dir) {
  const files = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) files.push(...walk(path))
    else if (/\.(jsx?|mjs)$/.test(entry)) files.push(path)
  }
  return files
}

function readRel(path) {
  return {
    path: relative(root, path),
    text: readFileSync(path, 'utf8'),
  }
}

function withoutLineComments(text) {
  return text
    .split('\n')
    .filter(line => !line.trim().startsWith('//'))
    .join('\n')
}

const sourceFiles = walk(srcRoot).map(readRel)

const bridgePath = 'src/state/appStateBridge.mjs'
const bridge = sourceFiles.find(file => file.path === bridgePath)
assert.ok(bridge, 'appStateBridge exists')

const forbiddenTaskStatePatterns = [
  /window\.appState\??\.tasks/,
  /\bappState\.tasks\s*=/,
  /\bstate\.tasks\s*=/,
]

const offenders = sourceFiles
  .filter(file => file.path !== bridgePath)
  .flatMap(file => forbiddenTaskStatePatterns
    .filter(pattern => pattern.test(file.text))
    .map(pattern => `${file.path} matches ${pattern}`))

assert.deepEqual(
  offenders,
  [],
  'React source must not read/write window.appState.tasks outside appStateBridge'
)
console.log('✅ runtime guard: task appState access stays behind bridge')

assert.match(bridge.text, /export function getTasks\(\)/, 'bridge exposes getTasks')
assert.match(bridge.text, /export function setTasks\(/, 'bridge exposes setTasks')
assert.match(bridge.text, /export function replaceTasks\(/, 'bridge exposes replaceTasks')
assert.match(bridge.text, /export async function refreshTasks\(/, 'bridge exposes refreshTasks')
console.log('✅ runtime guard: appStateBridge owns task access API')

const taskState = sourceFiles.find(file => file.path === 'src/state/taskState.mjs')
assert.ok(taskState, 'taskState helpers exist')
assert.doesNotMatch(withoutLineComments(taskState.text), /window\.appState|fetch\(|apiFetch\(/, 'taskState remains pure')
console.log('✅ runtime guard: taskState remains browser/API independent')

const taskMutations = sourceFiles.find(file => file.path === 'src/state/taskMutations.mjs')
assert.ok(taskMutations, 'taskMutations exists')
assert.doesNotMatch(taskMutations.text, /\/(?:claim|release|complete|route)`?,\s*'PUT'/, 'coordination primitives do not use PUT')
assert.match(taskMutations.text, /\/claim`?,\s*'POST'/, 'claim uses POST primitive endpoint')
assert.match(taskMutations.text, /\/release`?,\s*'POST'/, 'release uses POST primitive endpoint')
assert.match(taskMutations.text, /\/complete`?,\s*'POST'/, 'complete uses POST primitive endpoint')
assert.match(taskMutations.text, /\/route`?,\s*'POST'/, 'route uses POST primitive endpoint')
assert.doesNotMatch(taskMutations.text, /\/(?:restore|trash)`?/, 'trash/restore use canonical task update endpoint, not fake routes')
assert.doesNotMatch(taskMutations.text, /@human/, 'taskMutations must use a valid FlowBoard agent id fallback')
assert.match(taskMutations.text, /bridge\.getAppState\(\)\?\.agentId \|\| 'human'/, 'taskMutations derives current agent through appStateBridge')
console.log('✅ runtime guard: taskMutations matches task API primitives')

const dashboardContext = sourceFiles.find(file => file.path === 'src/context/DashboardContext.jsx')
assert.ok(dashboardContext, 'DashboardContext exists')
assert.match(dashboardContext.text, /querySelector\('\.sidebar-backdrop'\)/, 'DashboardContext owns migrated sidebar backdrop listener')
assert.match(dashboardContext.text, /addEventListener\('click', onBackdropClick\)/, 'sidebar backdrop click listener is installed')
assert.match(dashboardContext.text, /removeEventListener\('click', onBackdropClick\)/, 'sidebar backdrop click listener is cleaned up')
assert.match(dashboardContext.text, /installGlobalToast/, 'DashboardContext installs global toast bridge for migrated React surfaces')
console.log('✅ runtime guard: migrated shell bridge keeps hidden DOM listeners')

const tasksView = sourceFiles.find(file => file.path === 'src/pages/TasksView.jsx')
const detailPanel = sourceFiles.find(file => file.path === 'src/components/DetailPanel.jsx')
assert.ok(tasksView, 'TasksView exists')
assert.ok(detailPanel, 'DetailPanel exists')
assert.match(tasksView.text, /from '\.\.\/state\/appStateBridge\.mjs'/, 'TasksView imports appStateBridge')
assert.match(tasksView.text, /from '\.\.\/state\/taskState\.mjs'/, 'TasksView imports taskState')
assert.match(detailPanel.text, /from '\.\.\/state\/appStateBridge\.mjs'/, 'DetailPanel imports appStateBridge')
assert.match(detailPanel.text, /from '\.\.\/state\/taskState\.mjs'/, 'DetailPanel imports taskState')
assert.doesNotMatch(detailPanel.text, /refreshKanban/, 'DetailPanel no longer uses legacy refreshKanban')
console.log('✅ runtime guard: task surfaces use runtime modules')

// --- T-356 architecture invariants (keep the React migration from regressing) ---
// These fail the gate if future work reintroduces the global anti-patterns the
// migration removed. See docs/adr/0026-frontend-architecture-invariants.md.

// 1. No reintroduced window._* command/navigation bridges. Cross-view commands
//    go through DashboardContext (useDashboard) and navigation intents through
//    NavigationContext (useNavigation). We ban ASSIGNMENT / delete of the old
//    globals (prose comments that merely mention them are fine).
const BANNED_GLOBALS = '(?:viewProject|activateProject|deactivateProject|toggleSidebar|switchTab|refreshProjects|openSpec|scrollToTaskId|scrollToNoteId|scrollToColumn|pendingNewTask|pendingNewNote|pendingNewFile)'
const bridgeReintroPatterns = [
  new RegExp(`window\\._${BANNED_GLOBALS}\\b\\s*=`),
  new RegExp(`delete\\s+window\\._${BANNED_GLOBALS}\\b`),
]
const bridgeOffenders = sourceFiles.flatMap(file => bridgeReintroPatterns
  .filter(pattern => pattern.test(withoutLineComments(file.text)))
  .map(pattern => `${file.path} matches ${pattern}`))
assert.deepEqual(bridgeOffenders, [], 'no window._* command/navigation bridges — use DashboardContext / NavigationContext')
console.log('✅ runtime guard: no window._* command/navigation bridges')

// 2. Every /api call goes through apiFetch (auth: cookie + Telegram init-data).
//    A bare fetch('/api…') 403s under the Telegram/JWT tunnel deployment. Only
//    bootstrap.js (the pre-React auth bootstrap) may call fetch('/api') directly.
const rawApiFetch = /(^|[^A-Za-z.])fetch\(\s*['"`]\/api/m
const fetchOffenders = sourceFiles
  .filter(file => file.path !== 'src/bootstrap.js')
  .filter(file => rawApiFetch.test(withoutLineComments(file.text)))
  .map(file => file.path)
assert.deepEqual(fetchOffenders, [], 'all /api calls must go through apiFetch (except the bootstrap auth call)')
console.log('✅ runtime guard: API calls go through apiFetch')

// 3. window.appState is written only by the store (AppStateContext dispatch /
//    agents fetch) and the pre-React bootstrap — never ad hoc elsewhere.
const appStateWrite = /(?:Object\.assign\(\s*window\.appState|window\.appState\.[A-Za-z]+\s*=|window\.appState\s*=)/
const ALLOWED_APPSTATE_WRITERS = new Set(['src/state/appStore.mjs', 'src/bootstrap.js'])
const appStateWriteOffenders = sourceFiles
  .filter(file => !ALLOWED_APPSTATE_WRITERS.has(file.path))
  .filter(file => appStateWrite.test(withoutLineComments(file.text)))
  .map(file => file.path)
assert.deepEqual(appStateWriteOffenders, [], 'window.appState is written only by AppStateContext/bootstrap — go through dispatch')
console.log('✅ runtime guard: window.appState writes confined to the store')

// 4. The 5s fingerprint watchdog stays gone — all updates flow through dispatch.
const appStateContext = sourceFiles.find(file => file.path === 'src/context/AppStateContext.jsx')
assert.ok(appStateContext, 'AppStateContext exists')
assert.doesNotMatch(appStateContext.text, /setInterval/, 'AppStateContext must not reintroduce a polling watchdog')
console.log('✅ runtime guard: no appState polling watchdog')

console.log('✅ all runtime guardrail tests passed')
