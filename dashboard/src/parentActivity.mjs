function isActiveClaim(task) {
  if (!task?.agent) return false;
  if (!task.claimedAt) return false;
  if (task.status === 'done' || task.status === 'archived' || task.completedAt) return false;
  return true;
}

export function getActiveSubtaskClaims(parentTask, allTasks, limit = 3) {
  if (!parentTask?.id || parentTask.parentId) return [];
  const seenAgents = new Set();
  const claims = [];

  for (const task of allTasks || []) {
    if (task?.parentId !== parentTask.id) continue;
    if (task.trashedAt || task.status === 'archived') continue;
    if (!isActiveClaim(task)) continue;
    if (seenAgents.has(task.agent)) continue;

    seenAgents.add(task.agent);
    claims.push({
      agent: task.agent,
      taskId: task.id,
      title: task.title || 'Untitled subtask',
      claimedAt: task.claimedAt || null,
      leaseUntil: task.leaseUntil || null,
    });
    if (claims.length >= limit) break;
  }

  return claims;
}
