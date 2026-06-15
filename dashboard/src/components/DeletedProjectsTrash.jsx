import { useCallback, useEffect, useState } from 'react';
import { Trash2, ArchiveRestore, ChevronRight } from 'lucide-react';
import { apiFetch } from '../utils/apiFetch.js';
import { useDashboard } from '../context/DashboardContext.jsx';

/**
 * DeletedProjectsTrash (T-358) — a collapsible "Trash" list at the bottom of the
 * sidebar showing hard-deleted projects (GET /api/projects/deleted) with a
 * Restore action (POST /api/projects/:name/restore). This is the UI side of the
 * recovery path that was previously only possible by hand. Self-contained:
 * fetches its own list, reloads on any appstate change (so a fresh delete shows
 * up), and refreshes the project list after a restore so the project reappears.
 */
export default function DeletedProjectsTrash() {
  const { refreshProjectsOnly } = useDashboard();
  const [deleted, setDeleted] = useState([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/projects/deleted');
      if (!res.ok) return;
      const data = await res.json().catch(() => ({}));
      setDeleted(Array.isArray(data.projects) ? data.projects : []);
    } catch { /* fail-silent: trash is a non-critical affordance */ }
  }, []);

  // Load on mount, and re-load whenever app state changes (e.g. after a delete
  // or restore dispatches appstate:change) so the list stays current.
  useEffect(() => {
    load();
    const h = () => load();
    window.addEventListener('appstate:change', h);
    return () => window.removeEventListener('appstate:change', h);
  }, [load]);

  const restore = useCallback(async (name) => {
    setBusy(name);
    try {
      const res = await apiFetch(`/api/projects/${encodeURIComponent(name)}/restore`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        window.showToast?.(`Restored ${name}`, 'success');
        await load();
        await refreshProjectsOnly(); // brings the project back into the sidebar
      } else {
        window.showToast?.(data.error || `Restore failed (${res.status})`, 'error');
      }
    } catch (e) {
      window.showToast?.(`Restore failed: ${e.message}`, 'error');
    } finally {
      setBusy(null);
    }
  }, [load, refreshProjectsOnly]);

  if (deleted.length === 0) return null;

  return (
    <div className="sidebar-trash" data-sidebar-trash style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, width: '100%',
          background: 'transparent', border: 0, color: 'var(--muted)', cursor: 'pointer',
          font: 'inherit', fontSize: 12, padding: '4px 6px',
        }}
      >
        <ChevronRight size={13} style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform var(--duration-fast)' }} />
        <Trash2 size={13} />
        <span>Trash ({deleted.length})</span>
      </button>
      {open && (
        <ul style={{ listStyle: 'none', margin: 0, padding: '2px 0 0' }}>
          {deleted.map(d => (
            <li
              key={d.name}
              data-trash-project={d.name}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 6px 3px 22px' }}
            >
              <span className="mono truncate" title={d.name} style={{ flex: 1, fontSize: 12, color: 'var(--text)' }}>{d.name}</span>
              <button
                type="button"
                disabled={busy === d.name}
                onClick={() => restore(d.name)}
                title={`Restore ${d.name}`}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  background: 'transparent', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                  color: 'var(--text)', cursor: busy === d.name ? 'default' : 'pointer',
                  fontSize: 11, padding: '2px 8px', opacity: busy === d.name ? 0.6 : 1,
                }}
              >
                <ArchiveRestore size={12} />
                <span>{busy === d.name ? 'Restoring…' : 'Restore'}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
