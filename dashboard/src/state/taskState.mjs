// Pure task state helpers - browser-independent building blocks for the
// frontend runtime mutation contract. See ADR-0019 and
// docs/concepts/frontend-runtime.md.
//
// Every helper returns a new array (or the input reference on no-op) and
// never mutates inputs. These helpers know nothing about window.appState,
// React, fetch, or notifications - those belong to appStateBridge and the
// upcoming taskMutations / hook layer.

function asArray(tasks) {
  return Array.isArray(tasks) ? tasks : []
}

function clone(value) {
  if (value === null || value === undefined) return value
  return JSON.parse(JSON.stringify(value))
}

export function patchTask(tasks, id, patch) {
  const list = asArray(tasks)
  if (list !== tasks) return list
  if (!patch || typeof patch !== 'object') return tasks
  const index = list.findIndex(t => t && t.id === id)
  if (index === -1) return tasks
  const next = list.slice()
  next[index] = { ...list[index], ...patch }
  return next
}

export function upsertTask(tasks, task) {
  const list = asArray(tasks)
  if (!task || typeof task !== 'object' || !task.id) {
    return list === tasks ? tasks : list
  }
  const index = list.findIndex(t => t && t.id === task.id)
  if (index === -1) {
    return list.concat([{ ...task }])
  }
  const next = list.slice()
  next[index] = { ...list[index], ...task }
  return next
}

export function mergeParentUpdated(tasks, parentUpdated) {
  const list = asArray(tasks)
  if (!parentUpdated || typeof parentUpdated !== 'object' || !parentUpdated.id) {
    return list === tasks ? tasks : list
  }
  const index = list.findIndex(t => t && t.id === parentUpdated.id)
  if (index === -1) {
    return list === tasks ? tasks : list
  }
  const next = list.slice()
  next[index] = { ...list[index], ...parentUpdated }
  return next
}

export function applyTaskResponse(tasks, response) {
  const list = asArray(tasks)
  if (!response || typeof response !== 'object') {
    return list === tasks ? tasks : list
  }
  let next = list === tasks ? tasks : list
  if (response.task) next = upsertTask(next, response.task)
  if (response.parentUpdated) next = mergeParentUpdated(next, response.parentUpdated)
  return next
}

export function snapshotTask(tasks, id) {
  const list = asArray(tasks)
  const index = list.findIndex(t => t && t.id === id)
  const found = index === -1 ? null : list[index]
  return { id, index, task: found ? clone(found) : null }
}

export function snapshotTasks(tasks, ids) {
  if (!Array.isArray(ids)) return []
  return ids.map(id => snapshotTask(tasks, id))
}

export function rollbackSnapshot(tasks, snapshot) {
  const list = asArray(tasks)
  if (!snapshot || typeof snapshot !== 'object' || snapshot.id === undefined) {
    return list === tasks ? tasks : list
  }
  const index = list.findIndex(t => t && t.id === snapshot.id)
  if (snapshot.task === null) {
    if (index === -1) return list === tasks ? tasks : list
    const next = list.slice()
    next.splice(index, 1)
    return next
  }
  const restored = clone(snapshot.task)
  const next = index === -1 ? list.slice() : list.filter((_, i) => i !== index)
  const targetIndex = Number.isInteger(snapshot.index)
    ? Math.max(0, Math.min(snapshot.index, next.length))
    : next.length
  next.splice(targetIndex, 0, restored)
  return next
}

function sameValue(a, b) {
  if (Object.is(a, b)) return true
  if (a === undefined || b === undefined) return false
  try { return JSON.stringify(a) === JSON.stringify(b) } catch { return false }
}

/**
 * Roll back only fields that still equal this mutation's optimistic value.
 * Polls/external agents may have published a newer value while the request
 * was in flight; restoring the whole snapshot in that case would erase the
 * newer canonical state.
 */
export function rollbackOptimisticFields(tasks, snapshot, optimisticPatch) {
  const list = asArray(tasks)
  if (!snapshot || typeof snapshot !== 'object' || snapshot.task === null
      || !optimisticPatch || typeof optimisticPatch !== 'object') {
    return snapshot?.task === null ? rollbackSnapshot(list, snapshot) : list
  }
  const index = list.findIndex(t => t && t.id === snapshot.id)
  if (index === -1) return list
  const current = list[index]
  const restored = { ...current }
  let changed = false
  for (const [field, expected] of Object.entries(optimisticPatch)) {
    if (!sameValue(current[field], expected)) continue
    if (Object.prototype.hasOwnProperty.call(snapshot.task, field)) {
      const value = clone(snapshot.task[field])
      if (!sameValue(current[field], value)) {
        restored[field] = value
        changed = true
      }
    } else if (Object.prototype.hasOwnProperty.call(restored, field)) {
      delete restored[field]
      changed = true
    }
  }
  if (!changed) return list
  const next = list.slice()
  next[index] = restored
  return next
}

export function rollbackSnapshots(tasks, snapshots) {
  if (!Array.isArray(snapshots)) {
    const list = asArray(tasks)
    return list === tasks ? tasks : list
  }
  let next = tasks
  for (const snap of snapshots) {
    next = rollbackSnapshot(next, snap)
  }
  return next
}
