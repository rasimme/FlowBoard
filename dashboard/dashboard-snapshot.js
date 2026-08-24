'use strict';

/**
 * Build the dashboard's read model in-process (T-445).
 *
 * The HTTP endpoint deliberately uses this small dependency-injected module so
 * that a snapshot cannot accidentally turn into four loopback HTTP requests.
 * Each section is isolated: a broken optional/read model section is reported
 * as data in `sections`, while the response remains a valid versioned envelope.
 */

const SNAPSHOT_VERSION = 1;
const SECTION_NAMES = ['projects', 'agents', 'status', 'tasks'];

function safeSectionError() {
  return {
    code: 'SECTION_UNAVAILABLE',
    message: 'Dashboard snapshot section unavailable',
  };
}

function readSection(fn, validate) {
  try {
    const data = fn();
    if (validate) validate(data);
    return { ok: true, data };
  } catch {
    return { ok: false, error: safeSectionError() };
  }
}

function requireArray(value) {
  if (!Array.isArray(value)) throw new TypeError('snapshot section must return an array');
}

function requireStatus(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (value.agentId !== null && typeof value.agentId !== 'string')
    || (value.activeProject !== null && typeof value.activeProject !== 'string')
    || typeof value.contextReady !== 'boolean') {
    throw new TypeError('snapshot status section has an invalid shape');
  }
}

function buildDashboardSnapshot({
  agentId = null,
  requestedProject = null,
  now = () => Date.now(),
  listProjects,
  listAgents,
  getStatus,
  listTasks,
}) {
  if (typeof listProjects !== 'function' || typeof listAgents !== 'function'
    || typeof getStatus !== 'function' || typeof listTasks !== 'function') {
    throw new TypeError('dashboard snapshot dependencies are incomplete');
  }

  const sections = {
    projects: readSection(listProjects, requireArray),
    agents: readSection(listAgents, requireArray),
    status: readSection(() => getStatus(agentId), requireStatus),
  };

  const status = sections.status.ok ? sections.status.data : null;
  const activeProject = status?.activeProject || null;
  const projectHint = typeof requestedProject === 'string' && requestedProject.trim()
    ? requestedProject.trim()
    : null;
  const projects = sections.projects.ok ? sections.projects.data : [];
  const agents = sections.agents.ok ? sections.agents.data : [];
  const projectNames = new Set(projects.map(project => project?.name).filter(Boolean));
  const activeAgentProject = agents.find(agent => agent?.active_project
    && projectNames.has(agent.active_project))?.active_project || null;
  // Match the legacy selector: preserve an explicit view, then the caller's
  // active project, then another agent's active project, then the first project.
  const viewedProject = (projectHint && projectNames.has(projectHint) ? projectHint : null)
    || (activeProject && projectNames.has(activeProject) ? activeProject : null)
    || activeAgentProject
    || projects.find(project => project?.name)?.name
    || null;

  sections.tasks = !sections.projects.ok
    ? { ok: false, error: safeSectionError() }
    : (viewedProject
      ? readSection(() => listTasks(viewedProject), requireArray)
      : { ok: true, data: [] });

  // Keep the top-level fields intentionally boring for consumers that only
  // need a complete snapshot. A failed section is never represented as an
  // empty success: callers inspect `sections` before committing these values.
  const tasks = sections.tasks.ok ? sections.tasks.data : [];
  const snapshotStatus = sections.status.ok ? sections.status.data : null;
  const data = { projects, agents, status: snapshotStatus, activeProject, viewedProject, tasks };

  return {
    ok: true,
    version: SNAPSHOT_VERSION,
    generatedAt: new Date(now()).toISOString(),
    sections,
    ...data,
  };
}

module.exports = {
  SNAPSHOT_VERSION,
  SECTION_NAMES,
  buildDashboardSnapshot,
};
