// Shared browser auth circuit breaker (T-445).
//
// Authentication failures open the breaker, including bootstrap/auth failures
// and requests made by views outside DashboardContext. Domain authorization
// conflicts are not authentication failures: a task ownership conflict must
// not stop unrelated dashboard polling. A validated Telegram auth exchange or
// an explicit successful no-auth retry closes it; an arbitrary 2xx response
// must never make background polling resume after credentials have failed.

const TYPED_AUTH_FAILURE_CODES = new Set([
  'INVALID_SESSION',
  'TELEGRAM_INIT_DATA_MISSING',
  'TELEGRAM_INIT_DATA_INVALID',
  'TELEGRAM_INIT_DATA_EXPIRED',
  'TELEGRAM_INIT_DATA_FUTURE',
  'TELEGRAM_BOT_NOT_SUPPORTED',
  'TELEGRAM_USER_NOT_ALLOWED',
]);

let halted = false;
let lastError = null;
const listeners = new Set();

function notify() {
  listeners.forEach((listener) => listener());
}

export function isAuthHalted() {
  return halted;
}

export function getAuthHaltError() {
  return lastError;
}

export function isAuthenticationFailure(error = null) {
  if (error?.status === 401) return true;
  return error?.status === 403 && TYPED_AUTH_FAILURE_CODES.has(error?.code);
}

export function markAuthHalted(error = null) {
  if (!isAuthenticationFailure(error)) return halted;
  const nextError = error || null;
  const changed = !halted || lastError !== nextError;
  halted = true;
  lastError = nextError;
  if (changed) notify();
  return halted;
}

/**
 * Close the breaker only from an explicit, validated auth exchange.
 */
export function markAuthSucceeded() {
  const changed = halted || lastError !== null;
  halted = false;
  lastError = null;
  if (changed) notify();
}

export function subscribeAuthState(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
