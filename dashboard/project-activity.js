'use strict';

/**
 * T-529 (ADR-0044): derive per-project activity from live claims and recent
 * project bindings.
 *
 * A project is active when at least one of these holds:
 *   1. an agent holds a live claim there: task `in-progress`, `agent` and
 *      `claimedAt` set, lease not expired (a claim without a lease counts as
 *      live, the same rule as `countLiveClaims` and the claim gate);
 *   2. a session binding (`flowboard_session_projects`) or a legacy agent-wide
 *      binding (`flowboard_agents.active_project`) points at the project and
 *      was seen within the activity window.
 *
 * Archived projects are never active. The function is pure: callers pass the
 * cached claims and the two binding tables, so a request never scans the
 * event store. Only the `active` booleans depend on `nowMs`; every other field
 * is a plain projection of stored timestamps, which keeps the dashboard
 * snapshot ETag stable between polls while nothing changes.
 */

const DEFAULT_ACTIVITY_WINDOW_MINUTES = 30;

/** Parse FLOWBOARD_PROJECT_ACTIVITY_WINDOW_MINUTES; invalid → default. */
function activityWindowMinutes(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_ACTIVITY_WINDOW_MINUTES;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_ACTIVITY_WINDOW_MINUTES;
}

function inactiveActivity() {
  return { active: false, lastActivityAt: null, claims: 0, sessions: 0, agents: [] };
}

function parseMs(value) {
  if (!value) return NaN;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? NaN : ms;
}

function isLiveClaim(claim, nowMs) {
  if (!claim || claim.status !== 'in-progress') return false;
  if (!claim.agent || !claim.claimedAt) return false;
  if (claim.trashedAt) return false;
  if (!claim.leaseUntil) return true;
  const leaseMs = parseMs(claim.leaseUntil);
  return Number.isNaN(leaseMs) || leaseMs >= nowMs;
}

function isFreshBinding(lastSeen, nowMs, windowMs) {
  const seenMs = parseMs(lastSeen);
  if (Number.isNaN(seenMs)) return false;
  return nowMs - seenMs <= windowMs;
}

/**
 * @param {object} input
 * @param {Array<{name:string, archived?:boolean}>} input.projects
 * @param {Array<{project, agent, status, claimedAt, leaseUntil, lastCheckpointAt, trashedAt}>} input.claims
 * @param {Array<{agent_id, session_key, active_project, last_seen}>} input.sessionBindings
 * @param {Array<{agent_id, active_project, last_seen}>} input.agents  legacy agent-wide rows
 * @param {number} input.nowMs
 * @param {number} input.windowMinutes
 * @returns {Map<string, {active, lastActivityAt, claims, sessions, agents}>}
 */
function deriveProjectActivity({
  projects = [],
  claims = [],
  sessionBindings = [],
  agents = [],
  nowMs = Date.now(),
  windowMinutes = DEFAULT_ACTIVITY_WINDOW_MINUTES,
} = {}) {
  const windowMs = windowMinutes * 60 * 1000;
  const eligible = new Set();
  for (const project of projects) {
    if (project?.name && !project.archived) eligible.add(project.name);
  }

  const acc = new Map();
  const entry = (name) => {
    let e = acc.get(name);
    if (!e) {
      e = { claims: 0, sessions: 0, agents: new Set(), lastMs: NaN };
      acc.set(name, e);
    }
    return e;
  };
  const bump = (e, ...values) => {
    for (const value of values) {
      const ms = parseMs(value);
      if (!Number.isNaN(ms) && (Number.isNaN(e.lastMs) || ms > e.lastMs)) e.lastMs = ms;
    }
  };

  for (const claim of claims) {
    if (!eligible.has(claim?.project) || !isLiveClaim(claim, nowMs)) continue;
    const e = entry(claim.project);
    e.claims++;
    e.agents.add(String(claim.agent));
    bump(e, claim.claimedAt, claim.lastCheckpointAt);
  }

  for (const binding of sessionBindings) {
    const project = binding?.active_project;
    if (!eligible.has(project) || !isFreshBinding(binding.last_seen, nowMs, windowMs)) continue;
    const e = entry(project);
    e.sessions++;
    if (binding.agent_id) e.agents.add(String(binding.agent_id));
    bump(e, binding.last_seen);
  }

  // Legacy agent-wide binding (pre-ADR-0039 and explicit agent-scope
  // activations). It counts as one binding of that agent.
  for (const agent of agents) {
    const project = agent?.active_project;
    if (!eligible.has(project) || !isFreshBinding(agent.last_seen, nowMs, windowMs)) continue;
    const e = entry(project);
    e.sessions++;
    if (agent.agent_id) e.agents.add(String(agent.agent_id));
    bump(e, agent.last_seen);
  }

  const result = new Map();
  for (const project of projects) {
    if (!project?.name) continue;
    const e = acc.get(project.name);
    if (!e) {
      result.set(project.name, inactiveActivity());
      continue;
    }
    result.set(project.name, {
      active: true,
      lastActivityAt: Number.isNaN(e.lastMs) ? null : new Date(e.lastMs).toISOString(),
      claims: e.claims,
      sessions: e.sessions,
      agents: [...e.agents].sort(),
    });
  }
  return result;
}

/**
 * The active project with the most recent activity, or null. Ties break by
 * the order of `projects`, so the answer is deterministic.
 */
function mostRecentActiveProject(projects = []) {
  let best = null;
  let bestMs = -Infinity;
  for (const project of projects) {
    const activity = project?.activity;
    if (!project?.name || project.archived || !activity?.active) continue;
    const ms = parseMs(activity.lastActivityAt);
    const value = Number.isNaN(ms) ? -Infinity : ms;
    if (best === null || value > bestMs) {
      best = project.name;
      bestMs = value;
    }
  }
  return best;
}

module.exports = {
  DEFAULT_ACTIVITY_WINDOW_MINUTES,
  activityWindowMinutes,
  deriveProjectActivity,
  inactiveActivity,
  isLiveClaim,
  mostRecentActiveProject,
};
