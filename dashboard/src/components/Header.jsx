import { useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Menu, Search } from 'lucide-react';
import { useAppState } from '../context/AppStateContext.jsx';
import { formatDisplayName } from '../utils/formatting.js';
import SnippetUpgrade from './SnippetUpgrade.jsx';
import SearchPalette from './SearchPalette.jsx';
import logoSvg from '/favicon.svg';

export default function Header() {
  const { state } = useAppState();
  const [container, setContainer] = useState(null);
  const [searchOpen, setSearchOpen] = useState(false);

  // Cmd/Ctrl+K opens the global task search (T-301)
  useLayoutEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

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
        <button
          className="w-9 h-9 flex items-center justify-center border-none bg-transparent text-muted cursor-pointer rounded-[6px] transition-all duration-normal hover:text-text hover:bg-bg-hover"
          title="Search tasks (⌘K)"
          aria-label="Search tasks"
          onClick={() => setSearchOpen(true)}
        >
          <Search size={17} />
        </button>
        <SearchPalette open={searchOpen} onClose={() => setSearchOpen(false)} projects={state.projects} />
        <SnippetUpgrade />
        {state.viewedProject ? (
          <span className="text-[13px] tracking-[0.02em]">
            <span className="text-muted font-normal mr-1">Project:</span>
            <span className="font-semibold text-text-strong">
              {formatDisplayName(state.viewedProject, state.projects)}
            </span>
          </span>
        ) : (
          <span className="text-[13px] text-muted tracking-[0.02em]">
            No active project
          </span>
        )}
      </div>
    </>,
    container
  );
}
