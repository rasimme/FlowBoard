import { useMemo, useState, useCallback, useRef, useEffect, memo } from 'react';
import { useAppState } from '../context/AppStateContext.jsx';
import { Modal, PriorityPill, Popover, ActiveAgentsBar, Tooltip } from '../components/index.js';
import AgentChip from '../components/AgentChip.jsx';
import LeaseIndicator from '../components/LeaseIndicator.jsx';
import BlockedChip from '../components/BlockedChip.jsx';
import UndoToast from '../components/UndoToast.jsx';
import TrashPanel from '../components/TrashPanel.jsx';
import { useHaptic } from '../hooks/useHaptic.js';
import { Plus, Trash2, FileText, FilePlus, Archive, ListTree, RotateCcw } from 'lucide-react';
import { apiFetch } from '../utils/apiFetch.js';

const STATUS_KEYS = ['backlog', 'open', 'in-progress', 'review', 'done'];
const STATUS_LABELS = {
  backlog: 'Backlog',
  open: 'Open',
  'in-progress': 'In Progress',
  review: 'Review',
  done: 'Done',
};

function getInitialSort() {
  return localStorage.getItem('sortNewestFirst') !== 'false';
}
function getInitialArchived() {
  return localStorage.getItem('showArchived') === 'true';
}

function parseTaskNum(id) {
  return parseInt(id.replace('T-', ''));
}

function sortTasks(tasks, newestFirst) {
  const dir = newestFirst ? -1 : 1;
  return [...tasks].sort((a, b) => dir * (parseTaskNum(a.id) - parseTaskNum(b.id)));
}

// --- Subtask progress bar ---
function SubtaskProgress({ task, allTasks, expanded, onToggle }) {
  const subtasks = allTasks.filter(t => t.parentId === task.id && t.status !== 'archived');
  const total = subtasks.length;
  if (total === 0) return null;

  const done = subtasks.filter(t => t.status === 'done').length;
  const review = subtasks.filter(t => t.status === 'review').length;
  const active = subtasks.filter(t => t.status === 'in-progress').length;
  const donePct = (done / total) * 100;
  const reviewPct = (review / total) * 100;
  const activePct = (active / total) * 100;

  return (
    <div className="subtask-progress" onClick={(e) => { e.stopPropagation(); onToggle(task.id); }}>
      <span className={`expand-chevron${expanded ? ' expanded' : ''}`}>&#9654;</span>
      <div className="progress-bar">
        <div className="progress-done" style={{ width: `${donePct}%` }} />
        <div className="progress-review" style={{ width: `${reviewPct}%` }} />
        <div className="progress-active" style={{ width: `${activePct}%` }} />
      </div>
      <span className="progress-text">{done}/{total}</span>
    </div>
  );
}

// --- Subtask card (compact, uses legacy CSS tree-line system) ---
const SubtaskCard = memo(function SubtaskCard({ task, project, onTaskUpdated }) {
  const [popover, setPopover] = useState({ type: null, open: false, rect: null });
  const suppressClickRef = useRef(false);
  const haptic = useHaptic();

  const handleClick = () => {
    // Guard: don't open detail panel right after a popover action
    if (suppressClickRef.current) { suppressClickRef.current = false; return; }
    if (popover.open) return;
    if (window.openTaskDetail) window.openTaskDetail(task.id);
  };

  const handleDotClick = (e) => {
    e.stopPropagation();
    haptic.light();
    setPopover({ type: 'status', open: true, rect: e.currentTarget.getBoundingClientRect() });
  };

  const handlePopoverClose = () => {
    setPopover(prev => ({ ...prev, open: false }));
    // Suppress the next card click so closing popover doesn't open detail panel
    suppressClickRef.current = true;
    setTimeout(() => { suppressClickRef.current = false; }, 200);
  };

  const handleStatusSelect = async (status) => {
    haptic.medium();
    handlePopoverClose();
    await onTaskUpdated?.(task.id, { status });
  };

  const handleOpenSpec = (e) => {
    e.stopPropagation();
    if (window._openSpec) window._openSpec(task.specFile, task.id);
  };

  const handleCreateSpec = async (e) => {
    e.stopPropagation();
    try {
      const res = await apiFetch(`/api/projects/${project}/specs/${task.id}`, { method: 'POST' });
      const data = await res.json();
      if (data.ok && data.specFile) {
        task.specFile = data.specFile;
        if (window.showToast) window.showToast(`Spec created for ${task.id}`, 'success');
        if (window._openSpec) window._openSpec(data.specFile, task.id);
      }
    } catch (err) {
      console.warn('[create-spec]', err);
      if (window.showToast) window.showToast('Failed to create spec', 'error');
    }
  };

  const hasUsableSpec = task.specFile && task.specExists !== false;

  return (
    <div className="subtask-card" onClick={handleClick} style={{ cursor: 'pointer' }}>
      <div className="subtask-card-row">
        <span className="tree-dot" />
        <span className="status-dot-wrap" onClick={handleDotClick}>
          <span className={`status-dot status-dot-${task.status}`} />
        </span>
        <span className="subtask-title">{task.title}</span>
        {task.agent && (
          <AgentChip name={task.agent} size="xs" variant="solid" title={`Claimed by ${task.agent}`} />
        )}
        {!task.agent && task.routedAgent && (
          <AgentChip name={task.routedAgent} size="xs" variant="ring" title={`Routed to ${task.routedAgent}`} />
        )}
        <LeaseIndicator task={task} style={{ marginLeft: -2 }} />
        <span className="subtask-actions">
          {hasUsableSpec
            ? (
              <Tooltip content="Open spec file">
                <span className="spec-badge spec-badge-sm" onClick={handleOpenSpec}>
                  <FileText size={12} />
                </span>
              </Tooltip>
            )
            : (
              <Tooltip content="Create spec file">
                <span className="spec-badge spec-badge-add spec-badge-sm" onClick={handleCreateSpec}>
                  <FilePlus size={12} />
                </span>
              </Tooltip>
            )
          }
        </span>
      </div>
      {/* T-161-4: Blocked signal drops to its own line under the title so
          the main row's content (title + identity chips + spec) never gets
          truncated. Card grows vertically only when blocked is true. */}
      {task.blocked && (
        <div className="subtask-card-blocked">
          <BlockedChip />
        </div>
      )}
      {/* Status popover */}
      <Popover open={popover.open && popover.type === 'status'} onClose={handlePopoverClose} anchorRect={popover.rect}>
        {['backlog', 'open', 'in-progress', 'review', 'done'].map(s => (
          <Popover.Option key={s} onClick={() => handleStatusSelect(s)}>
            <span className="flex items-center gap-2">
              <span className={`status-dot status-dot-${s}`} />
              <span>{STATUS_LABELS[s]}</span>
            </span>
          </Popover.Option>
        ))}
      </Popover>
    </div>
  );
});

