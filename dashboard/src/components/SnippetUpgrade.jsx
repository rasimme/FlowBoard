import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Sparkles, X, Check, AlertTriangle, ChevronRight } from 'lucide-react';
import { apiFetch } from '../utils/apiFetch.js';
import ScrollArea from './ScrollArea.jsx';

/**
 * SnippetUpgrade — "FlowBoard update available" header pill + upgrade modal.
 *
 * - Polls GET /api/snippets/status on mount.
 * - If no files carry legacy markers, renders nothing (no pill, no modal).
 * - Otherwise shows a pulsing pill in the header; click opens a modal that lists
 *   per-workspace AGENTS.md / BOOT.md files grouped by "safe to auto-upgrade" and
 *   "manual merge required". Safe files are checkbox-selected; upgrading POSTs
 *   /api/snippets/apply which writes .bak-<ts> backups server-side.
 */
export default function SnippetUpgrade() {
  const [status, setStatus] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);

  const refresh = async () => {
    try {
      const res = await apiFetch('/api/snippets/status');
      if (!res.ok) return;
      const data = await res.json();
      setStatus(data);
    } catch {
      // Fail silently — pill simply doesn't appear
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  if (!status || !status.withMarkers) return null;

  return (
    <>
      <MigrationChip onClick={() => setModalOpen(true)} />
      <span className="header-divider" />
      <UpgradeModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        status={status}
        onApplied={refresh}
      />
    </>
  );
}

function MigrationChip({ onClick }) {
  return (
    <button className="migration-chip" onClick={onClick} title="Migration required">
      <span className="migration-chip-icon"><AlertTriangle size={13} /></span>
      <span>Migration required</span>
    </button>
  );
}

function UpgradeModal({ open, onClose, status, onApplied }) {
  const safeFiles = status.files.filter(f => f.status === 'safe');
  const manualFiles = status.files.filter(f => f.status === 'manual');

  const [selected, setSelected] = useState({});
  // Accordion: only one expanded diff at a time. Clicking an expanded row collapses it;
  // clicking another row switches the expansion. Keeps the modal body from stacking
  // multiple diffs and squeezing each one.
  const [expandedId, setExpandedId] = useState(null);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState(null);
  const masterCheckboxRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const initial = {};
    safeFiles.forEach(f => { initial[f.id] = true; });
    setSelected(initial);
    setExpandedId(null);
    setResult(null);
    setApplying(false);
  }, [open, status]);

  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [open, onClose]);

  const selectedCount = safeFiles.filter(f => selected[f.id]).length;
  const allSelected = safeFiles.length > 0 && selectedCount === safeFiles.length;
  const someSelected = selectedCount > 0 && !allSelected;

  useEffect(() => {
    if (masterCheckboxRef.current) masterCheckboxRef.current.indeterminate = someSelected;
  }, [someSelected]);

  if (!open) return null;

  const toggleFile = (id) => setSelected(prev => ({ ...prev, [id]: !prev[id] }));
  const toggleExpand = (id) => setExpandedId(prev => (prev === id ? null : id));
  const toggleAll = () => {
    const next = {};
    if (!allSelected) safeFiles.forEach(f => { next[f.id] = true; });
    else safeFiles.forEach(f => { next[f.id] = false; });
    setSelected(next);
  };

  const handleUpgrade = async () => {
    if (applying || selectedCount === 0) return;
    const ids = safeFiles.filter(f => selected[f.id]).map(f => f.id);
    setApplying(true);
    try {
      const res = await apiFetch('/api/snippets/apply', {
        method: 'POST',
        body: JSON.stringify({ ids }),
      });
      const data = await res.json();
      setResult(data);
      setApplying(false);
      if (data?.ok) {
        setTimeout(() => {
          onApplied?.();
          onClose?.();
        }, 900);
      }
    } catch {
      setApplying(false);
      setResult({ ok: false, error: 'Network error' });
    }
  };

  const upgraded = !!result?.ok;

  return createPortal(
    <div
      className="snippet-modal-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    >
      <div className="upgrade-modal" role="dialog" aria-modal="true" aria-labelledby="upgrade-title">
        {/* Header */}
        <div className="modal-header">
          <div className="modal-header-left">
            <div className="modal-header-icon"><Sparkles size={16} /></div>
            <div>
              <div id="upgrade-title" className="modal-title">FlowBoard update · Lazy-load rules</div>
              <div className="modal-subtitle">
                Rule snippets moved from eager loads to on-demand endpoints.
                {' '}{safeFiles.length} safe · {manualFiles.length} need manual merge
              </div>
            </div>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        {/* Body — wrapped in ScrollArea so the custom dark-mode scrollbar
            (position:absolute, no layout width) replaces the native one;
            this prevents the content-shift-on-scrollbar-appear artifact. */}
        <ScrollArea className="modal-body-wrap" innerClassName="modal-body-v2">
          {safeFiles.length > 0 && (
            <div className="group">
              <div className="group-header">
                <label
                  className={`group-checkbox${someSelected ? ' indeterminate' : ''}`}
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    ref={masterCheckboxRef}
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                  />
                  <span className="checkbox-box" aria-hidden="true">
                    {allSelected
                      ? <Check size={11} />
                      : someSelected ? <span className="checkbox-dash" /> : null}
                  </span>
                </label>
                <div className="group-header-text">
                  <div className="group-title">Auto-upgrade</div>
                  <div className="group-sub">
                    {selectedCount} of {safeFiles.length} selected · no conflicts detected
                  </div>
                </div>
              </div>
              <div className="group-body">
                {safeFiles.map(f => (
                  <FileRow
                    key={f.id}
                    file={f}
                    checked={!!selected[f.id]}
                    onToggle={() => toggleFile(f.id)}
                    expanded={expandedId === f.id}
                    onExpand={() => toggleExpand(f.id)}
                    upgraded={upgraded && !!selected[f.id]}
                  />
                ))}
              </div>
            </div>
          )}

          {manualFiles.length > 0 && (
            <div className="group">
              <div className="group-header">
                <div className="group-header-icon warn">
                  <AlertTriangle size={13} />
                </div>
                <div className="group-header-text">
                  <div className="group-title">Manual merge required</div>
                  <div className="group-sub">
                    These files diverge from the shipped snippet. Auto-upgrade is disabled.
                  </div>
                </div>
              </div>
              <div className="group-body">
                {manualFiles.map(f => (
                  <FileRow
                    key={f.id}
                    file={f}
                    readOnly
                    expanded={expandedId === f.id}
                    onExpand={() => toggleExpand(f.id)}
                  />
                ))}
              </div>
            </div>
          )}

          {safeFiles.length === 0 && manualFiles.length === 0 && (
            <div className="group">
              <div className="group-header">
                <div className="group-header-text">
                  <div className="group-title">Nothing to upgrade</div>
                  <div className="group-sub">No workspace files carry legacy snippet markers.</div>
                </div>
              </div>
            </div>
          )}
        </ScrollArea>

        {/* Footer */}
        <div className="modal-footer">
          <div className="footer-left">
            {upgraded ? (
              <span className="footer-status ok">
                <Check size={12} /> Upgraded {result.applied?.length || 0} file{(result.applied?.length || 0) !== 1 ? 's' : ''}
              </span>
            ) : result && !result.ok ? (
              <span className="footer-hint" style={{ color: 'var(--danger)' }}>
                {result.error || 'Upgrade failed — no files were changed'}
              </span>
            ) : (
              <span className="footer-hint">
                Changes apply to your working tree. A .bak-&lt;timestamp&gt; copy is written before each edit.
              </span>
            )}
          </div>
          <div className="footer-actions">
            <button className="btn btn-secondary btn-sm" onClick={onClose}>
              {upgraded ? 'Close' : 'Not now'}
            </button>
            <button
              className="btn btn-primary btn-sm"
              onClick={handleUpgrade}
              disabled={selectedCount === 0 || applying || upgraded}
            >
              {upgraded
                ? 'Upgraded'
                : applying
                  ? 'Upgrading…'
                  : `Upgrade ${selectedCount} file${selectedCount !== 1 ? 's' : ''}`}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.getElementById('modalRoot') || document.body
  );
}

