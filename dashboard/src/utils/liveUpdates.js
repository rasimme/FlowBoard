/**
 * Optional push source for board changes (T-515-8).
 *
 * Standalone, the dashboard polls: 5 s while things change, backing off to
 * 30 s. A host page that can deliver change events installs a source here;
 * the dashboard then refreshes when an event arrives and keeps only the slow
 * poll as a safety net for changes the host does not announce.
 *
 * `subscribe(listener)` returns an unsubscribe function. `focus(project)`
 * tells the host which board is on screen (null when none), so it can watch
 * that board in detail.
 */
let source = null;

export function setLiveUpdates(next) {
  source = next && typeof next.subscribe === 'function' ? next : null;
}

export function getLiveUpdates() {
  return source;
}
