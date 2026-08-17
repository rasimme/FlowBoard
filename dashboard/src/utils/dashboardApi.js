import { ApiError, apiJson } from './apiFetch.js';

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function invalidApiPayload(path, expectation) {
  return new ApiError(`Invalid FlowBoard response: expected ${expectation}.`, {
    kind: 'protocol',
    path: path.startsWith('/api/') ? path : `/api${path}`,
  });
}

export function requireObjectArrayField(data, field, path, validateEntry = null) {
  if (!isRecord(data) || !Array.isArray(data[field])) {
    throw invalidApiPayload(path, `an object with a ${field} array`);
  }
  data[field].forEach((entry, index) => {
    if (!isRecord(entry)) {
      throw invalidApiPayload(path, `${field}[${index}] to be an object`);
    }
    if (validateEntry && !validateEntry(entry)) {
      throw invalidApiPayload(path, `${field}[${index}] to match the API schema`);
    }
  });
  return data[field];
}

export async function fetchProjectsList(signal, options = {}) {
  const path = '/projects';
  const data = await apiJson(path, { ...options, signal });
  return requireObjectArrayField(
    data,
    'projects',
    path,
    (project) => typeof project.name === 'string' && project.name.length > 0,
  );
}

export async function fetchAgentsList(signal, options = {}) {
  const path = '/agents';
  const data = await apiJson(path, { ...options, signal });
  return requireObjectArrayField(
    data,
    'agents',
    path,
    (agent) => typeof agent.agent_id === 'string'
      && agent.agent_id.length > 0
      && (agent.active_project === null || typeof agent.active_project === 'string'),
  );
}

export async function fetchActiveProjectForAgent(agentId, signal, options = {}) {
  if (!agentId) return null;
  const path = `/status?agentId=${encodeURIComponent(agentId)}`;
  const data = await apiJson(path, { ...options, signal });
  if (!isRecord(data) || data.agentId !== agentId) {
    throw invalidApiPayload(path, `a status object for agentId ${agentId}`);
  }
  if (data.activeProject !== null && typeof data.activeProject !== 'string') {
    throw invalidApiPayload(path, 'activeProject to be a string or null');
  }
  return data.activeProject;
}

export async function fetchTasksForProject(project, signal, options = {}) {
  if (!project) return [];
  const path = `/projects/${encodeURIComponent(project)}/tasks?includeArchived=true`;
  const data = await apiJson(path, { ...options, signal });
  return requireObjectArrayField(
    data,
    'tasks',
    path,
    (task) => typeof task.id === 'string' && task.id.length > 0,
  );
}

export async function authenticateTelegram(initData, signal, options = {}) {
  const path = '/auth';
  const data = await apiJson(path, {
    ...options,
    method: 'POST',
    headers: { ...options.headers, 'X-Telegram-Init-Data': initData },
    credentials: 'include',
    signal,
  });
  if (!isRecord(data) || data.ok !== true || !isRecord(data.user)) {
    throw invalidApiPayload(path, 'an auth object with ok=true and a user object');
  }
  if (data.agentId !== null && data.agentId !== undefined
    && (typeof data.agentId !== 'string' || data.agentId.length === 0)) {
    throw invalidApiPayload(path, 'agentId to be a non-empty string or null');
  }
  if (data.user.username !== undefined && typeof data.user.username !== 'string') {
    throw invalidApiPayload(path, 'user.username to be a string when present');
  }
  return data;
}
