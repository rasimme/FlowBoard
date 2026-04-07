import { AppStateProvider } from './context/AppStateContext.jsx';
import Header from './components/Header.jsx';
import Sidebar from './components/Sidebar.jsx';

/**
 * React app shell — wraps all React UI with the state bridge.
 *
 * Header and Sidebar render via portals into the existing legacy DOM
 * containers (.header, #sidebar), preserving the CSS grid layout.
 * Legacy renderSidebar/renderHeader are no-ops once React mounts.
 */
export default function App() {
  return (
    <AppStateProvider>
      <Header />
      <Sidebar />
    </AppStateProvider>
  );
}