function FileRow({ file, checked, onToggle, readOnly, expanded, onExpand, upgraded }) {
  const classes = ['file-row'];
  if (expanded) classes.push('expanded');
  if (upgraded) classes.push('upgraded');
  if (readOnly) classes.push('manual');

  return (
    <div className={classes.join(' ')}>
      <div className="file-row-main" onClick={onExpand}>
        {readOnly ? (
          <span className="file-row-marker warn" title="Manual merge">
            <AlertTriangle size={12} />
          </span>
        ) : (
          <label
            className="file-row-checkbox"
            onClick={(e) => { e.stopPropagation(); onToggle?.(); }}
          >
            <input type="checkbox" checked={!!checked} readOnly />
            <span className="checkbox-box" aria-hidden="true">
              {checked ? <Check size={11} /> : null}
            </span>
          </label>
        )}
        <div className="file-row-text">
          <div className="file-row-path">
            <span className="mono" title={file.path}>{shortPath(file.path)}</span>
            <span className="file-row-bytes">{file.bytes}</span>
            {upgraded && <span className="chip ok"><Check size={10} /> Upgraded</span>}
          </div>
          <div className="file-row-summary">{file.summary}</div>
        </div>
        <button
          className="file-row-toggle"
          onClick={(e) => { e.stopPropagation(); onExpand?.(); }}
        >
          <ChevronRight size={13} className={expanded ? 'rot' : ''} />
          <span>{expanded ? 'Hide diff' : 'View diff'}</span>
        </button>
      </div>
      {expanded && (
        <div className="file-row-detail">
          <Diff diff={file.diff} />
        </div>
      )}
    </div>
  );
}

function Diff({ diff }) {
  if (!Array.isArray(diff) || diff.length === 0) {
    return <div className="diff"><div className="diff-body" style={{ padding: 12, color: 'var(--muted)' }}>No diff available</div></div>;
  }
  return (
    <div className="diff">
      <div className="diff-body">
        {diff.map((l, i) => {
          if (l.t === 'hunk') {
            return <div key={i} className="diff-line hunk"><span className="diff-text">{l.text}</span></div>;
          }
          return (
            <div key={i} className={`diff-line ${l.t}`}>
              <span className="diff-sigil" aria-hidden="true">{sigilFor(l.t)}</span>
              <span className="diff-ln">{l.n ?? ''}</span>
              <span className="diff-text">{l.text}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function sigilFor(type) {
  if (type === 'add') return '+';
  if (type === 'del') return '-';
  if (type === 'conflict') return '~';
  return ' ';
}

function shortPath(abs) {
  // Display workspace-relative label: "workspace/AGENTS.md" or "workspace-alice/AGENTS.md"
  const m = String(abs).match(/\/\.openclaw\/([^/]+)\/([^/]+)$/);
  if (m) return `${m[1]}/${m[2]}`;
  return abs;
}
