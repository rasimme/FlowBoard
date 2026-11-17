import { mostRecentActiveProject } from './projectActivity.mjs';

export { mostRecentActiveProject };

const AGENT_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function normalizeAgentId(value) {
  const id = String(value || '').trim().toLowerCase();
  if (!id || id.length > 64 || !AGENT_ID_RE.test(id)) return null;
  return id;
}

export function agentIdFromStartParam(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  const direct = normalizeAgentId(raw);
  if (direct) return direct;

  const match = raw.match(/(?:^|[?&_:,-])agent(?:id)?[=:_-]([a-z0-9-]+)/i);
  return normalizeAgentId(match?.[1]);
}

export function resolveDashboardAgentId({ urlSearch = '', telegramWebApp = null, authAgentId = null, storedAgentId = null } = {}) {
  return resolveDashboardAgentIdentity({ urlSearch, telegramWebApp, authAgentId, storedAgentId }).agentId;
}

export function resolveDashboardAgentIdentity({ urlSearch = '', telegramWebApp = null, authAgentId = null, storedAgentId = null } = {}) {
  const params = new URLSearchParams(urlSearch || '');
  // T-428-5: a server-confirmed auth identity is authoritative. Client-controlled
  // sources (Telegram start_param, URL params, local storage) cannot override it.
  const candidates = [
    ['auth', normalizeAgentId(authAgentId)],
    ['stored', normalizeAgentId(storedAgentId)],
    ['url', normalizeAgentId(params.get('agentId'))],
    ['url', normalizeAgentId(params.get('agent'))],
    ['telegram-start', agentIdFromStartParam(telegramWebApp?.initDataUnsafe?.start_param)],
  ];
  const found = candidates.find(([, agentId]) => agentId);
  return {
    agentId: found?.[1] || null,
    source: found?.[0] || null,
    chatBound: !!found && found[0] !== 'stored' && found[0] !== 'auth',
  };
}

/**
 * Which project the viewer shows. An explicit view (the user's own choice,
 * kept across polls) wins; on a fresh load the most recently active project
 * wins; then the caller's active project, another agent's active project, and
 * finally the first project.
 */
export function selectViewedProject({ projects = [], agents = [], activeProject = null, currentViewedProject = null } = {}) {
  const names = new Set(projects.map((p) => p?.name).filter(Boolean));
  if (currentViewedProject && names.has(currentViewedProject)) return currentViewedProject;
  const recentActive = mostRecentActiveProject(projects);
  if (recentActive) return recentActive;
  if (activeProject && names.has(activeProject)) return activeProject;

  const activeAgentProject = agents.find((a) => a?.active_project && names.has(a.active_project))?.active_project;
  if (activeAgentProject) return activeAgentProject;

  return projects.find((p) => p?.name)?.name || null;
}
