// T-459: the claim rule lives in exactly one place — isValidActiveClaim in
// utils/activeAgents.js, the same predicate the agents bar, the overview
// widgets and the Kanban card use.
//
// This file used to carry its own third copy. It was never wrong enough to
// notice, only weaker: it missed the `archived` boolean and left `trashedAt`
// to its caller. That is precisely the shape of the T-457 bug, where four
// tasks of work on this rule went past a second copy until an archived task
// showed up as an active claim on the board. A rule that is almost the same
// in two places drifts; a rule in one place cannot.
import { isValidActiveClaim } from './utils/activeAgents.js';

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
    // No separate archived/trashed skip: isValidActiveClaim covers both, and
    // half-restating a rule beside the rule is how the copies started.
    if (!isValidActiveClaim(task)) continue;
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
