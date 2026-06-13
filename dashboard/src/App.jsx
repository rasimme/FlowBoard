import { AppStateProvider } from './context/AppStateContext.jsx';
import { DashboardProvider } from './context/DashboardContext.jsx';
import { SpecifyProvider } from './context/SpecifyContext.jsx';
import Header from './components/Header.jsx';
import Sidebar from './components/Sidebar.jsx';
import TabBar from './components/TabBar.jsx';
import ViewShell from './components/ViewShell.jsx';
import DetailPanel from './components/DetailPanel.jsx';
import CanvasMigrationBanner from './components/CanvasMigrationBanner.jsx';

function AppWithSpecify() {
  return (
    <AppStateProvider>
      <DashboardProvider>
        <Header />
        <Sidebar />
        <TabBar />
        <ViewShell />
        <DetailPanel />
        <CanvasMigrationBanner />
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
