export const CONNECTION_STATUSES = Object.freeze([
  'loading',
  'ready',
  'empty',
  'auth-error',
  'offline',
  'timeout',
  'server-error',
]);

export const INITIAL_CONNECTION_STATE = Object.freeze({
  status: 'loading',
  hasData: false,
  retrying: false,
  error: null,
  httpStatus: null,
  errorScope: null,
});

export function classifyConnectionError(error) {
  const httpStatus = Number.isInteger(error?.status) ? error.status : null;
  let status = 'server-error';
  if (httpStatus === 401 || httpStatus === 403) status = 'auth-error';
  else if (error?.kind === 'network') status = 'offline';
  else if (error?.kind === 'timeout') status = 'timeout';

  return {
    status,
    error: error?.message || 'The dashboard request failed.',
    httpStatus,
  };
}

export function connectionSuccess(projects) {
  return {
    status: Array.isArray(projects) && projects.length === 0 ? 'empty' : 'ready',
    hasData: true,
    retrying: false,
    error: null,
    httpStatus: null,
    errorScope: null,
  };
}

const ERROR_SCOPE_PRIORITY = Object.freeze({ tasks: 1, agents: 1, core: 2, auth: 3 });

function scopePriority(scope) {
  return ERROR_SCOPE_PRIORITY[scope] || 0;
}

export function connectionFailure(previous, error, errorScope = 'core') {
  if (previous?.errorScope && scopePriority(previous.errorScope) > scopePriority(errorScope)) {
    return previous;
  }
  const failure = typeof error?.status === 'string' ? error : classifyConnectionError(error);
  return {
    status: failure.status,
    hasData: !!previous?.hasData,
    retrying: false,
    error: failure.error || 'The dashboard request failed.',
    httpStatus: Number.isInteger(failure.httpStatus) ? failure.httpStatus : null,
    errorScope,
  };
}

export function connectionRecovery(previous, projects, recoveredScope = 'core') {
  if (previous?.errorScope && scopePriority(previous.errorScope) > scopePriority(recoveredScope)) {
    return previous;
  }
  return connectionSuccess(projects);
}

// Clear one proven-recovered scope without claiming that a still-pending core
// request has succeeded. This is used after /api/auth itself succeeds during a
// Retry: if a following core request fails, that newer failure must replace the
// stale auth error instead of being hidden by scope priority.
export function connectionScopeRecovery(previous, projects, recoveredScope) {
  if (previous?.errorScope !== recoveredScope) return previous;
  if (previous?.hasData) {
    return { ...connectionSuccess(projects), retrying: !!previous.retrying };
  }
  return { ...INITIAL_CONNECTION_STATE, retrying: !!previous?.retrying };
}

export function connectionLoading(previous = INITIAL_CONNECTION_STATE) {
  if (previous?.hasData) return { ...previous, retrying: true };
  // A fatal auth retry still needs to know that /api/auth must run before the
  // core snapshot. Preserve only that scope while clearing the visible error.
  return {
    ...INITIAL_CONNECTION_STATE,
    status: 'loading',
    retrying: true,
    errorScope: previous?.errorScope || null,
  };
}
