import { ApiError, apiJson, abortableAll } from './apiFetch.js';
import { markAuthSucceeded } from '../state/authState.mjs';
import { selectViewedProject } from './projectSelection.mjs';
import {
  WORK_STATE_OPTIONS,
  WORK_STATE_DETAIL_FIELDS,
  normalizeStuckIndicatorActionDescriptor,
} from './workState.js';

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

function projectFromTaskPath(path) {
  if (typeof path !== 'string') return null;
  const match = /^\/?(?:api\/)?projects\/([^/]+)\/tasks(?:\/|\?|$)/.exec(path);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
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

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function validateWorkStateDetails(details, path, at) {
  require(isRecord(details), path, `${at}.workStateDetails to be an object`);
  for (const field of WORK_STATE_DETAIL_FIELDS) {
    require(
      hasOwn(details, field),
      path,
      `${at}.workStateDetails.${field} to be present in the canonical detail shape`,
    );
    require(
      details[field] === null || isNonEmptyString(details[field]),
      path,
      `${at}.workStateDetails.${field} to be a string or null`,
    );
  }
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

export function validateTask(task, index = 0, path = '/projects/tasks', project = null) {
  const at = `tasks[${index}]`;
  require(isRecord(task), path, `${at} to be an object`);
  require(isNonEmptyString(task.id), path, `${at}.id to be a non-empty string`);
  require(isNonEmptyString(task.title), path, `${at}.title to be a non-empty string`);
  require(TASK_STATUSES.has(task.status), path, `${at}.status to match the task status enum`);
  // T-452-7: `blocked` was a legacy projection and is no longer part of the
  // task contract. Ignore it when an older server still includes it so a
  // mixed-version snapshot cannot invalidate the complete board. The
  // canonical `workState` below remains mandatory.
  // Canonical work-state fields are an atomic integration contract.  A
  // response that omits them is rejected before it can reach appState; the UI
  // must not manufacture local `working`/empty-details success from a legacy
  // response during a partial backend rollout.
  require(hasOwn(task, 'workState') && WORK_STATE_OPTIONS.includes(task.workState), path,
    `${at}.workState to be present and match the canonical work-state enum`);
  require(hasOwn(task, 'workStateDetails'), path,
    `${at}.workStateDetails to be present as part of the canonical contract`);
  validateWorkStateDetails(task.workStateDetails, path, at);
  // Exactly one transient indicator is returned by the backend.  Arrays are
  // ambiguous and must fail closed rather than being reduced client-side.
  require(hasOwn(task, 'stuckIndicator')
    && (task.stuckIndicator === null || isRecord(task.stuckIndicator)), path,
  `${at}.stuckIndicator to be exactly one object or null`);
  if (isRecord(task.stuckIndicator) && hasOwn(task.stuckIndicator, 'actions')) {
    require(isRecord(task.stuckIndicator.actions), path,
      `${at}.stuckIndicator.actions to be an action map when present`);
    const actionProject = project || projectFromTaskPath(path);
    for (const [name, descriptor] of Object.entries(task.stuckIndicator.actions)) {
      const actionTask = actionProject ? { ...task, project: actionProject } : task;
      require(!!normalizeStuckIndicatorActionDescriptor(actionTask, name, descriptor), path,
        `${at}.stuckIndicator.actions.${name} to use explicit POST ${actionProject || '<project>'}/${task.id} clear/retry contract`);
    }
  }
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
      && (task.staleAfterMinutes === null || isPositiveInteger(task.staleAfterMinutes)),
    path,
    `${at}.staleAfterMinutes to be a positive integer or null`,
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

export function validateTaskPayload(task, path = '/projects/tasks') {
  validateTask(task, 0, path, projectFromTaskPath(path));
  return task;
}

export function validateTaskMutationResponse(data, path = '/projects/tasks') {
  require(isRecord(data) && data.ok === true, path, 'a mutation response with ok=true');
  require(isRecord(data.task), path, 'a canonical task in mutation response');
  validateTaskPayload(data.task, path);
  return data;
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
  tasks.forEach((task, index) => validateTask(task, index, path, project));
  return tasks;
}

function validateSnapshotStatus(status, path) {
  require(isRecord(status), path, 'status to be an object');
  require(isNullableString(status.agentId), path, 'status.agentId to be a string or null');
  require(isNullableString(status.activeProject), path, 'status.activeProject to be a string or null');
  require(typeof status.contextReady === 'boolean', path, 'status.contextReady to be a boolean');
}

function snapshotSection(ok, data, error = null) {
  return ok ? { ok: true, data } : { ok: false, error: error || {
    code: 'SECTION_UNAVAILABLE',
    message: 'Dashboard snapshot section unavailable',
  } };
}

/**
 * Manual rollback path for FLOWBOARD_ENABLE_DASHBOARD_SNAPSHOT=false. Keep
 * this compatible envelope so the rest of the dashboard does not need a
 * second state model while operators roll back the snapshot lane.
 */
async function fetchLegacyDashboardSnapshot(project, agentId, signal, options = {}) {
  const [projects, agents, activeProject] = await abortableAll([
    (groupSignal) => fetchProjectsList(groupSignal, options),
    (groupSignal) => fetchAgentsList(groupSignal, options),
    (groupSignal) => fetchActiveProjectForAgent(agentId, groupSignal, options),
  ], { signal });
  const viewedProject = selectViewedProject({
    projects,
    agents,
    activeProject,
    currentViewedProject: project,
  });
  const tasks = viewedProject ? await fetchTasksForProject(viewedProject, signal, options) : [];
  const status = { agentId: agentId || null, activeProject, contextReady: false };
  return {
    ok: true,
    version: 1,
    generatedAt: new Date().toISOString(),
    projects,
    agents,
    status,
    activeProject,
    viewedProject,
    tasks,
    sections: {
      projects: snapshotSection(true, projects),
      agents: snapshotSection(true, agents),
      status: snapshotSection(true, status),
      tasks: snapshotSection(true, tasks),
    },
  };
}

/**
 * Fetch the versioned shell read model. `project` is the currently viewed
 * project, while the server resolves the active project from the agent id.
 * A section failure is a protocol error rather than an empty successful
 * section; callers retain their previous snapshot.
 */
export async function fetchDashboardSnapshot(project = null, agentId = null, signal, options = {}) {
  // Keep the helper convenient for focused callers that prefer an options
  // object: fetchDashboardSnapshot({ project, agentId }, signal, options).
  if (isRecord(project)) {
    const request = project;
    options = signal || {};
    signal = agentId;
    project = request.project || null;
    agentId = request.agentId || null;
  }

  if (globalThis.window?.__FLOWBOARD_ENABLE_DASHBOARD_SNAPSHOT__ === false) {
    return fetchLegacyDashboardSnapshot(project, agentId, signal, options);
  }

  const query = new URLSearchParams();
  if (project) query.set('project', project);
  if (agentId) query.set('agentId', agentId);
  const path = `/dashboard/snapshot/v1${query.toString() ? `?${query}` : ''}`;

  // T-450-4: a caller (DashboardContext's background poll) may pass the ETag
  // it saw on the last snapshot. The server (T-450-3) answers a matching
  // If-None-Match with a bodyless 304; apiJson's `withETag` option surfaces
  // that as `{ notModified: true }` instead of throwing. Non-poll callers
  // (initial load, explicit Retry) never pass `etag`, so they always get an
  // unconditional 200 with the complete body — unaffected by any of this.
  const { etag: ifNoneMatch, ...restOptions } = options;
  const headers = ifNoneMatch
    ? { ...restOptions.headers, 'If-None-Match': ifNoneMatch }
    : restOptions.headers;

  let result;
  try {
    result = await apiJson(path, { ...restOptions, headers, signal, withETag: true });
  } catch (error) {
    // A server-side flag may be changed without a matching frontend build.
    // Honor the same explicit rollback path when the endpoint advertises that
    // it is disabled; unrelated 503s must still surface normally.
    if (error?.status === 503 && error?.code === 'DASHBOARD_SNAPSHOT_DISABLED') {
      return fetchLegacyDashboardSnapshot(project, agentId, signal, options);
    }
    throw error;
  }

  if (result.notModified) {
    return { notModified: true, etag: result.etag || ifNoneMatch || null };
  }

  const data = result.data;
  const etag = result.etag || null;
  require(isRecord(data) && data.ok === true, path, 'a snapshot response with ok=true');
  require(data.version === 1, path, 'snapshot version 1');
  require(isNonEmptyString(data.generatedAt), path, 'generatedAt to be a non-empty string');

  require(isRecord(data.sections), path, 'sections to be an object');
  for (const section of ['projects', 'agents', 'status', 'tasks']) {
    const state = data.sections[section];
    require(isRecord(state) && state.ok === true, path,
      `${section} snapshot section to be available`);
    require(hasOwn(state, 'data'), path, `${section} snapshot section to include data`);
  }

  require(Array.isArray(data.sections.projects.data), path, 'projects snapshot data to be an array');
  require(Array.isArray(data.sections.agents.data), path, 'agents snapshot data to be an array');
  validateSnapshotStatus(data.sections.status.data, path);
  require(Array.isArray(data.sections.tasks.data), path, 'tasks snapshot data to be an array');

  require(Array.isArray(data.projects), path, 'projects to be an array');
  require(Array.isArray(data.agents), path, 'agents to be an array');
  require(Array.isArray(data.tasks), path, 'tasks to be an array');
  require(data.activeProject === null || isNonEmptyString(data.activeProject), path,
    'activeProject to be a string or null');
  require(data.viewedProject === null || isNonEmptyString(data.viewedProject), path,
    'viewedProject to be a string or null');
  validateSnapshotStatus(data.status, path);
  data.projects.forEach((item, index) => validateProject(item, index, path));
  data.agents.forEach((item, index) => validateAgent(item, index, path));
  data.tasks.forEach((item, index) => validateTask(item, index, path, data.viewedProject));
  return { ...data, notModified: false, etag };
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
  // This is the sole success path allowed to clear the shared auth breaker.
  markAuthSucceeded();
  return data;
}
