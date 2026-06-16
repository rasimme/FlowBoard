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
