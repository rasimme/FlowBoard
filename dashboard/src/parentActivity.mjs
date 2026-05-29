function isActiveClaim(task) {
  if (!task?.agent) return false;
  if (!task.claimedAt) return false;
  if (task.status === 'done' || task.status === 'archived' || task.completedAt) return false;
  return true;
}

export const CLAIM_PULSE_MS = 2400;

export function getSyncedPulseDelayMs(now = Date.now(), origin = 0) {
  const elapsed = now - origin;
  if (!Number.isFinite(elapsed)) return 0;
  const phase = ((now % CLAIM_PULSE_MS) + CLAIM_PULSE_MS) % CLAIM_PULSE_MS;
  const claimPhase = ((elapsed % CLAIM_PULSE_MS) + CLAIM_PULSE_MS) % CLAIM_PULSE_MS;
  if (origin > 0) return claimPhase === 0 ? 0 : -claimPhase;
  if (phase === 0) return 0;
  return -phase;
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
      pulseDelayMs: getSyncedPulseDelayMs(Date.now(), Date.parse(task.claimedAt || '')),
    });
    if (claims.length >= limit) break;
  }

  return claims;
}
