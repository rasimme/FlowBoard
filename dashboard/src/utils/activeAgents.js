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

/**
 * T-455-3: agents eligible for the DetailPanel's Route popover.
 *
 * DetailPanel.jsx used to render every row from `/api/agents` unfiltered —
 * on the live instance that is 1091 rows, almost all idle registrations
 * from months-old one-off subagents. The system already has an idle
 * threshold that decides exactly this question:
 * `AGENT_IDLE_TTL_HOURS` (flowboard-metadata.js), enforced by
 * `isAgentIdleExpired` — idle longer than the TTL AND no live claim. Rather
 * than duplicate that number (and drift the moment
 * `FLOWBOARD_AGENT_IDLE_TTL_HOURS` changes), this filters on the
 * threshold's observable *effect*: auto-deactivation nulls `active_project`
 * once an agent trips it. So "routable" mirrors `isAgentIdleExpired`'s own
 * guard clauses — an agent stays eligible when `active_project` is set, or
 * it holds a currently-claimed task whose lease has not expired (mirrors
 * the backend's `countLiveClaims`: a claim with no lease is conservatively
 * treated as live).
 *
 * `tasks` only needs to cover the currently loaded project — that is all
 * DetailPanel has in `state`. An agent live-claiming in a *different*
 * project will in the ordinary flow also carry `active_project` for that
 * project (set by the same activation call that produced the claim), so
 * the first branch still catches it. The one gap this leaves is an agent
 * that claimed a task without ever activating a project — the same edge
 * case the backend's own idle-expiry already tolerates (a live claim alone
 * protects it from being cleared).
 */
export function isRoutableAgent(agent, tasks = [], now = Date.now()) {
  if (activeProject(agent) != null) return true;
  const slug = canonicalAgentSlug(agent);
  if (!slug) return false;
  return (Array.isArray(tasks) ? tasks : []).some((task) => {
    if (canonicalAgentSlug(task?.agent) !== slug) return false;
    if (!isActivelyClaimed(task)) return false;
    return getLeaseHealth(task, now) !== LEASE_HEALTH.EXPIRED;
  });
}

/**
 * Route popover's agent list: `isRoutableAgent`-filtered, with agents whose
 * `active_project` matches the currently viewed project sorted first (spec:
 * "Agenten mit active_project === aktuelles Projekt zuerst"). `/api/agents`
 * is already alphabetical by agent_id (flowboard-metadata.js's
 * `ORDER BY agent_id`), and Array#sort is stable, so both the "active
 * here" group and the rest keep that alphabetical order.
 */
export function buildRoutableAgentRows({ agents = [], tasks = [], viewedProject = null, now = Date.now() } = {}) {
  const list = Array.isArray(agents) ? agents : [];
  const routable = list.filter((agent) => isRoutableAgent(agent, tasks, now));
  return routable.sort((a, b) => {
    const aHere = viewedProject != null && activeProject(a) === viewedProject ? 0 : 1;
    const bHere = viewedProject != null && activeProject(b) === viewedProject ? 0 : 1;
    return aHere - bHere;
  });
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

export const ACTIVE_AGENT_LEASE_HEALTH_LABELS = {
  [LEASE_HEALTH.CURRENT]: 'Current',
  [LEASE_HEALTH.STALE]: 'Stale',
  [LEASE_HEALTH.EXPIRED]: 'Expired',
};

export function activeAgentLeaseHealthLabel(health) {
  return ACTIVE_AGENT_LEASE_HEALTH_LABELS[health] || 'Unknown';
}

/**
 * T-453: 0-100 progress for a claim row's mini progress bar.
 *
 * `task.progress` is the checkpoint-driven subtask tally the API already
 * computes ({ done, inProgress, total }, see dashboardApi.js's schema) — not
 * a literal percentage field. `done / total` is the percentage that tally
 * implies. review/done tasks read as complete even without a progress
 * object; everything else without usable counts renders an empty bar rather
 * than being hidden, so every popover row keeps the same 3-column shape.
 */
export function activeAgentTaskProgress(task) {
  if (!task) return 0;
  if (task.status === 'review' || task.status === 'done') return 100;
  const progress = task.progress;
  if (progress && typeof progress === 'object' && Number.isFinite(progress.total) && progress.total > 0) {
    const done = Number.isFinite(progress.done) ? progress.done : 0;
    return Math.max(0, Math.min(100, Math.round((done / progress.total) * 100)));
  }
  return 0;
}
