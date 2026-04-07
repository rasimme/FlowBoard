import { AppStateProvider } from './context/AppStateContext.jsx';
import Header from './components/Header.jsx';
import Sidebar from './components/Sidebar.jsx';
import TabBar from './components/TabBar.jsx';
import ViewShell from './components/ViewShell.jsx';

/**
 * React app shell — wraps all React UI with the state bridge.
 *
 * Header, Sidebar, and TabBar render via portals into existing legacy DOM
 * containers (.header, #sidebar, #tabBar), preserving the CSS grid layout.
 * ViewShell portals into #content for React-owned views; legacy views are
 * rendered by vanilla switchTab() — ViewShell stays out of the way.
 */
export default function App() {
  return (
    <AppStateProvider>
      <Header />
      <Sidebar />
      <TabBar />
      <ViewShell />
    </AppStateProvider>
  );
}
