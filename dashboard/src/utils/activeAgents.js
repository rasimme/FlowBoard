import { isActivelyClaimed } from './formatting.js';

/**
 * Return whether a task represents a claim that can be shown in the
 * project-local Active Agents bar.
 *
 * `agent` is intentionally not enough here: HZL keeps it as historical
 * attribution after a release or completion. A missing lease is accepted for
 * compatibility with older task payloads, while a supplied malformed or
 * expired lease is never treated as live.
 */
export function isValidActiveClaim(task, now = Date.now()) {
  if (!isActivelyClaimed(task)) return false;
  if (task.status === 'archived' || task.archived || task.trashedAt) return false;

  const leaseUntil = task.leaseUntil ?? task.lease_until;
  if (leaseUntil == null) return true;
  if (typeof leaseUntil !== 'string' || leaseUntil.trim() === '') return false;

  const leaseMs = Date.parse(leaseUntil);
  return Number.isFinite(leaseMs) && leaseMs > now;
}

export function taskId(task) {
  const id = task?.id ?? task?.taskId ?? task?.task_id;
  return id == null ? '' : String(id);
}

function agentSlug(agent) {
  const id = agent?.agent_id ?? agent?.agentId ?? agent?.id ?? agent?.slug;
  return id == null ? '' : String(id);
}

function activeProject(agent) {
  return agent?.active_project ?? agent?.activeProject ?? null;
}

/**
 * Group valid claims by the owner slug without losing a second claim for the
 * same owner. The first occurrence of a task id wins: this mirrors the loaded
 * project payload and makes duplicate API rows harmless and deterministic.
 */
export function groupActiveClaims(tasks = [], now = Date.now()) {
  const grouped = new Map();
  const seenTaskIds = new Set();

  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (!isValidActiveClaim(task, now)) continue;
    const id = taskId(task);
    const dedupeKey = id ? `id:${id}` : task;
    if (seenTaskIds.has(dedupeKey)) continue;
    seenTaskIds.add(dedupeKey);

    const owner = String(task.agent);
    if (!grouped.has(owner)) grouped.set(owner, []);
    grouped.get(owner).push(task);
  }

  return grouped;
}

/**
 * Build the render model for ActiveAgentsBar.
 *
 * `/api/agents` is authoritative for known-agent order. Valid claim owners
 * are appended even when their agent row is absent or points at another
 * project: a task claim is the stronger signal that work is active here, and
 * the owner slug is a safe display fallback in that partial-data case.
 */
export function buildActiveAgentRows({ agents = [], tasks = [], viewedProject, now = Date.now() } = {}) {
  if (!viewedProject) return [];

  const claimsByAgent = groupActiveClaims(tasks, now);
  const rows = [];
  const seenAgents = new Set();
  const knownAgents = Array.isArray(agents) ? agents : [];

  for (const agent of knownAgents) {
    const slug = agentSlug(agent);
    if (!slug || seenAgents.has(slug)) continue;
    const claims = claimsByAgent.get(slug) || [];
    if (activeProject(agent) !== viewedProject && claims.length === 0) continue;
    seenAgents.add(slug);
    rows.push({ agentId: slug, claims, agent });
  }

  // Unknown owners have no /api/agents position. Sort this fallback set by
  // slug so partial/replayed payloads do not make the bar shuffle.
  const unknown = [...claimsByAgent.keys()]
    .filter(slug => !seenAgents.has(slug))
    .sort((a, b) => a.localeCompare(b));
  for (const slug of unknown) {
    seenAgents.add(slug);
    rows.push({ agentId: slug, claims: claimsByAgent.get(slug) || [], agent: null });
  }

  return rows;
}

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
