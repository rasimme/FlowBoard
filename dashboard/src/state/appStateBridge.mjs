// AppState bridge - the only adapter allowed to read/write window.appState.tasks
// and the only place that owns React notification + project task refresh.
// See ADR-0019 and docs/concepts/frontend-runtime.md.

import { apiFetch } from '../utils/apiFetch.js'

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

export async function refreshTasks(projectOverride = null) {
  const project = projectOverride || getCurrentProject()
  if (!project || typeof globalThis.fetch !== 'function') return null

  const res = await apiFetch(`/api/projects/${encodeURIComponent(project)}/tasks?includeArchived=true`)

  if (!res.ok) {
    let detail = ''
    try { detail = (await res.json())?.error || '' } catch { /* ignore */ }
    throw new Error(`Refresh tasks failed (${res.status}${detail ? ': ' + detail : ''})`)
  }

  const data = await res.json()
  const tasks = Array.isArray(data?.tasks) ? data.tasks : []
  replaceTasks(tasks)
  return tasks
}

export function installRefreshBridge(refreshFn = refreshTasks) {
  const s = getAppState()
  if (!s) return null
  s._refreshBoard = () => refreshFn()
  return s._refreshBoard
}
