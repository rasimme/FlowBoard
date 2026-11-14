import { useLayoutEffect, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useAppState } from '../context/AppStateContext.jsx';
import { useDashboard } from '../context/DashboardContext.jsx';
import { VIEWS, getView } from '../config/views.js';
import { shellQuery, usesHostChrome } from '../utils/shell.js';
import { Menu } from 'lucide-react';
import SearchButton from './SearchButton.jsx';
import SnippetUpgrade from './SnippetUpgrade.jsx';

/**
 * React-owned Tab Bar — renders via portal into the existing .tab-bar element.
 *
 * Replaces the static HTML tab buttons. On tab click:
 * - Updates currentTab in appState via dispatch
 * - For legacy-owned views, calls switchTab() to trigger vanilla rendering
 * - For react-owned views, ViewShell handles rendering
 */
export default function TabBar() {
  const { state, dispatch } = useAppState();
  const { switchTab, toggleSidebar } = useDashboard();
  // The host page supplies the header; its tools move into the tab bar (T-515-2).
  const hostChrome = usesHostChrome();
  const [container, setContainer] = useState(null);
  const rightSlotRef = useRef(null);

  useLayoutEffect(() => {
    const el = shellQuery('#tabBar');
    if (el) {
      // Preserve nothing — React owns the full tab bar now
      el.innerHTML = '';
      setContainer(el);
    }
  }, []);

  if (!container || !state) return null;

  const currentTab = state.currentTab || 'overview';

  function handleTabClick(viewId) {
    if (viewId === currentTab) return;

    const view = getView(viewId);

    // Update shared state so both React and legacy see the new tab
    dispatch({ currentTab: viewId });

    if (view?.owner === 'legacy') {
      // Let legacy switchTab handle DOM rendering for this view
      switchTab(viewId);
    }
    // For react-owned views, ViewShell picks up the currentTab change automatically
  }

  return createPortal(
    <>
      {hostChrome && (
        <button
          className="w-8 h-8 mr-1 flex items-center justify-center border-none bg-transparent text-muted cursor-pointer rounded-[6px] hover:text-text hover:bg-bg-hover"
          title="Toggle project list"
          aria-label="Toggle project list"
          onClick={toggleSidebar}
        >
          <Menu size={17} />
        </button>
      )}
      {VIEWS.filter(v => !v.hidden).map(view => {
        const isActive = currentTab === view.id;
        return (
          <button
            key={view.id}
            className={['tab', isActive && 'active'].filter(Boolean).join(' ')}
            data-tab={view.id}
            onClick={() => handleTabClick(view.id)}
          >
            {view.label}
          </button>
        );
      })}
      <span className="flex-1" />
      {hostChrome && (
        <span className="flex items-center gap-1.5" data-host-chrome-tools>
          <SearchButton projects={state.projects} />
          <SnippetUpgrade />
        </span>
      )}
      <span id="tabBarRight" ref={rightSlotRef} />
    </>,
    container
  );
}
