/**
 * Grouping for the "Tasks needing me" view (T-487-8).
 *
 * The backend decides *what* needs the operator (`tasks.needing-me` in
 * openclaw/contract.js); this module only decides how the rail reads. It keeps
 * the SPA's two answers to "what needs me?" apart, because they ask different
 * things of the human:
 *
 *  - **Needs approval** — the `review` lane, FlowBoard's approve gate. An agent
 *    is finished and waiting for a decision (the SPA's `approvals` widget).
 *  - **Blocked or stuck** — canonical `workState: blocked` (ADR-0031) and the
 *    live stall detection. Nobody is waiting for a decision; the work stopped.
 *
 * Pure, DOM-free and dependency-free so it is unit-tested directly
 * (dashboard/test-control-ui-lib.js).
 */

export const NEEDS_ME_GROUPS = [
  { id: 'review', label: 'Needs approval', reasons: ['review'] },
  { id: 'attention', label: 'Blocked or stuck', reasons: ['blocked', 'stuck'] },
];

/**
 * Split a `tasks.needing-me` answer into the rail's groups, preserving the
 * order the backend already sorted them into. Unknown reasons — a newer server
 * against an older bundle — are dropped rather than rendered in a lane whose
 * meaning they may not share.
 */
export function groupNeedsMe(items) {
  const rows = Array.isArray(items) ? items : [];
  return NEEDS_ME_GROUPS.map((group) => ({
    id: group.id,
    label: group.label,
    items: rows.filter((item) => item && group.reasons.includes(item.reason)),
  }));
}

/** Total rows the rail will render; drives the badge and the empty state. */
export function countNeedsMe(items) {
  return groupNeedsMe(items).reduce((total, group) => total + group.items.length, 0);
}

/** The short badge on a row: the precise reason, not the group. */
export function reasonLabel(item) {
  if (!item) return '';
  if (item.reason === 'review') return 'review';
  if (item.reason === 'blocked') return 'blocked';
  return 'stuck';
}

/** One line of evidence under the title, without repeating the badge. */
export function describeNeedsMe(item) {
  if (!item) return '';
  const parts = [];
  if (item.note) parts.push(item.note);
  if (item.agent) parts.push(`@${item.agent}`);
  // The lifecycle status is only worth a line when it says something the
  // reason badge did not — a `review` row does not need "review" twice.
  if (!parts.length && item.status && item.status !== reasonLabel(item)) parts.push(item.status);
  return parts.join(' · ');
}
