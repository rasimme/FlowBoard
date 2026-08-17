import { createContext, useContext, useEffect, useSyncExternalStore } from 'react';
import { fetchAgentsList } from '../utils/dashboardApi.js';
import { subscribe, getVersion, getState, dispatch as storeDispatch, notifyChange } from '../state/appStore.mjs';

const AppStateContext = createContext(null);

// T-360 / ADR-0026: the store is owned by src/state/appStore.mjs. window.appState
// is a transparent Proxy over it (installed by bootstrap), so every write —
// in-app or via the global — goes through the store and notifies React. This
// provider just bridges that store into React: `state` is the immutable snapshot
// (fresh ref per change → identity/memo are meaningful), `dispatch` is the one
// write path, and `version` drives re-renders via useSyncExternalStore.
export function AppStateProvider({ children }) {
  const version = useSyncExternalStore(subscribe, getVersion, getVersion);

  // Fetch agents on mount so React doesn't render with an empty agents array.
  // The shared dashboard API loader enforces the same JSON/schema/deadline
  // contract as DashboardContext. A late response may only replace the exact
  // array that existed when this request started; a newer full snapshot wins.
  useEffect(() => {
    const controller = new AbortController();
    const agentsAtStart = window.appState?.agents;

    fetchAgentsList(controller.signal, {
      headers: { 'X-FlowBoard-Load': 'app-state-initial-agents' },
    }).then((agents) => {
      if (!controller.signal.aborted && window.appState?.agents === agentsAtStart) {
        storeDispatch({ agents });
      }
    }).catch((error) => {
      if (error?.kind !== 'aborted') {
        console.warn('[AppStateProvider] initial agents fetch failed:', error);
      }
    });

    return () => controller.abort(new DOMException('AppStateProvider unmounted', 'AbortError'));
  }, []);

  // Legacy bridge: appStateBridge.notify() / external code can force a re-render.
  useEffect(() => {
    window._notifyReact = notifyChange;
    return () => { delete window._notifyReact; };
  }, []);

  const value = { state: getState(), version, dispatch: storeDispatch };

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
