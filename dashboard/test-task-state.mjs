import assert from 'node:assert/strict'

const state = await import('./src/state/taskState.mjs')

// ---------- patchTask ----------

// 1. patchTask shallow-merges patch fields into the matching task.
{
  const tasks = [
    { id: 'A', status: 'pending', title: 'first' },
    { id: 'B', status: 'pending', title: 'second' },
  ]
  const next = state.patchTask(tasks, 'B', { status: 'doing', claimedBy: 'agent-1' })
  assert.deepEqual(next[0], { id: 'A', status: 'pending', title: 'first' }, 'A untouched')
  assert.deepEqual(next[1], { id: 'B', status: 'doing', title: 'second', claimedBy: 'agent-1' }, 'B receives patch')
  console.log('✅ patchTask applies shallow merge')
}

// 2. patchTask does not mutate the input array or the input task object.
{
  const taskA = { id: 'A', status: 'pending' }
  const taskB = { id: 'B', status: 'pending' }
  const tasks = [taskA, taskB]
  const next = state.patchTask(tasks, 'A', { status: 'doing' })
  assert.notEqual(next, tasks, 'returns a new array')
  assert.notEqual(next[0], taskA, 'patched task is a new object')
  assert.equal(next[1], taskB, 'untouched task identity preserved')
  assert.deepEqual(taskA, { id: 'A', status: 'pending' }, 'original task unchanged')
  assert.deepEqual(tasks.map(t => t.id), ['A', 'B'], 'original array unchanged')
  console.log('✅ patchTask preserves immutability')
}

// 3. patchTask is a no-op when the id is missing.
{
  const tasks = [{ id: 'A' }, { id: 'B' }]
  const next = state.patchTask(tasks, 'missing', { status: 'doing' })
  assert.equal(next, tasks, 'returns the same array reference on miss')
  console.log('✅ patchTask no-ops on missing id')
}

// 4. patchTask preserves ordering and patches in place.
{
  const tasks = [{ id: 'A' }, { id: 'B' }, { id: 'C' }]
  const next = state.patchTask(tasks, 'B', { status: 'done' })
  assert.deepEqual(next.map(t => t.id), ['A', 'B', 'C'], 'order preserved')
  console.log('✅ patchTask preserves order')
}

// ---------- upsertTask ----------

// 5. upsertTask replaces an existing task at the same position, shallow-merging fields.
{
  const tasks = [
    { id: 'A', status: 'pending', clientOnly: true },
    { id: 'B', status: 'pending' },
  ]
  const next = state.upsertTask(tasks, { id: 'A', status: 'done', completedAt: 'ts' })
  assert.deepEqual(next.map(t => t.id), ['A', 'B'], 'order preserved')
  assert.deepEqual(next[0], { id: 'A', status: 'done', clientOnly: true, completedAt: 'ts' }, 'shallow-merged with canonical winning')
  console.log('✅ upsertTask merges existing task')
}

// 6. upsertTask appends when the id is new (canonical task that did not exist locally yet).
{
  const tasks = [{ id: 'A' }]
  const next = state.upsertTask(tasks, { id: 'NEW', status: 'pending', title: 'fresh' })
  assert.deepEqual(next.map(t => t.id), ['A', 'NEW'], 'new task appended at end')
  assert.deepEqual(next[1], { id: 'NEW', status: 'pending', title: 'fresh' })
  console.log('✅ upsertTask appends new canonical task')
}

// 7. upsertTask is a no-op for nullish task input.
{
  const tasks = [{ id: 'A' }]
  assert.equal(state.upsertTask(tasks, null), tasks, 'null is a no-op')
  assert.equal(state.upsertTask(tasks, undefined), tasks, 'undefined is a no-op')
  assert.equal(state.upsertTask(tasks, {}), tasks, 'object without id is a no-op')
  console.log('✅ upsertTask no-ops on missing input')
}

// 8. upsertTask does not mutate the input array or input task.
{
  const taskA = { id: 'A', status: 'pending' }
  const tasks = [taskA]
  const incoming = { id: 'A', status: 'done' }
  const next = state.upsertTask(tasks, incoming)
  assert.notEqual(next, tasks, 'new array')
  assert.notEqual(next[0], taskA, 'new task object')
  assert.deepEqual(taskA, { id: 'A', status: 'pending' }, 'original task untouched')
  assert.deepEqual(incoming, { id: 'A', status: 'done' }, 'incoming task untouched')
  console.log('✅ upsertTask preserves immutability')
}

// ---------- mergeParentUpdated ----------

// 9. mergeParentUpdated shallow-merges parent fields when the parent exists.
{
  const tasks = [
    { id: 'P', status: 'pending', progress: { done: 0, total: 3 } },
    { id: 'C', parentId: 'P' },
  ]
  const next = state.mergeParentUpdated(tasks, { id: 'P', status: 'doing', progress: { done: 1, total: 3 } })
  assert.deepEqual(next[0], { id: 'P', status: 'doing', progress: { done: 1, total: 3 } })
  assert.equal(next[1], tasks[1], 'other tasks untouched')
  console.log('✅ mergeParentUpdated merges existing parent')
}

