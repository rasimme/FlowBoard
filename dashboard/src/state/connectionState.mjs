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

export function connectionFailure(previous, error, errorScope = 'core') {
  if (errorScope !== 'core' && previous?.errorScope === 'core') return previous;
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
  if (recoveredScope !== 'core' && previous?.errorScope === 'core') return previous;
  return connectionSuccess(projects);
}

export function connectionLoading(previous = INITIAL_CONNECTION_STATE) {
  if (previous?.hasData) return { ...previous, retrying: true };
  return { ...INITIAL_CONNECTION_STATE, status: 'loading', retrying: true };
}
