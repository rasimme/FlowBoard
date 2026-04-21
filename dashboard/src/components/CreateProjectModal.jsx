import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Folder, FolderPlus, X } from 'lucide-react';

function slugify(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 63);
}

/**
 * New-project modal per design handoff (.np-* classes).
 * Fields: Name (with live slug-path hint) + Folder dropdown (existing folders +
 * "New folder…" inline input). Posts to POST /api/projects with { name, displayName, group }.
 */
export default function CreateProjectModal({
  open,
  onClose,
  onCreated,
  folders = [],
  existingNames = [],
}) {
  const [name, setName] = useState('');
  const [folder, setFolder] = useState(null); // string | null
  const [ddOpen, setDdOpen] = useState(false);
  const [newFolderMode, setNewFolderMode] = useState(false);
  const [newFolderInput, setNewFolderInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const nameInputRef = useRef(null);
  const modalRef = useRef(null);
  const newFolderRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setName('');
    setFolder(null);
    setDdOpen(false);
    setNewFolderMode(false);
    setNewFolderInput('');
    setSubmitting(false);
    setError(null);
    setTimeout(() => nameInputRef.current?.focus(), 0);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (newFolderMode) setTimeout(() => newFolderRef.current?.focus(), 0);
  }, [newFolderMode]);

  if (!open) return null;

  const trimmedName = name.trim();
  const slug = trimmedName ? slugify(trimmedName) : 'new-service';
  const slugClash = !!slug && existingNames.includes(slug);
  const canCreate = !!trimmedName && !!slug && !slugClash && !submitting;

  const dropdownLabel = folder || '— Root —';

  async function handleCreate() {
    if (!canCreate) return;
    setSubmitting(true);
    setError(null);
    try {
      const body = {
        name: slug,
        displayName: trimmedName,
      };
      if (folder) body.group = folder;
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || `HTTP ${res.status}`);
        setSubmitting(false);
        return;
      }
      // If user picked an existing folder, the backend already stored it.
      // For the rare "New folder…" case we rely on the same `group` field —
      // no separate folder-creation endpoint is needed.
      onCreated?.(data.project);
      onClose?.();
    } catch (err) {
      setError(err.message);
      setSubmitting(false);
    }
  }

  function pickFolder(value) {
    setFolder(value);
    setDdOpen(false);
    setNewFolderMode(false);
  }

  function commitNewFolder() {
    const trimmed = newFolderInput.trim();
    if (!trimmed) return;
    setFolder(trimmed);
    setDdOpen(false);
    setNewFolderMode(false);
    setNewFolderInput('');
  }

  const modal = (
    <div
      className="modal-overlay"
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.6)',
        backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
      }}
      onClick={() => { if (!submitting) onClose?.(); }}
    >
      <div
        ref={modalRef}
        className="np-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="np-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="np-header">
          <div className="np-title" id="np-title">New project</div>
          <button
            type="button"
            className="np-close"
            onClick={onClose}
            aria-label="Close"
            disabled={submitting}
          >
            <X size={16} />
          </button>
        </div>

        <div className="np-body">
          <div className="np-field">
            <label className="np-label" htmlFor="np-name">Project name</label>
            <input
              ref={nameInputRef}
              id="np-name"
              className="np-input"
              placeholder="new-service"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && canCreate) handleCreate(); }}
              disabled={submitting}
            />
            <div className="np-hint">
              Lowercase, dashes allowed · will live at{' '}
              <span className="mono">~/projects/{slug}</span>
            </div>
            {slugClash && (
              <div className="np-hint" style={{ color: 'var(--danger, #ef4444)' }}>
                A project with slug <span className="mono">{slug}</span> already exists.
              </div>
            )}
          </div>

          <div className="np-field">
            <label className="np-label">Folder</label>
            <button
              type="button"
              className="np-select"
              onClick={() => { setDdOpen((o) => !o); setNewFolderMode(false); }}
              disabled={submitting}
            >
              <span style={{ color: folder ? 'var(--text-strong)' : 'var(--muted)' }}>
                {dropdownLabel}
              </span>
              <span className="chev"><ChevronDown size={11} /></span>
            </button>

            {ddOpen && (
              <div className="np-dropdown">
                {newFolderMode ? (
                  <div style={{ padding: 4, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <input
                      ref={newFolderRef}
                      className="np-input"
                      placeholder="Folder name"
                      value={newFolderInput}
                      onChange={(e) => setNewFolderInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitNewFolder();
                        else if (e.key === 'Escape') setNewFolderMode(false);
                      }}
                      maxLength={60}
                    />
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => setNewFolderMode(false)}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={!newFolderInput.trim()}
                        onClick={commitNewFolder}
                      >
                        Use
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      className={`np-dropdown-item${folder === null ? ' active' : ''}`}
                      onClick={() => pickFolder(null)}
                    >
                      <Folder size={13} />
                      <span>— Root —</span>
                    </button>
                    {folders.map((f) => (
                      <button
                        key={f}
                        type="button"
                        className={`np-dropdown-item${folder === f ? ' active' : ''}`}
                        onClick={() => pickFolder(f)}
                      >
                        <Folder size={13} />
                        <span>{f}</span>
                      </button>
                    ))}
                    <div className="np-dropdown-divider" />
                    <button
                      type="button"
                      className="np-dropdown-item new-folder"
                      onClick={() => setNewFolderMode(true)}
                    >
                      <FolderPlus size={13} />
                      <span>New folder…</span>
                    </button>
                  </>
                )}
              </div>
            )}
          </div>

          {error && (
            <div className="np-hint" style={{ color: 'var(--danger, #ef4444)' }}>
              {error}
            </div>
          )}
        </div>

        <div className="np-footer">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={!canCreate}
            onClick={handleCreate}
          >
            {submitting ? 'Creating…' : 'Create project'}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.getElementById('modalRoot') || document.body);
}
