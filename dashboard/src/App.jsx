import { AppStateProvider } from './context/AppStateContext.jsx';
import { DashboardProvider } from './context/DashboardContext.jsx';
import { NavigationProvider } from './context/NavigationContext.jsx';
import { SpecifyProvider } from './context/SpecifyContext.jsx';
import Header from './components/Header.jsx';
import Sidebar from './components/Sidebar.jsx';
import TabBar from './components/TabBar.jsx';
import ViewShell from './components/ViewShell.jsx';
import DetailPanel from './components/DetailPanel.jsx';
import DashboardConnectionState from './components/DashboardConnectionState.jsx';
import { useDashboard } from './context/DashboardContext.jsx';

function DashboardShell() {
  const { state } = useDashboard();
  const blocksShell = !state?.connection?.hasData;

  return (
    <>
      <DashboardConnectionState />
      {!blocksShell && (
        <>
          <Header />
          <Sidebar />
          <TabBar />
          <ViewShell />
          <DetailPanel />
        </>
      )}
    </>
  );
}

function AppWithSpecify() {
  return (
    <AppStateProvider>
      <DashboardProvider>
        <DashboardShell />
      </DashboardProvider>
    </AppStateProvider>
  );
}

export default function App() {
  return (
    <NavigationProvider>
      <SpecifyProvider>
        <AppWithSpecify />
      </SpecifyProvider>
    </NavigationProvider>
  );
}
