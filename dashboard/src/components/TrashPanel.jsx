import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, RotateCcw, Trash2 } from 'lucide-react';
import { apiFetch } from '../utils/apiFetch.js';

/**
 * TrashPanel — slide-in panel from the right (same pattern as
 * DetailPanel) showing every task in the viewed project whose
 * `flowboard.trashedAt` is set. Per-row Restore; footer Empty Trash
 * with confirmation dialog (two-step delete is the safety; no minimum
 * age gate, per design doc §2.2).
 *
 * Props:
 *   open            — whether the panel is shown
 *   project         — current project name
 *   trashedTasks    — pre-filtered list of tasks with trashedAt set
 *   onClose         — called when user closes the panel
 *   onRestore       — (taskId, prevStatus) → clear trashedAt, restore status
 *   onEmptied       — called after successful Empty Trash
 */
export default function TrashPanel({ open, project, trashedTasks, onClose, onRestore, onEmptied }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  async function handleEmpty() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await apiFetch(`/api/projects/${project}/tasks/trash`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to empty trash');
      if (window.showToast) {
        const n = (data.removed || []).length;
        window.showToast(`Trash emptied — ${n} task${n === 1 ? '' : 's'} permanently deleted`, 'success');
      }
      setConfirming(false);
      onEmptied?.();
    } catch (err) {
      if (window.showToast) window.showToast('Empty Trash failed: ' + err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  function formatWhen(iso) {
    if (!iso) return '';
    const diffMs = Date.now() - new Date(iso).getTime();
    const m = Math.round(diffMs / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.round(h / 24);
    return `${d}d ago`;
  }

  return createPortal(
    <>
      <div
        onClick={onClose}
        className="fixed inset-0 z-[1500] bg-black/50 backdrop-blur-[2px] transition-opacity duration-300"
      />
      <div className="fixed top-0 right-0 z-[1600] h-full w-full max-w-[480px] bg-card border-l border-border shadow-[-4px_0_24px_rgba(0,0,0,0.3)] flex flex-col animate-slide-in-right">
        {/* Header */}
        <div className="px-5 pt-5 pb-3 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Trash2 size={16} className="text-muted" />
            <h2 className="m-0 text-base font-semibold text-text-strong">Trash</h2>
            <span className="text-xs text-muted">{trashedTasks.length} item{trashedTasks.length === 1 ? '' : 's'}</span>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-muted hover:text-text hover:bg-bg-hover border-0 bg-transparent cursor-pointer"
            aria-label="Close trash panel"
          >
            <X size={16} />
          </button>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          {trashedTasks.length === 0 && (
            <div className="p-8 text-center text-sm text-muted">
              Trash is empty.
            </div>
          )}
          {trashedTasks.map((t) => (
            <div key={t.id} className="flex items-start gap-3 px-4 py-3 border-b border-border hover:bg-bg-hover transition-colors">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs text-muted font-mono mb-0.5">
                  <span>{t.id}</span>
                  <span>·</span>
                  <span>deleted {formatWhen(t.trashedAt)}</span>
                </div>
                <div className="text-sm text-text break-words">{t.title}</div>
              </div>
              <button
                type="button"
                onClick={() => onRestore?.(t)}
                title={`Restore ${t.id}`}
                aria-label={`Restore ${t.id}`}
                className="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg text-muted hover:text-ok hover:bg-ok-subtle border-0 bg-transparent cursor-pointer"
              >
                <RotateCcw size={14} />
              </button>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-border bg-card">
          {!confirming ? (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              disabled={trashedTasks.length === 0 || busy}
              className="w-full h-9 rounded-lg border border-danger bg-transparent text-danger hover:bg-danger-subtle disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors text-sm font-medium"
            >
              Empty Trash
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted flex-1">
                {trashedTasks.length} task{trashedTasks.length === 1 ? '' : 's'} will be permanently deleted. No undo.
              </span>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={busy}
                className="h-8 px-3 rounded-lg border border-border bg-transparent text-text hover:bg-bg-hover cursor-pointer text-xs font-medium"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleEmpty}
                disabled={busy}
                className="h-8 px-3 rounded-lg border-0 bg-danger text-white hover:brightness-110 cursor-pointer text-xs font-medium disabled:opacity-50"
              >
                {busy ? '…' : 'Delete forever'}
              </button>
            </div>
          )}
        </div>
      </div>
    </>,
    document.body
  );
}
