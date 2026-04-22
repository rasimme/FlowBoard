import { Fragment, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Archive, ChevronDown, Folder, FolderPlus, GripVertical, Plus } from 'lucide-react';
import { useAppState } from '../context/AppStateContext.jsx';
import { formatDisplayName } from '../utils.js';
import CreateProjectModal from './CreateProjectModal.jsx';
import DeleteProjectModal from './DeleteProjectModal.jsx';
import ProjectActionsMenu from './ProjectActionsMenu.jsx';
import Popover from './Popover.jsx';

const COLLAPSE_KEY = 'flowboard_sidebar_collapsed';
const FOLDERS_LS_KEY = 'flowboard_user_folders';
const FOLDER_ORDER_KEY = 'flowboard_folder_order';
const ARCHIVE_KEY = '__archive__';
const ROOT_ZONE = '__root__';
const FOLDER_PREFIX = 'folder:';

function loadCollapsed() {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    if (!(ARCHIVE_KEY in parsed)) parsed[ARCHIVE_KEY] = true;
    return parsed;
  } catch {
    return { [ARCHIVE_KEY]: true };
  }
}
function saveCollapsed(state) {
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(state)); } catch { /* ignore */ }
}

function loadUserFolders() {
  try {
    const raw = localStorage.getItem(FOLDERS_LS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
  } catch { return []; }
}
function saveUserFolders(list) {
  try { localStorage.setItem(FOLDERS_LS_KEY, JSON.stringify(list)); } catch { /* ignore */ }
}

function loadFolderOrder() {
  try {
    const raw = localStorage.getItem(FOLDER_ORDER_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
  } catch { return []; }
}
function saveFolderOrder(list) {
  try { localStorage.setItem(FOLDER_ORDER_KEY, JSON.stringify(list)); } catch { /* ignore */ }
}

function compareProjects(a, b) {
  const oa = typeof a.order === 'number' ? a.order : Number.POSITIVE_INFINITY;
  const ob = typeof b.order === 'number' ? b.order : Number.POSITIVE_INFINITY;
  if (oa !== ob) return oa - ob;
  return (a.displayName || a.name).localeCompare(b.displayName || b.name);
}

async function putProject(name, patch) {
  const res = await fetch(`/api/projects/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return res.json();
}

async function persistSectionOrder(names, patchPerName) {
  // patchPerName(name, i) → additional fields (group/archived) for cross-section moves
  await Promise.all(
    names.map((name, i) => {
      const patch = { order: (i + 1) * 10, ...(patchPerName?.(name, i) || {}) };
      return putProject(name, patch);
    })
  );
}

function ProjectItem({
  project,
  section,
  isViewed,
  hasAgentActivity,
  allProjects,
  folders,
  renaming,
  onView,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onDeleteRequest,
  onDragStart,
  onDragEnd,
  onDragOverItem,
  onDragLeaveItem,
  onDropItem,
}) {
  const [renameValue, setRenameValue] = useState(project.displayName || project.name);
  const inputRef = useRef(null);

  useLayoutEffect(() => {
    if (renaming) {
      setRenameValue(project.displayName || project.name);
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 0);
    }
  }, [renaming, project.displayName, project.name]);

  const cls = [
    'project-item',
    isViewed && 'viewed',
    project.archived && 'archived',
  ].filter(Boolean).join(' ');

  return (
    <div
      className={cls}
      draggable={!renaming}
      onDragStart={(e) => onDragStart?.(e, project, section)}
      onDragEnd={onDragEnd}
      onDragOver={(e) => onDragOverItem?.(e, project, section)}
      onDragLeave={(e) => onDragLeaveItem?.(e, project)}
      onDrop={(e) => onDropItem?.(e, project, section)}
      onClick={() => !renaming && onView?.(project.name)}
    >
      <span className="row-grip" aria-hidden="true">
        <GripVertical size={12} />
      </span>
      {renaming ? (
        <input
          ref={inputRef}
          className="proj-rename"
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onCommitRename?.(renameValue);
            else if (e.key === 'Escape') onCancelRename?.();
          }}
          onBlur={() => onCommitRename?.(renameValue)}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="proj-name">{formatDisplayName(project.name, allProjects)}</span>
      )}
      {!renaming && hasAgentActivity && (
        <span
          className="agent-pulse"
          aria-label="Agent active on this project"
          title="Agent active on this project"
        >
          <span className="agent-pulse-halo" />
          <span className="agent-pulse-dot" />
        </span>
      )}
      {!renaming && (
        <ProjectActionsMenu
          project={project}
          folders={folders}
          onRenameRequest={onStartRename}
          onDeleteRequest={onDeleteRequest}
        />
      )}
    </div>
  );
}

export default function Sidebar() {
  const { state } = useAppState();
  const [container, setContainer] = useState(null);
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const [userFolders, setUserFolders] = useState(loadUserFolders);
  const [folderOrder, setFolderOrder] = useState(loadFolderOrder);
  const [folderDropTarget, setFolderDropTarget] = useState(null); // { folder, kind: 'before'|'after' }
  const folderDragState = useRef({ sourceFolder: null });
  const [createOpen, setCreateOpen] = useState(false);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [renamingName, setRenamingName] = useState(null);
  const [dropTarget, setDropTarget] = useState(null); // { kind, itemName?, section }
  const dragState = useRef({ sourceName: null, sourceSection: null });

  // "+ New" menu
  const newBtnRef = useRef(null);
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [newMenuRect, setNewMenuRect] = useState(null);

  // New-folder inline modal
  const [newFolderValue, setNewFolderValue] = useState('');

  useLayoutEffect(() => {
    const el = document.getElementById('sidebar');
    if (el) {
      el.innerHTML = '';
      setContainer(el);
    }
  }, []);

  const toggleSection = useCallback((key) => {
    setCollapsed((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      saveCollapsed(next);
      return next;
    });
  }, []);

  const projects = state?.projects || [];
  const activeProject = state?.activeProject;
  const viewedProject = state?.viewedProject;
  // T-161 B4 Pulse: set of project names that have at least one agent actively
  // working on them. Source of truth is flowboard_agents via /api/agents.
  // Kept deliberately independent of state.activeProject (legacy single-active
  // concept) so Layer 1 (project activity) ≠ Layer 2 (task claim).
  const agentActiveProjects = useMemo(() => {
    const set = new Set();
    for (const a of state?.agents || []) {
      if (a?.active_project) set.add(a.active_project);
    }
    return set;
  }, [state?.agents]);

  const { rootItems, folders, folderItems, archiveItems } = useMemo(() => {
    const active = [];
    const archived = [];
    for (const p of projects) {
      if (p.archived) archived.push(p);
      else active.push(p);
    }
    active.sort(compareProjects);
    archived.sort(compareProjects);

    const byFolder = new Map();
    const root = [];
    for (const p of active) {
      if (p.group) {
        if (!byFolder.has(p.group)) byFolder.set(p.group, []);
        byFolder.get(p.group).push(p);
      } else {
        root.push(p);
      }
    }

    // Merge server-derived folders with localStorage user-defined empty folders
    const folderSet = new Set([...byFolder.keys(), ...userFolders]);
    // Apply custom folder order (localStorage): take ordered names that still
    // exist, then append any remaining folders alphabetically for stable layout.
    const ordered = [];
    const seen = new Set();
    for (const name of folderOrder) {
      if (folderSet.has(name) && !seen.has(name)) {
        ordered.push(name);
        seen.add(name);
      }
    }
    const leftovers = [...folderSet].filter((f) => !seen.has(f)).sort((a, b) => a.localeCompare(b));
    const folderNames = [...ordered, ...leftovers];
    // Ensure every folder has at least an empty list entry
    for (const f of folderNames) {
      if (!byFolder.has(f)) byFolder.set(f, []);
    }

    return {
      rootItems: root,
      folders: folderNames,
      folderItems: byFolder,
      archiveItems: archived,
    };
  }, [projects, userFolders, folderOrder]);

  function addUserFolder(name) {
    const trimmed = (name || '').trim();
    if (!trimmed) return;
    setUserFolders((prev) => {
      if (prev.includes(trimmed)) return prev;
      const next = [...prev, trimmed];
      saveUserFolders(next);
      return next;
    });
  }

  function removeUserFolderIfMaterialized(name) {
    // Called after a project is moved *into* a folder — the folder no longer
    // needs a localStorage stub since it's now backed by real project data.
    setUserFolders((prev) => {
      if (!prev.includes(name)) return prev;
      const next = prev.filter((x) => x !== name);
      saveUserFolders(next);
      return next;
    });
  }

  async function refresh() { await window._refreshProjects?.(); }

  // --- DnD ---

  function sectionOf(project) {
    if (project.archived) return ARCHIVE_KEY;
    if (project.group) return `${FOLDER_PREFIX}${project.group}`;
    return ROOT_ZONE;
  }

  function patchForSection(sectionKey) {
    if (sectionKey === ARCHIVE_KEY) return { archived: true };
    if (sectionKey === ROOT_ZONE) return { archived: false, group: null };
    if (sectionKey.startsWith(FOLDER_PREFIX)) {
      return { archived: false, group: sectionKey.slice(FOLDER_PREFIX.length) };
    }
    return {};
  }

  function sectionItems(sectionKey) {
    if (sectionKey === ARCHIVE_KEY) return archiveItems;
    if (sectionKey === ROOT_ZONE) return rootItems;
    if (sectionKey.startsWith(FOLDER_PREFIX)) {
      return folderItems.get(sectionKey.slice(FOLDER_PREFIX.length)) || [];
    }
    return [];
  }

  function onDragStart(e, project) {
    dragState.current.sourceName = project.name;
    dragState.current.sourceSection = sectionOf(project);
    try {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', project.name);
    } catch { /* noop */ }
  }
  function onDragEnd() {
    dragState.current.sourceName = null;
    dragState.current.sourceSection = null;
    setDropTarget(null);
  }

  function onDragOverItem(e, project, section) {
    if (!dragState.current.sourceName) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    const rect = e.currentTarget.getBoundingClientRect();
    const mid = rect.top + rect.height / 2;
    const kind = e.clientY < mid ? 'before' : 'after';
    if (
      dropTarget?.kind !== kind ||
      dropTarget?.itemName !== project.name ||
      dropTarget?.section !== section
    ) {
      setDropTarget({ kind, itemName: project.name, section });
    }
  }
  function onDragLeaveItem(e, project) {
    // Only clear if we're leaving cleanly (not onto a child)
    if (dropTarget?.itemName === project.name && !e.currentTarget.contains(e.relatedTarget)) {
      setDropTarget(null);
    }
  }

  function onDragOverSection(section) {
    return (e) => {
      if (!dragState.current.sourceName) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      // Only set into-section if we're not already hovering an item
      if (dropTarget?.kind === 'before' || dropTarget?.kind === 'after') return;
      if (dropTarget?.kind !== 'into' || dropTarget?.section !== section) {
        setDropTarget({ kind: 'into', section });
      }
    };
  }
  function onDragLeaveSection(section) {
    return (e) => {
      if (dropTarget?.section === section && dropTarget?.kind === 'into' &&
          !e.currentTarget.contains(e.relatedTarget)) {
        setDropTarget(null);
      }
    };
  }

  async function applyDrop(targetSection, insertIndex) {
    const sourceName = dragState.current.sourceName;
    const sourceSection = dragState.current.sourceSection;
    dragState.current.sourceName = null;
    dragState.current.sourceSection = null;
    setDropTarget(null);
    if (!sourceName) return;

    // Build new ordered list of names for the target section
    const destItems = sectionItems(targetSection)
      .map((p) => p.name)
      .filter((n) => n !== sourceName);
    const idx = Math.max(0, Math.min(insertIndex, destItems.length));
    destItems.splice(idx, 0, sourceName);

    const patch = patchForSection(targetSection);
    const crossSection = targetSection !== sourceSection;

    try {
      // For cross-section, first apply group/archived change on the dragged project.
      // The batch renumber sets order afterwards. Two passes so the source's new
      // section membership is consistent before we renumber.
      if (crossSection) {
        await putProject(sourceName, patch);
      }
      // Renumber destination section. For cross-section, also apply patch to the
      // source so its group/archived sticks even if renumber lands first.
      await persistSectionOrder(destItems, (name) =>
        name === sourceName ? patch : null
      );
      // If target was a localStorage-only empty folder and we just added a project,
      // drop the localStorage stub (folder is now server-backed).
      if (targetSection.startsWith(FOLDER_PREFIX)) {
        removeUserFolderIfMaterialized(targetSection.slice(FOLDER_PREFIX.length));
      }
      await refresh();
    } catch (err) {
      window.showToast?.(`Drop failed: ${err.message}`, 'error');
    }
  }

  function onDropItem(e, project, section) {
    e.preventDefault();
    e.stopPropagation();
    const sourceName = dragState.current.sourceName;
    if (!sourceName) return;
    const destList = sectionItems(section).filter((p) => p.name !== sourceName);
    let targetIdx = destList.findIndex((p) => p.name === project.name);
    if (targetIdx < 0) targetIdx = destList.length;
    const kind = dropTarget?.kind === 'after' ? 'after' : 'before';
    const insertAt = kind === 'after' ? targetIdx + 1 : targetIdx;
    applyDrop(section, insertAt);
  }

  function onDropSection(section) {
    return (e) => {
      e.preventDefault();
      if (!dragState.current.sourceName) return;
      // Drop on section = append at end
      const destList = sectionItems(section).filter((p) => p.name !== dragState.current.sourceName);
      applyDrop(section, destList.length);
    };
  }

  // --- Folder reordering DnD (localStorage only; folders are string keys on
  // projects and don't have a server-side entity). Separate drag-state from
  // project DnD so the two flows can never cross-wire. ---
  function onFolderDragStart(e, folderName) {
    folderDragState.current.sourceFolder = folderName;
    try {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', `folder:${folderName}`);
    } catch { /* noop */ }
    e.stopPropagation();
  }
  function onFolderDragEnd() {
    folderDragState.current.sourceFolder = null;
    setFolderDropTarget(null);
  }
  function onFolderDragOver(e, folderName) {
    if (!folderDragState.current.sourceFolder) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    const rect = e.currentTarget.getBoundingClientRect();
    const mid = rect.top + rect.height / 2;
    const kind = e.clientY < mid ? 'before' : 'after';
    if (folderDropTarget?.folder !== folderName || folderDropTarget?.kind !== kind) {
      setFolderDropTarget({ folder: folderName, kind });
    }
  }
  function onFolderDragLeave(e, folderName) {
    if (folderDropTarget?.folder === folderName && !e.currentTarget.contains(e.relatedTarget)) {
      setFolderDropTarget(null);
    }
  }
  function onFolderDrop(e, folderName) {
    e.preventDefault();
    e.stopPropagation();
    const source = folderDragState.current.sourceFolder;
    const target = folderDropTarget;
    folderDragState.current.sourceFolder = null;
    setFolderDropTarget(null);
    if (!source || source === folderName) return;

    // Rebuild ordered list: drop source out, re-insert at chosen position
    const current = folders.slice();
    const filtered = current.filter((f) => f !== source);
    const targetIdx = filtered.indexOf(folderName);
    if (targetIdx < 0) return;
    const insertAt = target?.kind === 'after' ? targetIdx + 1 : targetIdx;
    filtered.splice(insertAt, 0, source);
    saveFolderOrder(filtered);
    setFolderOrder(filtered);
  }

  function folderInsertIndex() {
    if (!folderDragState.current.sourceFolder) return -1;
    if (!folderDropTarget) return -1;
    const idx = folders.findIndex((f) => f === folderDropTarget.folder);
    if (idx < 0) return -1;
    return folderDropTarget.kind === 'after' ? idx + 1 : idx;
  }

  async function commitRename(name, nextDisplay) {
    const trimmed = (nextDisplay || '').trim();
    const current = projects.find((p) => p.name === name);
    if (!current) { setRenamingName(null); return; }
    const before = current.displayName || current.name;
    if (trimmed.length === 0 || trimmed === before) { setRenamingName(null); return; }
    setRenamingName(null);
    try {
      await putProject(name, { displayName: trimmed });
      await refresh();
    } catch (err) {
      window.showToast?.(`Rename failed: ${err.message}`, 'error');
    }
  }

  function openNewMenu() {
    setNewMenuRect(newBtnRef.current?.getBoundingClientRect() || null);
    setNewMenuOpen(true);
  }

  if (!container || !state) return null;


  const renderItem = (p, sectionKey) => (
    <ProjectItem
      key={p.name}
      project={p}
      section={sectionKey}
      isViewed={p.name === viewedProject}
      hasAgentActivity={agentActiveProjects.has(p.name)}
      allProjects={projects}
      folders={folders}
      renaming={renamingName === p.name}
      onView={(name) => window._viewProject?.(name)}
      onStartRename={() => setRenamingName(p.name)}
      onCommitRename={(v) => commitRename(p.name, v)}
      onCancelRename={() => setRenamingName(null)}
      onDeleteRequest={setDeleteTarget}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOverItem={onDragOverItem}
      onDragLeaveItem={onDragLeaveItem}
      onDropItem={onDropItem}
    />
  );

  // Compute the insertion index that a drop would target in the given section.
  // Returns -1 when no drop is pending for this section. 'into' kinds resolve
  // to items.length (append at end). 'before'/'after' resolve to the index of
  // the hovered item, adjusted by kind.
  function insertIndexFor(sectionKey, items) {
    if (!dragState.current.sourceName) return -1;
    if (dropTarget?.section !== sectionKey) return -1;
    if (dropTarget.kind === 'into') return items.length;
    const idx = items.findIndex((p) => p.name === dropTarget.itemName);
    if (idx < 0) return -1;
    return dropTarget.kind === 'after' ? idx + 1 : idx;
  }

  // Render helper: interleave <div className="drop-line" /> at computed insertAt.
  // Handles both populated and empty lists (empty list → single divider at 0 when
  // the section is the drop target).
  function renderItemsWithDivider(items, sectionKey) {
    const insertAt = insertIndexFor(sectionKey, items);
    const rows = [];
    for (let i = 0; i < items.length; i++) {
      if (insertAt === i) {
        rows.push(<div key={`__line-${i}`} className="drop-line" />);
      }
      rows.push(<Fragment key={items[i].name}>{renderItem(items[i], sectionKey)}</Fragment>);
    }
    if (insertAt === items.length) {
      rows.push(<div key="__line-end" className="drop-line" />);
    }
    return rows;
  }

  // Empty-section-only ring highlight (when a drop is hovering an empty folder
  // body or the empty archive placeholder). For populated sections the divider
  // does all the visual work.
  function emptySectionIntoClass(sectionKey, items) {
    if (!dragState.current.sourceName) return '';
    if (items.length !== 0) return '';
    if (dropTarget?.section === sectionKey && dropTarget?.kind === 'into') return 'drop-into';
    return '';
  }

  return createPortal(
    <>
      <div className="sidebar-head">
        <div className="sidebar-label">Projects</div>
        <button
          ref={newBtnRef}
          type="button"
          className="sidebar-new"
          onClick={openNewMenu}
          aria-expanded={newMenuOpen}
        >
          <Plus size={11} strokeWidth={2.25} />
          <span>New</span>
        </button>
      </div>

      <Popover open={newMenuOpen} onClose={() => setNewMenuOpen(false)} anchorRect={newMenuRect}>
        <Popover.Option onClick={() => { setNewMenuOpen(false); setCreateOpen(true); }}>
          <span className="inline-flex items-center gap-2">
            <Plus size={13} /> New project
          </span>
        </Popover.Option>
        <Popover.Option onClick={() => { setNewMenuOpen(false); setNewFolderValue(''); setNewFolderOpen(true); }}>
          <span className="inline-flex items-center gap-2">
            <FolderPlus size={13} /> New folder
          </span>
        </Popover.Option>
      </Popover>

      <div className="sidebar-scroll">
        {projects.length === 0 && folders.length === 0 && (
          <div className="sidebar-empty">No projects</div>
        )}

        <div
          className={emptySectionIntoClass(ROOT_ZONE, rootItems)}
          onDragOver={onDragOverSection(ROOT_ZONE)}
          onDragLeave={onDragLeaveSection(ROOT_ZONE)}
          onDrop={onDropSection(ROOT_ZONE)}
          style={{ minHeight: rootItems.length === 0 ? 16 : undefined }}
        >
          {renderItemsWithDivider(rootItems, ROOT_ZONE)}
        </div>

        {(() => {
          const folderInsertAt = folderInsertIndex();
          const out = [];
          folders.forEach((f, i) => {
            if (folderInsertAt === i) {
              out.push(<div key={`__folder-line-${i}`} className="drop-line" />);
            }
            const sectionKey = `${FOLDER_PREFIX}${f}`;
            const isCollapsed = !!collapsed[`folder:${f}`];
            const items = folderItems.get(f) || [];
            out.push(
              <div
                key={f}
                className="folder-group"
                onDragOver={onDragOverSection(sectionKey)}
                onDragLeave={onDragLeaveSection(sectionKey)}
                onDrop={onDropSection(sectionKey)}
              >
                <button
                  type="button"
                  className={`folder-head ${isCollapsed ? 'collapsed' : ''}`}
                  onClick={() => toggleSection(`folder:${f}`)}
                  draggable
                  onDragStart={(e) => onFolderDragStart(e, f)}
                  onDragEnd={onFolderDragEnd}
                  onDragOver={(e) => onFolderDragOver(e, f)}
                  onDragLeave={(e) => onFolderDragLeave(e, f)}
                  onDrop={(e) => onFolderDrop(e, f)}
                >
                  <span className="chev"><ChevronDown size={10} /></span>
                  <span className="folder-ico"><Folder size={11} /></span>
                  <span>{f}</span>
                </button>
                {!isCollapsed && (
                  <div className={`folder-body ${emptySectionIntoClass(sectionKey, items)}`}>
                    {renderItemsWithDivider(items, sectionKey)}
                  </div>
                )}
              </div>
            );
          });
          if (folderInsertAt === folders.length) {
            out.push(<div key="__folder-line-end" className="drop-line" />);
          }
          return out;
        })()}

        {archiveItems.length > 0 && (
          <div
            className="archive-section"
            onDragOver={onDragOverSection(ARCHIVE_KEY)}
            onDragLeave={onDragLeaveSection(ARCHIVE_KEY)}
            onDrop={onDropSection(ARCHIVE_KEY)}
          >
            <button
              type="button"
              className={`archive-head ${collapsed[ARCHIVE_KEY] ? 'collapsed' : ''}`}
              onClick={() => toggleSection(ARCHIVE_KEY)}
            >
              <span className="chev"><ChevronDown size={10} /></span>
              <span className="folder-ico"><Archive size={11} /></span>
              <span>Archive</span>
              <span className="folder-count">{archiveItems.length}</span>
            </button>
            {!collapsed[ARCHIVE_KEY] && (
              <div className={`folder-body ${emptySectionIntoClass(ARCHIVE_KEY, archiveItems)}`}>
                {renderItemsWithDivider(archiveItems, ARCHIVE_KEY)}
              </div>
            )}
          </div>
        )}

        {/* Empty archive placeholder — only shown during active drag so users
            have a drop-target without the section being permanently visible. */}
        {archiveItems.length === 0 && dragState.current.sourceName && (
          <div
            className={`archive-section ${emptySectionIntoClass(ARCHIVE_KEY, archiveItems)}`}
            onDragOver={onDragOverSection(ARCHIVE_KEY)}
            onDragLeave={onDragLeaveSection(ARCHIVE_KEY)}
            onDrop={onDropSection(ARCHIVE_KEY)}
          >
            <div className="archive-head" style={{ cursor: 'default', opacity: 0.4 }}>
              <span className="folder-ico"><Archive size={11} /></span>
              <span>Drop to archive</span>
            </div>
          </div>
        )}
      </div>



      <CreateProjectModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        folders={folders}
        existingNames={projects.map((p) => p.name)}
        onCreated={(project) => {
          if (project?.group) removeUserFolderIfMaterialized(project.group);
          window._refreshProjects?.().then(() => {
            if (project?.name) window._viewProject?.(project.name);
          });
        }}
      />

      <NewFolderModal
        open={newFolderOpen}
        initial={newFolderValue}
        existing={folders}
        onClose={() => setNewFolderOpen(false)}
        onCreate={(name) => {
          addUserFolder(name);
          setNewFolderOpen(false);
        }}
      />

      <DeleteProjectModal
        open={!!deleteTarget}
        project={deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onDeleted={() => { window._refreshProjects?.(); }}
      />
    </>,
    container
  );
}

// Tiny inline modal just for creating an empty folder. Kept colocated with the
// Sidebar because it's the only consumer and has no other surface in the app.
function NewFolderModal({ open, initial = '', existing = [], onClose, onCreate }) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef(null);
  useLayoutEffect(() => {
    if (open) {
      setValue(initial || '');
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open, initial]);
  if (!open) return null;

  const trimmed = value.trim();
  const clash = existing.includes(trimmed);
  const canCreate = trimmed.length > 0 && trimmed.length <= 60 && !clash;

  return createPortal(
    <div
      className="modal-overlay"
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
      }}
      onClick={onClose}
    >
      <div
        className="np-modal"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 360 }}
      >
        <div className="np-header">
          <div className="np-title">New folder</div>
        </div>
        <div className="np-body">
          <div className="np-field">
            <label className="np-label" htmlFor="nf-name">Folder name</label>
            <input
              ref={inputRef}
              id="nf-name"
              className="np-input"
              placeholder="e.g. Client Work"
              maxLength={60}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canCreate) onCreate(trimmed);
                else if (e.key === 'Escape') onClose();
              }}
            />
            <div className="np-hint">
              Empty folders are visible in this browser only until you move a project into them.
            </div>
            {clash && (
              <div className="np-hint" style={{ color: 'var(--danger, #ef4444)' }}>
                A folder named <span className="mono">{trimmed}</span> already exists.
              </div>
            )}
          </div>
        </div>
        <div className="np-footer">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={!canCreate}
            onClick={() => onCreate(trimmed)}
          >
            Create folder
          </button>
        </div>
      </div>
    </div>,
    document.getElementById('modalRoot') || document.body
  );
}
