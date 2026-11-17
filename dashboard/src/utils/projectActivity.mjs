// T-529 (ADR-0044): client helpers for the server-derived `project.activity`
// object ({ active, lastActivityAt, claims, sessions, agents }). The UI only
// reads it; the derivation lives in dashboard/project-activity.js.

/**
 * T-529 (ADR-0044): the active project with the most recent activity, read
 * from the server-derived `project.activity`. Ties keep list order. Mirrors
 * `mostRecentActiveProject` in dashboard/project-activity.js (the server-side
 * snapshot selector).
 */
export function mostRecentActiveProject(projects = []) {
  let best = null;
  let bestMs = -Infinity;
  for (const project of projects) {
    const activity = project?.activity;
    if (!project?.name || project.archived || !activity?.active) continue;
    const ms = Date.parse(activity.lastActivityAt || '');
    const value = Number.isNaN(ms) ? -Infinity : ms;
    if (best === null || value > bestMs) {
      best = project.name;
      bestMs = value;
    }
  }
  return best;
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/**
 * Short label for the sidebar activity dot, e.g. "Active: 2 claims, 1 session".
 * Null when the project is not active (no dot).
 */
export function projectActivityLabel(project) {
  const activity = project?.activity;
  if (!activity?.active || project?.archived) return null;
  const parts = [];
  if (activity.claims > 0) parts.push(plural(activity.claims, 'claim'));
  if (activity.sessions > 0) parts.push(plural(activity.sessions, 'session'));
  return parts.length ? `Active: ${parts.join(', ')}` : 'Active';
}
