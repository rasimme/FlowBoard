// Task mutation wrappers — frontend runtime mutation contract (ADR-0019).
// Every mutation: snapshot → optimistic patch → API call → merge/rollback.
// Browser-independent: all window access goes through appStateBridge.

import * as bridge from './appStateBridge.mjs'
import * as state from './taskState.mjs'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function apiHeaders() {
  const h = { 'Content-Type': 'application/json' }
  if (typeof Telegram !== 'undefined' && Telegram?.WebApp?.initData) {
    h['X-Telegram-Init-Data'] = Telegram.WebApp.initData
  }
  return h
}

async function apiRequest(url, method, body) {
  const opts = { method, headers: apiHeaders(), credentials: 'include' }
  if (body !== undefined) opts.body = JSON.stringify(body)
  const res = await fetch(url, opts)
  const data = await res.json()
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`)
  return data
}

async function mutate(project, taskId, mutationFn) {
  if (!project) return { ok: false, error: 'No active project' }

  // Snapshot for rollback
  const tasks = bridge.getTasks()
  const snap = state.snapshotTask(tasks, taskId)

  try {
    const result = await mutationFn()

    // Merge server response
    const currentTasks = bridge.getTasks()
    const next = state.applyTaskResponse(currentTasks, result)
    bridge.replaceTasks(next)

    return { ok: true, task: result.task }
  } catch (err) {
    // Rollback
    const currentTasks = bridge.getTasks()
    const next = state.rollbackSnapshot(currentTasks, snap)
    bridge.replaceTasks(next)

    return { ok: false, error: err.message }
  }
}

// ---------------------------------------------------------------------------
// Public mutation API
// ---------------------------------------------------------------------------

export async function claimTask(project, taskId) {
  return mutate(project, taskId, () =>
    apiRequest(`/api/projects/${encodeURIComponent(project)}/tasks/${encodeURIComponent(taskId)}/claim`, 'PUT')
  )
}

export async function releaseTask(project, taskId) {
  return mutate(project, taskId, () =>
    apiRequest(`/api/projects/${encodeURIComponent(project)}/tasks/${encodeURIComponent(taskId)}/release`, 'PUT')
  )
}

export async function completeTask(project, taskId, status) {
  return mutate(project, taskId, () =>
    apiRequest(
      `/api/projects/${encodeURIComponent(project)}/tasks/${encodeURIComponent(taskId)}/complete`,
      'PUT',
      status ? { status } : undefined
    )
  )
}

export async function routeTask(project, taskId, agentId) {
  return mutate(project, taskId, () =>
    apiRequest(
      `/api/projects/${encodeURIComponent(project)}/tasks/${encodeURIComponent(taskId)}/route`,
      'PUT',
      { agentId }
    )
  )
}

export async function updateTaskStatus(project, taskId, status, priority) {
  return mutate(project, taskId, () => {
    const body = { status }
    if (priority !== undefined) body.priority = priority
    return apiRequest(
      `/api/projects/${encodeURIComponent(project)}/tasks/${encodeURIComponent(taskId)}`,
      'PUT',
      body
    )
  })
}

export async function updateTaskPriority(project, taskId, priority) {
  return mutate(project, taskId, () =>
    apiRequest(
      `/api/projects/${encodeURIComponent(project)}/tasks/${encodeURIComponent(taskId)}`,
      'PUT',
      { priority }
    )
  )
}

export async function deleteTask(project, taskId) {
  return mutate(project, taskId, () =>
    apiRequest(`/api/projects/${encodeURIComponent(project)}/tasks/${encodeURIComponent(taskId)}`, 'DELETE')
  )
}

export async function restoreTask(project, taskId) {
  return mutate(project, taskId, () =>
    apiRequest(
      `/api/projects/${encodeURIComponent(project)}/tasks/${encodeURIComponent(taskId)}/restore`,
      'PUT'
    )
  )
}

export async function trashTask(project, taskId) {
  return mutate(project, taskId, () =>
    apiRequest(
      `/api/projects/${encodeURIComponent(project)}/tasks/${encodeURIComponent(taskId)}/trash`,
      'PUT'
    )
  )
}

export async function createTask(project, title, opts = {}) {
  if (!project) return { ok: false, error: 'No active project' }
  try {
    const body = { title, ...opts }
    const result = await apiRequest(
      `/api/projects/${encodeURIComponent(project)}/tasks`,
      'POST',
      body
    )

    // After create, refresh the full task list
    const refreshed = await bridge.refreshTasks(project)
    if (refreshed !== null) bridge.replaceTasks(refreshed)

    return { ok: true, task: result.task }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}
