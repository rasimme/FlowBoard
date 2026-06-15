import { useMemo, useState, useCallback, useRef, useEffect, useLayoutEffect, memo, Fragment } from 'react';
import { useAppState } from '../context/AppStateContext.jsx';
import { useDashboard } from '../context/DashboardContext.jsx';
import { useNavigation } from '../context/NavigationContext.jsx';
import { sortTasks } from './taskSort.js';
import { Modal, PriorityPill, Popover, ActiveAgentsBar, Tooltip } from '../components/index.js';
import AgentChip, { agentColor } from '../components/AgentChip.jsx';
import LeaseIndicator from '../components/LeaseIndicator.jsx';
import BlockedChip from '../components/BlockedChip.jsx';
import UndoToast from '../components/UndoToast.jsx';
import TrashPanel from '../components/TrashPanel.jsx';
import { useHaptic } from '../hooks/useHaptic.js';
import { isActivelyClaimed, ownerLabel } from '../utils/formatting.js';
import { getActiveSubtaskClaims, getSyncedPulseDelayMs } from '../parentActivity.mjs';
import { Plus, Trash2, FileText, FilePlus, Archive, ListTree, RotateCcw, ArrowUpDown, ChevronDown, Check, GripVertical } from 'lucide-react';
import { apiFetch } from '../utils/apiFetch.js';
import { getTasks, replaceTasks, refreshTasks, notify } from '../state/appStateBridge.mjs';
import { patchTask, applyTaskResponse } from '../state/taskState.mjs';

// CSS-var pair for the active-claim contour pulse. The card's border-color
// animates between the soft ring token and the full ring token. Returning null
// signals "not actively claimed" so the caller can skip the class+style.
function activeClaimColors(task) {
  if (!isActivelyClaimed(task)) return null;
  return activeClaimColorsForAgent(task.agent, task.claimedAt);
}

function activeClaimColorsForAgent(agent, claimedAt = null, pulseDelayMs = null) {
  if (!agent) return null;
  const c = agentColor(agent);
  const delay = pulseDelayMs ?? getSyncedPulseDelayMs(Date.now(), Date.parse(claimedAt || ''));
  return {
    ['--agent-claim-color']: c.ring,
    ['--agent-claim-color-soft']: c.ringSoft,
    ['--agent-pulse-delay']: `${delay}ms`,
  };
}

const STATUS_KEYS = ['backlog', 'open', 'in-progress', 'review', 'done'];
const STATUS_LABELS = {
  backlog: 'Backlog',
  open: 'Open',
  'in-progress': 'In Progress',
  review: 'Review',
  done: 'Done',
};

// T-130: sort modes. 'custom' = manual drag order (the default now that columns
// are user-orderable); 'newest'/'oldest' sort purely by task number and ignore
// (but preserve) the manual ranks.
const SORT_MODES = ['custom', 'newest', 'oldest'];
const SORT_LABELS = { custom: 'Custom', newest: 'Newest first', oldest: 'Oldest first' };
function getInitialSortMode() {
  const m = localStorage.getItem('sortMode');
  if (SORT_MODES.includes(m)) return m;
  // Migrate the old boolean toggle: default everyone to the new manual order.
  return 'custom';
}

// T-364: persist the Kanban view per project (expanded parents + scroll), the
// same way the Canvas persists pan/zoom (sessionStorage → survives a tab switch
// / page navigation / reload, not a restart). One slot per project so switching
// projects restores the right view. (sortMode/showArchived already persist via
// localStorage.) Replaces the dead `window.kanbanState` global left over from
// the removed vanilla runtime (ADR-0024), which never persisted anything.
function kanbanViewKey(project) {
  return `flowboard.kanban.view.${project}`;
}
function loadKanbanView(project) {
  if (!project) return null;
  try {
    const o = JSON.parse(sessionStorage.getItem(kanbanViewKey(project)) || 'null');
    return o && typeof o === 'object' ? o : null;
  } catch { return null; }
}
function saveKanbanView(project, patch) {
  if (!project) return;
  try {
    const cur = loadKanbanView(project) || {};
    const merged = { ...cur, ...patch };
    if (patch.cols) merged.cols = { ...(cur.cols || {}), ...patch.cols }; // deep-merge per-column scroll
    sessionStorage.setItem(kanbanViewKey(project), JSON.stringify(merged));
  } catch { /* storage unavailable/quota — view persistence is best-effort */ }
}
function getInitialArchived() {
  return localStorage.getItem('showArchived') === 'true';
}

// Column sort (custom / newest / oldest) lives in ./taskSort.js so the ordering
// logic is unit-testable without a DOM (T-376).