// 10. mergeParentUpdated is a no-op when the parent is not in the local list.
{
  const tasks = [{ id: 'A' }, { id: 'B' }]
  const next = state.mergeParentUpdated(tasks, { id: 'missing-parent', status: 'doing' })
  assert.equal(next, tasks, 'returns the same array reference')
  console.log('✅ mergeParentUpdated no-ops on missing parent')
}

// 11. mergeParentUpdated is a no-op for nullish input.
{
  const tasks = [{ id: 'A' }]
  assert.equal(state.mergeParentUpdated(tasks, null), tasks)
  assert.equal(state.mergeParentUpdated(tasks, undefined), tasks)
  assert.equal(state.mergeParentUpdated(tasks, {}), tasks)
  console.log('✅ mergeParentUpdated no-ops on nullish input')
}

// ---------- applyTaskResponse ----------

// 12. applyTaskResponse upserts response.task.
{
  const tasks = [
    { id: 'A', status: 'pending' },
    { id: 'B', status: 'pending' },
  ]
  const next = state.applyTaskResponse(tasks, { ok: true, task: { id: 'A', status: 'done' } })
  assert.deepEqual(next[0], { id: 'A', status: 'done' })
  assert.equal(next[1], tasks[1])
  console.log('✅ applyTaskResponse merges task')
}

// 13. applyTaskResponse merges parentUpdated alongside task.
{
  const tasks = [
    { id: 'P', status: 'pending', progress: { done: 0, total: 2 } },
    { id: 'C', parentId: 'P', status: 'pending' },
  ]
  const next = state.applyTaskResponse(tasks, {
    ok: true,
    task: { id: 'C', status: 'done', parentId: 'P' },
    parentUpdated: { id: 'P', status: 'doing', progress: { done: 1, total: 2 } },
  })
  const parent = next.find(t => t.id === 'P')
  const child = next.find(t => t.id === 'C')
  assert.equal(parent.status, 'doing', 'parent status merged')
  assert.deepEqual(parent.progress, { done: 1, total: 2 }, 'parent progress merged')
  assert.equal(child.status, 'done', 'child status merged')
  console.log('✅ applyTaskResponse handles task + parentUpdated')
}

// 14. applyTaskResponse appends a new canonical task even when local list lacks it.
{
  const tasks = [{ id: 'A' }]
  const next = state.applyTaskResponse(tasks, { ok: true, task: { id: 'NEW', status: 'pending' } })
  assert.deepEqual(next.map(t => t.id), ['A', 'NEW'])
  console.log('✅ applyTaskResponse appends new canonical')
}

// 15. applyTaskResponse is a no-op on responses without a task or parentUpdated.
{
  const tasks = [{ id: 'A' }]
  assert.equal(state.applyTaskResponse(tasks, { ok: true }), tasks, 'no task = no-op')
  assert.equal(state.applyTaskResponse(tasks, null), tasks, 'null response = no-op')
  assert.equal(state.applyTaskResponse(tasks, undefined), tasks, 'undefined response = no-op')
  console.log('✅ applyTaskResponse no-ops on empty response')
}

// 16. applyTaskResponse only merges parentUpdated when the parent exists locally.
{
  const tasks = [{ id: 'C', parentId: 'P' }]
  const next = state.applyTaskResponse(tasks, {
    task: { id: 'C', status: 'done', parentId: 'P' },
    parentUpdated: { id: 'P', status: 'doing' },
  })
  assert.deepEqual(next.map(t => t.id), ['C'], 'absent parent is not invented')
  console.log('✅ applyTaskResponse does not invent missing parent')
}

// ---------- snapshotTask / rollbackSnapshot ----------

// 17. snapshotTask deep-clones the matching task.
{
  const original = { id: 'A', status: 'pending', meta: { tag: 'x' } }
  const tasks = [original]
  const snap = state.snapshotTask(tasks, 'A')
  assert.equal(snap.id, 'A')
  assert.equal(snap.index, 0)
  assert.deepEqual(snap.task, original)
  assert.notEqual(snap.task, original, 'snapshot task is a clone')
  snap.task.status = 'mutated-snap'
  snap.task.meta.tag = 'mutated-meta'
  assert.equal(original.status, 'pending', 'mutating snapshot does not touch original')
  assert.equal(original.meta.tag, 'x', 'snapshot deep-cloned nested object')
  console.log('✅ snapshotTask deep-clones')
}

// 18. snapshotTask returns a snapshot with task: null when id is missing (used to rollback an optimistic create).
{
  const tasks = [{ id: 'A' }]
  const snap = state.snapshotTask(tasks, 'NEW')
  assert.deepEqual(snap, { id: 'NEW', index: -1, task: null })
  console.log('✅ snapshotTask marks absent ids')
}

