// T-499 F1 — pure unit tests for the dashboard embed-mode core
// (src/embed/embedMode.mjs): activation rules, host-origin verification,
// message building/parsing bounds, postToHost targetOrigin, coalescing.
import assert from 'node:assert/strict'

const m = await import('./src/embed/embedMode.mjs')

const HOST = 'http://127.0.0.1:18860'
const allowList = [HOST]
const framed = { isFramed: true, allowList, ancestorOrigins: [HOST] }
const q = (params) => '?' + new URLSearchParams(params).toString()

// --- activation ---------------------------------------------------------
const ok = m.resolveEmbedConfig(q({ embed: 'ideas', project: 'demo', host: HOST }), framed)
assert.equal(ok.surface, 'ideas')
assert.equal(ok.project, 'demo')
assert.equal(ok.hostOrigin, HOST)
assert.ok(Object.isFrozen(ok), 'config is frozen')

for (const surface of m.EMBED_SURFACES) {
  assert.equal(m.resolveEmbedConfig(q({ embed: surface, host: HOST }), framed).surface, surface)
}

assert.equal(m.resolveEmbedConfig(q({ embed: 'ideas', host: HOST }), { ...framed, isFramed: false }), null,
  'top-level page never activates embed mode')
assert.equal(m.resolveEmbedConfig(q({ host: HOST }), framed), null, 'no embed param -> standalone')
assert.equal(m.resolveEmbedConfig(q({ embed: 'tasks', host: HOST }), framed), null, 'board is native, not an embed surface')
assert.equal(m.resolveEmbedConfig(q({ embed: 'overview', host: HOST }), framed), null, 'overview stays standalone-only')
assert.equal(m.resolveEmbedConfig(q({ embed: 'ideas' }), framed), null, 'host param is required')
assert.equal(m.resolveEmbedConfig(q({ embed: 'ideas', host: 'http://evil.example' }), framed), null,
  'host must be in the allow-list')
assert.equal(m.resolveEmbedConfig(q({ embed: 'ideas', host: HOST }), { ...framed, allowList: [] }), null,
  'empty allow-list (FLOWBOARD_FRAME_ANCESTORS unset) never activates')
assert.equal(m.resolveEmbedConfig(q({ embed: 'ideas', host: HOST }), { ...framed, allowList: undefined }), null)
assert.equal(m.resolveEmbedConfig(q({ embed: 'ideas', host: HOST }), { ...framed, ancestorOrigins: ['http://127.0.0.1:1'] }), null,
  'direct parent (ancestorOrigins[0]) must equal the host')
assert.equal(m.resolveEmbedConfig(q({ embed: 'ideas', host: HOST }), { ...framed, ancestorOrigins: null }).hostOrigin, HOST,
  'no ancestorOrigins support: allow-list decides')
assert.equal(m.resolveEmbedConfig(q({ embed: 'ideas', host: HOST }), { ...framed, ancestorOrigins: [] }).hostOrigin, HOST)
assert.equal(m.resolveEmbedConfig(q({ embed: 'ideas', host: HOST + '/path' }), framed), null, 'host with path rejected')
assert.equal(m.resolveEmbedConfig(q({ embed: 'ideas', host: HOST + '/' }), framed).hostOrigin, HOST, 'trailing slash ok')
assert.equal(m.resolveEmbedConfig(q({ embed: 'ideas', host: 'javascript:alert(1)' }), framed), null)
assert.equal(m.resolveEmbedConfig(q({ embed: 'ideas', host: 'http://u:p@127.0.0.1:18860' }), framed), null)

// --- param bounds ---------------------------------------------------------
const bad = m.resolveEmbedConfig(q({ embed: 'files', host: HOST, project: '../etc', file: '../secret', task: 'x y' }), framed)
assert.equal(bad.project, null)
assert.equal(bad.file, null)
assert.equal(bad.task, null)
const files = m.resolveEmbedConfig(q({ embed: 'files', host: HOST, project: 'demo', file: 'specs/T-1.md', task: 'T-499' }), framed)
assert.equal(files.file, 'specs/T-1.md')
assert.equal(files.task, 'T-499')
const spec = m.resolveEmbedConfig(q({ embed: 'specify', host: HOST, project: 'demo', title: '  Add\nexport ' + 'x'.repeat(300), priority: 'urgent' }), framed)
assert.equal(spec.title.length, m.MAX_TITLE_LENGTH)
assert.ok(spec.title.startsWith('Add export'))
assert.equal(spec.priority, 'medium', 'unknown priority falls back to medium')
assert.equal(m.resolveEmbedConfig(q({ embed: 'specify', host: HOST, priority: 'high' }), framed).priority, 'high')

