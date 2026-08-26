// T-461: a small, dependency-injected scheduler for "poll a resource while a
// panel is open" loops.
//
// Mirrors the pattern DashboardContext.jsx has used for the board snapshot
// poll since T-450-1 (pause while document.hidden, reload immediately on
// becoming visible again) and T-450-4 (stepwise backoff while consecutive
// polls report nothing changed, snapping back to the base interval on any
// change): a self-rescheduling setTimeout loop, not setInterval, so the
// delay between ticks can adapt.
//
// This does NOT duplicate DashboardContext's internals (snapshot ETags, task
// reconciliation, connection-state publishing — all board-specific and
// intentionally untouched). It factors out only the timing/backoff shape as
// a small, non-React, injectable scheduler, so it can be:
//   - reused by SpecifyStepper.jsx without re-deriving the same loop, and
//   - unit tested deterministically with a fake clock, no browser/jsdom
//     required (see test-t461-specify-poll-backoff.mjs).
//
// `poll` is the caller's async fetch step. It must resolve to a boolean:
// `true` when the fetched state differs from the previous poll's, `false`
// when unchanged. How "changed" is decided is entirely up to the caller —
// the board poll leans on a server ETag/304; SpecifyStepper's session route
// has no such conditional-GET support, so it compares session JSON instead
// (see SpecifyStepper.jsx's applySession).

/**
 * @param {object} opts
 * @param {() => Promise<boolean>} opts.poll - one fetch step; resolves to
 *   whether the fetched state changed since the previous poll.
 * @param {number} opts.baseMs - fast interval used right after a change, a
 *   reset(), or becoming visible again.
 * @param {number} opts.maxMs - ceiling the backoff cannot exceed.
 * @param {() => boolean} [opts.isHidden] - defaults to document.hidden.
 * @param {(handler: () => void) => (() => void)} [opts.addVisibilityListener]
 *   - registers a 'visibilitychange' handler, defaults to
 *   document.addEventListener; must return an unsubscribe function.
 * @param {typeof setTimeout} [opts.setTimeoutFn]
 * @param {typeof clearTimeout} [opts.clearTimeoutFn]
 * @returns {{ stop: () => void, reset: () => void }}
 */
export function startAdaptivePoll({
  poll,
  baseMs,
  maxMs,
  isHidden = () => (typeof document !== 'undefined' ? document.hidden : false),
  addVisibilityListener = (handler) => {
    if (typeof document === 'undefined') return () => {};
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  },
  setTimeoutFn = (...args) => setTimeout(...args),
  clearTimeoutFn = (...args) => clearTimeout(...args),
}) {
  let intervalMs = baseMs;
  let timeoutId = null;
  let stopped = false;

  // Callers use this for "Nutzerinteraktion" resets (a mutating action whose
  // own response already applies the change locally, so the poll's own
  // before/after comparison wouldn't by itself notice a reason to speed back
  // up) — see postStep/requestNext in SpecifyStepper.jsx. Only changes which
  // interval the *next* scheduling decision uses; it deliberately does not
  // cancel/reschedule a timer that is already pending, matching
  // DashboardContext's resetPollInterval.
  const reset = () => {
    intervalMs = baseMs;
  };

  const scheduleNext = () => {
    if (stopped || isHidden()) return;
    timeoutId = setTimeoutFn(runTick, intervalMs);
  };

  const runTick = async () => {
    timeoutId = null;
    if (stopped || isHidden()) return;
    const changed = await poll();
    if (stopped) return;
    intervalMs = changed ? baseMs : Math.min(intervalMs * 2, maxMs);
    scheduleNext();
  };

  // Becoming visible again reloads immediately instead of waiting for
  // wherever the (paused) interval had drifted to, and counts as an
  // interaction — resume at the fast base cadence.
  const onVisibilityChange = () => {
    if (timeoutId != null) {
      clearTimeoutFn(timeoutId);
      timeoutId = null;
    }
    if (isHidden()) return undefined;
    reset();
    return runTick();
  };

  const removeVisibilityListener = addVisibilityListener(onVisibilityChange);
  scheduleNext();

  const stop = () => {
    stopped = true;
    removeVisibilityListener();
    if (timeoutId != null) {
      clearTimeoutFn(timeoutId);
      timeoutId = null;
    }
  };

  return { stop, reset };
}
