import assert from 'node:assert/strict'

// CustomEvent polyfill for Node; the browser supplies this natively.
if (typeof globalThis.CustomEvent !== 'function') {
  globalThis.CustomEvent = class CustomEvent {
    constructor(type, init = {}) {
      this.type = type
      this.detail = init.detail
    }
  }
}

function createFakeWindow({ viewedProject = null, activeProject = null, tasks = [], notifyReact = null } = {}) {
  const events = []
  return {
    appState: {
      viewedProject,
      activeProject,
      tasks,
      projects: [],
      agents: [],
    },
    dispatchEvent(ev) { events.push(ev); return true },
    _events: events,
    _notifyReact: notifyReact,
    Telegram: undefined,
  }
}

function clearWindow() { delete globalThis.window }
function setWindow(w) { globalThis.window = w }

const bridge = await import('./src/state/appStateBridge.mjs')

// 1. No-window safety: every accessor stays silent when window is undefined.
{
  clearWindow()
  assert.equal(bridge.hasAppState(), false, 'hasAppState is false without window')
  assert.equal(bridge.getAppState(), null, 'getAppState returns null without window')
  assert.deepEqual(bridge.getTasks(), [], 'getTasks returns [] without window')
  assert.equal(bridge.getCurrentProject(), null, 'getCurrentProject returns null without window')
  assert.doesNotThrow(() => bridge.setTasks([{ id: 'x' }]), 'setTasks is a noop without window')
  assert.doesNotThrow(() => bridge.replaceTasks([{ id: 'x' }]), 'replaceTasks is a noop without window')
  assert.doesNotThrow(() => bridge.notify(), 'notify is a noop without window')
  console.log('✅ no-window safety')
}

// 2. Task read/write goes through appState.tasks.
{
  setWindow(createFakeWindow({ tasks: [{ id: 'A' }, { id: 'B' }] }))
  assert.equal(bridge.hasAppState(), true)
  assert.deepEqual(bridge.getTasks().map(t => t.id), ['A', 'B'], 'getTasks reads appState.tasks')

  bridge.setTasks([{ id: 'C' }])
  assert.deepEqual(globalThis.window.appState.tasks.map(t => t.id), ['C'], 'setTasks replaces appState.tasks')
  console.log('✅ task read/write')
}

// 3. notify() prefers window._notifyReact when supplied.
{
  let calls = 0
  const win = createFakeWindow({ notifyReact: () => { calls++ } })
  setWindow(win)
  bridge.notify()
  assert.equal(calls, 1, '_notifyReact was called once')
  assert.equal(win._events.length, 0, '_notifyReact owns the dispatch; bridge does not double-fire')
  console.log('✅ notify routes through _notifyReact')
}

// 4. notify() falls back to dispatchEvent when _notifyReact is missing.
{
  const win = createFakeWindow()
  setWindow(win)
  bridge.notify()
  assert.equal(win._events.length, 1, 'one event dispatched')
  assert.equal(win._events[0].type, 'appstate:change', 'event type is appstate:change')
  console.log('✅ notify falls back to dispatchEvent')
}

// 5. refreshTasks: success path fetches, stores, and notifies.
{
  const win = createFakeWindow({ viewedProject: 'demo', activeProject: 'demo', tasks: [{ id: 'stale' }] })
  setWindow(win)
  const seenUrls = []
  globalThis.fetch = async (url, opts) => {
    seenUrls.push({ url, opts })
    return {
      ok: true,
      status: 200,
      json: async () => ({ tasks: [{ id: 'fresh-1' }, { id: 'fresh-2' }] }),
    }
  }
  const tasks = await bridge.refreshTasks()
  assert.equal(seenUrls.length, 1, 'fetch called exactly once')
  assert.match(seenUrls[0].url, /^\/api\/projects\/demo\/tasks/, 'uses /api/projects/<project>/tasks path')
  assert.match(seenUrls[0].url, /includeArchived=true/, 'requests includeArchived=true')
  assert.equal(seenUrls[0].opts?.credentials, 'include', 'sends cookie credentials')
  assert.deepEqual(tasks.map(t => t.id), ['fresh-1', 'fresh-2'], 'returns fetched tasks')
  assert.deepEqual(win.appState.tasks.map(t => t.id), ['fresh-1', 'fresh-2'], 'replaces appState.tasks')
  assert.equal(win._events.length, 1, 'notify dispatched once')
  assert.equal(win._events[0].type, 'appstate:change')
  console.log('✅ refreshTasks success')
}

