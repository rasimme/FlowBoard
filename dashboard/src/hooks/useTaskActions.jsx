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

  const deleteTask = useCallback(async (taskId) => {
    return mutations.deleteTask(proj(), taskId)
  }, [])

  const restoreTask = useCallback(async (taskId) => {
    return mutations.restoreTask(proj(), taskId)
  }, [])

  const trashTask = useCallback(async (taskId) => {
    return mutations.trashTask(proj(), taskId)
  }, [])

  const createTask = useCallback(async (title, opts) => {
    return mutations.createTask(proj(), title, opts)
  }, [])

  return {
    claimTask,
    releaseTask,
    completeTask,
    routeTask,
    updateStatus,
    updatePriority,
    deleteTask,
    restoreTask,
    trashTask,
    createTask,
  }
}
