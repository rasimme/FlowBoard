/**
 * Format a project slug as a display name.
 * Uses displayName from project data if available, otherwise title-cases the slug.
 */
export function formatDisplayName(name, projects) {
  const proj = projects?.find(p => p.name === name);
  if (proj?.displayName) return proj.displayName;
  return name.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/**
 * True when a task is currently *actively* claimed by an agent.
 *
 * Why both fields: HZL-core preserves `agent` past release/done as historical
 * attribution (see hzl-core projections/tasks-current.js — "PRESERVE agent"
 * comment), so `agent` alone does NOT mean "currently claimed". `claimedAt`
 * is the active-claim timestamp; it is cleared on release/auto-release.
 */
export function isActivelyClaimed(task) {
  if (!task?.agent) return false;
  if (!task.claimedAt) return false;
  if (task.status === 'done' || task.completedAt) return false;
  return true;
}

/**
 * Tooltip text for an AgentChip on a task. Distinguishes active claim from
 * historical ownership (e.g. a done task surfaces who completed it).
 */
export function ownerLabel(task) {
  const name = task?.agent;
  if (!name) return '';
  if (isActivelyClaimed(task)) return `Claimed by ${name}`;
  if (task.status === 'done' || task.completedAt) return `Done by ${name}`;
  return `Last worked by ${name}`;
}