// T-130: find the insertion index for a drop, by comparing the pointer's Y to
// each top-level card's vertical midpoint. Works in rendered-list space (counts
// every top-level card, including the one being dragged — it keeps its slot
// during an HTML5 drag), so the index maps 1:1 onto the column's rendered list.
// Nested subtask cards are excluded. handleDrop adjusts for the dragged card's
// own removal before assigning ranks.
function computeDropIndex(columnEl, clientY) {
  const cards = [...columnEl.querySelectorAll('[data-react-tasks]')]
    .filter(el => !el.closest('.subtask-container'));
  for (let i = 0; i < cards.length; i++) {
    const r = cards[i].getBoundingClientRect();
    if (clientY < r.top + r.height / 2) return i;
  }
  return cards.length;
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
  const { openSpec } = useDashboard();

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
    openSpec(task.specFile, task.id);
  };

  const handleCreateSpec = async (e) => {
    e.stopPropagation();
    try {
      const res = await apiFetch(`/api/projects/${project}/specs/${task.id}`, { method: 'POST' });
      const data = await res.json();
      if (data.ok && data.specFile) {
        task.specFile = data.specFile;
        if (window.showToast) window.showToast(`Spec created for ${task.id}`, 'success');
        openSpec(data.specFile, task.id);
      }
    } catch (err) {
      console.warn('[create-spec]', err);
      if (window.showToast) window.showToast('Failed to create spec', 'error');
    }
  };

  const hasUsableSpec = task.specFile && task.specExists !== false;
  const claimColors = activeClaimColors(task);
  const subtaskClass = [
    'subtask-card',
    claimColors && 'subtask-card-active-claim',
    // Blocked subtasks get the same dashed card treatment as blocked
    // parents — not just the chip (T-246-9).
    task.blocked && 'is-blocked',
  ].filter(Boolean).join(' ');
  const subtaskStyle = { cursor: 'pointer', ...(claimColors || null) };

  return (
    <div className={subtaskClass} data-task-id={task.id} onClick={handleClick} style={subtaskStyle}>
      <div className="subtask-card-row">
        <span className="tree-dot" />
        <span className="status-dot-wrap" onClick={handleDotClick}>
          <span className={`status-dot status-dot-${task.status}`} />
        </span>
        <span className="subtask-title">{task.title}</span>
        {task.agent && (
          <AgentChip
            name={task.agent}
            size="xs"
            variant={isActivelyClaimed(task) ? 'solid' : 'soft'}
            title={ownerLabel(task)}
          />
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
const TaskCard = memo(function TaskCard({ task, allTasks, expanded, onToggleExpand, project, onTaskDeleted, onTaskTrashed, onTaskUpdated, onHandlePointerDown, onCardKeyDown, wasDraggedRef, isNew, addingSubtask, onAddSubtask, onSubtaskCreated, onCancelAddSubtask }) {
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [animated, setAnimated] = useState(false);
  const [popover, setPopover] = useState({ type: null, open: false, rect: null });
  const haptic = useHaptic();
  const { openSpec } = useDashboard();

  // T-295: derive from the live task list, not task.subtaskIds — a PUT
  // response can momentarily carry an empty subtaskIds and unmount the
  // subtask UI (flicker). allTasks is always the source of truth here.
  const hasSubtasks = allTasks.some(t => t.parentId === task.id && t.status !== 'archived');
  const hasUsableSpec = task.specFile && task.specExists !== false;
  const activeSubtaskClaims = getActiveSubtaskClaims(task, allTasks);
  const hasDerivedSubtaskActivity = !isActivelyClaimed(task) && activeSubtaskClaims.length > 0;

  const handleClick = () => {
    // T-374 fix: a click emitted right after a drag must NOT open the detail
    // panel (the gesture was a drag, not a click).
    if (wasDraggedRef?.current) return;
    if (window.openTaskDetail) window.openTaskDetail(task.id);
  };

  // --- Delete with shrink animation ---
  const handleDeleteClick = (e) => {
    e.stopPropagation();
    haptic.light();
    setShowDeleteModal(true);
  };

  const handleDeleteConfirm = async (options = {}) => {
    setShowDeleteModal(false);
    // T-161-4: soft-delete → move to Trash (sets metadata.flowboard.trashedAt).
    // The task's current status is preserved so Restore from Trash returns
    // it exactly where it was. If the user chose "also move subtasks",
    // trash them too (cascade is handled one PUT per child so each one
    // can be independently restored from the Trash panel if needed).
    try {
      await onTaskTrashed?.(task.id, task.status);
      if (options.deleteSubtasks && task.subtaskIds && task.subtaskIds.length > 0) {
        const subs = getTasks().filter(t => task.subtaskIds.includes(t.id) && !t.trashedAt);
        for (const sub of subs) {
          try { await onTaskTrashed?.(sub.id, sub.status); } catch { /* best-effort per child */ }
        }
      }
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
    openSpec(task.specFile, task.id);
  };

  const handleCreateSpec = async (e) => {
    e.stopPropagation();
    try {
      const res = await apiFetch(`/api/projects/${project}/specs/${task.id}`, { method: 'POST' });
      const data = await res.json();
      if (data.ok && data.specFile) {
        task.specFile = data.specFile;
        if (window.showToast) window.showToast(`Spec created for ${task.id}`, 'success');
        openSpec(data.specFile, task.id);
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

  // Active-claim contour — pulsing border in agent color when this card is
  // currently being worked on. Keep the chip static here; two independent
  // pulse layers were visually noisy and made parent/subtask timing drift.
  const claimColors = activeClaimColors(task)
    || (hasDerivedSubtaskActivity
      ? activeClaimColorsForAgent(
        activeSubtaskClaims[0].agent,
        activeSubtaskClaims[0].claimedAt,
        activeSubtaskClaims[0].pulseDelayMs,
      )
      : null);
  if (claimColors) cardClass += ' task-card-active-claim';
  const cardStyle = claimColors || undefined;

  return (
    <div>
      <div className="relative group">
        <div
          className={cardClass}
          style={cardStyle}
          data-task-id={task.id}
          onPointerDown={onHandlePointerDown && !removing ? (e) => {
            // whole-card drag (mouse): a small move threshold means a plain click
            // still opens the card. Skip when starting on an interactive child or
            // the grip. On touch the body never drags (grip does) — handled in
            // startPointerDrag via pointerType.
            if (e.target.closest('button, a, input, textarea, select, [role="menu"]')) return;
            onHandlePointerDown(e, task.id, { fromBody: true, threshold: 6 });
          } : undefined}
          onClick={!removing ? handleClick : undefined}
          onKeyDown={!removing ? (e) => {
            // T-370: full keyboard reorder is handled centrally; only when the
            // card itself (not a child control) holds focus.
            if (e.target === e.currentTarget) onCardKeyDown?.(e, task.id, task.status);
          } : undefined}
          /* T-371: NOT role="button" — the card holds real buttons (grip, delete,
             archive, status…) and "interactive content inside a button role" is
             an ARIA violation. It stays keyboard-focusable (tabIndex + Enter/Space
             opens) as a labelled clickable container; the nested controls are now
             legitimately reachable. */
          tabIndex={removing ? -1 : 0}
          aria-label={`Open task ${task.id}: ${task.title}`}
          onAnimationEnd={handleAnimationEnd}
          data-react-tasks
        >
          <div className="flex items-start justify-between gap-2 mb-1">
            <span className="flex items-center gap-1 min-w-0">
              {/* T-367-4: touch drag handle — Pointer-Events drag (mouse + touch)
                  that reuses the same drop pipeline as the desktop HTML5 drag.
                  Shown on touch devices (CSS); a grab here can't be confused
                  with a scroll swipe. */}
              {onHandlePointerDown && !removing && (
                <button
                  type="button"
                  className="card-drag-handle"
                  aria-label="Drag to reorder"
                  style={{ touchAction: 'none' }}
                  onPointerDown={(e) => { e.stopPropagation(); onHandlePointerDown(e, task.id); }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <GripVertical size={14} />
                </button>
              )}
              <span className="task-id mono">
                {task.id}
              </span>
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
              {hasDerivedSubtaskActivity && activeSubtaskClaims.map(claim => (
                <AgentChip
                  key={`${claim.taskId}:${claim.agent}`}
                  name={claim.agent}
                  size="sm"
                  variant="solid"
                  title={`Active subtask ${claim.taskId} claimed by ${claim.agent}: ${claim.title}`}
                />
              ))}
              {!hasDerivedSubtaskActivity && task.agent && (
                <AgentChip
                  name={task.agent}
                  size="sm"
                  variant={isActivelyClaimed(task) ? 'solid' : 'soft'}
                  title={ownerLabel(task)}
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
  // Stable numeric order by FlowBoard id (T-x-1 … T-x-10) — never by
  // status/update order, so status changes don't reshuffle the list (T-246-6).
  const subtasks = allTasks
    .filter(t => t.parentId === task.id && t.status !== 'archived')
    .sort((a, b) => {
      const na = parseInt(a.id.split('-').pop() || '0', 10);
      const nb = parseInt(b.id.split('-').pop() || '0', 10);
      return (Number.isNaN(na) || Number.isNaN(nb)) ? a.id.localeCompare(b.id) : na - nb;
    });

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
      if (data.task) {
        let next = applyTaskResponse(getTasks(), data);
        const parent = next.find(t => t.id === parentId);
        if (parent && !parent.subtaskIds?.includes(data.task.id)) {
          const subtaskIds = [...(parent.subtaskIds || []), data.task.id];
          next = patchTask(next, parentId, { subtaskIds });
        }
        replaceTasks(next);
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
          data-task-id={task.id}
          onClick={handleClick}
          onKeyDown={(e) => {
            if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
              e.preventDefault();
              handleClick(e);
            }
          }}
          /* T-371: not role="button" (contains interactive controls) */
          tabIndex={0}
          aria-label={`Open task ${task.id}: ${task.title} (archived)`}
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

  // T-161-4: This used to hit the server's hard-delete endpoint
  // directly, which completely bypassed the Trash flow. Now the modal
  // just collects the user's choices and delegates to onConfirm — the
  // parent TaskCard handler runs the soft-delete (PUT trashedAt) via
  // onTaskTrashed, and Undo-Toast / Empty-Trash handle recovery +
  // permanent removal. Subtask and spec choices are forwarded so a
  // future cascade can respect them; right now the parent just moves
  // the one task to Trash.
  const handleConfirm = async () => {
    haptic.medium();
    onConfirm({ deleteSubtasks, deleteSpec });
  };

  return (
    <Modal
      open
      onClose={onCancel}
      title={`Move ${task.id} to Trash?`}
      actions={<>
        <Modal.Button variant="secondary" onClick={onCancel}>Cancel</Modal.Button>
        <Modal.Button variant="danger" onClick={handleConfirm}>Move to Trash</Modal.Button>
      </>}
    >
      <p className="text-sm text-muted truncate mb-3">{task.title}</p>
      <p className="text-xs text-muted mb-3">
        You can restore it from the Trash, or empty the Trash to delete it permanently.
      </p>
      <div className="flex flex-col gap-2">
        {hasSubtasks && (
          <label className="flex items-center gap-2 text-sm text-text cursor-pointer">
            <input
              type="checkbox"
              checked={deleteSubtasks}
              onChange={(e) => setDeleteSubtasks(e.target.checked)}
              className="w-4 h-4 rounded border-border accent-accent"
            />
            Also move {subtaskCount} subtask(s) to Trash
          </label>
        )}
      </div>
    </Modal>
  );
}

// --- Inline Add-Task form (Backlog only) ---
function AddTaskForm({ project, onCreated }) {
  const { intent: navIntent, clearPendingNewTask } = useNavigation();
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

  // overview quick action "New Task" — consume the navigation intent (T-356)
  useEffect(() => {
    if (navIntent.pendingNewTask) {
      clearPendingNewTask();
      handleOpen();
    }
  }, [navIntent.pendingNewTask]); // eslint-disable-line react-hooks/exhaustive-deps

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
      if (data.task) {
        replaceTasks(applyTaskResponse(getTasks(), data));
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
const Column = memo(function Column({ status, tasks, archivedTasks, allTasks, showArchived, onToggleArchived, expandedParents, onToggleExpand, sortMode, project, onTaskCreated, onTaskDeleted, onTaskTrashed, onTaskUpdated, onHandlePointerDown, onCardKeyDown, wasDraggedRef, dropIndex, onColumnScroll, lastCreatedId, addingSubtaskParentId, onAddSubtask, onSubtaskCreated, onCancelAddSubtask }) {
  const isDone = status === 'done';
  const isBacklog = status === 'backlog';
  const archivedCount = isDone ? archivedTasks.length : 0;
  const sortedArchived = isDone && showArchived ? sortTasks(archivedTasks, sortMode) : [];

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

  // T-374: drag is fully Pointer-Events now (see board startPointerDrag); the
  // column needs no HTML5 drag handlers — the drag controller hit-tests columns
  // itself and toggles .drag-over + the insert line.
  const DropLine = () => <div className="drop-line" aria-hidden="true" />;

  return (
    <div
      className="column"
      data-status={status}
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
      <div className="column-body" onScroll={(e) => onColumnScroll?.(status, e.currentTarget.scrollTop)}>
        {/* New tasks appear at the top in custom/newest, so the add form sits on
            top there; in oldest-first they append at the bottom, so the form
            moves below the list to stay next to where the task will land (T-376). */}
        {isBacklog && project && sortMode !== 'oldest' && (
          <AddTaskForm project={project} onCreated={onTaskCreated} />
        )}
        {tasks.length === 0 && sortedArchived.length === 0 && !isBacklog ? (
          <div className="column-empty">No tasks</div>
        ) : (
          <>
            {tasks.map((t, i) => (
              <Fragment key={t.id}>
                {dropIndex === i && <DropLine />}
                <TaskCard
                  task={t}
                  allTasks={allTasks}
                  expanded={expandedParents.has(t.id)}
                  onToggleExpand={onToggleExpand}
                  project={project}
                  onTaskDeleted={onTaskDeleted}
                  onTaskTrashed={onTaskTrashed}
                  onTaskUpdated={onTaskUpdated}
                  onHandlePointerDown={onHandlePointerDown}
                  onCardKeyDown={onCardKeyDown}
                  wasDraggedRef={wasDraggedRef}
                  isNew={t.id === lastCreatedId}
                  addingSubtask={addingSubtaskParentId === t.id}
                  onAddSubtask={onAddSubtask}
                  onSubtaskCreated={onSubtaskCreated}
                  onCancelAddSubtask={onCancelAddSubtask}
                />
              </Fragment>
            ))}
            {typeof dropIndex === 'number' && dropIndex >= tasks.length && <DropLine />}
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
        {isBacklog && project && sortMode === 'oldest' && (
          <AddTaskForm project={project} onCreated={onTaskCreated} />
        )}
      </div>
    </div>
  );
});

export default function TasksView() {
  const { state } = useAppState();
  const { refreshProjectsOnly } = useDashboard();
  const viewedProject = state?.viewedProject;
  const allTasks = state?.tasks || [];

  const [sortMode, setSortMode] = useState(getInitialSortMode);
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(getInitialArchived);
  const [expandedParents, setExpandedParents] = useState(() => new Set(loadKanbanView(viewedProject)?.expanded || []));
  const [lastCreatedId, setLastCreatedId] = useState(null);
  const [addingSubtaskParentId, setAddingSubtaskParentId] = useState(null);
  // T-161-4: Trash panel + Undo-toast state. UndoState lives alongside
  // handleTaskTrashed so the user can reverse a just-deleted task without
  // needing to open the Trash panel.
  const [trashPanelOpen, setTrashPanelOpen] = useState(false);
  const [undoState, setUndoState] = useState(null); // { taskId, title, prevStatus }

  const draggedId = useRef(null);
  // T-368-5: teardown for an in-flight pointer-drag, so unmounting mid-drag
  // (tab/project switch) removes the window listeners + floating ghost instead
  // of leaking them and firing state updates on an unmounted tree.
  const dragTeardownRef = useRef(null);
  useEffect(() => () => dragTeardownRef.current?.(), []);
  // T-374 fix: true between a drag's activation and the next gesture, so the
  // card's onClick can swallow the click that a completed drag may emit (the
  // drag must NOT open the detail panel). Reset on every new pointerdown.
  const wasDraggedRef = useRef(false);

  // T-364: Kanban view persistence (expanded parents + scroll), per project.
  const kanbanRef = useRef(null);
  const persistTimer = useRef(null);
  const pendingView = useRef({});
  const restoredFor = useRef(null);
  const schedulePersist = useCallback((patch) => {
    pendingView.current = {
      ...pendingView.current, ...patch,
      cols: { ...(pendingView.current.cols || {}), ...(patch.cols || {}) },
    };
    if (persistTimer.current) clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      saveKanbanView(viewedProject, pendingView.current);
      pendingView.current = {};
    }, 200);
  }, [viewedProject]);
  const handleColumnScroll = useCallback((status, scrollTop) => {
    schedulePersist({ cols: { [status]: scrollTop } });
  }, [schedulePersist]);
  // Expand/collapse is a discrete, intentional action — persist it immediately
  // (not debounced) so it survives even if the user navigates away instantly.
  const persistExpanded = useCallback((set) => {
    saveKanbanView(viewedProject, { expanded: [...set] });
  }, [viewedProject]);
  const handleKanbanScroll = useCallback((e) => {
    schedulePersist({ scrollLeft: e.currentTarget.scrollLeft });
  }, [schedulePersist]);

  // Restore expanded parents when the viewed project changes (the component also
  // remounts on tab/page navigation, where the useState initializer covers it).
  useEffect(() => {
    setExpandedParents(new Set(loadKanbanView(viewedProject)?.expanded || []));
    restoredFor.current = null; // re-arm scroll restore for the new project
  }, [viewedProject]);

  // Restore scroll once the columns have rendered with their tasks. Runs once per
  // project (guarded by restoredFor) so it doesn't fight the user's own scrolling.
  useLayoutEffect(() => {
    if (!viewedProject || allTasks.length === 0 || !kanbanRef.current) return;
    if (restoredFor.current === viewedProject) return;
    restoredFor.current = viewedProject;
    const v = loadKanbanView(viewedProject);
    if (!v) return;
    if (Number.isFinite(v.scrollLeft)) kanbanRef.current.scrollLeft = v.scrollLeft;
    if (v.cols) {
      for (const [status, top] of Object.entries(v.cols)) {
        const body = kanbanRef.current.querySelector(`.column[data-status="${status}"] .column-body`);
        if (body && Number.isFinite(top)) body.scrollTop = top;
      }
    }
  }, [viewedProject, allTasks.length]);

  // T-130: live drop position for the insertion indicator — { status, index }
  // in rendered-list space (0 = before first card, N = after last). Mirrors the
  // sidebar's drop-target line so a reorder shows where the card will land.
  const [dropHint, setDropHint] = useState(null);
  // T-370: keyboard reorder. kbRef holds the in-progress keyboard "grab"
  // { id, status, index }; liveMsg drives the aria-live announcements.
  const kbRef = useRef(null);
  const [liveMsg, setLiveMsg] = useState('');
  const handleDragHint = useCallback((status, index) => {
    setDropHint(prev => (prev && prev.status === status && prev.index === index) ? prev : { status, index });
  }, []);
  // The drop indicator is cleared centrally when any drag ends (the source card's
  // dragend bubbles to window) — robust against the browser's noisy per-card
  // dragleave events, which otherwise made the line flicker mid-drag.
  useEffect(() => {
    const clear = () => setDropHint(null);
    window.addEventListener('dragend', clear);
    return () => window.removeEventListener('dragend', clear);
  }, []);

  const handleSetSortMode = useCallback((mode) => {
    setSortMode(mode);
    setSortMenuOpen(false);
    localStorage.setItem('sortMode', mode);
  }, []);

  const handleToggleArchived = useCallback(() => {
    setShowArchived(prev => {
      const next = !prev;
      localStorage.setItem('showArchived', next);
      return next;
    });
  }, []);

  const handleToggleExpand = useCallback((id) => {
    setExpandedParents(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      persistExpanded(next);
      return next;
    });
  }, [persistExpanded]);

  // ScrollToTask uses this to reveal a subtask whose parent is collapsed
  const handleExpandParent = useCallback((parentId) => {
    setExpandedParents(prev => {
      if (prev.has(parentId)) return prev;
      const next = new Set(prev);
      next.add(parentId);
      persistExpanded(next);
      return next;
    });
  }, [persistExpanded]);

  const handleTaskDeleted = useCallback(() => {
    notify();
  }, []);

  const handleTaskCreated = useCallback((newTaskId) => {
    if (newTaskId) {
      // T-376: new tasks stay unranked (no manual `order`) so the 'custom' sort
      // shows them at the top — unranked-first, newest among themselves — no
      // matter which path created them. A task only gains a manual rank once it
      // is dragged. (Replaces the old optimistic top-rank hack, which only fired
      // for board-form creates and pushed the new card below older unranked ones.)
      setLastCreatedId(newTaskId);
    }
    notify();
  }, [viewedProject]);

  const handleAddSubtask = useCallback((parentId) => {
    setAddingSubtaskParentId(parentId);
    // Auto-expand parent so form is visible
    setExpandedParents(prev => {
      const next = new Set(prev);
      next.add(parentId);
      persistExpanded(next);
      return next;
    });
  }, [persistExpanded]);

  const handleSubtaskCreated = useCallback(() => {
    setAddingSubtaskParentId(null);
    notify();
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
    const existing = getTasks().find(t => t.id === taskId);
    const title = existing?.title || taskId;
    try {
      const res = await apiFetch(`/api/projects/${viewedProject}/tasks/${taskId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trashedAt: now }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to move to trash');
      replaceTasks(applyTaskResponse(getTasks(), data));
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
      replaceTasks(applyTaskResponse(getTasks(), data));
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
      replaceTasks(applyTaskResponse(getTasks(), data));
      if (window.showToast) window.showToast(`Restored ${task.id}`, 'success');
    } catch (err) {
      if (window.showToast) window.showToast('Restore failed: ' + err.message, 'error');
    }
  }, [viewedProject]);

  // T-161-4: after Empty Trash, the affected tasks are gone server-side.
  // Trigger a refresh so state.tasks drops them and the panel + toolbar
  // reflect the new empty state.
  const handleTrashEmptied = useCallback(() => {
    refreshProjectsOnly();
    refreshTasks(viewedProject).catch(() => { /* ignore */ });
    setTrashPanelOpen(false);
  }, [viewedProject, refreshProjectsOnly]);

  const handleTaskUpdated = useCallback(async (taskId, updates) => {
    try {
      // T-186: status-picker review -> done goes through the explicit
      // /approve endpoint so the activity feed records the approval.
      const tasksNow = getTasks();
      const current = tasksNow.find(t => t.id === taskId);
      const reviewApproval = (updates && updates.status === 'done' && current && current.status === 'review');
      const res = reviewApproval
        ? await apiFetch(`/api/projects/${viewedProject}/tasks/${taskId}/approve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ actor: window.appState?.agentId || 'human' }),
          })
        : await apiFetch(`/api/projects/${viewedProject}/tasks/${taskId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updates),
          });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update task');
      replaceTasks(applyTaskResponse(getTasks(), data));
    } catch (err) {
      console.warn('[update-task]', err);
      if (window.showToast) window.showToast(err.message, 'error');
    }
  }, [viewedProject]);

  const handleDrop = useCallback((newStatus, dropIndex) => {
    setDropHint(null);
    const id = draggedId.current;
    if (!id) return;
    const tasksBefore = getTasks();
    const task = tasksBefore.find(t => t.id === id);
    if (!task) return;

    const oldStatus = task.status;
    const statusChanged = oldStatus !== newStatus;
    // Manual ranks are only written/honoured in 'custom' sort. In newest/oldest a
    // drop is a pure status change (cross-column); intra-column drops are a no-op.
    const manual = sortMode === 'custom';

    // T-130: in custom mode, rebuild the target column's order with the dragged
    // card inserted at the drop position, then assign sparse ranks (10, 20, 30…).
    // `dropIndex` is in rendered-list space (includes the dragged card when it
    // started in this column), so translate it to the dragged-excluded list.
    let ordered = [];
    let rankById = new Map();
    const orderChanged = (t) => rankById.get(t.id) !== (typeof t.order === 'number' ? t.order : null);
    if (manual) {
      const colAll = sortTasks(
        tasksBefore.filter(t => !t.parentId && !t.trashedAt && t.status === newStatus),
        sortMode,
      );
      const colTasks = colAll.filter(t => t.id !== id);
      const draggedPos = colAll.findIndex(t => t.id === id);
      let idx = (typeof dropIndex === 'number' && dropIndex >= 0) ? dropIndex : colTasks.length;
      if (draggedPos !== -1 && idx > draggedPos) idx -= 1; // account for the dragged card's own removal
      idx = Math.max(0, Math.min(idx, colTasks.length));
      ordered = [...colTasks.slice(0, idx), task, ...colTasks.slice(idx)];
      rankById = new Map(ordered.map((t, i) => [t.id, (i + 1) * 10]));
    }
    const reordered = ordered.filter(orderChanged);

    if (!statusChanged && reordered.length === 0) return;

    // --- Optimistic apply: status (dragged) + new ranks (whole column) ---
    let optimistic = tasksBefore;
    const applyStatusPatch = (patch) => {
      if (newStatus === 'done') patch.completed = new Date().toISOString().slice(0, 10);
      if (oldStatus === 'done' && newStatus !== 'done') patch.completed = null;
      return patch;
    };
    if (manual) {
      for (const t of ordered) {
        const patch = { order: rankById.get(t.id) };
        if (t.id === id && statusChanged) applyStatusPatch(patch).status = newStatus;
        optimistic = patchTask(optimistic, t.id, patch);
      }
    } else if (statusChanged) {
      optimistic = patchTask(optimistic, id, applyStatusPatch({ status: newStatus }));
    }
    replaceTasks(optimistic);

    // --- Persist ---
    // T-186: review → done is an explicit approval, not a generic status PUT.
    const reviewApproval = statusChanged && oldStatus === 'review' && newStatus === 'done';
    const put = (taskId, body) => apiFetch(`/api/projects/${viewedProject}/tasks/${taskId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const requests = [];
    if (reviewApproval) {
      requests.push(apiFetch(`/api/projects/${viewedProject}/tasks/${id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actor: window.appState?.agentId || 'human' }),
      }));
    }
    if (manual) {
      // One PUT per task whose rank changed; fold the dragged task's status in
      // (unless it went through the approve endpoint above).
      for (const t of ordered) {
        const body = {};
        if (orderChanged(t)) body.order = rankById.get(t.id);
        if (t.id === id && statusChanged && !reviewApproval) body.status = newStatus;
        if (Object.keys(body).length > 0) requests.push(put(t.id, body));
      }
    } else if (statusChanged && !reviewApproval) {
      requests.push(put(id, { status: newStatus }));
    }

    Promise.all(requests).then(async (responses) => {
      let next = getTasks();
      for (const res of responses) {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to move task');
        next = applyTaskResponse(next, data);
      }
      replaceTasks(next);
      if (statusChanged && window.showToast) {
        window.showToast(`${task.title}: ${STATUS_LABELS[oldStatus]} → ${STATUS_LABELS[newStatus]}`, 'success');
      }
      window.Telegram?.WebApp?.HapticFeedback?.impactOccurred('medium');
    }).catch(() => {
      replaceTasks(tasksBefore);
      if (window.showToast) window.showToast('Failed to move task', 'error');
      window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('error');
    });
  }, [viewedProject, sortMode]);

  // T-367-4: Pointer-Events drag (mouse + touch) initiated from a card's drag
  // handle. Reuses the exact same drop pipeline as the desktop HTML5 drag
  // (draggedId → dropHint → handleDrop), so reorder/cross-column/indicator all
  // behave identically; this just makes drag work on touch where HTML5 drag
  // never fires. A floating clone follows the pointer; the column + insert index
  // are hit-tested from the pointer position each move.
  // T-374: the single drag mechanism for the board — Pointer Events for mouse
  // AND touch (the native HTML5 drag is gone). Initiated from the whole card
  // body (mouse, with a small move threshold so a plain click still opens the
  // card) or from the grip (touch + mouse, immediate). One styled-clone visual
  // everywhere; highlights the target column (.drag-over) + shows the insert
  // line; reuses handleDrop. opts: { fromBody, threshold }.
  const startPointerDrag = useCallback((e, taskId, opts = {}) => {
    if (typeof e.button === 'number' && e.button !== 0) return; // primary button only
    if (draggedId.current || dragTeardownRef.current) return;   // a drag (pending or active) already runs
    // On touch, only the grip initiates — a body-drag would fight list scrolling.
    if (opts.fromBody && e.pointerType === 'touch') return;
    const cardEl = e.target.closest('[data-task-id]');
    if (!cardEl) return;
    const pointerId = e.pointerId;
    const threshold = opts.threshold ?? 0;
    const startX = e.clientX, startY = e.clientY;
    let lastX = startX, lastY = startY, offX = 0, offY = 0;
    let ghost = null, active = false, raf = 0;
    const EDGE = 52, SPEED = 16;
    wasDraggedRef.current = false;
    // T-374 fix: no text selection while a drag gesture is in progress (a
    // pointerdown+move would otherwise select the cards' text). Restored in cleanup.
    document.body.style.userSelect = 'none';
    document.body.style.webkitUserSelect = 'none';

    const columnAt = (x, y) => document.elementFromPoint(x, y)?.closest?.('.column');
    function highlightColumn(x, y) {
      const col = columnAt(x, y);
      document.querySelectorAll('.column.drag-over').forEach(c => { if (c !== col) c.classList.remove('drag-over'); });
      if (col?.dataset?.status) col.classList.add('drag-over');
      return col;
    }
    function applyHint(x, y) {
      const col = highlightColumn(x, y);
      if (col?.dataset?.status) handleDragHint(col.dataset.status, computeDropIndex(col, y));
    }
    function autoScrollTick() {
      raf = 0;
      let scrolled = false;
      const kb = kanbanRef.current;
      if (kb) {
        const r = kb.getBoundingClientRect();
        if (lastX < r.left + EDGE && kb.scrollLeft > 0) { kb.scrollLeft -= SPEED; scrolled = true; }
        else if (lastX > r.right - EDGE && kb.scrollLeft < kb.scrollWidth - kb.clientWidth) { kb.scrollLeft += SPEED; scrolled = true; }
      }
      const body = document.elementFromPoint(lastX, lastY)?.closest?.('.column-body');
      if (body) {
        const r = body.getBoundingClientRect();
        if (lastY < r.top + EDGE && body.scrollTop > 0) { body.scrollTop -= SPEED; scrolled = true; }
        else if (lastY > r.bottom - EDGE && body.scrollTop < body.scrollHeight - body.clientHeight) { body.scrollTop += SPEED; scrolled = true; }
      }
      if (scrolled) { applyHint(lastX, lastY); raf = requestAnimationFrame(autoScrollTick); }
    }
    function maybeAutoScroll() {
      if (raf) return;
      const kb = kanbanRef.current;
      const nearH = kb && (lastX < kb.getBoundingClientRect().left + EDGE || lastX > kb.getBoundingClientRect().right - EDGE);
      const body = document.elementFromPoint(lastX, lastY)?.closest?.('.column-body');
      const nearV = body && (lastY < body.getBoundingClientRect().top + EDGE || lastY > body.getBoundingClientRect().bottom - EDGE);
      if (nearH || nearV) raf = requestAnimationFrame(autoScrollTick);
    }
    function activate() {
      active = true;
      wasDraggedRef.current = true;
      draggedId.current = taskId;
      const rect = cardEl.getBoundingClientRect();
      offX = lastX - rect.left; offY = lastY - rect.top;
      ghost = cardEl.cloneNode(true);
      ghost.classList.add('drag-ghost');
      for (const a of ['data-task-id', 'data-react-tasks', 'id', 'draggable']) ghost.removeAttribute(a);
      ghost.style.cssText = `position:fixed; left:${rect.left}px; top:${rect.top}px; width:${rect.width}px; margin:0; pointer-events:none; z-index:9999;`;
      document.body.appendChild(ghost);
      cardEl.classList.add('dragging');
      kanbanRef.current?.classList.add('is-dragging');
    }
    function cleanup() {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      if (raf) cancelAnimationFrame(raf);
      if (ghost) ghost.remove();
      cardEl.classList.remove('dragging');
      kanbanRef.current?.classList.remove('is-dragging');
      document.querySelectorAll('.column.drag-over').forEach(c => c.classList.remove('drag-over'));
      document.body.style.userSelect = '';
      document.body.style.webkitUserSelect = '';
      setDropHint(null);
      draggedId.current = null;
      dragTeardownRef.current = null;
    }
    function onMove(ev) {
      if (ev.pointerId !== pointerId) return;
      lastX = ev.clientX; lastY = ev.clientY;
      if (!active) {
        if (Math.abs(ev.clientX - startX) < threshold && Math.abs(ev.clientY - startY) < threshold) return;
        activate(); // crossed the threshold → it's a drag, not a click
      }
      ev.preventDefault();
      ghost.style.left = `${ev.clientX - offX}px`;
      ghost.style.top = `${ev.clientY - offY}px`;
      applyHint(ev.clientX, ev.clientY);
      maybeAutoScroll();
    }
    function onUp(ev) {
      if (ev.pointerId !== pointerId) return;
      if (active) {
        const col = ev.type !== 'pointercancel' ? columnAt(ev.clientX, ev.clientY) : null;
        if (col?.dataset?.status) handleDrop(col.dataset.status, computeDropIndex(col, ev.clientY));
        // No click-suppression needed: a >threshold drag doesn't emit a browser
        // click, so the card's onClick (open detail) won't fire after a drag.
      }
      // if never activated → it was a click/tap: do nothing, let the click open the card
      cleanup();
    }
    dragTeardownRef.current = cleanup;
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, [handleDrop, handleDragHint]);

  // T-370: keyboard reorder for a focused card. Enter opens the detail; Space
  // "picks up" the card; while grabbed, Arrow keys move it (up/down within a
  // column, left/right across columns), Space/Enter drops (reusing handleDrop),
  // Escape cancels. Column counts are read from the DOM so there's no stale
  // closure; each step is announced via the aria-live region.
  const handleCardKeyDown = useCallback((e, taskId, status) => {
    const colLen = (s) => document.querySelectorAll(`.column[data-status="${s}"] [data-react-tasks]`).length;
    const clearVisual = () => {
      document.querySelectorAll('.column.drag-over').forEach(c => c.classList.remove('drag-over'));
      setDropHint(null);
    };
    const st = kbRef.current;
    if (!st) {
      if (e.key === 'Enter') { e.preventDefault(); if (!wasDraggedRef.current && window.openTaskDetail) window.openTaskDetail(taskId); return; }
      if (e.key === ' ') {
        e.preventDefault();
        const cards = [...document.querySelectorAll(`.column[data-status="${status}"] [data-react-tasks]`)];
        const index = Math.max(0, cards.findIndex(c => c.dataset.taskId === taskId));
        kbRef.current = { id: taskId, status, index };
        draggedId.current = taskId;
        document.querySelector(`.column[data-status="${status}"]`)?.classList.add('drag-over');
        setDropHint({ status, index });
        setLiveMsg(`Picked up ${taskId}. Use arrow keys to move it, Space or Enter to drop, Escape to cancel.`);
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault(); clearVisual(); kbRef.current = null; draggedId.current = null;
      setLiveMsg(`Cancelled moving ${st.id}.`);
      return;
    }
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      const { status: s, index } = st;
      clearVisual(); kbRef.current = null;
      handleDrop(s, index); // draggedId.current still set — handleDrop reads it synchronously
      draggedId.current = null;
      setLiveMsg(`Dropped ${st.id} in ${STATUS_LABELS[s]}, position ${index + 1}.`);
      return;
    }
    let { status: s, index } = st;
    if (e.key === 'ArrowUp') { e.preventDefault(); index = Math.max(0, index - 1); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); index = Math.min(colLen(s), index + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); const i = STATUS_KEYS.indexOf(s); if (i > 0) { s = STATUS_KEYS[i - 1]; index = Math.min(index, colLen(s)); } }
    else if (e.key === 'ArrowRight') { e.preventDefault(); const i = STATUS_KEYS.indexOf(s); if (i < STATUS_KEYS.length - 1) { s = STATUS_KEYS[i + 1]; index = Math.min(index, colLen(s)); } }
    else return;
    st.status = s; st.index = index;
    document.querySelectorAll('.column.drag-over').forEach(c => c.classList.remove('drag-over'));
    document.querySelector(`.column[data-status="${s}"]`)?.classList.add('drag-over');
    setDropHint({ status: s, index });
    setLiveMsg(`${st.id}: ${STATUS_LABELS[s]} column, position ${index + 1}.`);
  }, [handleDrop]);

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
      groups[s] = sortTasks(groups[s], sortMode);
    }
    // Sort trashed newest-first by trashedAt so recently deleted items surface first
    trashed.sort((a, b) => new Date(b.trashedAt).getTime() - new Date(a.trashedAt).getTime());
    return { grouped: groups, archivedTopLevel: archived, trashedTopLevel: trashed };
  }, [allTasks, sortMode]);

  if (!viewedProject) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-sm" data-react-tasks>
        {(state?.projects?.length === 0)
          ? 'No projects found. Create a new project via chat.'
          : 'Select a project from the sidebar'}
      </div>
    );
  }

  // A brand-new project has zero tasks — still render the full board so the
  // columns and the backlog "Add task" form are available (an early "No tasks"
  // return here left new projects with no columns and no way to add a task).
  // Each column shows its own empty state; the backlog column carries the form.
  return (
    <div className="flex flex-col h-full" data-react-tasks>
      {/* T-370: announces keyboard-reorder steps to screen readers */}
      <div role="status" aria-live="polite" className="sr-only">{liveMsg}</div>
      <ActiveAgentsBar />
      <div className="flex items-center justify-end pb-2 gap-2 shrink-0">
        <div className="sort-mode" style={{ position: 'relative' }}>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            style={{ fontSize: '11px', display: 'flex', alignItems: 'center', gap: '4px' }}
            onClick={() => setSortMenuOpen(o => !o)}
            aria-haspopup="listbox"
            aria-expanded={sortMenuOpen}
            title="Sort order"
          >
            <ArrowUpDown size={12} />
            <span>{SORT_LABELS[sortMode]}</span>
            <ChevronDown size={12} />
          </button>
          {sortMenuOpen && (
            <>
              {/* click-away backdrop */}
              <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={() => setSortMenuOpen(false)} />
              <div
                className="sort-mode-menu"
                role="listbox"
                style={{ position: 'absolute', right: 0, top: '100%', marginTop: '4px', zIndex: 41, minWidth: '150px' }}
              >
                {SORT_MODES.map(mode => (
                  <button
                    key={mode}
                    type="button"
                    role="option"
                    aria-selected={sortMode === mode}
                    className={`sort-mode-item${sortMode === mode ? ' active' : ''}`}
                    onClick={() => handleSetSortMode(mode)}
                  >
                    <span>{SORT_LABELS[mode]}</span>
                    {sortMode === mode && <Check size={12} />}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
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
      {/* Scroll-to-task effect: consumed when coming back from spec view
          without a detail panel (Kanban-only flow). The flag is set by
          FilesView's onBackToTask when there's no openTaskDetail bridge. */}
      <ScrollToTask onExpandParent={handleExpandParent} />
      <ScrollToColumn />
      <div className="kanban" ref={kanbanRef} onScroll={handleKanbanScroll}>
        {STATUS_KEYS.map(status => (
          <Column
            key={status}
            status={status}
            onColumnScroll={handleColumnScroll}
            tasks={grouped[status]}
            archivedTasks={archivedTopLevel}
            allTasks={allTasks}
            showArchived={showArchived}
            onToggleArchived={handleToggleArchived}
            expandedParents={expandedParents}
            onToggleExpand={handleToggleExpand}
            sortMode={sortMode}
            project={viewedProject}
            onTaskCreated={handleTaskCreated}
            onTaskDeleted={handleTaskDeleted}
            onTaskTrashed={handleTaskTrashed}
            onTaskUpdated={handleTaskUpdated}
            onHandlePointerDown={startPointerDrag}
            onCardKeyDown={handleCardKeyDown}
            wasDraggedRef={wasDraggedRef}
            dropIndex={sortMode === 'custom' && dropHint?.status === status ? dropHint.index : null}
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

// Scrolls a task card into view when coming back from spec view, global search,
// or an overview widget. Consumes the navigation `scrollToTask` intent
// (NavigationContext) and clears it once revealed.
function ScrollToTask({ onExpandParent }) {
  const { intent, clearScrollToTask } = useNavigation();
  useEffect(() => {
    const taskId = intent.scrollToTask;
    if (!taskId) return;

    const reveal = (card) => {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.classList.add('highlighted-from-back');
      setTimeout(() => card.classList.remove('highlighted-from-back'), 2000);
    };

    // A subtask id is `T-<n>-<m>`; its card only renders when the parent is
    // expanded. If the card isn't there yet, expand the parent and retry a
    // few frames while the subtask list mounts.
    const subMatch = /^(T-\d+)-\d+$/.exec(taskId);
    if (subMatch) onExpandParent?.(subMatch[1]);

    // Time-budgeted retry: a same-tab expand→render lands in a few frames, but a
    // cross-project jump from global search (T-355) must also wait for the new
    // project's task list to fetch + render, so allow up to ~2.5s. The intent is
    // cleared once revealed (or after the budget) so it can't fire twice (T-356).
    const start = performance.now();
    let raf = 0;
    const tick = () => {
      const card = document.querySelector(`[data-task-id="${taskId}"]`);
      if (card) { reveal(card); clearScrollToTask(); return; }
      if (performance.now() - start < 2500) raf = requestAnimationFrame(tick);
      else clearScrollToTask();
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [intent.scrollToTask]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

// Scrolls a whole status column into view (horizontal kanban scroll) and
// briefly highlights it. Consumes the navigation `scrollToColumn` intent — set
// by the task-stats widget's legend so "Review 7" lands on the Review column
// rather than one arbitrary task.
function ScrollToColumn() {
  const { intent, clearScrollToColumn } = useNavigation();
  useEffect(() => {
    const status = intent.scrollToColumn;
    if (!status) return;
    clearScrollToColumn();
    requestAnimationFrame(() => {
      const col = document.querySelector(`.column[data-status="${status}"]`);
      if (!col) return;
      col.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
      col.classList.add('column-highlight');
      setTimeout(() => col.classList.remove('column-highlight'), 1600);
    });
  }, [intent.scrollToColumn]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}
