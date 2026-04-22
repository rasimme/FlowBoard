import { useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Menu } from 'lucide-react';
import { useAppState } from '../context/AppStateContext.jsx';
import { formatDisplayName } from '../utils.js';
import SnippetUpgrade from './SnippetUpgrade.jsx';
import logoSvg from '/favicon.svg';

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

  return createPortal(
    <>
      <div className="flex items-center gap-3">
        <button
          className="w-9 h-9 flex items-center justify-center border-none bg-transparent text-muted cursor-pointer rounded-[6px] transition-all duration-normal text-lg hover:text-text hover:bg-bg-hover"
          title="Toggle sidebar"
          onClick={() => {
            document.getElementById('app')?.classList.toggle('sidebar-collapsed');
            window.Telegram?.WebApp?.HapticFeedback?.impactOccurred('light');
          }}
        >
          <Menu size={18} />
        </button>
        <span className="header-logo">
          <img src={logoSvg} alt="FlowBoard" />
        </span>
        <div className="header-brand">
          <div className="header-title">FlowBoard</div>
          <div className="header-subtitle">Project Management</div>
        </div>
      </div>
      <div className="flex items-center gap-2.5" id="headerRight">
        <SnippetUpgrade />
        {state.viewedProject && (
          <>
            <span className="text-[13px] font-semibold text-text-strong tracking-[0.02em]">
              {formatDisplayName(state.viewedProject, state.projects)}
            </span>
          </>
        )}
      </div>
    </>,
    container
  );
}