// --- Parent task card ---
const TaskCard = memo(function TaskCard({ task, allTasks, expanded, onToggleExpand, project, onTaskDeleted, onTaskTrashed, onTaskUpdated, dragRef, isNew, addingSubtask, onAddSubtask, onSubtaskCreated, onCancelAddSubtask }) {
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [animated, setAnimated] = useState(false);
  const [popover, setPopover] = useState({ type: null, open: false, rect: null });
  const haptic = useHaptic();

  const hasSubtasks = task.subtaskIds && task.subtaskIds.length > 0;
  const hasUsableSpec = task.specFile && task.specExists !== false;

  const handleClick = () => {
    if (window.openTaskDetail) window.openTaskDetail(task.id);
  };

  // --- Drag handlers ---
  const handleDragStart = (e) => {
    dragRef.current = task.id;
    e.dataTransfer.effectAllowed = 'move';
    e.currentTarget.classList.add('dragging');
  };

  const handleDragEnd = (e) => {
    e.currentTarget.classList.remove('dragging');
    document.querySelectorAll('.column').forEach(c => c.classList.remove('drag-over'));
    dragRef.current = null;
  };

  // --- Delete with shrink animation ---
  const handleDeleteClick = (e) => {
    e.stopPropagation();
    haptic.light();
    setShowDeleteModal(true);
  };

  const handleDeleteConfirm = async () => {
    setShowDeleteModal(false);
    // T-161-4: soft-delete → move to Trash (sets metadata.flowboard.trashedAt).
    // The task's current status is preserved so Restore from Trash returns
    // it exactly where it was. The card disappears from the Kanban via the
    // grouped-filter re-derivation, no shrink animation needed.
    try {
      await onTaskTrashed?.(task.id, task.status);
    } catch (err) {
      if (window.showToast) window.showToast('Delete failed: ' + err.message, 'error');
    }
  };

  // --- Archive (T-161-4): only available on done tasks via the card hover icon.
  // Any-status archive lives in the DetailPanel Kebab (Chunk 6). No modal
  // here yet — archive is reversible (restore from Archive section), so we
  // keep the card gesture snappy and rely on the existing toast-on-update
  // surface for feedback.
  const handleArchiveClick = async (e) => {
    e.stopPropagation();
    haptic.medium();
    try {
      await onTaskUpdated?.(task.id, { status: 'archived' });
      if (window.showToast) window.showToast(`Archived ${task.id}`, 'success');
    } catch (err) {
      if (window.showToast) window.showToast('Archive failed', 'error');
    }
  };

  const handleAnimationEnd = () => {
    if (removing) {
      onTaskDeleted?.(task.id);
    }
    if (isNew && !animated) {
      setAnimated(true);
    }
  };

  // --- Popovers ---
  const handlePopoverOpen = (e, type) => {
    e.stopPropagation();
    haptic.light();
    const rect = e.currentTarget.getBoundingClientRect();
    setPopover({ type, open: true, rect });
  };

  const handlePopoverClose = () => {
    setPopover(prev => ({ ...prev, open: false }));
  };

  const handlePopoverSelect = async (value) => {
    haptic.medium();
    handlePopoverClose();
    if (popover.type === 'priority') {
      await onTaskUpdated?.(task.id, { priority: value });
    }
  };

  // --- Spec file ---
  const handleOpenSpec = (e) => {
    e.stopPropagation();
    if (window._openSpec) window._openSpec(task.specFile, task.id);
  };

  const handleCreateSpec = async (e) => {
    e.stopPropagation();
    try {
      const res = await apiFetch(`/api/projects/${project}/specs/${task.id}`, { method: 'POST' });
      const data = await res.json();
      if (data.ok && data.specFile) {
        task.specFile = data.specFile;
        if (window.showToast) window.showToast(`Spec created for ${task.id}`, 'success');
        if (window._openSpec) window._openSpec(data.specFile, task.id);
      }
    } catch (err) {
      console.warn('[create-spec]', err);
      if (window.showToast) window.showToast('Failed to create spec', 'error');
    }
  };

  // Build card class
  let cardClass = 'task-card';
  if (task.status === 'archived') cardClass += ' is-archived';
  if (task.blocked) cardClass += ' is-blocked';
  if (removing) cardClass += ' animate-shrink overflow-hidden';
  else if (isNew && !animated) cardClass += ' animate-rise';

  return (
    <div>
      <div className="relative group">
        <div
          className={cardClass}
          draggable={!removing}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onClick={!removing ? handleClick : undefined}
          onAnimationEnd={handleAnimationEnd}
          data-react-tasks
        >
          <div className="flex items-start justify-between gap-2 mb-1">
            <span className="task-id mono">
              {task.id}
            </span>
            {/* Right cluster — hover-revealed admin icons sit directly to
                the left of the permanent AgentChip cluster. If no agent
                is claimed/routed, the Delete icon becomes the right-most
                element. Archive only appears for done tasks. */}
            <span className="flex items-center gap-1 shrink-0">
              <span className="card-hover-actions">
                {task.status === 'done' && (
                  <Tooltip content="Archive task">
                    <button
                      type="button"
                      className="card-hover-btn card-hover-btn-archive"
                      onClick={handleArchiveClick}
                      aria-label="Archive task"
                    >
                      <Archive size={14} />
                    </button>
                  </Tooltip>
                )}
                <Tooltip content="Move to Trash">
                  <button
                    type="button"
                    className="card-hover-btn card-hover-btn-delete"
                    onClick={handleDeleteClick}
                    aria-label="Move to Trash"
                  >
                    <Trash2 size={14} />
                  </button>
                </Tooltip>
              </span>
              {task.agent && (
                <AgentChip
                  name={task.agent}
                  size="sm"
                  variant="solid"
                  title={`Claimed by ${task.agent}`}
                />
              )}
              {!task.agent && task.routedAgent && (
                <AgentChip
                  name={task.routedAgent}
                  size="sm"
                  variant="ring"
                  title={`Routed to ${task.routedAgent}`}
                />
              )}
              <LeaseIndicator task={task} style={{ marginLeft: -2 }} />
            </span>
          </div>
          <div className="task-title">{task.title}</div>
          <div className="task-meta">
            <span className="priority-pill-wrap flex items-center gap-[6px]">
              {task.priority && (
                <PriorityPill
                  priority={task.priority}
                  onClick={(e) => handlePopoverOpen(e, 'priority')}
                />
              )}
              {task.blocked && <BlockedChip />}
            </span>
            <span className="task-meta-actions">
              <Tooltip content="Add subtask">
                <span className="subtask-add-btn" onClick={(e) => { e.stopPropagation(); onAddSubtask?.(task.id); }}>
                  <ListTree size={14} />
                </span>
              </Tooltip>
              {hasUsableSpec
                ? (
                  <Tooltip content="Open spec file">
                    <span className="spec-badge" onClick={handleOpenSpec}>
                      <FileText size={14} />
                    </span>
                  </Tooltip>
                )
                : (
                  <Tooltip content="Create spec file">
                    <span className="spec-badge spec-badge-add" onClick={handleCreateSpec}>
                      <FilePlus size={14} />
                    </span>
                  </Tooltip>
                )
              }
            </span>
          </div>
          {hasSubtasks && (
            <SubtaskProgress
              task={task}
              allTasks={allTasks}
              expanded={expanded}
              onToggle={onToggleExpand}
            />
          )}
        </div>
        <Popover
          open={popover.open && popover.type === 'priority'}
          onClose={handlePopoverClose}
          anchorRect={popover.rect}
        >
          <div className="flex gap-1 p-1.5">
            {['low', 'medium', 'high'].map(p => (
              <PriorityPill
                key={p}
                priority={p}
                onClick={() => handlePopoverSelect(p)}
                className={p !== task.priority ? 'opacity-50 hover:opacity-100' : ''}
              />
            ))}
          </div>
        </Popover>
      </div>
      {showDeleteModal && (
        <DeleteTaskModal
          task={task}
          project={project}
          onConfirm={handleDeleteConfirm}
          onCancel={() => setShowDeleteModal(false)}
        />
      )}
      {(hasSubtasks && expanded || addingSubtask) && !removing && (
        <ExpandedSubtasks
          task={task} allTasks={allTasks} project={project} onTaskUpdated={onTaskUpdated}
          showAddForm={addingSubtask}
          onSubtaskCreated={onSubtaskCreated}
          onCancelAdd={onCancelAddSubtask}
        />
      )}
    </div>
  );
});

