import { ApiError, apiJson } from './apiFetch.js';

const PROJECT_STATUSES = new Set(['active', 'closed', 'archived']);
const TASK_STATUSES = new Set(['backlog', 'open', 'in-progress', 'review', 'done', 'archived']);
const TASK_PRIORITIES = new Set(['low', 'medium', 'high']);
const TASK_COUNT_FIELDS = ['open', 'in-progress', 'review', 'done', 'backlog', 'archived', 'blocked'];

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(record, field) {
  return Object.prototype.hasOwnProperty.call(record, field);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isNullableString(value) {
  return value === null || isNonEmptyString(value);
}

function isNullableFiniteNumber(value) {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

export function invalidApiPayload(path, expectation) {
  return new ApiError(`Invalid FlowBoard response: expected ${expectation}.`, {
    kind: 'protocol',
    path: path.startsWith('/api/') ? path : `/api${path}`,
  });
}

function require(condition, path, expectation) {
  if (!condition) throw invalidApiPayload(path, expectation);
}

function requireSuccessArray(data, field, path) {
  require(isRecord(data), path, 'a JSON object');
  require(data.ok === true, path, 'top-level ok=true');
  require(Array.isArray(data[field]), path, `${field} to be an array`);
  return data[field];
}

function validateProject(project, index, path) {
  const at = `projects[${index}]`;
  require(isRecord(project), path, `${at} to be an object`);
  require(isNonEmptyString(project.name), path, `${at}.name to be a non-empty string`);
  require(isNonEmptyString(project.displayName), path, `${at}.displayName to be a non-empty string`);
  require(PROJECT_STATUSES.has(project.status), path, `${at}.status to be active, closed, or archived`);
  require(typeof project.archived === 'boolean', path, `${at}.archived to be a boolean`);
  require(project.group === null || isNonEmptyString(project.group), path, `${at}.group to be a string or null`);
  require(isNullableFiniteNumber(project.order), path, `${at}.order to be a finite number or null`);
  require(isStringArray(project.assignedAgents), path, `${at}.assignedAgents to be an array of strings`);
  require(typeof project.description === 'string', path, `${at}.description to be a string`);
  require(isNullableString(project.createdAt), path, `${at}.createdAt to be a string or null`);

  require(project.github === null || isRecord(project.github), path, `${at}.github to be an object or null`);
  if (isRecord(project.github)) {
    require(isNonEmptyString(project.github.repo), path, `${at}.github.repo to be a non-empty string`);
    require(project.github.branch === undefined || isNonEmptyString(project.github.branch), path,
      `${at}.github.branch to be a non-empty string when present`);
  }

  require(isRecord(project.taskCounts), path, `${at}.taskCounts to be an object`);
  for (const field of TASK_COUNT_FIELDS) {
    require(hasOwn(project.taskCounts, field) && isNonNegativeInteger(project.taskCounts[field]), path,
      `${at}.taskCounts.${field} to be a non-negative integer`);
  }
}

function validateAgent(agent, index, path) {
  const at = `agents[${index}]`;
  require(isRecord(agent), path, `${at} to be an object`);
  require(isNonEmptyString(agent.agent_id), path, `${at}.agent_id to be a non-empty string`);
  require(hasOwn(agent, 'active_project') && isNullableString(agent.active_project), path,
    `${at}.active_project to be a string or null`);
  require(hasOwn(agent, 'activated_at') && isNullableString(agent.activated_at), path,
    `${at}.activated_at to be a string or null`);
  require(hasOwn(agent, 'last_seen') && isNullableString(agent.last_seen), path,
    `${at}.last_seen to be a string or null`);
}

function validateTask(task, index, path) {
  const at = `tasks[${index}]`;
  require(isRecord(task), path, `${at} to be an object`);
  require(isNonEmptyString(task.id), path, `${at}.id to be a non-empty string`);
  require(isNonEmptyString(task.title), path, `${at}.title to be a non-empty string`);
  require(TASK_STATUSES.has(task.status), path, `${at}.status to match the task status enum`);
  require(typeof task.blocked === 'boolean', path, `${at}.blocked to be a boolean`);
  require(TASK_PRIORITIES.has(task.priority), path, `${at}.priority to match the priority enum`);
  require(hasOwn(task, 'parentId') && isNullableString(task.parentId), path,
    `${at}.parentId to be a string or null`);
  require(isStringArray(task.subtaskIds), path, `${at}.subtaskIds to be an array of strings`);
  require(hasOwn(task, 'specFile') && isNullableString(task.specFile), path,
    `${at}.specFile to be a string or null`);
  require(hasOwn(task, 'created') && isNullableString(task.created), path,
    `${at}.created to be a string or null`);
  require(hasOwn(task, 'enteredStatusAt') && isNullableString(task.enteredStatusAt), path,
    `${at}.enteredStatusAt to be a string or null`);
  require(hasOwn(task, 'completed') && isNullableString(task.completed), path,
    `${at}.completed to be a string or null`);
  require(hasOwn(task, 'agent') && isNullableString(task.agent), path,
    `${at}.agent to be a string or null`);
  require(hasOwn(task, 'claimedAt') && isNullableString(task.claimedAt), path,
    `${at}.claimedAt to be a string or null`);
  require(hasOwn(task, 'leaseUntil') && isNullableString(task.leaseUntil), path,
    `${at}.leaseUntil to be a string or null`);
  require(hasOwn(task, 'lastCheckpointAt') && isNullableString(task.lastCheckpointAt), path,
    `${at}.lastCheckpointAt to be a string or null`);
  require(
    hasOwn(task, 'staleAfterMinutes')
      && (task.staleAfterMinutes === null || isNonNegativeInteger(task.staleAfterMinutes)),
    path,
    `${at}.staleAfterMinutes to be a non-negative integer or null`,
  );
  require(isNonNegativeInteger(task.checkpointCount), path, `${at}.checkpointCount to be a non-negative integer`);
  require(isNullableFiniteNumber(task.order), path, `${at}.order to be a finite number or null`);
  require(isStringArray(task.tags), path, `${at}.tags to be an array of strings`);
  require(typeof task.description === 'string', path, `${at}.description to be a string`);
  require(hasOwn(task, 'routedAgent') && isNullableString(task.routedAgent), path,
    `${at}.routedAgent to be a string or null`);
  require(hasOwn(task, 'trashedAt') && isNullableString(task.trashedAt), path,
    `${at}.trashedAt to be a string or null`);
  require(typeof task.specExists === 'boolean', path, `${at}.specExists to be a boolean`);

  if (hasOwn(task, 'progress')) {
    require(isRecord(task.progress), path, `${at}.progress to be an object when present`);
    for (const field of ['done', 'inProgress', 'total']) {
      require(hasOwn(task.progress, field) && isNonNegativeInteger(task.progress[field]), path,
        `${at}.progress.${field} to be a non-negative integer`);
    }
  }
}

export async function fetchProjectsList(signal, options = {}) {
  const path = '/projects';
  const data = await apiJson(path, { ...options, signal });
  const projects = requireSuccessArray(data, 'projects', path);
  projects.forEach((project, index) => validateProject(project, index, path));
  return projects;
}

export async function fetchAgentsList(signal, options = {}) {
  const path = '/agents';
  const data = await apiJson(path, { ...options, signal });
  const agents = requireSuccessArray(data, 'agents', path);
  agents.forEach((agent, index) => validateAgent(agent, index, path));
  return agents;
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
  const tasks = requireSuccessArray(data, 'tasks', path);
  tasks.forEach((task, index) => validateTask(task, index, path));
  return tasks;
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
