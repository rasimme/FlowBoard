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
      <div className="flex items-center gap-3">
        <button
          className="w-9 h-9 flex items-center justify-center border-none bg-transparent text-text-muted cursor-pointer rounded-[6px] transition-all duration-200 text-lg hover:text-text-primary hover:bg-bg-hover"
          title="Toggle sidebar"
          onClick={() => {
            document.getElementById('app')?.classList.toggle('sidebar-collapsed');
            window.Telegram?.WebApp?.HapticFeedback?.impactOccurred('light');
          }}
        >
          ☰
        </button>
        <span className="leading-none flex items-center max-[600px]:hidden">
          <img src="./favicon.svg" alt="FlowBoard" className="h-[30px] w-auto align-middle" />
        </span>
        <div className="flex flex-col">
          <div className="text-[15px] font-bold tracking-[0.05em] text-text-strong uppercase">FlowBoard</div>
          <div className="text-[10px] text-text-muted uppercase tracking-[0.06em] font-medium">Project Management</div>
        </div>
      </div>
      <div className="flex items-center gap-2.5" id="headerRight">
        {state.viewedProject && (
          <>
            <span className="text-[13px] font-semibold text-text-strong tracking-[0.02em]">
              {formatDisplayName(state.viewedProject, state.projects)}
            </span>
            {isActive && <span className="inline-flex px-2.5 py-[3px] rounded-full text-[10px] font-semibold text-accent border border-[#ff5c5c59] bg-accent-subtle uppercase tracking-[0.04em]">Active</span>}
          </>
        )}
      </div>
    </>,
    container
  );
}
