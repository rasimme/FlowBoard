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

  // T-186: review -> done is now an explicit review-approval action, not a
  // generic PUT. Route it through /approve so the activity feed records the
  // approval. Priority is bundled as a follow-up PUT if also supplied.
  const tasks = bridge.getTasks()
  const current = tasks.find(t => t.id === taskId)
  if (status === 'done' && current && current.status === 'review') {
    return mutate(project, taskId, optimistic, async () => {
      const approveRes = await apiRequest(
        `/api/projects/${encodeURIComponent(project)}/tasks/${encodeURIComponent(taskId)}/approve`,
        'POST',
        { actor: currentAgent() }
      )
      if (priority !== undefined) {
        await apiRequest(
          `/api/projects/${encodeURIComponent(project)}/tasks/${encodeURIComponent(taskId)}`,
          'PUT',
          { priority }
        )
      }
      return approveRes
    })
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

// T-356 Step 4: the never-wired CRUD/admin helpers (deleteTask, restoreTask,
// trashTask, createTask, approveTask, rejectTask) were removed. The Kanban board
// (TasksView) intentionally hand-rolls list CRUD — create / drop / trash / undo —
// with its own optimistic+rollback logic close to the drag-and-drop UI (ADR-0019);
// this module is the task-COORDINATION primitive layer (claim / release / complete
// / route + status & priority updates) consumed by the DetailPanel via
// useTaskActions. Keeping both surfaces lean avoids the previous "looks like one
// enforced contract but the board bypasses it" confusion.
