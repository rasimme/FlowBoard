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

console.log('✅ all runtime guardrail tests passed')