assert.equal(m.normalizeFilePath('/abs'), null)
assert.equal(m.normalizeFilePath('a\\b'), null)
assert.equal(m.normalizeFilePath('a//b'), null)
assert.equal(m.normalizeFilePath('a/./b'), null)
assert.equal(m.normalizeFilePath('a\u0000b'), null)
assert.equal(m.normalizeFilePath('x'.repeat(m.MAX_FILE_LENGTH + 1)), null)
assert.equal(m.normalizeProject('x'.repeat(m.MAX_PROJECT_LENGTH + 1)), null)
assert.equal(m.normalizeTaskId('T-' + '1'.repeat(m.MAX_TASK_ID_LENGTH)), null)
assert.equal(m.normalizeTaskId('-lead'), null)
assert.deepEqual(m.readAllowList([HOST, HOST, 'nope', 7, 'https://a.example/']), [HOST, 'https://a.example'])
assert.deepEqual(m.readAllowList('http://x'), [])

// --- tab mapping ------------------------------------------------------------
assert.equal(m.surfaceTab('ideas'), 'ideas')
assert.equal(m.surfaceTab('files'), 'files')
assert.equal(m.surfaceTab('projects'), null)
assert.equal(m.surfaceTab('specify'), null)
assert.equal(m.hostSurfaceForTab('tasks'), 'board')
assert.equal(m.hostSurfaceForTab('ideas'), 'ideas')
assert.equal(m.hostSurfaceForTab('overview'), null)

// --- frame -> host messages ---------------------------------------------------
const env = { type: 'flowboard:embed', v: 1 }
assert.deepEqual(m.buildFrameMessage('ready', { surface: 'ideas', project: 'demo' }), { ...env, kind: 'ready', surface: 'ideas', project: 'demo' })
assert.deepEqual(m.buildFrameMessage('ready', { surface: 'projects' }), { ...env, kind: 'ready', surface: 'projects' },
  'optional project is omitted, not null')
assert.deepEqual(m.buildFrameMessage('open-task', { project: 'demo', task: 'T-1' }), { ...env, kind: 'open-task', project: 'demo', task: 'T-1' })
assert.equal(m.buildFrameMessage('open-task', { project: 'demo' }), null, 'open-task needs a task id')
assert.equal(m.buildFrameMessage('open-task', { task: 'T-1' }), null, 'open-task needs a project')
assert.deepEqual(m.buildFrameMessage('open-surface', { surface: 'board', project: 'demo' }), { ...env, kind: 'open-surface', surface: 'board', project: 'demo' })
assert.deepEqual(m.buildFrameMessage('open-surface', { surface: 'board', project: null }), { ...env, kind: 'open-surface', surface: 'board' })
assert.deepEqual(m.buildFrameMessage('open-surface', { surface: 'files', project: 'demo', file: 'PROJECT.md' }),
  { ...env, kind: 'open-surface', surface: 'files', project: 'demo', file: 'PROJECT.md' })
assert.equal(m.buildFrameMessage('open-surface', { surface: 'files', file: '../x' }), null)
assert.equal(m.buildFrameMessage('open-surface', { surface: 'overview' }), null)
assert.deepEqual(m.buildFrameMessage('open-project', { project: 'demo' }), { ...env, kind: 'open-project', project: 'demo' })
assert.equal(m.buildFrameMessage('open-project', { project: 'a b' }), null)
assert.deepEqual(m.buildFrameMessage('specify-closed', { project: 'demo', task: 'T-7' }),
  { ...env, kind: 'specify-closed', project: 'demo', task: 'T-7' }, 'specify-closed carries the first created task')
