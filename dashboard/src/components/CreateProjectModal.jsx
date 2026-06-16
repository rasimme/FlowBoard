import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Folder, FolderPlus } from 'lucide-react';
import Modal from './Modal.jsx';
import Button from './Button.jsx';
import Input from './Input.jsx';
import FormGroup from './FormGroup.jsx';
import { apiFetch } from '../utils/apiFetch.js';
import { shouldOfferSuggestion, presetLabel } from '../utils/overviewSuggestion.js';

function slugify(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 63);
}

const dropdownItemClass = 'flex items-center gap-2 w-full px-2.5 py-1.5 text-[12px] text-left rounded-md border-0 bg-transparent text-text cursor-pointer hover:bg-bg-hover';

/**
 * New-project modal. Fields: Name (with live slug-path hint) + Folder dropdown
 * (existing folders + "New folder…" inline input). Posts to POST /api/projects
 * with { name, displayName, group }.
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
  // After a UI create, the server may suggest a best-fit dashboard preset to
  // confirm (T-365). Holds { project, preset, rationale } while that step shows.
  const [suggestion, setSuggestion] = useState(null);
  const [applying, setApplying] = useState(false);

  const nameInputRef = useRef(null);
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
    setSuggestion(null);
    setApplying(false);
    setTimeout(() => nameInputRef.current?.focus(), 0);
  }, [open]);

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
      const res = await apiFetch('/api/projects', {
        method: 'POST',
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
      //
      // T-365: the server may return a best-fit dashboard suggestion. For a
      // non-default, not-yet-applied one, pause on a confirm step instead of
      // closing — the user decides whether to apply it.
      if (shouldOfferSuggestion(data.overview)) {
        setSuggestion({ project: data.project, preset: data.overview.preset, rationale: data.overview.rationale });
        setSubmitting(false);
        return;
      }
      onCreated?.(data.project);
      onClose?.();
    } catch (err) {
      setError(err.message);
      setSubmitting(false);
    }
  }

  function finishCreate() {
    const created = suggestion?.project;
    setSuggestion(null);
    if (created) onCreated?.(created);
    onClose?.();
  }

  async function applySuggestion() {
    if (!suggestion) return;
    setApplying(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/projects/${suggestion.project.name}/overview`, {
        method: 'PUT',
        body: JSON.stringify({ preset: suggestion.preset }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || `HTTP ${res.status}`);
        setApplying(false);
        return;
      }
      finishCreate();
    } catch (err) {
      setError(err.message);
      setApplying(false);
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

  return (
    <Modal
      open={open}
      onClose={suggestion ? finishCreate : onClose}
      title={suggestion ? 'Set up the dashboard' : 'New project'}
      size="sm"
      showClose
      dismissible={!submitting && !applying}
      actions={
        suggestion ? (
          <>
            <Button variant="ghost" size="sm" onClick={finishCreate} disabled={applying}>
              Keep default
            </Button>
            <Button size="sm" onClick={applySuggestion} disabled={applying}>
              {applying ? 'Applying…' : `Use ${presetLabel(suggestion.preset)}`}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" size="sm" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleCreate} disabled={!canCreate}>
              {submitting ? 'Creating…' : 'Create project'}
            </Button>
          </>
        )
      }
    >
      {suggestion ? (
        <div className="flex flex-col gap-3">
          <div className="text-[13px] text-text">
            Project{' '}
            <span className="text-text-strong">{suggestion.project.displayName || suggestion.project.name}</span>{' '}
            created.
          </div>
          <div className="flex flex-col gap-1.5 rounded-lg border border-solid border-border bg-bg-elevated p-3">
            <div className="text-[11px] text-muted">Suggested dashboard</div>
            <div className="text-[14px] text-text-strong">{presetLabel(suggestion.preset)}</div>
            <div className="text-[12px] text-muted">{suggestion.rationale}</div>
          </div>
          {error && <div className="text-[11px] text-danger">{error}</div>}
        </div>
      ) : (
      <div className="flex flex-col gap-3.5">
        <FormGroup
          label="Project name"
          htmlFor="np-name"
          error={slugClash ? `A project with slug "${slug}" already exists.` : null}
          hint={null}
        >
          <Input
            ref={nameInputRef}
            id="np-name"
            placeholder="new-service"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && canCreate) handleCreate(); }}
            disabled={submitting}
          />
          <div className="text-[11px] text-muted">
            Lowercase, dashes allowed · will live at{' '}
            <span className="mono">~/projects/{slug}</span>
          </div>
        </FormGroup>

        <FormGroup label="Folder">
          <div className="relative">
            <button
              type="button"
              onClick={() => { setDdOpen((o) => !o); setNewFolderMode(false); }}
              disabled={submitting}
              className="flex items-center justify-between w-full px-3 py-2 text-sm rounded-lg bg-bg border border-solid border-border cursor-pointer focus:border-accent outline-none"
            >
              <span className={folder ? 'text-text-strong' : 'text-muted'}>
                {dropdownLabel}
              </span>
              <ChevronDown size={11} className="opacity-70" />
            </button>

            {ddOpen && (
              <div className="absolute z-50 mt-1 w-full max-h-56 overflow-y-auto rounded-lg border border-border bg-bg-elevated shadow-card p-1">
                {newFolderMode ? (
                  <div className="flex flex-col gap-2 p-1">
                    <Input
                      ref={newFolderRef}
                      size="sm"
                      placeholder="Folder name"
                      value={newFolderInput}
                      onChange={(e) => setNewFolderInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitNewFolder();
                        else if (e.key === 'Escape') setNewFolderMode(false);
                      }}
                      maxLength={60}
                    />
                    <div className="flex justify-end gap-2">
                      <Button variant="ghost" size="xs" onClick={() => setNewFolderMode(false)}>
                        Cancel
                      </Button>
                      <Button size="xs" disabled={!newFolderInput.trim()} onClick={commitNewFolder}>
                        Use
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      className={`${dropdownItemClass} ${folder === null ? 'bg-accent-subtle text-accent' : ''}`}
                      onClick={() => pickFolder(null)}
                    >
                      <Folder size={13} className="opacity-70 shrink-0" />
                      <span>— Root —</span>
                    </button>
                    {folders.map((f) => (
                      <button
                        key={f}
                        type="button"
                        className={`${dropdownItemClass} ${folder === f ? 'bg-accent-subtle text-accent' : ''}`}
                        onClick={() => pickFolder(f)}
                      >
                        <Folder size={13} className="opacity-70 shrink-0" />
                        <span>{f}</span>
                      </button>
                    ))}
                    <div className="h-px bg-border my-1" />
                    <button
                      type="button"
                      className={`${dropdownItemClass} text-accent`}
                      onClick={() => setNewFolderMode(true)}
                    >
                      <FolderPlus size={13} className="opacity-70 shrink-0" />
                      <span>New folder…</span>
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </FormGroup>

        {error && (
          <div className="text-[11px] text-danger">{error}</div>
        )}
      </div>
      )}
    </Modal>
  );
}
