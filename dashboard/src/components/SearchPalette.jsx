import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search } from 'lucide-react';
import Input from './Input.jsx';
import Badge from './Badge.jsx';
import Spinner from './Spinner.jsx';
import { formatDisplayName } from '../utils/formatting.js';

/**
 * SearchPalette — global cross-project task search (T-301).
 * Opens via the header button or Cmd/Ctrl+K, queries GET /api/search
 * (debounced), keyboard-navigable; selecting a result switches to the
 * task's project and scrolls/highlights the card.
 */
export default function SearchPalette({ open, onClose, projects = [] }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);
  const overlayRef = useRef(null);
  const debounceRef = useRef(null);
  const seqRef = useRef(0);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setResults([]);
    setActive(0);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    if (!query.trim()) {
      setResults([]);
      setLoading(false);
      return undefined;
    }
    setLoading(true);
    clearTimeout(debounceRef.current);
    const seq = ++seqRef.current;
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query.trim())}&limit=15`, { credentials: 'include' });
        const data = await res.json().catch(() => ({}));
        if (seq !== seqRef.current) return; // stale response
        setResults(res.ok ? (data.tasks || []) : []);
        setActive(0);
      } finally {
        if (seq === seqRef.current) setLoading(false);
      }
    }, 200);
    return () => clearTimeout(debounceRef.current);
  }, [query, open]);

  const pick = useCallback((task) => {
    onClose?.();
    window._viewProject?.(task.project);
    window._scrollToTaskId = task.id;
  }, [onClose]);

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') { onClose?.(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter' && results[active]) { e.preventDefault(); pick(results[active]); }
  };

  if (!open) return null;

  return createPortal(
    <div
      ref={overlayRef}
      onClick={(e) => { if (e.target === overlayRef.current) onClose?.(); }}
      className="fixed inset-0 z-[1000] flex justify-center bg-black/60 pt-[12vh]"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Task search"
        className="bg-card border border-border rounded-lg shadow-lg w-full max-w-xl mx-4 h-fit overflow-hidden animate-scale-in"
        onKeyDown={handleKeyDown}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
          <Search size={16} className="text-muted shrink-0" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tasks across all projects…"
            className="border-0 bg-transparent focus:border-0 px-0 py-0"
            aria-label="Search query"
          />
          {loading && <Spinner size="sm" />}
        </div>
        {results.length > 0 && (
          <ul className="max-h-[50vh] overflow-y-auto list-none m-0 p-1" role="listbox">
            {results.map((t, i) => (
              <li key={`${t.project}:${t.id}`} role="option" aria-selected={i === active}>
                <button
                  type="button"
                  onClick={() => pick(t)}
                  onMouseEnter={() => setActive(i)}
                  className={`flex items-center gap-2 w-full px-3 py-2 text-left rounded-md border-0 cursor-pointer ${
                    i === active ? 'bg-bg-hover' : 'bg-transparent'
                  }`}
                >
                  <span className="mono text-[11px] text-muted shrink-0">{t.id}</span>
                  <span className="text-sm text-text truncate flex-1">{t.title}</span>
                  <Badge>{formatDisplayName(t.project, projects)}</Badge>
                  <span className="text-[11px] text-muted shrink-0">{t.status}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {!loading && query.trim() && results.length === 0 && (
          <div className="px-4 py-6 text-sm text-muted text-center">No tasks found</div>
        )}
      </div>
    </div>,
    document.getElementById('modalRoot') || document.body
  );
}
