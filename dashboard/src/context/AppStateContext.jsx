import { createContext, useContext, useEffect, useRef, useCallback, useSyncExternalStore } from 'react';

const AppStateContext = createContext(null);
const APPSTATE_EVENT = 'appstate:change';
const LEGACY_WATCHDOG_MS = 5000;
let appStateVersion = 0;
let lastSnapshotFingerprint = '';

/**
 * Lightweight fingerprint of window.appState for change detection.
 * Avoids expensive JSON.stringify on the full tasks array every tick.
 */
function fingerprint(s) {
  if (!s) return '';
  // Build a compact tasks hash. Includes agent/claimedAt so the C2 Labeled bar
  // re-renders when a claim changes on a task even if status/priority don't.
  const tasksHash = s.tasks
    ? s.tasks.map(t => t.id + t.status + t.priority + (t.agent || '') + (t.claimedAt || '')).join(',')
    : '';
  const agentsHash = s.agents
    ? s.agents.map(a => (a.agent_id || '') + ':' + (a.active_project || '')).join(',')
    : '';
  return [
    s.viewedProject,
    s.activeProject,
    s.authUser,
    s.currentTab,
    s.projects?.length,
    tasksHash,
    agentsHash,
  ].join('|');
}

function notifyAppStateChanged() {
  window.dispatchEvent(new CustomEvent(APPSTATE_EVENT));
}

function subscribeAppState(callback) {
  if (typeof window === 'undefined') return () => {};

  const publish = () => {
    lastSnapshotFingerprint = fingerprint(window.appState);
    appStateVersion += 1;
    callback();
  };

  const handler = () => publish();
  window.addEventListener(APPSTATE_EVENT, handler);

  // Legacy compatibility: older vanilla paths can still mutate window.appState
  // without dispatching appstate:change. Keep a slow watchdog so those paths do
  // not go stale, but make explicit events the normal render path.
  const interval = window.setInterval(() => {
    const fp = fingerprint(window.appState);
    if (fp !== lastSnapshotFingerprint) publish();
  }, LEGACY_WATCHDOG_MS);

  return () => {
    window.removeEventListener(APPSTATE_EVENT, handler);
    window.clearInterval(interval);
  };
}

function getAppStateSnapshot() {
  return appStateVersion;
}

export function AppStateProvider({ children }) {
  const version = useSyncExternalStore(
    subscribeAppState,
    getAppStateSnapshot,
    getAppStateSnapshot
  );
  const initDone = useRef(false);

  // T-161: fetch agents immediately on mount so React doesn't render with an
  // empty agents array while the legacy init block is still awaiting its own
  // fetch.  This removes the race between React mount and app.js init.
  useEffect(() => {
    if (initDone.current) return;
    initDone.current = true;

    // Wait for window.appState to be initialised by legacy app.js before
    // writing to it. app.js runs first (module script) so the window.appState
    // object should exist before this effect fires.  50ms gives the browser
    // enough time to execute app.js top-to-bottom even on slow connections.
    async function fetchAgents() {
      if (!window.appState) {
        // Poll briefly; app.js initialises window.appState asynchronously.
        // Wait up to 2 seconds before giving up.
        for (let i = 0; i < 40 && !window.appState; i++) await new Promise(r => setTimeout(r, 50));
      }
      if (!window.appState) {
        console.warn('[AppStateProvider] window.appState not ready after 2000ms');
        return;
      }
      try {
        const res = await fetch('/api/agents', { credentials: 'include' });
        if (!res.ok) return;
        const data = await res.json();
        const agents = Array.isArray(data?.agents) ? data.agents : [];
        window.appState.agents = agents;
        notifyAppStateChanged();
      } catch (err) {
        console.warn('[AppStateProvider] initial agents fetch failed:', err);
      }
    }
    fetchAgents();
  }, []);

  // Expose a notify function so legacy code can trigger React re-renders
  useEffect(() => {
    window._notifyReact = () => {
      notifyAppStateChanged();
    };
    return () => { delete window._notifyReact; };
  }, []);

  // dispatch: update legacy appState and notify React
  const dispatch = useCallback((updates) => {
    if (window.appState) {
      Object.assign(window.appState, updates);
    }
    notifyAppStateChanged();
  }, []);

  // The value object changes when version changes, triggering consumer re-renders.
  // Consumers read from state (which is window.appState) directly.
  const value = { state: window.appState, version, dispatch };

  return (
    <AppStateContext.Provider value={value}>
      {children}
    </AppStateContext.Provider>
  );
}

export function useAppState() {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error('useAppState must be used within AppStateProvider');
  return ctx;
}

export default AppStateContext;
