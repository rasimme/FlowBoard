import { createContext, useContext, useReducer, useEffect, useRef, useCallback } from 'react';

const AppStateContext = createContext(null);

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
    s.currentTab,
    s.projects?.length,
    tasksHash,
    agentsHash,
  ].join('|');
}

export function AppStateProvider({ children }) {
  const [version, bump] = useReducer(x => x + 1, 0);
  const lastFp = useRef('');
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
        // Poll briefly; app.js initialises window.appState synchronously.
        for (let i = 0; i < 10 && !window.appState; i++) await sleep(50);
      }
      if (!window.appState) {
        console.warn('[AppStateProvider] window.appState not ready after 500ms');
        return;
      }
      try {
        const res = await fetch('/api/agents', { credentials: 'include' });
        if (!res.ok) return;
        const data = await res.json();
        const agents = Array.isArray(data?.agents) ? data.agents : [];
        window.appState.agents = agents;
        window.dispatchEvent(new CustomEvent('appstate:change'));
      } catch (err) {
        console.warn('[AppStateProvider] initial agents fetch failed:', err);
      }
    }
    fetchAgents();
  }, []);

  useEffect(() => {
    // Poll for changes to window.appState (lightweight fingerprint check)
    const interval = setInterval(() => {
      const fp = fingerprint(window.appState);
      if (fp !== lastFp.current) {
        lastFp.current = fp;
        bump();
      }
    }, 500);

    // Also accept explicit notifications from legacy code
    const handler = () => {
      lastFp.current = fingerprint(window.appState);
      bump();
    };
    window.addEventListener('appstate:change', handler);

    return () => {
      clearInterval(interval);
      window.removeEventListener('appstate:change', handler);
    };
  }, []);

  // Expose a notify function so legacy code can trigger React re-renders
  useEffect(() => {
    window._notifyReact = () => {
      window.dispatchEvent(new CustomEvent('appstate:change'));
    };
    return () => { delete window._notifyReact; };
  }, []);

  // dispatch: update legacy appState and notify React
  const dispatch = useCallback((updates) => {
    if (window.appState) {
      Object.assign(window.appState, updates);
    }
    window.dispatchEvent(new CustomEvent('appstate:change'));
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
