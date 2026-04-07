import { useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppState } from '../context/AppStateContext.jsx';
import { formatDisplayName } from '../utils.js';

export default function Header() {
  const { state } = useAppState();
  const [container, setContainer] = useState(null);

  useLayoutEffect(() => {
    const el = document.querySelector('.header');
    if (el) {
      el.innerHTML = '';
      setContainer(el);
    }
  }, []);

  if (!container || !state) return null;

  const isActive = state.viewedProject && state.viewedProject === state.activeProject;

  return createPortal(
    <>
      <div className="header-left">
        <button
          className="sidebar-toggle"
          title="Toggle sidebar"
          onClick={() => {
            document.getElementById('app')?.classList.toggle('sidebar-collapsed');
            window.Telegram?.WebApp?.HapticFeedback?.impactOccurred('light');
          }}
        >
          ☰
        </button>
        <span className="header-logo">
          <img src="./favicon.svg" alt="FlowBoard" />
        </span>
        <div className="header-brand">
          <div className="header-title">FlowBoard</div>
          <div className="header-subtitle">Project Management</div>
        </div>
      </div>
      <div className="header-right" id="headerRight">
        {state.viewedProject && (
          <>
            <span className="header-project">
              {formatDisplayName(state.viewedProject, state.projects)}
            </span>
            {isActive && <span className="badge-active">Active</span>}
          </>
        )}
      </div>
    </>,
    container
  );
}
