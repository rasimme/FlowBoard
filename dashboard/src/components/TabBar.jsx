import { useLayoutEffect, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useAppState } from '../context/AppStateContext.jsx';
import { VIEWS, getView } from '../config/views.js';

/**
 * React-owned Tab Bar — renders via portal into the existing .tab-bar element.
 *
 * Replaces the static HTML tab buttons. On tab click:
 * - Updates currentTab in appState via dispatch
 * - For legacy-owned views, calls window._switchTab() to trigger vanilla rendering
 * - For react-owned views, ViewShell handles rendering
 */
export default function TabBar() {
  const { state, dispatch } = useAppState();
  const [container, setContainer] = useState(null);
  const rightSlotRef = useRef(null);

  useLayoutEffect(() => {
    const el = document.getElementById('tabBar');
    if (el) {
      // Preserve nothing — React owns the full tab bar now
      el.innerHTML = '';
      setContainer(el);
    }
  }, []);

  if (!container || !state) return null;

  const currentTab = state.currentTab || 'tasks';

  function handleTabClick(viewId) {
    if (viewId === currentTab) return;

    const view = getView(viewId);

    // Update shared state so both React and legacy see the new tab
    dispatch({ currentTab: viewId });

    if (view?.owner === 'legacy') {
      // Let legacy switchTab handle DOM rendering for this view
      window._switchTab?.(viewId);
    }
    // For react-owned views, ViewShell picks up the currentTab change automatically
  }

  return createPortal(
    <>
      {VIEWS.filter(v => !v.hidden).map(view => {
        const isActive = currentTab === view.id;
        return (
          <button
            key={view.id}
            className={[
              'flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium cursor-pointer border rounded-full transition-all bg-card font-[inherit]',
              isActive
                ? 'text-white bg-accent border-accent hover:bg-accent-hover'
                : 'text-text border-border hover:bg-bg-hover hover:border-border-strong',
            ].join(' ')}
            data-tab={view.id}
            onClick={() => handleTabClick(view.id)}
          >
            {view.label}
          </button>
        );
      })}
      <span className="flex-1" />
      <span id="tabBarRight" ref={rightSlotRef} />
    </>,
    container
  );
}
