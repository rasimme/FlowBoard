'use strict';

/**
 * T-186 — Status transition guard for PUT /api/projects/:name/tasks/:id.
 *
 * Generic PUT is meant for metadata edits (title, priority, blocked, etc.)
 * and most non-sensitive status changes. The transitions below are
 * sensitive because they bypass first-class workflow/review semantics:
 *
 *   - review -> done   : finalising review work; must go via POST /approve.
 *   - done   -> open   : reopening already-accepted work.
 *   - done   -> in-progress, review, backlog : ditto.
 *
 * Notable transitions that are intentionally NOT sensitive:
 *
 *   - archived -> done : "restore from archive" — existing UI flow.
 *   - done -> archived : terminal cleanup — existing UI flow.
 *   - in-progress -> done via PUT : would bypass /complete, but blocking
 *     this would break drag/drop in the kanban; left soft for now and
 *     documented in the T-186 spec.
 */

const REOPEN_TARGETS = new Set(['open', 'in-progress', 'review', 'backlog']);

function isSensitiveTransition(fromStatus, toStatus) {
  if (!fromStatus || !toStatus) return false;
  if (fromStatus === toStatus) return false;

  if (fromStatus === 'review' && toStatus === 'done') return true;
  if (fromStatus === 'done' && REOPEN_TARGETS.has(toStatus)) return true;

  return false;
}

function transitionErrorMessage(fromStatus, toStatus) {
  if (fromStatus === 'review' && toStatus === 'done') {
    return 'Use POST /api/projects/:project/tasks/:id/approve for review -> done';
  }
  if (fromStatus === 'done' && REOPEN_TARGETS.has(toStatus)) {
    return `Refusing to silently reopen a completed task (done -> ${toStatus}). ` +
      `Pass adminOverride=true in the PUT body together with a reason if you really mean this.`;
  }
  return `Refusing sensitive status transition ${fromStatus} -> ${toStatus}.`;
}

function adminOverrideReasonError(reason) {
  if (reason && String(reason).trim()) return null;
  return 'adminOverride requires a non-empty reason for sensitive status transitions';
}

module.exports = {
  adminOverrideReasonError,
  isSensitiveTransition,
  transitionErrorMessage,
};
