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

function readSection(fn) {
  try {
    return { ok: true, data: fn() };
  } catch {
    return { ok: false, error: safeSectionError() };
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
    projects: readSection(listProjects),
    agents: readSection(listAgents),
    status: readSection(() => getStatus(agentId)),
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

  sections.tasks = viewedProject
    ? readSection(() => listTasks(viewedProject))
    : { ok: true, data: [] };

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
    snapshot: data,
  };
}

module.exports = {
  SNAPSHOT_VERSION,
  SECTION_NAMES,
  buildDashboardSnapshot,
};
