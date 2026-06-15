import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search, ListTodo, StickyNote, Folder } from 'lucide-react';
import Input from './Input.jsx';
import Badge from './Badge.jsx';
import Spinner from './Spinner.jsx';
import { formatDisplayName } from '../utils/formatting.js';
import { useDashboard } from '../context/DashboardContext.jsx';

/**
 * SearchPalette — global unified search (T-301, T-349).
 * Opens via the header button or Cmd/Ctrl+K, queries GET /api/search
 * (debounced) across tasks, canvas notes and projects; keyboard-navigable.
 * Selecting routes to the right surface: a task scrolls/highlights its
 * card, a note opens its project's Ideas canvas, a project is activated.
 */
export default function SearchPalette({ open, onClose, projects = [] }) {
  const { viewProject, switchTab } = useDashboard();
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
        // flatten the three kinds into one keyboard-navigable list
        const flat = res.ok ? [
          ...(data.tasks || []).map(t => ({ kind: 'task', ...t })),
          ...(data.notes || []).map(n => ({ kind: 'note', ...n })),
          ...(data.projects || []).map(p => ({ kind: 'project', ...p })),
        ] : [];
        setResults(flat);
        setActive(0);
      } finally {
        if (seq === seqRef.current) setLoading(false);
      }
    }, 200);
    return () => clearTimeout(debounceRef.current);
  }, [query, open]);

  const pick = useCallback((r) => {
    onClose?.();
    if (r.kind === 'task') {
      viewProject(r.project);
      // Switch to the Tasks tab so ScrollToTask actually mounts and consumes the
      // flag — without this, picking a task from Overview/Files/Ideas left
      // _scrollToTaskId set on a tab that never rendered (T-355). Mirrors the
      // note branch below.
      switchTab('tasks');
      window._scrollToTaskId = r.id;
    } else if (r.kind === 'note') {
      viewProject(r.project);
      switchTab('ideas');
      window._scrollToNoteId = r.id; // canvas consumes if it supports it
    } else if (r.kind === 'project') {
      viewProject(r.name);
    }
  }, [onClose, viewProject, switchTab]);

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
            placeholder="Search tasks, notes & projects across all projects…"
            className="border-0 bg-transparent focus:border-0 px-0 py-0"
            aria-label="Search query"
          />
          {loading && <Spinner size="sm" />}
        </div>
        {results.length > 0 && (
          <ul className="max-h-[50vh] overflow-y-auto list-none m-0 p-1" role="listbox">
            {results.map((r, i) => (
              <li key={`${r.kind}:${r.project || ''}:${r.id || r.name}`} role="option" aria-selected={i === active}>
                <button
                  type="button"
                  onClick={() => pick(r)}
                  onMouseEnter={() => setActive(i)}
                  className={`flex items-center gap-2 w-full px-3 py-2 text-left rounded-md border-0 cursor-pointer ${
                    i === active ? 'bg-bg-hover' : 'bg-transparent'
                  }`}
                >
                  {r.kind === 'task' && (
                    <>
                      <ListTodo size={14} className="text-muted shrink-0" />
                      <span className="mono text-[11px] text-muted shrink-0">{r.id}</span>
                      <span className="text-sm text-text truncate flex-1">{r.title}</span>
                      <Badge>{formatDisplayName(r.project, projects)}</Badge>
                      <span className="text-[11px] text-muted shrink-0">{r.status}</span>
                    </>
                  )}
                  {r.kind === 'note' && (
                    <>
                      <StickyNote size={14} className="text-muted shrink-0" />
                      <span className="text-sm text-text truncate flex-1">{r.text || '(empty note)'}</span>
                      <Badge>{formatDisplayName(r.project, projects)}</Badge>
                      <span className="text-[11px] text-muted shrink-0">note</span>
                    </>
                  )}
                  {r.kind === 'project' && (
                    <>
                      <Folder size={14} className="text-muted shrink-0" />
                      <span className="text-sm text-text truncate flex-1">{r.displayName}</span>
                      <span className="text-[11px] text-muted shrink-0">project</span>
                    </>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
        {!loading && query.trim() && results.length === 0 && (
          <div className="px-4 py-6 text-sm text-muted text-center">No tasks, notes or projects found</div>
        )}
      </div>
    </div>,
    document.getElementById('modalRoot') || document.body
  );
}
