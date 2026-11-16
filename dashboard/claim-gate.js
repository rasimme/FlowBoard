'use strict';

/**
 * T-526: an agent may checkpoint or complete only a task it has claimed.
 *
 * The gate is applied by the agent-facing routes, not by hzl-service: internal
 * workflows (handoff writes a checkpoint on the unclaimed follow-on, delegate,
 * migrations, importers) call the service directly and must keep working.
 *
 * A claim is live while `claimedAt` is set. Release, complete and a review/done
 * status change clear it; lease expiry does not. So:
 * - a live claim of the caller passes, even with an expired lease (the
 *   checkpoint renews it, as before);
 * - a live claim of another agent passes on to the service, which keeps
 *   answering NOT_OWNER;
 * - the caller's own finished task (review/done, `agent` kept as history)
 *   passes, so a closing checkpoint after complete still works;
 * - a parent task (one with subtasks) passes: it cannot be claimed, its
 *   status is aggregated from its subtasks, and orchestrators checkpoint it
 *   (production locks, stage notes). The service's owner check still applies;
 * - everything else has no claim to work under: NOT_CLAIMED.
 *
 * The refusal teaches the next call and echoes a rejected checkpoint so the
 * agent can resend it unchanged after claiming.
 */

const ACTIONS = Object.freeze(['checkpoint', 'complete']);

function isClaimedFor(task, agent) {
  if (!task) return true; // nothing to gate; the service answers 404
  if (task.agent && task.claimedAt) return true;
  if (Array.isArray(task.subtaskIds) && task.subtaskIds.length > 0) return true;
  return task.agent === agent && (task.status === 'review' || task.status === 'done');
}

function notClaimedRefusal(task, { project, taskId, agent, action, sessionKey = null, message, progress } = {}) {
  if (!ACTIONS.includes(action)) throw new Error(`Unknown claim-gate action: ${action}`);
  if (isClaimedFor(task, agent)) return null;
  const claimBody = { agent, ...(sessionKey ? { sessionKey } : {}) };
  const body = {
    error: `Task ${taskId} is not claimed by "${agent}"; claim it before you ${action} it.`,
    code: 'NOT_CLAIMED',
    hint: {
      method: 'POST',
      path: `/api/projects/${project}/tasks/${taskId}/claim`,
      body: claimBody,
      alternative: { method: 'POST', path: '/api/workflows/start', body: { ...claimBody, project } },
    },
    rules: `/api/projects/${project}/rules/agent-bridge`,
  };
  if (action === 'checkpoint') body.rejected = { message: message ?? null, progress: progress ?? null };
  return body;
}

module.exports = { ACTIONS, isClaimedFor, notClaimedRefusal };
