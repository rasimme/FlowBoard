import { useRef, useState } from 'react';
import { Archive, ArchiveRestore, Folder, FolderPlus, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import Popover from './Popover.jsx';
import Input from './Input.jsx';
import { useDashboard } from '../context/DashboardContext.jsx';
import { apiFetch } from '../utils/apiFetch.js';

async function putProject(name, patch) {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(name)}`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * Kebab menu for a project row. Reveals on row hover via CSS
 * (.project-item:hover .row-kebab). Parent supplies:
 *  - onRenameRequest() — flips the row into inline-edit mode
 *  - onDeleteRequest(project) — hands off to the parent's DeleteProjectModal
 *  - folders: string[] — existing folder names for the "Move to folder" submenu
 */
export default function ProjectActionsMenu({ project, folders = [], onRenameRequest, onDeleteRequest }) {
  const { refreshProjectsOnly } = useDashboard();
  const btnRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState(null);
  const [view, setView] = useState('root'); // 'root' | 'folder' | 'newFolder'
  const [newFolder, setNewFolder] = useState('');
  const [busy, setBusy] = useState(false);

  function openMenu(e) {
    e.stopPropagation();
    if (busy) return;
    setRect(btnRef.current?.getBoundingClientRect() || null);
    setView('root');
    setOpen(true);
  }

  function closeMenu() {
    setOpen(false);
    setView('root');
    setNewFolder('');
  }

  async function run(patch, label) {
    setBusy(true);
    closeMenu();
    try {
      await putProject(project.name, patch);
      await refreshProjectsOnly();
    } catch (err) {
      window.showToast?.(`Could not ${label}: ${err.message}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  function handleRename(e) {
    e.stopPropagation();
    closeMenu();
    onRenameRequest?.();
  }

  function handleArchiveToggle(e) {
    e.stopPropagation();
    run({ archived: !project.archived }, project.archived ? 'restore' : 'archive');
  }

  function handleDelete(e) {
    e.stopPropagation();
    closeMenu();
    onDeleteRequest?.(project);
  }

  function handlePickFolder(target) {
    return (e) => {
      e.stopPropagation();
      if (target === project.group) { closeMenu(); return; }
      run({ group: target }, 'move');
    };
  }

  function commitNewFolder(e) {
    e?.stopPropagation();
    const trimmed = newFolder.trim();
    if (!trimmed) return;
    if (trimmed === project.group) { closeMenu(); return; }
    run({ group: trimmed }, 'create folder');
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="row-kebab"
        aria-label={`Actions for ${project.displayName || project.name}`}
        aria-expanded={open}
        onClick={openMenu}
      >
        <MoreHorizontal size={14} />
      </button>
      <Popover open={open} onClose={closeMenu} anchorRect={rect}>
        {view === 'root' && (
          <>
            <Popover.Option onClick={handleRename}>
              <span className="inline-flex items-center gap-2">
                <Pencil size={13} /> Rename
              </span>
            </Popover.Option>
            <Popover.Option onClick={(e) => { e.stopPropagation(); setView('folder'); }}>
              <span className="inline-flex items-center gap-2 justify-between w-full">
                <span className="inline-flex items-center gap-2">
                  <Folder size={13} /> Move to folder
                </span>
                <span className="opacity-60">›</span>
              </span>
            </Popover.Option>
            <Popover.Option onClick={handleArchiveToggle}>
              <span className="inline-flex items-center gap-2">
                {project.archived ? <ArchiveRestore size={13} /> : <Archive size={13} />}
                {project.archived ? 'Restore' : 'Archive'}
              </span>
            </Popover.Option>
            {/* T-358: hard-delete is two-step — only offered once a project is
                deactivated (archived). Active projects must be archived first,
                which is reversible. This makes accidental deletion much harder. */}
            {project.archived && (
              <>
                <div className="h-px bg-border my-1" />
                <Popover.Option onClick={handleDelete} className="text-danger">
                  <span className="inline-flex items-center gap-2">
                    <Trash2 size={13} /> Delete permanently…
                  </span>
                </Popover.Option>
              </>
            )}
          </>
        )}

        {view === 'folder' && (
          <>
            <Popover.Option onClick={(e) => { e.stopPropagation(); setView('root'); }}>
              <span className="inline-flex items-center gap-2 opacity-70">‹ Back</span>
            </Popover.Option>
            <div className="h-px bg-border my-1" />
            <Popover.Option
              onClick={handlePickFolder(null)}
              className={!project.group ? 'text-accent' : ''}
            >
              <span className="inline-flex items-center gap-2">— Root —</span>
            </Popover.Option>
            {folders.map((f) => (
              <Popover.Option
                key={f}
                onClick={handlePickFolder(f)}
                className={project.group === f ? 'text-accent' : ''}
              >
                <span className="inline-flex items-center gap-2">
                  <Folder size={13} /> {f}
                </span>
              </Popover.Option>
            ))}
            <div className="h-px bg-border my-1" />
            <Popover.Option onClick={(e) => { e.stopPropagation(); setView('newFolder'); }}>
              <span className="inline-flex items-center gap-2 text-accent">
                <FolderPlus size={13} /> New folder…
              </span>
            </Popover.Option>
          </>
        )}

        {view === 'newFolder' && (
          <div className="p-2 flex flex-col gap-2 w-48" onClick={(e) => e.stopPropagation()}>
            <Input
              autoFocus
              size="sm"
              placeholder="Folder name"
              value={newFolder}
              onChange={(e) => setNewFolder(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitNewFolder(e);
                else if (e.key === 'Escape') setView('folder');
              }}
              maxLength={60}
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={(e) => { e.stopPropagation(); setView('folder'); }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={commitNewFolder}
                disabled={!newFolder.trim() || busy}
              >
                Create
              </button>
            </div>
          </div>
        )}
      </Popover>
    </>
  );
}
