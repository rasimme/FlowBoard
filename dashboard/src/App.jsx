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
import EmbedShell from './embed/EmbedShell.jsx';
import { getEmbed } from './embed/embedRuntime.js';

function DashboardShell() {
  const { state } = useDashboard();
  const blocksShell = !state?.connection?.hasData;
  // T-499: null unless a verified host frames a single surface (?embed=…).
  const embed = getEmbed();

  return (
    <>
      <DashboardConnectionState />
      {!blocksShell && embed && <EmbedShell embed={embed} />}
      {!blocksShell && !embed && (
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

// SpecifyProvider renders the SpecifyStepper, which reads useDashboard() and
// useNavigation(); it must sit inside both providers or opening the stepper
// throws "useDashboard must be used within DashboardProvider" and unmounts the
// whole tree (found while wiring the T-499 framed Specify surface).
export default function App() {
  return (
    <NavigationProvider>
      <AppStateProvider>
        <DashboardProvider>
          <SpecifyProvider>
            <DashboardShell />
          </SpecifyProvider>
        </DashboardProvider>
      </AppStateProvider>
    </NavigationProvider>
  );
}