// --- Expanded subtask list (uses legacy CSS tree-line system) ---
function ExpandedSubtasks({ task, allTasks, project, onTaskUpdated, showAddForm, onSubtaskCreated, onCancelAdd }) {
  const subtasks = allTasks.filter(t => t.parentId === task.id && t.status !== 'archived');

  if (subtasks.length === 0 && !showAddForm) return null;

  return (
    <div className="subtask-container">
      {subtasks.map(st => (
        <SubtaskCard key={st.id} task={st} project={project} onTaskUpdated={onTaskUpdated} />
      ))}
      {showAddForm && (
        <AddSubtaskForm parentId={task.id} project={project} onCreated={onSubtaskCreated} onCancel={onCancelAdd} />
      )}
    </div>
  );
}

// --- Inline add-subtask form (inside subtask-container for tree-line continuity) ---
function AddSubtaskForm({ parentId, project, onCreated, onCancel }) {
  const [title, setTitle] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef(null);
  const haptic = useHaptic();

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 50);
  }, []);

  const handleSubmit = async () => {
    const trimmed = title.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    try {
      const res = await apiFetch(`/api/projects/${project}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: trimmed, parentId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create subtask');
      haptic.medium();
      // Push subtask into local state + update parent's subtaskIds
      if (data.task) {
        window.appState.tasks.push(data.task);
        const parent = window.appState.tasks.find(t => t.id === parentId);
        if (parent) {
          if (!parent.subtaskIds) parent.subtaskIds = [];
          parent.subtaskIds.push(data.task.id);
        }
        window.appState.tasks = [...window.appState.tasks];
      }
      if (window.showToast) window.showToast(`Subtask ${data.task?.id} created`, 'success');
      onCreated?.();
    } catch (err) {
      console.warn('[add-subtask]', err);
      haptic.error();
      if (window.showToast) window.showToast(err.message, 'error');
      setSubmitting(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); handleSubmit(); }
    if (e.key === 'Escape') onCancel?.();
  };

  return (
    <div className="add-subtask-form">
      <div className="tree-dot-form" />
      <input
        ref={inputRef}
        className="subtask-input"
        placeholder="Subtask title..."
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={submitting}
      />
      <div className="form-actions" style={{ marginTop: 6 }}>
        <button className="btn btn-primary btn-sm" onClick={handleSubmit} disabled={!title.trim() || submitting}>Add</button>
        <button className="btn btn-secondary btn-sm" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// --- Archived task card (read-only, dimmed) ---
function ArchivedTaskCard({ task, project, onTaskUpdated, onTaskTrashed }) {
  // Archived cards open the Panel on click (for full detail view) and
  // offer two hover icons on the card itself: Restore (un-archive) and
  // Delete (→ Trash), symmetrical to the live-card hover row. Archive
  // itself obviously doesn't reappear — the card already is archived.
  const handleClick = () => { if (window.openTaskDetail) window.openTaskDetail(task.id); };

  const handleRestoreClick = async (e) => {
    e.stopPropagation();
    try {
      // Restore from archive = status back to `done`. HZL's updateTask
      // takes care of lifting child tasks out of archived too. From
      // `done` the user can move it anywhere via the Status-Picker.
      await onTaskUpdated?.(task.id, { status: 'done' });
      if (window.showToast) window.showToast(`Restored ${task.id}`, 'success');
    } catch {
      if (window.showToast) window.showToast('Restore failed', 'error');
    }
  };

  const handleDeleteClick = async (e) => {
    e.stopPropagation();
    try {
      await onTaskTrashed?.(task.id, task.status);
    } catch {
      if (window.showToast) window.showToast('Delete failed', 'error');
    }
  };

  // Structure mirrors TaskCard 1:1 so layout behaviour is identical:
  // outer <div><div.relative.group><div.task-card>…</div></div></div>
  // plus the `shrink-0` flex wrapper around the right-cluster. Archived
  // cards inherit every layout property from .task-card + mobile
  // media-query overrides; they differ only in colour (via
  // .is-archived) and in which action icons the hover row exposes.
  return (
    <div>
      <div className="relative group">
        <div
          className="task-card is-archived"
          onClick={handleClick}
        >
          <div className="flex items-start justify-between gap-2 mb-1">
            <span className="task-id mono">{task.id}</span>
            <span className="flex items-center gap-1 shrink-0">
              <span className="card-hover-actions">
                <Tooltip content="Restore from archive">
                  <button
                    type="button"
                    className="card-hover-btn card-hover-btn-restore"
                    onClick={handleRestoreClick}
                    aria-label="Restore from archive"
                  >
                    <RotateCcw size={14} />
                  </button>
                </Tooltip>
                <Tooltip content="Move to Trash">
                  <button
                    type="button"
                    className="card-hover-btn card-hover-btn-delete"
                    onClick={handleDeleteClick}
                    aria-label="Move to Trash"
                  >
                    <Trash2 size={14} />
                  </button>
                </Tooltip>
              </span>
            </span>
          </div>
          <div className="task-title">{task.title}</div>
          {task.priority && (
            <div className="task-meta">
              <span className="priority-pill-wrap flex items-center gap-[6px]">
                <PriorityPill priority={task.priority} />
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// --- Delete Task Modal (subtask-aware, uses shared Modal) ---
function DeleteTaskModal({ task, project, onConfirm, onCancel }) {
  const subtaskCount = task.subtaskIds?.length || 0;
  const hasSubtasks = subtaskCount > 0;
  const [deleteSubtasks, setDeleteSubtasks] = useState(true);
  const [deleteSpec, setDeleteSpec] = useState(true);
  const haptic = useHaptic();

  const handleConfirm = async () => {
    haptic.medium();
    let url = `/api/projects/${project}/tasks/${task.id}`;
    const params = [];
    if (hasSubtasks) params.push(`mode=${deleteSubtasks ? 'all' : 'keep-children'}`);
    if (deleteSpec && task.specFile) params.push('deleteSpec=true');
    if (params.length) url += '?' + params.join('&');
    try {
      const res = await apiFetch(url, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) {
        if (data.error === 'Task has subtasks') {
          if (window.showToast) window.showToast('Choose how to handle subtasks', 'warn');
          return;
        }
        throw new Error(data.error || 'Failed to delete task');
      }
      if (window.showToast) window.showToast(`Deleted ${task.id}`, 'success');
      onConfirm(task.id);
    } catch (err) {
      console.warn('[delete-task]', err);
      haptic.error();
      if (window.showToast) window.showToast(err.message, 'error');
    }
  };

  return (
    <Modal
      open
      onClose={onCancel}
      title={`Delete ${task.id}?`}
      actions={<>
        <Modal.Button variant="secondary" onClick={onCancel}>Cancel</Modal.Button>
        <Modal.Button variant="danger" onClick={handleConfirm}>Delete</Modal.Button>
      </>}
    >
      <p className="text-sm text-muted truncate mb-3">{task.title}</p>
      <div className="flex flex-col gap-2">
        {hasSubtasks && (
          <label className="flex items-center gap-2 text-sm text-text cursor-pointer">
            <input
              type="checkbox"
              checked={deleteSubtasks}
              onChange={(e) => setDeleteSubtasks(e.target.checked)}
              className="w-4 h-4 rounded border-border accent-accent"
            />
            Delete {subtaskCount} subtask(s)
          </label>
        )}
        {task.specFile && (
          <label className="flex items-center gap-2 text-sm text-text cursor-pointer">
            <input
              type="checkbox"
              checked={deleteSpec}
              onChange={(e) => setDeleteSpec(e.target.checked)}
              className="w-4 h-4 rounded border-border accent-accent"
            />
            Delete spec file
          </label>
        )}
      </div>
    </Modal>
  );
}

// --- Inline Add-Task form (Backlog only) ---
function AddTaskForm({ project, onCreated }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState('medium');
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef(null);
  const haptic = useHaptic();

  const handleOpen = () => {
    setOpen(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const reset = () => {
    setTitle('');
    setPriority('medium');
    setOpen(false);
    setSubmitting(false);
  };

  const handleSubmit = async () => {
    const trimmed = title.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    try {
      const res = await apiFetch(`/api/projects/${project}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: trimmed, priority, status: 'backlog' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create task');
      haptic.medium();
      // Push new task into local state for instant UI update
      if (data.task) {
        window.appState.tasks.push(data.task);
        window.appState.tasks = [...window.appState.tasks];
      }
      if (window.showToast) window.showToast(`Created ${data.task?.id || 'task'}`, 'success');
      onCreated?.(data.task?.id);
      reset();
    } catch (err) {
      console.warn('[add-task]', err);
      haptic.error();
      if (window.showToast) window.showToast(err.message, 'error');
      setSubmitting(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); handleSubmit(); }
    if (e.key === 'Escape') reset();
  };

  if (!open) {
    return (
      <button type="button" className="add-task-btn" onClick={handleOpen}>
        + New Task
      </button>
    );
  }

  return (
    <div className="add-task-form">
      <input
        ref={inputRef}
        id="newTaskTitle"
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Task title..."
        disabled={submitting}
      />
      <div className="priority-selector">
        {['low', 'medium', 'high'].map(p => (
          <PriorityPill
            key={p}
            priority={p}
            onClick={() => setPriority(p)}
            className={priority !== p ? 'opacity-50' : ''}
          />
        ))}
      </div>
      <div className="form-actions">
        <button type="button" className="btn btn-primary btn-sm" onClick={handleSubmit} disabled={!title.trim() || submitting}>
          {submitting ? 'Adding…' : 'Create'}
        </button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={reset}>Cancel</button>
      </div>
    </div>
  );
}