assert.deepEqual(m.buildFrameMessage('specify-closed', { project: 'demo' }),
  { ...env, kind: 'specify-closed', project: 'demo' }, 'no task created -> task omitted')
assert.deepEqual(m.buildFrameMessage('specify-closed', {}), { ...env, kind: 'specify-closed' })
assert.equal(m.buildFrameMessage('specify-closed', { project: 'demo', task: 'bad id' }), null)
assert.equal(m.buildFrameMessage('bogus', {}), null)

// --- host -> frame parsing ------------------------------------------------------
assert.deepEqual(m.parseHostMessage({ ...env, kind: 'context', surface: 'files', project: 'demo', file: 'a.md' }),
  { kind: 'context', surface: 'files', project: 'demo', file: 'a.md' })
assert.deepEqual(m.parseHostMessage({ ...env, kind: 'context', surface: 'ideas' }),
  { kind: 'context', surface: 'ideas', project: null, file: null })
assert.equal(m.parseHostMessage({ ...env, v: 2, kind: 'context', surface: 'ideas' }), null, 'unknown version')
assert.equal(m.parseHostMessage({ type: 'other', v: 1, kind: 'context', surface: 'ideas' }), null)
assert.equal(m.parseHostMessage({ ...env, kind: 'open-task', surface: 'ideas' }), null, 'only context flows host -> frame')
assert.equal(m.parseHostMessage({ ...env, kind: 'context', surface: 'board' }), null)
assert.equal(m.parseHostMessage({ ...env, kind: 'context', surface: 'ideas', project: '../x' }), null)
assert.equal(m.parseHostMessage({ ...env, kind: 'context', surface: 'files', file: '/etc/passwd' }), null)
assert.equal(m.parseHostMessage('{"type":"flowboard:embed"}'), null, 'strings are not parsed')
assert.equal(m.parseHostMessage(null), null)
assert.equal(m.parseHostMessage([]), null)

// --- origin/source check -----------------------------------------------------------
const parent = {}
assert.equal(m.isTrustedHostEvent({ source: parent, origin: HOST }, { parent, hostOrigin: HOST }), true)
assert.equal(m.isTrustedHostEvent({ source: {}, origin: HOST }, { parent, hostOrigin: HOST }), false, 'forged source')
assert.equal(m.isTrustedHostEvent({ source: parent, origin: 'http://evil.example' }, { parent, hostOrigin: HOST }), false, 'forged origin')
assert.equal(m.isTrustedHostEvent({ source: parent, origin: HOST }, { parent, hostOrigin: null }), false)

// --- postToHost: exact targetOrigin -------------------------------------------------
const sent = []
const target = { postMessage: (msg, origin) => sent.push([msg, origin]) }
assert.ok(m.postToHost(target, HOST, 'open-project', { project: 'demo' }))
assert.deepEqual(sent, [[{ ...env, kind: 'open-project', project: 'demo' }, HOST]])
assert.equal(m.postToHost(target, '*', 'open-project', { project: 'demo' }), null, "never '*'")
assert.equal(m.postToHost(target, HOST, 'open-project', { project: 'a b' }), null, 'invalid payload not sent')
assert.equal(sent.length, 1)

// --- coalescing ----------------------------------------------------------------------
assert.deepEqual(
  m.coalesceOutbound([
    { kind: 'open-task', payload: { project: 'demo', task: 'T-1' } },
    { kind: 'open-surface', payload: { surface: 'board', project: 'demo' } },
  ]).map((x) => x.kind),
  ['open-task'],
  'open-task subsumes a same-burst open-surface board')
assert.deepEqual(
  m.coalesceOutbound([
    { kind: 'open-surface', payload: { surface: 'board', project: 'demo' } },
    { kind: 'open-surface', payload: { surface: 'board', project: 'demo' } },
  ]).length,
  1,
  'exact duplicates are sent once')
assert.equal(
  m.coalesceOutbound([
    { kind: 'open-task', payload: { project: 'demo', task: 'T-1' } },
    { kind: 'open-surface', payload: { surface: 'files', project: 'demo' } },
  ]).length,
  2)

console.log('✅ embed mode core (T-499 F1): all checks passed')
