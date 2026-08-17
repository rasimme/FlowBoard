// Canonical work-state boundary for the dashboard UI.
//
// The task lifecycle (`backlog`/`open`/`in-progress`/`review`/`done`) is
// deliberately not represented here. Work state is an additional, orthogonal
// value. Keeping normalization and update-payload construction in this module
// lets the UI remain compatible while the backend rolls out canonical fields.

export const WORK_STATE_OPTIONS = ['working', 'waiting', 'blocked', 'paused'];

export const WORK_STATE_DETAIL_FIELDS = [
  'reason',
  'waitingFor',
  'responsible',
  'checkAgainAt',
  'setAt',
];

export const EMPTY_WORK_STATE_DETAILS = Object.freeze({
  reason: null,
  waitingFor: null,
  responsible: null,
  checkAgainAt: null,
  setAt: null,
});

// The backend owns the transient-indicator action routes. The UI may render
// only these named, explicit POST actions when the response supplies a
// descriptor for the exact project/task-bound endpoint; it must never invent a
// task PUT or arbitrary /api fallback.
export const TRANSIENT_INDICATOR_ACTIONS = Object.freeze(['clear', 'retry']);

const TERMINAL_LIFECYCLE_STATES = new Set(['review', 'done', 'archived']);

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

function nullableText(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function nullableTimestamp(value) {
  const text = nullableText(value);
  if (!text) return null;
  return Number.isNaN(new Date(text).getTime()) ? null : text;
}

function taskProject(task) {
  return isRecord(task) && typeof task.project === 'string' && task.project.trim()
    ? task.project.trim()
    : null;
}

/**
 * The action URL is part of the frontend/backend contract, not an arbitrary
 * URL supplied by task metadata.  Callers that do not have the project-bound
 * task identity must fail closed and render no executable action.
 */
export function stuckIndicatorActionPath(task, action) {
  const project = taskProject(task);
  if (!project || !isRecord(task) || typeof task.id !== 'string' || !task.id
      || !TRANSIENT_INDICATOR_ACTIONS.includes(action)) return null;
  return `/api/projects/${encodeURIComponent(project)}/tasks/${encodeURIComponent(task.id)}`
    + `/stuck-indicator/${action}`;
}

export function normalizeWorkState(value, legacyBlocked = false) {
  if (WORK_STATE_OPTIONS.includes(value)) return value;
  return legacyBlocked === true ? 'blocked' : 'working';
}

/**
 * Always returns the complete, stable detail shape. `setAt` is read-only and
 * is therefore never emitted by buildWorkStateUpdate().
 */
export function normalizeWorkStateDetails(details) {
  const source = isRecord(details) ? details : {};
  const normalized = {
    reason: nullableText(source.reason),
    waitingFor: nullableText(source.waitingFor),
    responsible: nullableText(source.responsible),
    checkAgainAt: nullableTimestamp(source.checkAgainAt),
    setAt: nullableTimestamp(source.setAt),
  };
  // Some backend rollout shapes temporarily nest the living signal under
  // details. Preserve only that known compatibility field; arbitrary unknown
  // detail keys must not leak into canonical form or PUT bodies.
  if (source.stuckIndicator !== undefined) normalized.stuckIndicator = source.stuckIndicator;
  return normalized;
}

/**
 * Read compatibility projection. Canonical workState wins whenever present;
 * only legacy records without a valid canonical value use `blocked`.
 */
export function normalizeTaskWorkState(task) {
  if (!isRecord(task)) return task;
  const workState = normalizeWorkState(task.workState, task.blocked === true);
  const workStateDetails = normalizeWorkStateDetails(task.workStateDetails);
  return {
    ...task,
    workState,
    workStateDetails,
    // `blocked` is intentionally a projection, never an independent value.
    blocked: workState === 'blocked',
  };
}

/**
 * Canonical PUT body. Do not include legacy `blocked` or server-owned `setAt`.
 */
export function buildWorkStateUpdate(workState, details = EMPTY_WORK_STATE_DETAILS) {
  const normalizedState = normalizeWorkState(workState);
  const normalizedDetails = normalizeWorkStateDetails(details);
  return {
    workState: normalizedState,
    workStateDetails: {
      reason: normalizedDetails.reason,
      waitingFor: normalizedDetails.waitingFor,
      responsible: normalizedDetails.responsible,
      checkAgainAt: normalizedDetails.checkAgainAt,
    },
  };
}

function candidateIndicator(task) {
  if (!isRecord(task)) return null;
  const candidate = task.stuckIndicator
    ?? task.stuck_indicator
    ?? task.attention?.stuckIndicator
    ?? task.attention?.stuck_indicator
    ?? task.workStateDetails?.stuckIndicator
    ?? null;
  // Exactly one indicator is part of the API contract.  Arrays are not
  // reduced by picking an arbitrary entry because that creates a local
  // phantom success when the backend has returned an incompatible shape.
  return isRecord(candidate) ? candidate : null;
}

function indicatorIsInactive(indicator) {
  return !isRecord(indicator)
    || indicator.active === false
    || indicator.cleared === true
    || indicator.status === 'cleared'
    || indicator.status === 'resolved'
    || indicator.state === 'cleared'
    || indicator.state === 'resolved'
    || indicator.clearedAt != null
    || indicator.resolvedAt != null;
}

export function normalizeStuckIndicatorActionDescriptor(task, name, value) {
  if (!TRANSIENT_INDICATOR_ACTIONS.includes(name) || !isRecord(value)) return null;
  const expectedPath = stuckIndicatorActionPath(task, name);
  // The descriptor must identify the mapped action and use the explicit
  // method/path from the exact project+task-bound contract.  Defaults,
  // alternate hrefs, and generic /api paths are deliberately not accepted.
  if (!expectedPath
      || !Object.prototype.hasOwnProperty.call(value, 'action')
      || value.action !== name
      || !Object.prototype.hasOwnProperty.call(value, 'method')
      || value.method !== 'POST'
      || !Object.prototype.hasOwnProperty.call(value, 'path')
      || value.path !== expectedPath) return null;
  const hasBody = Object.prototype.hasOwnProperty.call(value, 'body');
  const hasPayload = Object.prototype.hasOwnProperty.call(value, 'payload');
  if ((hasBody && !isRecord(value.body)) || (hasPayload && !isRecord(value.payload))) return null;
  if (hasBody && hasPayload) return null;
  const body = hasBody
    ? clone(value.body)
    : hasPayload ? clone(value.payload) : undefined;
  // Explicit indicator actions are non-destructive.  Reject descriptors that
  // smuggle lifecycle/work-state writes into the action body.
  if (body && ['status', 'blocked', 'workState', 'workStateDetails'].some((field) => Object.prototype.hasOwnProperty.call(body, field))) {
    return null;
  }
  return {
    action: name,
    method: 'POST',
    path: expectedPath,
    ...(body ? { body } : {}),
  };
}

function normalizedActionEntries(task, rawActions) {
  const entries = [];
  if (Array.isArray(rawActions)) {
    for (const value of rawActions) {
      if (!isRecord(value)) continue;
      const name = value.action || value.name;
      const descriptor = normalizeStuckIndicatorActionDescriptor(task, name, value);
      if (descriptor) entries.push({ name, value: descriptor });
    }
    return entries;
  }
  if (!isRecord(rawActions)) return entries;
  for (const name of TRANSIENT_INDICATOR_ACTIONS) {
    const descriptor = normalizeStuckIndicatorActionDescriptor(task, name, rawActions[name]);
    if (descriptor) entries.push({ name, value: descriptor });
  }
  return entries;
}

/**
 * Return the one active structured indicator, or null. Terminal lifecycle
 * states are treated as clear even when a stale poll briefly returns an old
 * indicator.
 */
export function getStuckIndicator(task, project = null) {
  if (!isRecord(task) || TERMINAL_LIFECYCLE_STATES.has(task.status)) return null;
  const indicator = candidateIndicator(task);
  if (indicatorIsInactive(indicator)) return null;
  // Tasks returned by the project-scoped list need not repeat their project.
  // The caller may supply that authoritative project context; it is used only
  // to validate the exact action route, never to loosen validation.
  const taskContext = project ? { ...task, project } : task;
  return {
    ...indicator,
    message: nullableText(indicator.message)
      || nullableText(indicator.summary)
      || nullableText(indicator.reason)
      || 'Task needs attention',
    reason: nullableText(indicator.reason),
    detectedAt: nullableTimestamp(indicator.detectedAt || indicator.createdAt || indicator.setAt),
    // Keep createdAt as a read-compatibility alias for older renderers, but
    // detectedAt is the canonical monitoring timestamp.
    createdAt: nullableTimestamp(indicator.createdAt || indicator.detectedAt || indicator.setAt),
    updatedAt: nullableTimestamp(indicator.updatedAt),
    checkAgainAt: nullableTimestamp(indicator.checkAgainAt),
    actions: normalizedActionEntries(taskContext, indicator.actions || indicator.availableActions)
      .map(({ value }) => value),
  };
}

export function hasStuckAction(indicator, action) {
  if (!isRecord(indicator) || !action) return false;
  return Array.isArray(indicator.actions)
    && indicator.actions.some((entry) => isRecord(entry)
      && entry.action === action
      && entry.method === 'POST');
}

function suppliedActionDescriptor(task, indicator, action) {
  const entries = normalizedActionEntries(
    task,
    indicator?.actions || indicator?.availableActions,
  );
  const entry = entries.find((candidate) => candidate.name === action);
  return entry?.value ? clone(entry.value) : null;
}

/**
 * Clear/retry never mutate the indicator or work-state locally. They return
 * only an explicit, backend-supplied non-destructive action descriptor. When
 * the backend branch is not integrated yet this returns null, so the UI has
 * no phantom-success path.
 */
export function buildStuckIndicatorActionUpdate(task, indicator, action) {
  const supplied = suppliedActionDescriptor(task, indicator, action);
  return supplied ? { ...supplied, action } : null;
}

export const buildStuckIndicatorActionRequest = buildStuckIndicatorActionUpdate;

export function formatDateTimeLocal(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function parseDateTimeLocal(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;

  // Construct in local time and demand a lossless round-trip.  JS otherwise
  // silently normalizes invalid calendar dates and DST spring-forward gaps.
  const date = new Date(0);
  date.setHours(0, 0, 0, 0);
  date.setFullYear(year, month - 1, day);
  date.setHours(hour, minute, 0, 0);
  if (date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
    || date.getHours() !== hour
    || date.getMinutes() !== minute) return null;
  return date.toISOString();
}
