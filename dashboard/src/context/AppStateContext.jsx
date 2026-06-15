import { createContext, useContext, useEffect, useRef, useCallback, useSyncExternalStore } from 'react';

const AppStateContext = createContext(null);
const APPSTATE_EVENT = 'appstate:change';
let appStateVersion = 0;

// T-355: expose an IMMUTABLE shallow snapshot of window.appState as the context
// `state` instead of the live mutable object. Previously `state: window.appState`
// was the same reference on every render, so identity/memo checks on `state`
// were meaningless. Now a fresh object is built on each change, so consumers can
// rely on `state` identity changing exactly when the data changes. window.appState
// remains the underlying store (still mutated directly by ~10 call sites + legacy
// app.js, which is why the watchdog stays); the snapshot is a read-only view.
let currentSnapshot = buildSnapshot();
function buildSnapshot() {
  return (typeof window !== 'undefined' && window.appState) ? { ...window.appState } : null;
}

function notifyAppStateChanged() {
  window.dispatchEvent(new CustomEvent(APPSTATE_EVENT));
}

function subscribeAppState(callback) {
  if (typeof window === 'undefined') return () => {};

  const publish = () => {
    currentSnapshot = buildSnapshot(); // fresh immutable view for this change
    appStateVersion += 1;
    callback();
  };

  const handler = () => publish();
  window.addEventListener(APPSTATE_EVENT, handler);

  // T-356: the 5s fingerprint watchdog was removed. Every update to a rendered
  // field now goes through dispatch() (which fires APPSTATE_EVENT) or an
  // explicit notify (bootstrap auth, agents fetch), so there are no un-notified
  // mutations left to poll for.
  return () => {
    window.removeEventListener(APPSTATE_EVENT, handler);
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

  // Pick up a late legacy init (window.appState created after this module loaded)
  // on the next render without waiting for a publish.
  if (!currentSnapshot && typeof window !== 'undefined' && window.appState) {
    currentSnapshot = buildSnapshot();
  }
  // The value changes when version changes, triggering consumer re-renders.
  // `state` is an immutable snapshot whose identity changes only on real updates.
  const value = { state: currentSnapshot, version, dispatch };

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
