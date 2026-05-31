// Task mutation wrappers — frontend runtime mutation contract (ADR-0019).
// Every mutation: snapshot → optimistic patch → API call → merge/rollback.
// Browser-independent: all window access goes through appStateBridge.

import * as bridge from './appStateBridge.mjs'
import * as state from './taskState.mjs'
import { apiJson } from '../utils/apiFetch.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function currentAgent() {
  return bridge.getAppState()?.agentId || 'human'
}

async function apiRequest(url, method, body) {
  return apiJson(url, { method, body })
}

async function mutate(project, taskId, optimisticPatch, mutationFn) {
  if (!project) return { ok: false, error: 'No active project' }

  // Snapshot for rollback
  const tasks = bridge.getTasks()
  const snap = state.snapshotTask(tasks, taskId)
  if (optimisticPatch && typeof optimisticPatch === 'object') {
    bridge.replaceTasks(state.patchTask(tasks, taskId, optimisticPatch))
  }

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
  const agent = currentAgent()
  return mutate(project, taskId, { agent, claimedAt: new Date().toISOString(), status: 'in-progress' }, () =>
    apiRequest(
      `/api/projects/${encodeURIComponent(project)}/tasks/${encodeURIComponent(taskId)}/claim`,
      'POST',
      { agent, lease: 60 }
    )
  )
}

export async function releaseTask(project, taskId) {
  return mutate(project, taskId, { agent: null, claimedAt: null, leaseUntil: null }, () =>
    apiRequest(
      `/api/projects/${encodeURIComponent(project)}/tasks/${encodeURIComponent(taskId)}/release`,
      'POST',
      { agent: currentAgent(), force: true }
    )
  )
}

export async function completeTask(project, taskId, status) {
  return mutate(project, taskId, { status: status || 'done', agent: null, claimedAt: null, leaseUntil: null }, () =>
    apiRequest(
      `/api/projects/${encodeURIComponent(project)}/tasks/${encodeURIComponent(taskId)}/complete`,
      'POST',
      { agent: currentAgent() }
    )
  )
}

export async function routeTask(project, taskId, agentId) {
  return mutate(project, taskId, { routedAgent: agentId || null }, () =>
    apiRequest(
      `/api/projects/${encodeURIComponent(project)}/tasks/${encodeURIComponent(taskId)}/route`,
      'POST',
      { agent: agentId || null }
    )
  )
}

export async function updateTaskStatus(project, taskId, status, priority) {
  const optimistic = { status }
  if (priority !== undefined) optimistic.priority = priority
  if (status === 'review' || status === 'done') {
    optimistic.agent = null
    optimistic.claimedAt = null
    optimistic.leaseUntil = null
  }
  return mutate(project, taskId, optimistic, () => {
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
  return mutate(project, taskId, { priority }, () =>
    apiRequest(
      `/api/projects/${encodeURIComponent(project)}/tasks/${encodeURIComponent(taskId)}`,
      'PUT',
      { priority }
    )
  )
}

export async function deleteTask(project, taskId) {
  return mutate(project, taskId, { status: 'archived' }, () =>
    apiRequest(`/api/projects/${encodeURIComponent(project)}/tasks/${encodeURIComponent(taskId)}`, 'DELETE')
  )
}

export async function restoreTask(project, taskId) {
  return mutate(project, taskId, { trashedAt: null }, () =>
    apiRequest(
      `/api/projects/${encodeURIComponent(project)}/tasks/${encodeURIComponent(taskId)}`,
      'PUT',
      { trashedAt: null }
    )
  )
}

export async function trashTask(project, taskId) {
  const trashedAt = new Date().toISOString()
  return mutate(project, taskId, { trashedAt }, () =>
    apiRequest(
      `/api/projects/${encodeURIComponent(project)}/tasks/${encodeURIComponent(taskId)}`,
      'PUT',
      { trashedAt }
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
