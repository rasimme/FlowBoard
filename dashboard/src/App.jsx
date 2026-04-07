import { AppStateProvider } from './context/AppStateContext.jsx';

/**
 * React app shell — wraps all future React UI with the state bridge.
 *
 * Currently renders nothing visible; T-137-3 will mount the header
 * and sidebar here. The shell exists to:
 *  1. Establish the AppStateProvider (bridge to legacy window.appState)
 *  2. Provide a stable React tree for incremental migration
 */
export default function App() {
  return (
    <AppStateProvider>
      {/* T-137-3 will add <Header /> and <Sidebar /> here */}
    </AppStateProvider>
  );
}
