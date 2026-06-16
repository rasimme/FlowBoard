// The React-owned application store (T-360 / ADR-0026).
//
// `window.appState` is a thin transparent Proxy over a module-private `base`
// object: reads come from the store, and writes/deletes forward INTO it and
// notify subscribers. This makes the store — not the window global — the source
// of truth, while keeping every existing `window.appState` reader/writer working
// unchanged (the bootstrap auth writes, appStateBridge, and the browser-test
// driving hook). Crucially, because every write goes through the Proxy, there is
// no "un-notified mutation" path anymore — which is exactly why the old 5s
// fingerprint watchdog existed. React reads an IMMUTABLE snapshot that is
// replaced on each change, so identity/memo stay meaningful.

const INITIAL = {
  projects: [],
  activeProject: null,
  viewedProject: null,
  tasks: [],
  currentTab: 'overview',
  agents: [],
  agentId: null,
  agentIdSource: null,
  agentIdChatBound: false,
};

// `base` is the live, mutable object the Proxy wraps (stable identity → no Proxy
// invariant pitfalls). `snapshot` is the immutable copy React consumes; it is
// replaced on every change so its reference changes exactly when data changes.
const base = { ...INITIAL };
let snapshot = { ...base };
let version = 0;
const listeners = new Set();

function commit() {
  snapshot = { ...base };
  version += 1;
  listeners.forEach((l) => l());
}

/** Immutable snapshot for React consumers (new ref per change). */
export function getState() { return snapshot; }
/** Monotonic version for useSyncExternalStore. */
export function getVersion() { return version; }
/** Subscribe to store changes; returns an unsubscribe fn. */
export function subscribe(cb) { listeners.add(cb); return () => listeners.delete(cb); }
/** The one write path for app code: merge a patch and notify. */
export function dispatch(updates) {
  if (updates && typeof updates === 'object') {
    Object.assign(base, updates);
    commit();
  }
}
/** Force a re-render (used to bridge legacy `appstate:change` events). */
export function notifyChange() { commit(); }

/**
 * Install `window.appState` as a Proxy over the store. Idempotent. Called once
 * by bootstrap.js before any other code touches window.appState.
 */
export function installAppStateProxy() {
  if (typeof window === 'undefined') return;
  if (window.__appStateProxyInstalled) return;
  // Absorb anything written onto a plain window.appState before install.
  if (window.appState && typeof window.appState === 'object') {
    Object.assign(base, window.appState);
  }
  window.appState = new Proxy(base, {
    set(target, prop, value) { target[prop] = value; commit(); return true; },
    deleteProperty(target, prop) { delete target[prop]; commit(); return true; },
  });
  window.__appStateProxyInstalled = true;
  // Bridge legacy/external `appstate:change` dispatches (appStateBridge.notify,
  // bootstrap, tests) into a re-render. Writes through the Proxy already notify;
  // this just covers a bare event with no accompanying Proxy write.
  window.addEventListener('appstate:change', notifyChange);
  commit();
}
