import { AppStateProvider } from './context/AppStateContext.jsx';
import { DashboardProvider } from './context/DashboardContext.jsx';
import Header from './components/Header.jsx';
import Sidebar from './components/Sidebar.jsx';
import TabBar from './components/TabBar.jsx';
import ViewShell from './components/ViewShell.jsx';
import DetailPanel from './components/DetailPanel.jsx';

export default function App() {
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
