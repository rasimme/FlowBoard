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
import { usesHostChrome } from './utils/shell.js';
import { useEffect } from 'react';
import { getState } from './state/appStore.mjs';
import { subscribeDeepLink, takeDeepLink } from './utils/deepLink.js';

// T-515-6: act on a project/task request from the host page's parameters or
// from the native widget and panel. Sits after DetailPanel so the task opener
// is installed.
function DeepLinkBridge() {
  const { viewProject, switchTab } = useDashboard();
  useEffect(() => {
    const apply = async () => {
      const link = takeDeepLink();
      if (!link) return;
      if (!(getState().projects || []).some((p) => p?.name === link.project)) return;
      if (getState().viewedProject !== link.project) await viewProject(link.project);
      if (link.task) {
        switchTab('tasks');
        window.openTaskDetail?.(link.task);
      }
    };
    apply();
    return subscribeDeepLink(apply);
  }, [viewProject, switchTab]);
  return null;
}

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
          {!usesHostChrome() && <Header />}
          <Sidebar />
          <TabBar />
          <ViewShell />
          <DetailPanel />
          <DeepLinkBridge />
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
