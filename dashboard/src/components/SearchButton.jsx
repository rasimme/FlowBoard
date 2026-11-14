import { useLayoutEffect, useState } from 'react';
import { Search } from 'lucide-react';
import SearchPalette from './SearchPalette.jsx';
import { usesHostChrome } from '../utils/shell.js';

/**
 * Global task search (T-301): the magnifier button, the palette, and the
 * Cmd/Ctrl+K shortcut. Lives in the header standalone and in the tab bar when
 * a host page supplies the header (T-515-2).
 */
export default function SearchButton({ projects }) {
  const [open, setOpen] = useState(false);

  useLayoutEffect(() => {
    // Inside a host page Cmd/Ctrl+K belongs to the host's command palette.
    if (usesHostChrome()) return undefined;
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
      <button
        className="w-9 h-9 flex items-center justify-center border-none bg-transparent text-muted cursor-pointer rounded-[6px] transition-all duration-normal hover:text-text hover:bg-bg-hover"
        title={usesHostChrome() ? 'Search tasks' : 'Search tasks (⌘K)'}
        aria-label="Search tasks"
        onClick={() => setOpen(true)}
      >
        <Search size={17} />
      </button>
      <SearchPalette open={open} onClose={() => setOpen(false)} projects={projects} />
    </>
  );
}
