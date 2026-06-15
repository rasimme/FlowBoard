import { useCallback } from 'react'
import * as mutations from '../state/taskMutations.mjs'
import { getCurrentProject } from '../state/appStateBridge.mjs'

/**
 * React hook wrapping all task mutations as stable callbacks.
 * Reads the current project from appStateBridge automatically.
 * Follows ADR-0019 frontend runtime contract.
 *
 * Usage:
 *   const { claimTask, createTask, ... } = useTaskActions()
 *   await claimTask('T-123')
 */
export default function useTaskActions() {
  const proj = () => getCurrentProject()

  const claimTask = useCallback(async (taskId) => {
    return mutations.claimTask(proj(), taskId)
  }, [])

  const releaseTask = useCallback(async (taskId) => {
    return mutations.releaseTask(proj(), taskId)
  }, [])

  const completeTask = useCallback(async (taskId, status) => {
    return mutations.completeTask(proj(), taskId, status)
  }, [])

  const routeTask = useCallback(async (taskId, agentId) => {
    return mutations.routeTask(proj(), taskId, agentId)
  }, [])

  const updateStatus = useCallback(async (taskId, status, priority) => {
    return mutations.updateTaskStatus(proj(), taskId, status, priority)
  }, [])

  const updatePriority = useCallback(async (taskId, priority) => {
    return mutations.updateTaskPriority(proj(), taskId, priority)
  }, [])

  // T-356 Step 4: list-CRUD wrappers (deleteTask/restoreTask/trashTask/createTask)
  // were removed — the Kanban board hand-rolls those with its own optimistic
  // logic. This hook exposes only the coordination primitives the DetailPanel uses.
  return {
    claimTask,
    releaseTask,
    completeTask,
    routeTask,
    updateStatus,
    updatePriority,
  }
}
