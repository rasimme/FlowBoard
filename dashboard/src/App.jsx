import { useEffect } from 'react';
import { AppStateProvider } from './context/AppStateContext.jsx';
import { DashboardProvider } from './context/DashboardContext.jsx';
import { SpecifyProvider, useSpecify } from './context/SpecifyContext.jsx';
import Header from './components/Header.jsx';
import Sidebar from './components/Sidebar.jsx';
import TabBar from './components/TabBar.jsx';
import ViewShell from './components/ViewShell.jsx';
import DetailPanel from './components/DetailPanel.jsx';

function AppWithSpecify() {
  const specify = useSpecify();

  useEffect(() => {
    window.__showSpecifyStepper = (sessionId) => specify.show(sessionId);
    return () => {
      delete window.__showSpecifyStepper;
    };
  }, [specify]);

  return (
    <AppStateProvider>
      <DashboardProvider>
        <Header />
        <Sidebar />
        <TabBar />
        <ViewShell />
        <DetailPanel />
      </DashboardProvider>
    </AppStateProvider>
  );
}

export default function App() {
  return (
    <SpecifyProvider>
      <AppWithSpecify />
    </SpecifyProvider>
  );
}
