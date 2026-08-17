// AppState bridge - the only adapter allowed to read/write window.appState.tasks
// and the only place that owns React notification + project task refresh.
// See ADR-0019 and docs/concepts/frontend-runtime.md.

import { fetchTasksForProject } from '../utils/dashboardApi.js'

const directRefreshState = { generation: 0, active: null }

function getWindow() {
  if (typeof globalThis !== 'undefined' && globalThis.window) return globalThis.window
  return null
}

export function hasAppState() {
  const w = getWindow()
  return !!(w && w.appState)
}

export function getAppState() {
  const w = getWindow()
  return w && w.appState ? w.appState : null
}

export function getTasks() {
  const s = getAppState()
  return Array.isArray(s?.tasks) ? s.tasks : []
}

export function setTasks(tasks) {
  const s = getAppState()
  if (!s) return
  s.tasks = Array.isArray(tasks) ? tasks : []
}

export function getCurrentProject() {
  const s = getAppState()
  if (!s) return null
  return s.viewedProject || s.activeProject || null
}

export function notify() {
  const w = getWindow()
  if (!w) return
  if (typeof w._notifyReact === 'function') {
    w._notifyReact()
    return
  }
  if (typeof w.dispatchEvent !== 'function') return
  const CE = typeof globalThis.CustomEvent === 'function' ? globalThis.CustomEvent : null
  if (!CE) return
  w.dispatchEvent(new CE('appstate:change'))
}

export function replaceTasks(tasks) {
  setTasks(tasks)
  notify()
}

async function directRefreshTasks(projectOverride = null, options = {}) {
  const project = projectOverride || getCurrentProject()
  if (!project || typeof globalThis.fetch !== 'function') return null

  const running = directRefreshState.active
  const generation = directRefreshState.generation + 1
  directRefreshState.generation = generation

  return (async () => {
    if (running) {
      running.superseded = true
      running.controller.abort(new DOMException('Superseded task refresh', 'AbortError'))
      await running.promise.catch(() => null)
      if (directRefreshState.generation !== generation) return null
      if (directRefreshState.active === running) directRefreshState.active = null
    }

    const controller = new AbortController()
    const callerSignal = options.signal
    const forwardCallerAbort = () => controller.abort(callerSignal.reason)
    if (callerSignal?.aborted) forwardCallerAbort()
    else callerSignal?.addEventListener('abort', forwardCallerAbort, { once: true })

    let active
    const request = (async () => {
      try {
        const tasks = await fetchTasksForProject(project, controller.signal, options)
        // Overrides choose the request target, never publication ownership. A
        // response may update the shared board only while that project remains
        // current and this is still the newest coordinated refresh.
        if (controller.signal.aborted
          || directRefreshState.generation !== generation
          || getCurrentProject() !== project) return null

        replaceTasks(tasks)
        return tasks
      } catch (error) {
        if (active?.superseded || directRefreshState.generation !== generation) return null
        throw error
      } finally {
        callerSignal?.removeEventListener('abort', forwardCallerAbort)
        if (directRefreshState.active === active) directRefreshState.active = null
      }
    })()

    active = { generation, controller, promise: request, project, superseded: false }
    directRefreshState.active = active
    return request
  })()
}

export async function refreshTasks(projectOverride = null, options = {}) {
  const installed = getAppState()?._refreshBoard
  if (typeof installed === 'function') return installed(projectOverride, options)
  return directRefreshTasks(projectOverride, options)
}

export function installRefreshBridge(refreshFn = directRefreshTasks) {
  const s = getAppState()
  if (!s) return null
  s._refreshBoard = (projectOverride = null, options = {}) => refreshFn(projectOverride, options)
  return s._refreshBoard
}

export function uninstallRefreshBridge(installed) {
  const s = getAppState()
  if (s && installed && s._refreshBoard === installed) delete s._refreshBoard
}
