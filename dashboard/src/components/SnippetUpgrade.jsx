import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Sparkles, X, Check, AlertTriangle, ChevronRight, Plus } from 'lucide-react';
import { apiFetch } from '../utils/apiFetch.js';
import ScrollArea from './ScrollArea.jsx';

/**
 * SnippetUpgrade — FlowBoard setup / migration header chip + modal.
 *
 * Polls GET /api/snippets/status on mount. Renders nothing when the server
 * returns `chip: null` (setup complete, no legacy remaining). Otherwise shows
 * the chip whose text/variant is driven by server state:
 *   - "Migration required" (warn) when any legacy snippet (identical / drifted) exists
 *   - "Finish setup" (info) when no legacy and no current snippet on any agent
 *
 * The modal groups rows by state:
 *   - Upgrade  (identical) — batch safe, default-on checkboxes
 *   - Migration required (drifted) — per-file opt-in, force-replace
 *   - Add FlowBoard to workspace (missing) — per-file opt-in OR Dismiss
 *
 * On Apply: POST /api/snippets/apply with `{ actions: [{id, action}] }`.
 * Every mutation writes a server-side `.bak-<timestamp>` first.
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
      // Fail silently — chip simply doesn't appear
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  if (!status || !status.chip) return null;

  return (
    <>
      <SetupChip chip={status.chip} onClick={() => setModalOpen(true)} />
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

function SetupChip({ chip, onClick }) {
  const classes = ['migration-chip'];
  if (chip.variant === 'info') classes.push('migration-chip-info');
  return (
    <button className={classes.join(' ')} onClick={onClick} title={chip.text}>
      <span className="migration-chip-icon">
        {chip.variant === 'warn' ? <AlertTriangle size={13} /> : <Sparkles size={13} />}
      </span>
      <span>{chip.text}</span>
    </button>
  );
}

function UpgradeModal({ open, onClose, status, onApplied }) {
  const identicalFiles = status.files.filter(f => f.state === 'identical');
  const driftedFiles = status.files.filter(f => f.state === 'drifted');
  const missingFiles = status.files.filter(f => f.state === 'missing');

  // Selection maps per group. Defaults:
  //   identical: all-on (safe)
  //   drifted:   all-off (force-replace is risky, user must opt-in)
  //   missing:   all-off (add is additive, user chooses which workspaces)
  const [selectedUpgrade, setSelectedUpgrade] = useState({});
  const [selectedMigrate, setSelectedMigrate] = useState({});
  const [selectedAdd, setSelectedAdd] = useState({});
  const [expandedId, setExpandedId] = useState(null);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState(null);
  const masterUpgradeRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const init = {};
    identicalFiles.forEach(f => { init[f.id] = true; });
    setSelectedUpgrade(init);
    setSelectedMigrate({});
    setSelectedAdd({});
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

  const upgradeCount = identicalFiles.filter(f => selectedUpgrade[f.id]).length;
  const migrateCount = driftedFiles.filter(f => selectedMigrate[f.id]).length;
  const addCount = missingFiles.filter(f => selectedAdd[f.id]).length;
  const totalSelected = upgradeCount + migrateCount + addCount;

  const allUpgradeSelected = identicalFiles.length > 0 && upgradeCount === identicalFiles.length;
  const someUpgradeSelected = upgradeCount > 0 && !allUpgradeSelected;

  useEffect(() => {
    if (masterUpgradeRef.current) masterUpgradeRef.current.indeterminate = someUpgradeSelected;
  }, [someUpgradeSelected]);

  if (!open) return null;

  const toggleUpgrade = (id) => setSelectedUpgrade(prev => ({ ...prev, [id]: !prev[id] }));
  const toggleMigrate = (id) => setSelectedMigrate(prev => ({ ...prev, [id]: !prev[id] }));
  const toggleAdd = (id) => setSelectedAdd(prev => ({ ...prev, [id]: !prev[id] }));
  const toggleExpand = (id) => setExpandedId(prev => (prev === id ? null : id));
  const toggleAllUpgrade = () => {
    const next = {};
    if (!allUpgradeSelected) identicalFiles.forEach(f => { next[f.id] = true; });
    setSelectedUpgrade(next);
  };

  const handleDismiss = async (file) => {
    setApplying(true);
    try {
      await apiFetch('/api/snippets/apply', {
        method: 'POST',
        body: JSON.stringify({ actions: [{ id: file.id, action: 'dismiss' }] }),
      });
      await onApplied?.();
    } finally {
      setApplying(false);
    }
  };

  const handleApply = async () => {
    if (applying || totalSelected === 0) return;
    const actions = [];
    identicalFiles.forEach(f => { if (selectedUpgrade[f.id]) actions.push({ id: f.id, action: 'upgrade' }); });
    driftedFiles.forEach(f => { if (selectedMigrate[f.id]) actions.push({ id: f.id, action: 'migrate' }); });
    missingFiles.forEach(f => { if (selectedAdd[f.id]) actions.push({ id: f.id, action: 'add' }); });
    setApplying(true);
    try {
      const res = await apiFetch('/api/snippets/apply', {
        method: 'POST',
        body: JSON.stringify({ actions }),
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

  const applied = !!result?.ok;
  const appliedCount = result?.applied?.length || 0;
  const hasAnything = identicalFiles.length + driftedFiles.length + missingFiles.length > 0;

  // Modal title & subtitle follow the chip variant
  const title = status.chip?.variant === 'warn' ? 'FlowBoard · Migration' : 'FlowBoard · Setup';
  const subtitle = [
    identicalFiles.length > 0 && `${identicalFiles.length} safe upgrade${identicalFiles.length !== 1 ? 's' : ''}`,
    driftedFiles.length > 0 && `${driftedFiles.length} migration${driftedFiles.length !== 1 ? 's' : ''}`,
    missingFiles.length > 0 && `${missingFiles.length} workspace${missingFiles.length !== 1 ? 's' : ''} to set up`,
  ].filter(Boolean).join(' · ');

  return createPortal(
    <div
      className="snippet-modal-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    >
      <div className="upgrade-modal" role="dialog" aria-modal="true" aria-labelledby="upgrade-title">
        <div className="modal-header">
          <div className="modal-header-left">
            <div className="modal-header-icon"><Sparkles size={16} /></div>
            <div>
              <div id="upgrade-title" className="modal-title">{title}</div>
              <div className="modal-subtitle">{subtitle || 'Nothing to do'}</div>
            </div>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <ScrollArea className="modal-body-wrap" innerClassName="modal-body-v2">
          {identicalFiles.length > 0 && (
            <div className="group">
              <div className="group-header">
                <label
                  className={`group-checkbox${someUpgradeSelected ? ' indeterminate' : ''}`}
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    ref={masterUpgradeRef}
                    type="checkbox"
                    checked={allUpgradeSelected}
                    onChange={toggleAllUpgrade}
                  />
                  <span className="checkbox-box" aria-hidden="true">
                    {allUpgradeSelected
                      ? <Check size={11} />
                      : someUpgradeSelected ? <span className="checkbox-dash" /> : null}
                  </span>
                </label>
                <div className="group-header-text">
                  <div className="group-title">Upgrade</div>
                  <div className="group-sub">
                    {upgradeCount} of {identicalFiles.length} selected · byte-identical, safe auto-upgrade
                  </div>
                </div>
              </div>
              <div className="group-body">
                {identicalFiles.map(f => (
                  <FileRow
                    key={f.id}
                    file={f}
                    variant="checkbox"
                    checked={!!selectedUpgrade[f.id]}
                    onToggle={() => toggleUpgrade(f.id)}
                    expanded={expandedId === f.id}
                    onExpand={() => toggleExpand(f.id)}
                    applied={applied && !!selectedUpgrade[f.id]}
                    actionLabel="Upgraded"
                  />
                ))}
              </div>
            </div>
          )}

          {driftedFiles.length > 0 && (
            <div className="group">
              <div className="group-header">
                <div className="group-header-icon warn">
                  <AlertTriangle size={13} />
                </div>
                <div className="group-header-text">
                  <div className="group-title">Migration required</div>
                  <div className="group-sub">
                    These files have a modified legacy block. Check to force-replace
                    with the current canonical snippet (a .bak backup is written).
                  </div>
                </div>
              </div>
              <div className="group-body">
                {driftedFiles.map(f => (
                  <FileRow
                    key={f.id}
                    file={f}
                    variant="checkbox-warn"
                    checked={!!selectedMigrate[f.id]}
                    onToggle={() => toggleMigrate(f.id)}
                    expanded={expandedId === f.id}
                    onExpand={() => toggleExpand(f.id)}
                    applied={applied && !!selectedMigrate[f.id]}
                    actionLabel="Migrated"
                  />
                ))}
              </div>
            </div>
          )}

          {missingFiles.length > 0 && (
            <div className="group">
              <div className="group-header">
                <div className="group-header-icon info">
                  <Plus size={13} />
                </div>
                <div className="group-header-text">
                  <div className="group-title">Add FlowBoard to workspace</div>
                  <div className="group-sub">
                    These files have no FlowBoard snippet. Check to append the current
                    snippet at the end, or dismiss if this workspace shouldn't use FlowBoard.
                  </div>
                </div>
              </div>
              <div className="group-body">
                {missingFiles.map(f => (
                  <FileRow
                    key={f.id}
                    file={f}
                    variant="checkbox-add"
                    checked={!!selectedAdd[f.id]}
                    onToggle={() => toggleAdd(f.id)}
                    expanded={expandedId === f.id}
                    onExpand={() => toggleExpand(f.id)}
                    applied={applied && !!selectedAdd[f.id]}
                    actionLabel="Added"
                    onDismiss={() => handleDismiss(f)}
                  />
                ))}
              </div>
            </div>
          )}

          {!hasAnything && (
            <div className="group">
              <div className="group-header">
                <div className="group-header-text">
                  <div className="group-title">Nothing to do</div>
                  <div className="group-sub">All workspaces are configured correctly.</div>
                </div>
              </div>
            </div>
          )}
        </ScrollArea>

        <div className="modal-footer">
          <div className="footer-left">
            {applied ? (
              <span className="footer-status ok">
                <Check size={12} /> Applied {appliedCount} change{appliedCount !== 1 ? 's' : ''}
              </span>
            ) : result && !result.ok ? (
              <span className="footer-hint" style={{ color: 'var(--danger)' }}>
                {result.error || 'Apply failed — no files were changed'}
              </span>
            ) : (
              <span className="footer-hint">
                Every change writes a .bak-&lt;timestamp&gt; copy first.
              </span>
            )}
          </div>
          <div className="footer-actions">
            <button className="btn btn-secondary btn-sm" onClick={onClose}>
              {applied ? 'Close' : 'Not now'}
            </button>
            <button
              className="btn btn-primary btn-sm"
              onClick={handleApply}
              disabled={totalSelected === 0 || applying || applied}
            >
              {applied
                ? 'Applied'
                : applying
                  ? 'Applying…'
                  : totalSelected === 0
                    ? 'Nothing selected'
                    : `Apply ${totalSelected} change${totalSelected !== 1 ? 's' : ''}`}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.getElementById('modalRoot') || document.body
  );
}

function FileRow({ file, variant, checked, onToggle, expanded, onExpand, applied, actionLabel, onDismiss }) {
  const classes = ['file-row'];
  if (expanded) classes.push('expanded');
  if (applied) classes.push('upgraded');

  const isCheckbox = variant === 'checkbox' || variant === 'checkbox-warn' || variant === 'checkbox-add';

  return (
    <div className={classes.join(' ')}>
      <div className="file-row-main" onClick={onExpand}>
        {isCheckbox ? (
          <label
            className="file-row-checkbox"
            onClick={(e) => { e.stopPropagation(); onToggle?.(); }}
          >
            <input type="checkbox" checked={!!checked} readOnly />
            <span className="checkbox-box" aria-hidden="true">
              {checked ? <Check size={11} /> : null}
            </span>
          </label>
        ) : (
          <span className="file-row-marker warn" title="Attention">
            <AlertTriangle size={12} />
          </span>
        )}
        <div className="file-row-text">
          <div className="file-row-path">
            <span className="mono" title={file.path}>{shortPath(file.path)}</span>
            <span className="file-row-bytes">{file.bytes}</span>
            {applied && <span className="chip ok"><Check size={10} /> {actionLabel}</span>}
          </div>
          <div className="file-row-summary">{file.summary}</div>
        </div>
        <div className="file-row-actions">
          {onDismiss && (
            <button
              className="file-row-dismiss"
              onClick={(e) => { e.stopPropagation(); onDismiss?.(); }}
              title="Dismiss this file — it's not a FlowBoard snippet host"
            >
              Dismiss
            </button>
          )}
          <button
            className="file-row-toggle"
            onClick={(e) => { e.stopPropagation(); onExpand?.(); }}
          >
            <ChevronRight size={13} className={expanded ? 'rot' : ''} />
            <span>{expanded ? 'Hide diff' : 'View diff'}</span>
          </button>
        </div>
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
  const m = String(abs).match(/\/\.openclaw\/([^/]+)\/([^/]+)$/);
  if (m) return `${m[1]}/${m[2]}`;
  return abs;
}
