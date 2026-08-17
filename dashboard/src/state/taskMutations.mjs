// Task mutation wrappers — frontend runtime mutation contract (ADR-0019).
// Mutations use snapshot → optional optimistic patch → API call → merge/rollback.
// Canonical work-state updates deliberately omit the shared-state patch to avoid
// same-value external-update races. Browser-independent: all window access
// goes through appStateBridge.

import * as bridge from './appStateBridge.mjs'
import * as state from './taskState.mjs'
import { apiJson } from '../utils/apiFetch.js'
import { validateTaskMutationResponse, validateTaskPayload } from '../utils/dashboardApi.js'
import {
  buildWorkStateUpdate,
  normalizeTaskWorkState,
  normalizeStuckIndicatorActionDescriptor,
  TRANSIENT_INDICATOR_ACTIONS,
} from '../utils/workState.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function currentAgent() {
  return bridge.getAppState()?.agentId || 'human'
}

async function apiRequest(url, method, body) {
  return apiJson(url, { method, body })
}

async function mutate(project, taskId, optimisticPatch, mutationFn, { requireCanonicalTask = false } = {}) {
  if (!project) return { ok: false, error: 'No active project' }

  // Snapshot for rollback
  const tasks = bridge.getTasks()
  const snap = state.snapshotTask(tasks, taskId)
  if (optimisticPatch && typeof optimisticPatch === 'object') {
    bridge.replaceTasks(state.patchTask(tasks, taskId, optimisticPatch))
  }

  try {
    const result = await mutationFn()
    if (!result || result.ok !== true) {
      throw new Error(result?.error || 'FlowBoard returned an unsuccessful mutation response')
    }
    if (requireCanonicalTask) {
      validateTaskMutationResponse(result, `/projects/${project}/tasks/${taskId}`)
    } else if (result.task) {
      // When an endpoint returns a task, never publish a partial/legacy task
      // object.  Endpoints such as release intentionally return only {ok} and
      // are refreshed by the caller instead.
      validateTaskPayload(result.task, `/projects/${project}/tasks/${taskId}`)
    }

    // Merge server response
    const currentTasks = bridge.getTasks()
    const next = state.applyTaskResponse(currentTasks, result)
    bridge.replaceTasks(next)

    return { ok: true, task: result.task }
  } catch (err) {
    // Field-aware rollback: a poll or another agent may have published a
    // newer value while this request was in flight.  Restoring the complete
    // snapshot would erase that external state.
    const currentTasks = bridge.getTasks()
    const next = state.rollbackOptimisticFields(currentTasks, snap, optimisticPatch)
    bridge.replaceTasks(next)

    // Return the shared canonical task to the editor as well.  A failed
    // canonical work-state PUT intentionally has no optimistic patch, so the
    // normal field-aware rollback is a no-op.  The picker still needs an
    // explicit draft reset when the shared task keeps the same reference and
    // values; otherwise a rejected selection remains locally selected and
    // cannot be submitted again.
    const canonicalTask = bridge.getTasks().find((task) => task?.id === taskId)
    return {
      ok: false,
      error: err.message,
      ...(canonicalTask ? { canonicalTask: normalizeTaskWorkState(canonicalTask) } : {}),
    }
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

/**
 * Update the canonical work state. The legacy `blocked` field is intentionally
 * absent from the request body; its local optimistic value is only the
 * compatibility projection used by existing board surfaces until the server
 * response arrives.
 */
export async function updateTaskWorkState(project, taskId, workState, details) {
  const current = normalizeTaskWorkState(
    bridge.getTasks().find((task) => task?.id === taskId),
  ) || {};
  const body = buildWorkStateUpdate(workState, details ?? current.workStateDetails);
  return updateTaskWorkStatePayload(project, taskId, body)
}

/**
 * Send an explicit canonical work-state update from the picker. Transient
 * stuck-indicator actions use runTransientIndicatorAction instead; they never
 * enter this task PUT path.
 */
export async function updateTaskWorkStatePayload(project, taskId, body) {
  const current = normalizeTaskWorkState(
    bridge.getTasks().find((task) => task?.id === taskId),
  ) || {};
  const details = body?.workStateDetails === undefined
    ? current.workStateDetails
    : { ...current.workStateDetails, ...body.workStateDetails };
  const workState = body?.workState || current.workState || 'working';
  const canonicalBody = buildWorkStateUpdate(workState, details);
  return mutate(
    project,
    taskId,
    // Work-state updates deliberately do not patch the shared task list
    // optimistically. A same-value external update (for example, another
    // agent also setting `waiting` with different details) is otherwise
    // indistinguishable from this mutation's optimistic value and a rejected
    // 409 would restore the stale snapshot over the newer external state.
    null,
    () => apiRequest(
      `/api/projects/${encodeURIComponent(project)}/tasks/${encodeURIComponent(taskId)}`,
      'PUT',
      canonicalBody,
    ),
    { requireCanonicalTask: true },
  )
}

/**
 * Execute a backend-provided transient indicator action.  The action is a
 * same-origin POST descriptor; it never becomes a work-state PUT fallback.
 * The endpoint must return the complete canonical task so integration cannot
 * report a local phantom success during a partial backend rollout.
 */
export async function runTransientIndicatorAction(project, taskId, descriptor) {
  const canonicalDescriptor = descriptor
    && TRANSIENT_INDICATOR_ACTIONS.includes(descriptor.action)
    ? normalizeStuckIndicatorActionDescriptor(
      { id: taskId, project },
      descriptor.action,
      descriptor,
    )
    : null;
  if (!canonicalDescriptor) {
    return { ok: false, error: 'Transient indicator action is not integrated.' }
  }
  return mutate(
    project,
    taskId,
    null,
    () => apiRequest(canonicalDescriptor.path, canonicalDescriptor.method, canonicalDescriptor.body),
    { requireCanonicalTask: true },
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