// 6. refreshTasks: explicit project override.
{
  const win = createFakeWindow({ viewedProject: 'a', activeProject: 'a', tasks: [] })
  setWindow(win)
  const seenUrls = []
  globalThis.fetch = async (url) => {
    seenUrls.push(url)
    return { ok: true, status: 200, json: async () => ({ tasks: [{ id: 'override' }] }) }
  }
  await bridge.refreshTasks('other-project')
  assert.match(seenUrls[0], /^\/api\/projects\/other-project\/tasks/, 'override project wins over appState')
  assert.deepEqual(win.appState.tasks.map(t => t.id), ['override'])
  console.log('✅ refreshTasks honors explicit project arg')
}

// 7. refreshTasks: guards skip fetch when no window or no project.
{
  clearWindow()
  let fetchCalled = false
  globalThis.fetch = async () => { fetchCalled = true; throw new Error('should not fetch') }
  assert.equal(await bridge.refreshTasks(), null, 'returns null without window')
  assert.equal(fetchCalled, false, 'fetch not called without window')

  setWindow(createFakeWindow({ viewedProject: null, activeProject: null }))
  fetchCalled = false
  assert.equal(await bridge.refreshTasks(), null, 'returns null without project')
  assert.equal(fetchCalled, false, 'fetch not called without project')

  setWindow(createFakeWindow({ viewedProject: '', activeProject: '' }))
  fetchCalled = false
  assert.equal(await bridge.refreshTasks(), null, 'returns null with empty project')
  assert.equal(fetchCalled, false, 'fetch not called with empty project')

  delete globalThis.fetch
  setWindow(createFakeWindow({ viewedProject: 'demo', activeProject: 'demo' }))
  assert.equal(await bridge.refreshTasks(), null, 'returns null without fetch')
  console.log('✅ refreshTasks guards skip fetch')
}

// 8. refreshTasks: API errors throw and leave appState untouched.
{
  const win = createFakeWindow({ viewedProject: 'demo', activeProject: 'demo', tasks: [{ id: 'keep-me' }] })
  setWindow(win)
  globalThis.fetch = async () => ({
    ok: false,
    status: 500,
    json: async () => ({ error: 'boom' }),
  })
  await assert.rejects(
    () => bridge.refreshTasks(),
    err => /500/.test(err.message) && /boom/.test(err.message),
    'rejects with a message that surfaces status and server error',
  )
  assert.deepEqual(win.appState.tasks.map(t => t.id), ['keep-me'], 'tasks unchanged on API error')
  assert.equal(win._events.length, 0, 'no notify on API error')
  console.log('✅ refreshTasks rejects on API error and preserves state')
}

// 9. installRefreshBridge: exposes the legacy _refreshBoard compatibility hook.
{
  const win = createFakeWindow({ viewedProject: 'demo', activeProject: 'demo' })
  setWindow(win)
  let calls = 0
  const installed = bridge.installRefreshBridge(() => {
    calls++
    return Promise.resolve(['ok'])
  })
  assert.equal(typeof installed, 'function', 'returns installed function')
  assert.equal(typeof win.appState._refreshBoard, 'function', 'sets appState._refreshBoard')
  const result = await win.appState._refreshBoard()
  assert.deepEqual(result, ['ok'], '_refreshBoard delegates to refresh function')
  assert.equal(calls, 1, 'refresh function called once')
  console.log('✅ installRefreshBridge exposes _refreshBoard')
}

console.log('✅ all app-state-bridge tests passed')
