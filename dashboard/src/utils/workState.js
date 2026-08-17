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
  return nullableText(value);
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
  return task.stuckIndicator
    ?? task.stuck_indicator
    ?? task.attention?.stuckIndicator
    ?? task.attention?.stuck_indicator
    ?? task.workStateDetails?.stuckIndicator
    ?? null;
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

function actionName(value) {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return null;
  return value.action || value.name || value.type || null;
}

function normalizedActionEntries(rawActions, indicator) {
  const entries = [];
  if (Array.isArray(rawActions)) {
    for (const action of rawActions) {
      const name = actionName(action);
      if (name) entries.push({ name, value: action });
    }
  } else if (isRecord(rawActions)) {
    for (const [name, value] of Object.entries(rawActions)) {
      if (value === true || isRecord(value)) entries.push({ name, value });
    }
  }
  for (const name of ['clear', 'retry']) {
    const capitalized = name[0].toUpperCase() + name.slice(1);
    if ((indicator?.[`can${capitalized}`] === true
      || indicator?.[`${name}able`] === true
      || indicator?.[name] === true
      || isRecord(indicator?.[name]))
      && !entries.some((entry) => entry.name === name)) {
      entries.push({ name, value: indicator?.[name] === true ? true : indicator?.[name] || true });
    }
  }
  return entries;
}

/**
 * Return the one active structured indicator, or null. Terminal lifecycle
 * states are treated as clear even when a stale poll briefly returns an old
 * indicator.
 */
export function getStuckIndicator(task) {
  if (!isRecord(task) || TERMINAL_LIFECYCLE_STATES.has(task.status)) return null;
  let indicator = candidateIndicator(task);
  if (Array.isArray(indicator)) {
    indicator = indicator.find((item) => !indicatorIsInactive(item)) || null;
  }
  if (indicatorIsInactive(indicator)) return null;
  return {
    ...indicator,
    message: nullableText(indicator.message)
      || nullableText(indicator.summary)
      || nullableText(indicator.reason)
      || 'Task needs attention',
    reason: nullableText(indicator.reason),
    createdAt: nullableTimestamp(indicator.createdAt || indicator.setAt),
    updatedAt: nullableTimestamp(indicator.updatedAt),
    checkAgainAt: nullableTimestamp(indicator.checkAgainAt),
    actions: normalizedActionEntries(indicator.actions || indicator.availableActions, indicator).map(({ name }) => name),
  };
}

export function hasStuckAction(indicator, action) {
  if (!isRecord(indicator) || !action) return false;
  return normalizedActionEntries(indicator.actions || indicator.availableActions, indicator)
    .some((entry) => entry.name === action);
}

function suppliedActionUpdate(indicator, action) {
  const entries = normalizedActionEntries(indicator?.actions || indicator?.availableActions, indicator);
  const entry = entries.find((candidate) => candidate.name === action);
  const value = entry?.value;
  if (isRecord(value?.update)) return clone(value.update);
  if (isRecord(value?.payload)) return clone(value.payload);
  if (isRecord(indicator?.[`${action}Update`])) return clone(indicator[`${action}Update`]);
  if (isRecord(indicator?.[`${action}Action`]?.update)) return clone(indicator[`${action}Action`].update);
  if (isRecord(indicator?.[`${action}Action`]?.payload)) return clone(indicator[`${action}Action`].payload);
  return null;
}

/**
 * Clear/retry never mutate the indicator locally. They produce a canonical
 * task update which the caller must send through the API; the server response
 * decides whether/when the living indicator disappears.
 */
export function buildStuckIndicatorActionUpdate(task, indicator, action) {
  const supplied = suppliedActionUpdate(indicator, action);
  if (supplied) return supplied;

  const details = normalizeWorkStateDetails(task?.workStateDetails);
  if (action === 'retry') {
    return {
      workState: 'working',
      workStateDetails: {
        reason: details.reason,
        waitingFor: details.waitingFor,
        responsible: details.responsible,
        checkAgainAt: null,
      },
    };
  }
  if (action === 'clear') {
    return buildWorkStateUpdate('working', EMPTY_WORK_STATE_DETAILS);
  }
  return null;
}

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
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}