// --- Column (drop zone) ---
const Column = memo(function Column({ status, tasks, archivedTasks, allTasks, showArchived, onToggleArchived, expandedParents, onToggleExpand, sortNewestFirst, project, onTaskCreated, onTaskDeleted, onTaskTrashed, onTaskUpdated, dragRef, onDrop, lastCreatedId, addingSubtaskParentId, onAddSubtask, onSubtaskCreated, onCancelAddSubtask }) {
  const isDone = status === 'done';
  const isBacklog = status === 'backlog';
  const archivedCount = isDone ? archivedTasks.length : 0;
  const sortedArchived = isDone && showArchived ? sortTasks(archivedTasks, sortNewestFirst) : [];

  // When the user toggles "show archived" on, scroll the column so the
  // archived section is immediately visible — otherwise they'd have to
  // scroll the done column themselves just to see what they asked for.
  // We only trigger the scroll when the toggle flips from off→on.
  const archiveAnchorRef = useRef(null);
  const prevShowArchivedRef = useRef(showArchived);
  useEffect(() => {
    if (!isDone) return;
    if (!prevShowArchivedRef.current && showArchived && archiveAnchorRef.current) {
      archiveAnchorRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    prevShowArchivedRef.current = showArchived;
  }, [showArchived, isDone]);

  const handleDragOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    e.currentTarget.classList.add('drag-over');
  };

  const handleDragLeave = (e) => {
    if (!e.currentTarget.contains(e.relatedTarget)) {
      e.currentTarget.classList.remove('drag-over');
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.currentTarget.classList.remove('drag-over');
    onDrop?.(status);
  };

  return (
    <div
      className="column"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="column-header">
        <span className="column-title">{STATUS_LABELS[status]}</span>
        <div className="flex items-center gap-1.5">
          <span className="column-count">{tasks.length}</span>
          {isDone && archivedCount > 0 && (
            <button
              type="button"
              className={`archive-toggle${showArchived ? ' active' : ''}`}
              onClick={onToggleArchived}
              title="Show/hide archived tasks"
            >
              <Archive size={12} /> {archivedCount}
            </button>
          )}
        </div>
      </div>
      <div className="column-body">
        {isBacklog && project && (
          <AddTaskForm project={project} onCreated={onTaskCreated} />
        )}
        {tasks.length === 0 && sortedArchived.length === 0 && !isBacklog ? (
          <div className="column-empty">No tasks</div>
        ) : (
          <>
            {tasks.map(t => (
              <TaskCard
                key={t.id}
                task={t}
                allTasks={allTasks}
                expanded={expandedParents.has(t.id)}
                onToggleExpand={onToggleExpand}
                project={project}
                onTaskDeleted={onTaskDeleted}
                onTaskTrashed={onTaskTrashed}
                onTaskUpdated={onTaskUpdated}
                dragRef={dragRef}
                isNew={t.id === lastCreatedId}
                addingSubtask={addingSubtaskParentId === t.id}
                onAddSubtask={onAddSubtask}
                onSubtaskCreated={onSubtaskCreated}
                onCancelAddSubtask={onCancelAddSubtask}
              />
            ))}
            {sortedArchived.length > 0 && (
              <>
                {/* Subtle divider — 1px-tall background stripe instead
                    of an <hr>. <hr> inherits its user-agent default
                    border (inset, bright) and Tailwind preflight is
                    disabled here, so a bg-color div is the only reliable
                    way to get a thin, dim line. Margins give the
                    breathing room; also serves as the scroll-anchor. */}
                {/* Divider — inline style because the Tailwind
                    `bg-border-strong` path produced an invisible line
                    on the user's display despite CSS generating
                    correctly. Inline style side-steps any cascade or
                    purge ambiguity: a raw 2px flex-item with a visible
                    grey background is the simplest possible guarantee. */}
                <div
                  ref={archiveAnchorRef}
                  aria-hidden="true"
                  style={{
                    height: '2px',
                    background: 'var(--border-strong)',
                    scrollMarginTop: '8px',
                    flexShrink: 0,
                  }}
                />
                {sortedArchived.map(t => <ArchivedTaskCard key={t.id} task={t} project={project} onTaskUpdated={onTaskUpdated} onTaskTrashed={onTaskTrashed} />)}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
});

export default function TasksView() {
  const { state } = useAppState();
  const viewedProject = state?.viewedProject;
  const allTasks = state?.tasks || [];

  const [sortNewestFirst, setSortNewestFirst] = useState(getInitialSort);
  const [showArchived, setShowArchived] = useState(getInitialArchived);
  const [expandedParents, setExpandedParents] = useState(() => {
    try { return new Set(window.kanbanState?.expandedParents || []); } catch { return new Set(); }
  });
  const [lastCreatedId, setLastCreatedId] = useState(null);
  const [addingSubtaskParentId, setAddingSubtaskParentId] = useState(null);
  // T-161-4: Trash panel + Undo-toast state. UndoState lives alongside
  // handleTaskTrashed so the user can reverse a just-deleted task without
  // needing to open the Trash panel.
  const [trashPanelOpen, setTrashPanelOpen] = useState(false);
  const [undoState, setUndoState] = useState(null); // { taskId, title, prevStatus }

  const draggedId = useRef(null);

  const handleToggleSort = useCallback(() => {
    setSortNewestFirst(prev => {
      const next = !prev;
      localStorage.setItem('sortNewestFirst', next);
      try { if (window.kanbanState) window.kanbanState.sortNewestFirst = next; } catch { /* noop */ }
      return next;
    });
  }, []);

  const handleToggleArchived = useCallback(() => {
    setShowArchived(prev => {
      const next = !prev;
      localStorage.setItem('showArchived', next);
      try { if (window.kanbanState) window.kanbanState.showArchived = next; } catch { /* noop */ }
      return next;
    });
  }, []);

  const handleToggleExpand = useCallback((id) => {
    setExpandedParents(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try { if (window.kanbanState) { window.kanbanState.expandedParents = next; } } catch { /* noop */ }
      return next;
    });
  }, []);

  const handleTaskDeleted = useCallback(() => {
    window.dispatchEvent(new CustomEvent('appstate:change'));
  }, []);

  const handleTaskCreated = useCallback((newTaskId) => {
    if (newTaskId) setLastCreatedId(newTaskId);
    window.dispatchEvent(new CustomEvent('appstate:change'));
  }, []);

  const handleAddSubtask = useCallback((parentId) => {
    setAddingSubtaskParentId(parentId);
    // Auto-expand parent so form is visible
    setExpandedParents(prev => {
      const next = new Set(prev);
      next.add(parentId);
      try { if (window.kanbanState) { window.kanbanState.expandedParents = next; } } catch { /* noop */ }
      return next;
    });
  }, []);

  const handleSubtaskCreated = useCallback(() => {
    setAddingSubtaskParentId(null);
    window.dispatchEvent(new CustomEvent('appstate:change'));
  }, []);

  const handleCancelAddSubtask = useCallback(() => {
    setAddingSubtaskParentId(null);
  }, []);

  // T-161-4: soft-delete a task by setting metadata.flowboard.trashedAt.
  // Previous status is stashed in undoState so the Undo toast can restore
  // the task exactly where it was, not just into its nominal "previous"
  // bucket. Card disappears from the Kanban via the grouped-filter re-run.
  const handleTaskTrashed = useCallback(async (taskId, prevStatus) => {
    const now = new Date().toISOString();
    const snapshot = window.appState?.tasks?.find(t => t.id === taskId);
    const title = snapshot?.title || taskId;
    try {
      const res = await apiFetch(`/api/projects/${viewedProject}/tasks/${taskId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trashedAt: now }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to move to trash');
      const localTask = window.appState.tasks.find(t => t.id === taskId);
      if (localTask && data.task) Object.assign(localTask, data.task);
      window.appState.tasks = [...window.appState.tasks];
      window.dispatchEvent(new CustomEvent('appstate:change'));
      setUndoState({ taskId, title, prevStatus });
    } catch (err) {
      if (window.showToast) window.showToast('Delete failed: ' + err.message, 'error');
      throw err;
    }
  }, [viewedProject]);

  // T-161-4: Undo a just-deleted task (clear trashedAt, keep current status).
  const handleUndoTrash = useCallback(async () => {
    if (!undoState) return;
    const { taskId } = undoState;
    try {
      const res = await apiFetch(`/api/projects/${viewedProject}/tasks/${taskId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trashedAt: null }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to restore');
      const localTask = window.appState.tasks.find(t => t.id === taskId);
      if (localTask && data.task) Object.assign(localTask, data.task);
      window.appState.tasks = [...window.appState.tasks];
      window.dispatchEvent(new CustomEvent('appstate:change'));
      if (window.showToast) window.showToast('Restored', 'success');
    } catch (err) {
      if (window.showToast) window.showToast('Undo failed: ' + err.message, 'error');
    } finally {
      setUndoState(null);
    }
  }, [undoState, viewedProject]);

  // T-161-4: Restore a single task from the Trash panel (not the undo toast).
  const handleRestoreFromTrash = useCallback(async (task) => {
    try {
      const res = await apiFetch(`/api/projects/${viewedProject}/tasks/${task.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trashedAt: null }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to restore');
      const localTask = window.appState.tasks.find(t => t.id === task.id);
      if (localTask && data.task) Object.assign(localTask, data.task);
      window.appState.tasks = [...window.appState.tasks];
      window.dispatchEvent(new CustomEvent('appstate:change'));
      if (window.showToast) window.showToast(`Restored ${task.id}`, 'success');
    } catch (err) {
      if (window.showToast) window.showToast('Restore failed: ' + err.message, 'error');
    }
  }, [viewedProject]);

  // T-161-4: after Empty Trash, the affected tasks are gone server-side.
  // Trigger a refresh so state.tasks drops them and the panel + toolbar
  // reflect the new empty state.
  const handleTrashEmptied = useCallback(() => {
    window._refreshProjects?.();
    // Also refresh the task list for the viewed project
    (async () => {
      try {
        const res = await apiFetch(`/api/projects/${viewedProject}/tasks?includeArchived=true`);
        const data = await res.json();
        if (res.ok && Array.isArray(data.tasks)) {
          window.appState.tasks = data.tasks;
          window.dispatchEvent(new CustomEvent('appstate:change'));
        }
      } catch { /* ignore */ }
    })();
    setTrashPanelOpen(false);
  }, [viewedProject]);

  const handleTaskUpdated = useCallback(async (taskId, updates) => {
    try {
      const res = await apiFetch(`/api/projects/${viewedProject}/tasks/${taskId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update task');
      // Merge server response into local task to prevent stale-data reverts
      const localTask = window.appState.tasks.find(t => t.id === taskId);
      if (localTask && data.task) Object.assign(localTask, data.task);
      if (data.parentUpdated) {
        const parent = window.appState.tasks.find(t => t.id === data.parentUpdated.id);
        if (parent) Object.assign(parent, data.parentUpdated);
      }
      window.appState.tasks = [...window.appState.tasks];
      window.dispatchEvent(new CustomEvent('appstate:change'));
    } catch (err) {
      console.warn('[update-task]', err);
      if (window.showToast) window.showToast(err.message, 'error');
    }
  }, [viewedProject]);

  const handleDrop = useCallback((newStatus) => {
    const id = draggedId.current;
    if (!id) return;
    const task = window.appState.tasks.find(t => t.id === id);
    if (!task || task.status === newStatus) return;

    const oldStatus = task.status;
    task.status = newStatus;
    if (newStatus === 'done') task.completed = new Date().toISOString().slice(0, 10);
    if (oldStatus === 'done' && newStatus !== 'done') task.completed = null;
    // New array reference so useMemo recomputes grouped columns instantly
    window.appState.tasks = [...window.appState.tasks];
    window.dispatchEvent(new CustomEvent('appstate:change'));

    apiFetch(`/api/projects/${viewedProject}/tasks/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus }),
    }).then(async (res) => {
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to move task');
      // Merge server response to prevent poll from reverting
      if (data.task) Object.assign(task, data.task);
      window.appState.tasks = [...window.appState.tasks];
      window.dispatchEvent(new CustomEvent('appstate:change'));
      if (window.showToast) {
        window.showToast(`${task.title}: ${STATUS_LABELS[oldStatus]} → ${STATUS_LABELS[newStatus]}`, 'success');
      }
      window.Telegram?.WebApp?.HapticFeedback?.impactOccurred('medium');
    }).catch(() => {
      task.status = oldStatus;
      if (oldStatus === 'done') task.completed = new Date().toISOString().slice(0, 10);
      else task.completed = null;
      window.appState.tasks = [...window.appState.tasks];
      window.dispatchEvent(new CustomEvent('appstate:change'));
      if (window.showToast) window.showToast('Failed to move task', 'error');
      window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('error');
    });
  }, [viewedProject]);

  const { grouped, archivedTopLevel, trashedTopLevel } = useMemo(() => {
    const topLevel = allTasks.filter(t => !t.parentId);
    const groups = {};
    STATUS_KEYS.forEach(s => { groups[s] = []; });
    const archived = [];
    const trashed = [];
    for (const t of topLevel) {
      // T-161-4: trashedAt is a FlowBoard-only flag orthogonal to status.
      // Trashed tasks are hidden from both Kanban and Archive section and
      // only visible in the Trash panel. Their status (typically archived
      // because the previous "hard delete" path used to archive the row)
      // is preserved for correct Restore behaviour.
      if (t.trashedAt) {
        trashed.push(t);
        continue;
      }
      if (t.status === 'archived') {
        archived.push(t);
      } else if (groups[t.status]) {
        groups[t.status].push(t);
      }
    }
    for (const s of STATUS_KEYS) {
      groups[s] = sortTasks(groups[s], sortNewestFirst);
    }
    // Sort trashed newest-first by trashedAt so recently deleted items surface first
    trashed.sort((a, b) => new Date(b.trashedAt).getTime() - new Date(a.trashedAt).getTime());
    return { grouped: groups, archivedTopLevel: archived, trashedTopLevel: trashed };
  }, [allTasks, sortNewestFirst]);

  if (!viewedProject) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-sm" data-react-tasks>
        {(state?.projects?.length === 0)
          ? 'No projects found. Create a new project via chat.'
          : 'Select a project from the sidebar'}
      </div>
    );
  }

  if (allTasks.length === 0) {
    return (
      <div className="flex flex-col h-full" data-react-tasks>
        <ActiveAgentsBar />
        <div className="flex items-center justify-center flex-1 text-muted text-sm">
          No tasks
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full" data-react-tasks>
      <ActiveAgentsBar />
      <div className="flex items-center justify-end pb-2 gap-2 shrink-0">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          style={{ fontSize: '11px', display: 'flex', alignItems: 'center', gap: '4px' }}
          onClick={handleToggleSort}
        >
          <span>{sortNewestFirst ? '↓' : '↑'}</span>
          <span>{sortNewestFirst ? 'Newest first' : 'Oldest first'}</span>
        </button>
        {/* T-161-4: Trash toolbar icon. Rendered only when the project has
            at least one trashed task so an empty Trash does not clutter the
            header. Badge shows the count; click opens the TrashPanel. */}
        {trashedTopLevel.length > 0 && (
          <button
            type="button"
            className="btn btn-ghost btn-sm trash-toolbar-btn"
            style={{ fontSize: '11px', display: 'flex', alignItems: 'center', gap: '4px' }}
            onClick={() => setTrashPanelOpen(true)}
            title={`Trash (${trashedTopLevel.length})`}
            aria-label={`Open trash (${trashedTopLevel.length} item${trashedTopLevel.length === 1 ? '' : 's'})`}
          >
            <Trash2 size={12} />
            <span className="trash-toolbar-count">{trashedTopLevel.length}</span>
          </button>
        )}
      </div>
      <div className="kanban">
        {STATUS_KEYS.map(status => (
          <Column
            key={status}
            status={status}
            tasks={grouped[status]}
            archivedTasks={archivedTopLevel}
            allTasks={allTasks}
            showArchived={showArchived}
            onToggleArchived={handleToggleArchived}
            expandedParents={expandedParents}
            onToggleExpand={handleToggleExpand}
            sortNewestFirst={sortNewestFirst}
            project={viewedProject}
            onTaskCreated={handleTaskCreated}
            onTaskDeleted={handleTaskDeleted}
            onTaskTrashed={handleTaskTrashed}
            onTaskUpdated={handleTaskUpdated}
            dragRef={draggedId}
            onDrop={handleDrop}
            lastCreatedId={lastCreatedId}
            addingSubtaskParentId={addingSubtaskParentId}
            onAddSubtask={handleAddSubtask}
            onSubtaskCreated={handleSubtaskCreated}
            onCancelAddSubtask={handleCancelAddSubtask}
          />
        ))}
      </div>
      {/* T-161-4: Trash panel + Undo toast render as portals on document.body;
          they live here so they share project scope + handlers. */}
      <TrashPanel
        open={trashPanelOpen}
        project={viewedProject}
        trashedTasks={trashedTopLevel}
        onClose={() => setTrashPanelOpen(false)}
        onRestore={handleRestoreFromTrash}
        onEmptied={handleTrashEmptied}
      />
      {undoState && (
        <UndoToast
          message={`${undoState.taskId} moved to Trash`}
          onUndo={handleUndoTrash}
          onDismiss={() => setUndoState(null)}
        />
      )}
    </div>
  );
}
