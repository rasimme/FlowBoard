import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProjectContextHandler } from '../hooks/project-context/handler.js'

const root = mkdtempSync(join(tmpdir(), 'fb-hook-stability-'))
const project = 'demo'
const projectDir = join(root, project)
mkdirSync(projectDir)
const projectMd = join(projectDir, 'PROJECT.md')
writeFileSync(projectMd, '')
const originalFetch = globalThis.fetch
const originalWarn = console.warn
const urls = []
const warnings = []
let tasks = [{ id: 'T-901', status: 'in-progress', title: 'Volatile task one' }]
let binding = 'agent'
let activeProject = project
const handler = createProjectContextHandler({ projectsDir: root, dashboardBaseUrl: 'http://127.0.0.1:19999' })

async function run(agentId = 'stability-probe') {
  const event = { type: 'agent', action: 'bootstrap', context: { agentId, bootstrapFiles: [] } }
  await handler(event)
  return event.context.bootstrapFiles.find(file => file.name === 'FLOWBOARD.md').content
}

try {
  globalThis.fetch = async url => {
    urls.push(String(url))
    if (String(url).includes('/api/status')) {
      return { ok: true, status: 200, json: async () => ({ activeProject, binding }) }
    }
    if (String(url).includes('/tasks')) {
      return { ok: true, status: 200, json: async () => ({ tasks }) }
    }
    throw new Error(`Unexpected URL: ${url}`)
  }
  console.warn = message => warnings.push(message)
  const first = await run()
  tasks = [
    { id: 'T-902', status: 'done', title: 'Volatile task two' },
    { id: 'T-903', status: 'review', title: 'Volatile task three' },
  ]
  const second = await run()
  assert.equal(second, first, 'task mutations leave the document byte-identical')
  assert.deepEqual(Buffer.from(second), Buffer.from(first))
  assert.equal(urls.length, 2, 'one status request per run')
  assert(urls.every(url => !url.includes('/tasks')), 'no Tasks API request')
  assert(!/T-90[123]|Volatile task|Operational Task State|in-progress:|done:|review:|total:/i.test(first))
  assert(first.includes('## Task State'))
  assert(first.includes('GET /api/projects/demo/tasks'))
  assert(first.includes('earlier tool results is stale'))
  console.log(`Empty PROJECT.md FLOWBOARD.md: ${first.length} characters`)
  assert.equal(warnings.length, 0)

  // Boundary, deduplication, and its complete (agent, project, size) key.
  writeFileSync(projectMd, 'boundary-marker')
  const overhead = (await run()).length - 'boundary-marker'.length
  writeFileSync(projectMd, 'x'.repeat(18000 - overhead))
  assert.equal((await run()).length, 18000)
  assert.equal(warnings.length, 0, 'no warning at the threshold')
  writeFileSync(projectMd, 'x'.repeat(18001 - overhead))
  const oversized = await run()
  assert.equal(oversized.length, 18001)
  assert.equal(await run(), oversized)
  assert.equal(warnings.length, 1, 'oversize warning is deduplicated')
  assert(warnings[0].includes('18001 characters'))
  assert(warnings[0].includes('agents.defaults.bootstrapMaxChars (default 20000)'))
  assert(!warnings[0].includes('xxxx'), 'no document content in warning')
  await run('alternate-probe')
  assert.equal(warnings.length, 2, 'different agent has a separate warning key')
  writeFileSync(projectMd, 'x'.repeat(18002 - overhead))
  await run()
  assert.equal(warnings.length, 3, 'different size has a separate warning key')
  activeProject = 'twin'
  mkdirSync(join(root, activeProject))
  writeFileSync(join(root, activeProject, 'PROJECT.md'), 'x'.repeat(18001 - overhead))
  await run()
  assert.equal(warnings.length, 4, 'different project has a separate warning key')

  activeProject = project
  writeFileSync(projectMd, '')
  binding = 'session'
  const sessionContent = await run()
  assert.notEqual(sessionContent, first, 'binding changes intentionally change context')
  assert.equal(await run(), sessionContent, 'session-bound context is deterministic too')
  activeProject = null
  const noProject = await run()
  assert(noProject.includes('FlowBoard: activate project <name>'))
  assert(noProject.includes('{ project, agentId, sessionKey }'))
  assert.equal(await run(), noProject)
  console.log('Hook bootstrap stability: passed')
} finally {
  globalThis.fetch = originalFetch
  console.warn = originalWarn
  rmSync(root, { recursive: true, force: true })
}