// 19. snapshotTasks captures snapshots for multiple ids in order.
{
  const tasks = [{ id: 'A', x: 1 }, { id: 'B', x: 2 }, { id: 'C', x: 3 }]
  const snaps = state.snapshotTasks(tasks, ['B', 'missing', 'A'])
  assert.equal(snaps.length, 3)
  assert.equal(snaps[0].id, 'B')
  assert.equal(snaps[0].index, 1)
  assert.deepEqual(snaps[0].task, { id: 'B', x: 2 })
  assert.equal(snaps[1].id, 'missing')
  assert.equal(snaps[1].index, -1)
  assert.equal(snaps[1].task, null)
  assert.equal(snaps[2].id, 'A')
  assert.equal(snaps[2].index, 0)
  assert.deepEqual(snaps[2].task, { id: 'A', x: 1 })
  console.log('✅ snapshotTasks captures multiple ids')
}

// 20. rollbackSnapshot restores a previously snapshotted task at its current position.
{
  const tasks = [
    { id: 'A', status: 'pending' },
    { id: 'B', status: 'pending' },
  ]
  const snap = state.snapshotTask(tasks, 'B')
  // Apply an optimistic patch.
  const patched = state.patchTask(tasks, 'B', { status: 'doing' })
  assert.equal(patched[1].status, 'doing')
  // Now roll back.
  const rolled = state.rollbackSnapshot(patched, snap)
  assert.deepEqual(rolled.map(t => t.id), ['A', 'B'], 'order preserved')
  assert.deepEqual(rolled[1], { id: 'B', status: 'pending' }, 'rolled back to snapshot')
  console.log('✅ rollbackSnapshot restores task')
}

// 21. rollbackSnapshot restores the original position if a task moved during an optimistic update.
{
  const tasks = [
    { id: 'A', status: 'pending' },
    { id: 'B', status: 'pending' },
    { id: 'C', status: 'pending' },
  ]
  const snap = state.snapshotTask(tasks, 'B')
  const moved = [tasks[1], tasks[0], tasks[2]]
  const rolled = state.rollbackSnapshot(moved, snap)
  assert.deepEqual(rolled.map(t => t.id), ['A', 'B', 'C'], 'original position restored')
  assert.deepEqual(rolled[1], { id: 'B', status: 'pending' })
  console.log('✅ rollbackSnapshot restores original position')
}

// 22. rollbackSnapshot reinserts a removed existing task at its original position.
{
  const tasks = [
    { id: 'A', status: 'pending' },
    { id: 'B', status: 'pending' },
    { id: 'C', status: 'pending' },
  ]
  const snap = state.snapshotTask(tasks, 'B')
  const withoutB = [tasks[0], tasks[2]]
  const rolled = state.rollbackSnapshot(withoutB, snap)
  assert.deepEqual(rolled.map(t => t.id), ['A', 'B', 'C'], 'removed task reinserted at original position')
  console.log('✅ rollbackSnapshot reinserts removed task in place')
}

// 23. rollbackSnapshot removes a task that was optimistically created.
{
  const baseline = [{ id: 'A' }]
  const snap = state.snapshotTask(baseline, 'NEW') // task: null
  const withOptimistic = state.upsertTask(baseline, { id: 'NEW', status: 'pending' })
  assert.deepEqual(withOptimistic.map(t => t.id), ['A', 'NEW'])
  const rolled = state.rollbackSnapshot(withOptimistic, snap)
  assert.deepEqual(rolled.map(t => t.id), ['A'], 'optimistic task removed on rollback')
  console.log('✅ rollbackSnapshot removes optimistic creation')
}

// 24. rollbackSnapshot is a no-op for null/undefined snapshot.
{
  const tasks = [{ id: 'A' }]
  assert.equal(state.rollbackSnapshot(tasks, null), tasks)
  assert.equal(state.rollbackSnapshot(tasks, undefined), tasks)
  console.log('✅ rollbackSnapshot no-ops on missing snapshot')
}

// 25. rollbackSnapshots applies a list of snapshots.
{
  const original = [
    { id: 'A', status: 'pending' },
    { id: 'B', status: 'pending' },
  ]
  const snaps = state.snapshotTasks(original, ['A', 'B'])
  let next = state.patchTask(original, 'A', { status: 'doing' })
  next = state.patchTask(next, 'B', { status: 'done' })
  const rolled = state.rollbackSnapshots(next, snaps)
  assert.deepEqual(rolled, original, 'all snapshots restored')
  console.log('✅ rollbackSnapshots restores list')
}

// 26. patchTask returns the array unchanged when given a null/undefined patch.
{
  const tasks = [{ id: 'A', status: 'pending' }]
  assert.equal(state.patchTask(tasks, 'A', null), tasks)
  assert.equal(state.patchTask(tasks, 'A', undefined), tasks)
  console.log('✅ patchTask no-ops on null patch')
}

// 27. patchTask tolerates non-array input (returns []).
{
  assert.deepEqual(state.patchTask(null, 'A', { x: 1 }), [])
  assert.deepEqual(state.patchTask(undefined, 'A', { x: 1 }), [])
  console.log('✅ patchTask tolerates non-array input')
}

console.log('✅ all task-state tests passed')
