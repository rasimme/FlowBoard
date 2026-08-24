// Shared browser auth circuit breaker (T-445).
//
// Any API 401/403 opens the breaker, including bootstrap/auth failures and
// requests made by views outside DashboardContext. Only a proven successful
// Telegram auth exchange closes it; an arbitrary 2xx response must never make
// background polling resume after credentials have failed.

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

export function markAuthHalted(error = null) {
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
