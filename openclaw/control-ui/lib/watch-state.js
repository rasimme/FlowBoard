/**
 * The state one `feature.watch` view can be in (T-487-8).
 *
 * `watch` re-runs its query on contract events and after a reconnect, and its
 * failures are ordinary and transient (the Gateway drops, FlowBoard restarts).
 * The rule encoded here: **a refresh failure never blanks a list that already
 * has data.** The rail keeps showing the last good answer, marks itself stale,
 * and replaces it only when a newer answer arrives.
 *
 * Pure reducer, unit-tested in dashboard/test-control-ui-lib.js.
 */

/** @typedef {'loading'|'ready'|'empty'|'error'|'stale'} WatchPhase */

export function initialWatchState() {
  return { phase: 'loading', data: null, error: null, updatedAt: null };
}

export function watchReducer(state = initialWatchState(), action = {}) {
  switch (action.type) {
    case 'data': {
      return {
        phase: action.empty ? 'empty' : 'ready',
        data: action.data ?? null,
        error: null,
        updatedAt: action.at ?? state.updatedAt,
      };
    }
    case 'error': {
      const message = action.error instanceof Error ? action.error.message : String(action.error ?? 'unknown error');
      return {
        // Data already on screen stays on screen; only its freshness changes.
        phase: state.data === null ? 'error' : 'stale',
        data: state.data,
        error: message.slice(0, 300),
        updatedAt: state.updatedAt,
      };
    }
    case 'reset':
      return initialWatchState();
    default:
      return state;
  }
}

/** True while the view has nothing it could render yet. */
export function isBlank(state) {
  return !state || state.data === null;
}
