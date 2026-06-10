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
  const candidates = [
    ['url', normalizeAgentId(params.get('agentId'))],
    ['url', normalizeAgentId(params.get('agent'))],
    ['telegram-start', agentIdFromStartParam(telegramWebApp?.initDataUnsafe?.start_param)],
    ['auth', normalizeAgentId(authAgentId)],
    ['stored', normalizeAgentId(storedAgentId)],
  ];
  const found = candidates.find(([, agentId]) => agentId);
  return {
    agentId: found?.[1] || null,
    source: found?.[0] || null,
    chatBound: !!found && found[0] !== 'stored',
  };
}

export function selectViewedProject({ projects = [], agents = [], activeProject = null, currentViewedProject = null } = {}) {
  const names = new Set(projects.map((p) => p?.name).filter(Boolean));
  if (currentViewedProject && names.has(currentViewedProject)) return currentViewedProject;
  if (activeProject && names.has(activeProject)) return activeProject;

  const activeAgentProject = agents.find((a) => a?.active_project && names.has(a.active_project))?.active_project;
  if (activeAgentProject) return activeAgentProject;

  return projects.find((p) => p?.name)?.name || null;
}
