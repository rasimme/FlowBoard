import { createContext, useContext, useReducer, useEffect, useRef, useCallback } from 'react';

const AppStateContext = createContext(null);

/**
 * Lightweight fingerprint of window.appState for change detection.
 * Avoids expensive JSON.stringify on the full tasks array every tick.
 */
function fingerprint(s) {
  if (!s) return '';
  return [
    s.viewedProject,
    s.activeProject,
    s.currentTab,
    s.projects?.length,
    s.tasks?.length,
    // Include a rough tasks fingerprint — first and last task IDs + statuses
    s.tasks?.[0]?.id,
    s.tasks?.[0]?.status,
    s.tasks?.[s.tasks.length - 1]?.id,
    s.tasks?.[s.tasks.length - 1]?.status,
  ].join('|');
}

export function AppStateProvider({ children }) {
  const [version, bump] = useReducer(x => x + 1, 0);
  const lastFp = useRef('');

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
