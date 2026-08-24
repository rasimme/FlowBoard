import { isActivelyClaimed } from './formatting.js';
import {
  aggregateLeaseHealth,
  getLeaseHealth,
  LEASE_HEALTH,
  normalizeStaleThresholdMinutes,
} from './leaseHealth.js';

/**
 * Return whether a task represents a claim that can be shown in the
 * project-local Active Agents bar.
 *
 * `agent` is intentionally not enough here: HZL keeps it as historical
 * attribution after a release or completion. Lease validity is deliberately
 * not part of this display predicate: expired and malformed leases remain
 * visible so the bar can surface their health and help an operator recover.
 */
export function isValidActiveClaim(task) {
  if (!isActivelyClaimed(task)) return false;
  if (task.status === 'archived' || task.archived || task.trashedAt) return false;
  return true;
}

export function taskId(task) {
  const id = task?.id ?? task?.taskId ?? task?.task_id;
  return id == null ? '' : String(id);
}

export function canonicalAgentSlug(agent) {
  if (typeof agent === 'string' || typeof agent === 'number') return String(agent).trim();
  const id = agent?.agent_id ?? agent?.agentId ?? agent?.id ?? agent?.slug;
  return id == null ? '' : String(id).trim();
}

function activeProject(agent) {
  return agent?.active_project ?? agent?.activeProject ?? null;
}

/**
 * Group displayable claims by the canonical owner slug without losing a
 * second claim for the same owner. The first occurrence of a task id wins:
 * this mirrors the loaded project payload and makes duplicate API rows
 * harmless and deterministic.
 */
export function groupActiveClaims(tasks = []) {
  const grouped = new Map();
  const seenTaskIds = new Set();

  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (!isValidActiveClaim(task)) continue;
    const id = taskId(task);
    const dedupeKey = id ? `id:${id}` : task;
    if (seenTaskIds.has(dedupeKey)) continue;
    seenTaskIds.add(dedupeKey);

    const owner = canonicalAgentSlug(task.agent);
    if (!owner) continue;
    if (!grouped.has(owner)) grouped.set(owner, []);
    grouped.get(owner).push(task);
  }

  return grouped;
}

/**
 * Build the render model for ActiveAgentsBar.
 *
 * `/api/agents` is authoritative for known-agent order. Displayable claim owners
 * are appended even when their agent row is absent or points at another
 * project: a task claim is the stronger signal that work is active here, and
 * the owner slug is a safe display fallback in that partial-data case.
 */
export function buildActiveAgentRows({
  agents = [],
  tasks = [],
  viewedProject,
  now = Date.now(),
  staleThresholdMinutes,
} = {}) {
  if (!viewedProject) return [];

  const claimsByAgent = groupActiveClaims(tasks, now);
  const leaseHealthOptions = { staleThresholdMinutes };
  const rows = [];
  const seenAgents = new Set();
  const knownAgents = Array.isArray(agents) ? agents : [];

  for (const agent of knownAgents) {
    const slug = canonicalAgentSlug(agent);
    if (!slug || seenAgents.has(slug)) continue;
    const claims = claimsByAgent.get(slug) || [];
    if (activeProject(agent) !== viewedProject && claims.length === 0) continue;
    seenAgents.add(slug);
    rows.push({
      agentId: slug,
      claims,
      agent,
      leaseHealth: claims.length ? aggregateLeaseHealth(claims, now, leaseHealthOptions) : null,
    });
  }

  // Unknown owners have no /api/agents position. Sort this fallback set by
  // slug so partial/replayed payloads do not make the bar shuffle.
  const unknown = [...claimsByAgent.keys()]
    .filter(slug => !seenAgents.has(slug))
    .sort((a, b) => a.localeCompare(b));
  for (const slug of unknown) {
    seenAgents.add(slug);
    const claims = claimsByAgent.get(slug) || [];
    rows.push({
      agentId: slug,
      claims,
      agent: null,
      leaseHealth: claims.length ? aggregateLeaseHealth(claims, now, leaseHealthOptions) : null,
    });
  }

  return rows;
}

export {
  aggregateLeaseHealth,
  getLeaseHealth,
  LEASE_HEALTH,
  normalizeStaleThresholdMinutes,
};

export const ACTIVE_AGENT_STATUS_LABELS = {
  backlog: 'Backlog',
  open: 'Open',
  'in-progress': 'In progress',
  review: 'Review',
  done: 'Done',
  archived: 'Archived',
};

export function activeAgentStatusLabel(status) {
  return ACTIVE_AGENT_STATUS_LABELS[status] || (status ? String(status) : 'Unknown');
}
