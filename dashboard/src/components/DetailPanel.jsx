import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X, Send, MessageSquare, CheckCircle2, ArrowRight, Inbox, ChevronDown, Lock, Unlock, FileText, FilePlus, Archive as ArchiveIcon, Trash2, UserPlus, RotateCcw, FolderInput } from 'lucide-react';
import { useAppState } from '../context/AppStateContext.jsx';
import { useDashboard } from '../context/DashboardContext.jsx';
import { useNavigation } from '../context/NavigationContext.jsx';
import Button from './Button.jsx';
import Badge from './Badge.jsx';
import Input from './Input.jsx';
import Textarea from './Textarea.jsx';
import Popover from './Popover.jsx';
import PriorityPill from './PriorityPill.jsx';
import MoveTaskModal from './MoveTaskModal.jsx';
import ClaimStateLine from './ClaimStateLine.jsx';
import AgentChip from './AgentChip.jsx';
import LeaseIndicator from './LeaseIndicator.jsx';
import Tooltip from './Tooltip.jsx';
import useTaskActions from '../hooks/useTaskActions.jsx';
import { isActivelyClaimed, ownerLabel } from '../utils/formatting.js';
import { getTasks, refreshTasks, replaceTasks } from '../state/appStateBridge.mjs';
import { applyTaskResponse, patchTask } from '../state/taskState.mjs';
import { apiJson as apiFetch } from '../utils/apiFetch.js';

// Shared Tailwind class strings for the Zone 1 / Zone 2 buttons. The
// critical parts are the resets (`border-0 outline-none`) — without
// them the browser adds its own focus outline on top of our border,
// which renders as a two-tone contour with a harsh shadow.
// Shared baseline: layout, focus ring, transitions. No border-color or
// background-color is set here — those belong to the state-specific
// classes per usage. Tailwind 3 sorts utilities alphabetically when
// generating CSS, so shipping a `border-transparent` default in the
// base meant it overrode `border-accent-subtle` appended per call (same
// for `bg-transparent` vs `bg-accent-subtle`). Keeping colour intent
// off the base removes that pitfall.
// `appearance-none` is critical: without it the browser still renders
// its native button chrome (inset border, button-face gradient, focus
// outline) UNDER our tailwind styles, which showed up as the "komische
// Kontur mit Schatten-Effekt" the user flagged repeatedly.
// `border-solid` is CRITICAL: Tailwind's `border` utility only sets
// border-width. Without preflight (which the project disables for
// legacy-CSS reasons), native <button> elements keep their UA-default
// `border-style: outset`, which renders as a 3D two-tone bevel —
// exactly the "komische Kontur mit Schatteneffekt" that kept coming
// back. Same trap bites <input> (UA default: `inset`).
const CHIP_BTN_BASE =
  'inline-flex items-center gap-1 h-[22px] px-2.5 rounded-full ' +
  'text-[11px] font-medium cursor-pointer appearance-none ' +
  'outline-none focus-visible:shadow-focus-accent ' +
  'transition-colors duration-fast border border-solid';
const ICON_BTN_BASE =
  'w-8 h-8 inline-flex items-center justify-center rounded-md cursor-pointer ' +
  'border border-solid appearance-none outline-none focus-visible:shadow-focus-accent ' +
  'transition-colors duration-fast';

// T-161-4: operational statuses shown in the Zone-1 Status-Picker.
// Archive is intentionally not in this list — it is a separate user
// intent (Zone 2 Kebab), not an operational status. See
// context/hzl-semantics-for-ui.md §3.
const STATUS_OPTIONS = ['backlog', 'open', 'in-progress', 'review', 'done'];
const STATUS_LABELS = {
  backlog: 'Backlog',
  open: 'Open',
  'in-progress': 'In Progress',
  review: 'Review',
  done: 'Done',
};

// Whether the ClaimStateLine (agent identity + action CTA) should render.
// Terminal or trashed tasks carry no active claim so the claim UI is hidden.
function showClaimLine(task) {
  if (!task) return false;
  if (task.trashedAt) return false;
  return task.status !== 'done' && task.status !== 'archived';
}

// Whether the Zone-1 Status Rail renders at all. Archived and done tasks
// still get the Status + Priority pickers so the user can restore them
// (archived → done, done → review, etc.) — only trashed tasks drop the
// rail entirely (they're only surfaced via the Trash panel).
function showStatusRail(task) {
  if (!task) return false;
  return !task.trashedAt;
}

function clampProgress(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function latestCheckpointProgress(items = []) {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item?.type !== 'checkpoint') continue;
    const progress = clampProgress(item.progress);
    if (progress !== null) return progress;
  }
  return null;
}

function taskProgressFor(task, items = []) {
  if (task?.status === 'review' || task?.status === 'done') return 100;
  return latestCheckpointProgress(items);
}

// The operational statuses plus `archived` as a deliberate restore target
// inside the panel. Archived surfaces only when the currently viewed task
// is itself archived, so the picker becomes the restore affordance.
function statusOptionsFor(task) {
  const base = ['backlog', 'open', 'in-progress', 'review', 'done'];
  if (task?.status === 'archived') return [...base, 'archived'];
  return base;
}

function fmtTime(ts) {
  if (!ts) return '--:--';
  const d = new Date(ts);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const HH = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${dd}.${mm}. ${HH}:${min}`;
}

const ACTIVITY_ICON = {
  comment: <MessageSquare size={14} />,
  checkpoint: <CheckCircle2 size={14} />,
  status: <ArrowRight size={14} />,
};

function currentAgent() {
  // T-161-4: the dashboard operator is always the reserved `@human` agent in
  // HZL terms, regardless of which Telegram user is logged in. Claims,
  // releases, comments triggered from the UI all carry this identity so the
  // Human ↔ Agent boundary stays visible in the shared Activity Feed.
  // `window.appState.authUser` is still set (for "logged in as" display) but
  // is intentionally not used as the HZL agent id. See
  // context/hzl-semantics-for-ui.md §1.
  return 'human';
}

function cleanActorName(value) {
  return String(value || '').trim().replace(/^@/, '');
}

function currentHumanAuthor() {
  const tgUser = window.Telegram?.WebApp?.initDataUnsafe?.user;
  const telegramName = [tgUser?.first_name, tgUser?.last_name].filter(Boolean).join(' ');
  return cleanActorName(telegramName || tgUser?.username || window.appState?.authUser) || currentAgent();
}

function displayActivityAuthor(author) {
  const name = cleanActorName(author);
  if (!name || name === 'system') return 'flowboard';
  if (name === 'human') return currentHumanAuthor();
  return name;
}

function showToast(msg, type = 'info') {
  // Reuse legacy toast system
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  const container = document.getElementById('toastContainer');
  if (container) {
    container.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }
}

// --- Main Component ---

export default function DetailPanel() {
  const { state, version } = useAppState();
  const { openSpec, viewProject } = useDashboard();
  const { goToTask } = useNavigation();
  const taskActions = useTaskActions();
  const [taskId, setTaskId] = useState(null);
  const [task, setTask] = useState(null);
  const [feed, setFeed] = useState([]);
  const [loading, setLoading] = useState(false);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [hzlAvailable, setHzlAvailable] = useState(true);
  const [syntheticItems, setSyntheticItems] = useState([]);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  // T-161-4: header popover (Status or Priority picker) — one shared state
  // so only one popover can be open at a time.
  const [headerPopover, setHeaderPopover] = useState({ type: null, rect: null });
  // T-161-4 Zone 2: Quick-Action state
  const [routePopover, setRoutePopover] = useState({ open: false, rect: null });
  const [blockReasonOpen, setBlockReasonOpen] = useState(false);
  const [blockReasonText, setBlockReasonText] = useState('');
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);
  const [moveModalOpen, setMoveModalOpen] = useState(false);
  // T-161-4 Zone 3: description inline-edit
  const [isEditingDescription, setIsEditingDescription] = useState(false);
  const [editDescription, setEditDescription] = useState('');
  // T-311: tag editor
  const [isAddingTag, setIsAddingTag] = useState(false);
  const [newTag, setNewTag] = useState('');

  const scrollRef = useRef(null);
  const pollRef = useRef(null);
  const taskRef = useRef(null); // always-current task for action handlers
  const titleTextareaRef = useRef(null);
  // T-161-4 Activity Feed: sticky-to-bottom flag. Starts true so the
  // feed anchors to the latest entry on first open, but flips to false
  // as soon as the user scrolls up, which stops the 12 s poll from
  // yanking the view back to the bottom every tick.
  const stickToBottomRef = useRef(true);

  const project = state?.viewedProject;
  const isOpen = taskId !== null;

  // Sync global flag for vanilla JS bridge
  if (isOpen) window._detailPanelOpen = true;

  // Keep taskRef in sync
  taskRef.current = task;

  // Reset all transient panel state: editing modes, inline confirms,
  // popovers, draft text. Called both on panel close and on task switch
  // so a half-typed description from task A doesn't bleed into task B.
  const resetPanelOverlays = useCallback(() => {
    setIsEditingTitle(false);
    setIsEditingDescription(false);
    setBlockReasonOpen(false);
    setArchiveConfirmOpen(false);
    setHeaderPopover({ type: null, rect: null });
    setRoutePopover({ open: false, rect: null });
    setEditTitle('');
    setEditDescription('');
    setBlockReasonText('');
    stickToBottomRef.current = true;
  }, []);

  // --- Expose window.openTaskDetail for vanilla JS bridge ---
  useEffect(() => {
    const handler = (id) => {
      setTaskId(id);
      window._detailPanelOpen = true;
      setTask(null);
      setFeed([]);
      setSyntheticItems([]);
      setHzlAvailable(true);
      setLoading(true);
      resetPanelOverlays();
    };
    window.openTaskDetail = handler;
    // Drain any calls that arrived before React mounted
    if (window._detailQueue && window._detailQueue.length > 0) {
      window._detailQueue.forEach(handler);
      window._detailQueue.length = 0;
    }
    return () => { delete window.openTaskDetail; };
  }, []);

  // --- Fetch task when taskId changes ---
  useEffect(() => {
    if (!taskId || !project) return;
    let cancelled = false;

    async function load() {
      try {
        const data = await apiFetch(`/projects/${project}/tasks?includeArchived=true`);
        const tasks = Array.isArray(data) ? data : Array.isArray(data?.tasks) ? data.tasks : [];
        const found = tasks.find((t) => t.id === taskId);
        if (cancelled) return;
        if (!found) throw new Error('Task not found');
        setTask(found);
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        showToast('Failed to load: ' + err.message, 'danger');
        close();
      }
    }
    load();
    return () => { cancelled = true; };
  }, [taskId, project]);

  // T-295: keep the open panel in sync with live task state. The panel held
  // task as a one-shot snapshot, so an external/poll update (e.g. another
  // agent moving the task to review) moved the kanban card but left the panel
  // stale. Re-select from the live store by id on every appstate change.
  // `version` ticks on appstate:change; skip while an inline edit is in
  // progress so we never clobber what the user is typing.
  useEffect(() => {
    if (!taskId || isEditingTitle || isEditingDescription) return;
    const live = getTasks().find(t => t.id === taskId);
    if (!live) return;
    setTask(prev => {
      if (!prev) return prev; // initial load owns the first set
      // Cheap change check on the fields the panel renders.
      const same = prev.status === live.status && prev.priority === live.priority
        && prev.blocked === live.blocked && prev.agent === live.agent
        && prev.routedAgent === live.routedAgent && prev.title === live.title
        && prev.specFile === live.specFile && prev.completed === live.completed
        && (prev.subtaskIds || []).join(',') === (live.subtaskIds || []).join(',');
      return same ? prev : { ...prev, ...live };
    });
  }, [version, taskId, isEditingTitle, isEditingDescription]);

  // --- Load activity feed ---
  const loadActivity = useCallback(async () => {
    if (!taskId || !project) return;
    try {
      // T-161-4: three parallel sources — comments (human utterances),
      // checkpoints (agent progress), and status events (claims / routes
      // / blocks / status transitions from the HZL event store). Each
      // stream is independent; if one 503s we still render the others.
      const [commentsResult, checkpointsResult, eventsResult] = await Promise.allSettled([
        apiFetch(`/projects/${project}/tasks/${taskId}/comments`),
        apiFetch(`/projects/${project}/tasks/${taskId}/checkpoints`),
        apiFetch(`/projects/${project}/tasks/${taskId}/events`),
      ]);

      if (
        commentsResult.status === 'rejected' ||
        checkpointsResult.status === 'rejected' ||
        eventsResult.status === 'rejected'
      ) {
        const err = commentsResult.reason || checkpointsResult.reason || eventsResult.reason;
        if (err?.message?.includes('503')) {
          setHzlAvailable(false);
        }
      }

      const comments = commentsResult.status === 'fulfilled'
        ? (Array.isArray(commentsResult.value?.comments) ? commentsResult.value.comments : [])
        : [];
      const checkpoints = checkpointsResult.status === 'fulfilled'
        ? (Array.isArray(checkpointsResult.value?.checkpoints) ? checkpointsResult.value.checkpoints : [])
        : [];
      const statusEvents = eventsResult.status === 'fulfilled'
        ? (Array.isArray(eventsResult.value?.events) ? eventsResult.value.events : [])
        : [];

      const merged = [
        ...comments.map((c) => ({ ...c, type: 'comment' })),
        ...checkpoints.map((c) => ({ ...c, type: 'checkpoint' })),
        ...statusEvents, // already carry { type: 'status', event, message, agent, timestamp }
      ].sort((a, b) => {
        const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
        const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
        return ta - tb;
      });
      setFeed(merged);
    } catch {
      // silently ignore poll errors
    }
  }, [taskId, project]);

  // Load activity once task is loaded, then poll every 12s
  useEffect(() => {
    if (!task) return;
    loadActivity();
    pollRef.current = setInterval(loadActivity, 12000);
    return () => { clearInterval(pollRef.current); };
  }, [task, loadActivity]);

  // Scroll feed to bottom when new items arrive, but only if the user
  // was already near the bottom. Prevents the poll from hijacking a
  // deliberate scroll-up back to the latest entry.
  useEffect(() => {
    if (scrollRef.current && stickToBottomRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [feed, syntheticItems]);

  function handleScrollActivity(e) {
    const el = e.currentTarget;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    stickToBottomRef.current = atBottom;
  }

  // Close on Escape (but not while editing title)
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e) => {
      if (e.key === 'Escape' && !isEditingTitle) close();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, isEditingTitle]);

  function close() {
    window._detailPanelOpen = false;
    setTaskId(null);
    setTask(null);
    setFeed([]);
    setSyntheticItems([]);
    clearInterval(pollRef.current);
    resetPanelOverlays();
  }

  function addSyntheticItem(type, message) {
    setSyntheticItems((prev) => [
      ...prev,
      { type, message, author: currentHumanAuthor(), timestamp: new Date().toISOString() },
    ]);
  }

  function syncPanelTask(nextTask) {
    if (!nextTask) return null;
    setTask(nextTask);
    taskRef.current = nextTask;
    replaceTasks(patchTask(getTasks(), nextTask.id, nextTask));
    return nextTask;
  }

  function mergeTaskResponse(res, baseTask = taskRef.current) {
    if (!baseTask && !res?.task) return null;
    const merged = res?.task ? { ...(baseTask || {}), ...res.task } : baseTask;
    setTask(merged);
    taskRef.current = merged;
    replaceTasks(applyTaskResponse(getTasks(), res));
    return merged;
  }

  async function refreshSharedTasks() {
    const tasks = await refreshTasks(project);
    const current = taskRef.current;
    const fresh = current ? tasks?.find((x) => x.id === current.id) : null;
    if (fresh) {
      setTask(fresh);
      taskRef.current = fresh;
    }
    return tasks;
  }

  async function syncActionResult(result, fallbackTask = taskRef.current) {
    if (!result?.ok) throw new Error(result?.error || 'Unknown error');
    if (result.task) {
      return syncPanelTask({ ...(fallbackTask || {}), ...result.task });
    }
    await refreshSharedTasks();
    return taskRef.current;
  }

  // --- Action Handlers (optimistic updates) ---

  async function handleClaim() {
    const t = taskRef.current;
    if (!t) return;
    const agent = currentAgent();
    try {
      await syncActionResult(await taskActions.claimTask(t.id), t);
      addSyntheticItem('status', `Task claimed by ${agent}`);
      showToast('Task claimed', 'success');
    } catch (err) {
      if (err.message?.includes('503') || err.message?.includes('HZL not enabled')) {
        setHzlAvailable(false);
      }
      showToast('Claim failed: ' + (err.message || 'Unknown error'), 'error');
    }
  }

  async function handleRelease() {
    const t = taskRef.current;
    if (!t) return;
    try {
      await syncActionResult(await taskActions.releaseTask(t.id), t);
      addSyntheticItem('status', 'Task released');
      showToast('Task released', 'success');
    } catch (err) {
      if (err.message?.includes('503') || err.message?.includes('HZL not enabled')) {
        setHzlAvailable(false);
      }
      showToast('Release failed: ' + (err.message || 'Unknown error'), 'error');
    }
  }

  // T-161-4: Steal. Same endpoint as claim; server allows re-claim only
  // when the previous lease has expired (see hzl-service.js#claimTask).
  async function handleSteal() {
    const t = taskRef.current;
    if (!t) return;
    const agent = currentAgent();
    const oldAgent = t.agent;
    try {
      await syncActionResult(await taskActions.claimTask(t.id), t);
      addSyntheticItem('status', `Stolen by ${agent} (previous claim by ${oldAgent || 'unknown'})`);
      showToast('Task stolen', 'success');
    } catch (err) {
      showToast('Steal failed: ' + (err.message || 'Unknown error'), 'error');
    }
  }

  // T-161-4: status change via the Zone-1 picker. PUT /tasks/:id {status}.
  // Server auto-releases the claim when moving to review/done (Chunk 1),
  // so the old "Complete" button is retired — the picker does it now.
  async function handleStatusChange(newStatus) {
    const t = taskRef.current;
    if (!t || t.status === newStatus) return;
    const oldStatus = t.status;
    try {
      await syncActionResult(await taskActions.updateStatus(t.id, newStatus), t);
      addSyntheticItem('status', `Status: ${oldStatus} -> ${newStatus}`);
    } catch (err) {
      showToast('Status change failed: ' + (err.message || 'Unknown'), 'error');
    }
  }

  async function handlePriorityChange(newPriority) {
    const t = taskRef.current;
    if (!t || t.priority === newPriority) return;
    try {
      await syncActionResult(await taskActions.updatePriority(t.id, newPriority), t);
    } catch (err) {
      showToast('Priority change failed: ' + (err.message || 'Unknown'), 'error');
    }
  }

  function openHeaderPopover(e, type) {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    setHeaderPopover({ type, rect });
  }
  function closeHeaderPopover() {
    setHeaderPopover({ type: null, rect: null });
  }

  // T-161-4 Zone 2 handlers

  function openRoutePopover(e) {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    setRoutePopover({ open: true, rect });
  }
  function closeRoutePopover() {
    setRoutePopover({ open: false, rect: null });
  }
  async function handleRoute(targetAgent) {
    const t = taskRef.current;
    if (!t) return;
    closeRoutePopover();
    const oldRouted = t.routedAgent || null;
    try {
      await syncActionResult(await taskActions.routeTask(t.id, targetAgent), t);
      // The HZL event store emits a task_updated event with the new
      // routedAgent value; loadActivity picks it up on the next poll
      // so no local synthetic is needed. Trigger a refresh now for
      // immediate feedback instead of waiting 12s.
      loadActivity();
    } catch (err) {
      syncPanelTask({ ...t, routedAgent: oldRouted });
      showToast('Route failed: ' + (err.message || 'Unknown'), 'error');
    }
  }

  // Spec actions — mirror the TaskCard behaviour: if spec exists, open it;
  // if not, POST to create one and then open. In both cases the panel
  // closes once the spec opens, because the user's focus is moving to
  // the Files view anyway.
  function handleOpenSpec() {
    const t = taskRef.current;
    if (t && t.specFile) {
      window.appState.pendingSpecFromPanel = true;
      openSpec(t.specFile, t.id);
      close();
    }
  }
  async function handleCreateSpec() {
    const t = taskRef.current;
    if (!t) return;
    try {
      const res = await apiFetch(`/projects/${project}/specs/${t.id}`, { method: 'POST' });
      if (res?.ok && res.specFile) {
        syncPanelTask({ ...t, specFile: res.specFile });
        window.appState.pendingSpecFromPanel = true;
        openSpec(res.specFile, t.id);
        showToast(`Spec created for ${t.id}`, 'success');
        close();
      }
    } catch (err) {
      showToast('Failed to create spec: ' + (err.message || 'Unknown'), 'error');
    }
  }

  // Block-with-reason (design doc §4.2 / Z2b).
  function startBlock() {
    setBlockReasonText('');
    setBlockReasonOpen(true);
  }
  async function confirmBlock() {
    const t = taskRef.current;
    if (!t) return;
    const reason = blockReasonText.trim();
    setBlockReasonOpen(false);
    const oldBlocked = t.blocked;
    // Optimistic update plus authoritative merge from server response so
    // state.tasks and the local view agree — without this the app-state
    // poll can race and re-paint the old blocked=true.
    syncPanelTask({ ...t, blocked: true });
    try {
      const res = await apiFetch(`/projects/${project}/tasks/${t.id}`, {
        method: 'PUT',
        body: { blocked: true },
      });
      if (res?.error) throw new Error(res.error);
      if (res.task) {
        mergeTaskResponse(res, t);
      }
      if (reason) {
        try {
          await apiFetch(`/projects/${project}/tasks/${t.id}/comment`, {
            method: 'POST',
            body: { message: `Blocked: ${reason}`, author: currentAgent() },
          });
          loadActivity();
        } catch { /* comment is optional */ }
      }
      addSyntheticItem('status', reason ? `Blocked - ${reason}` : 'Blocked');
    } catch (err) {
      syncPanelTask({ ...t, blocked: oldBlocked });
      showToast('Block failed: ' + (err.message || 'Unknown'), 'error');
    }
  }
  async function handleUnblock() {
    const t = taskRef.current;
    if (!t) return;
    const oldBlocked = t.blocked;
    syncPanelTask({ ...t, blocked: false });
    try {
      const res = await apiFetch(`/projects/${project}/tasks/${t.id}`, {
        method: 'PUT',
        body: { blocked: false },
      });
      if (res?.error) throw new Error(res.error);
      if (res.task) {
        mergeTaskResponse(res, t);
      }
      // hzl-core emits a task_updated event for the blocked flag
      // change; /events picks it up. Refresh now for immediate feedback.
      loadActivity();
    } catch (err) {
      syncPanelTask({ ...t, blocked: oldBlocked });
      showToast('Unblock failed: ' + (err.message || 'Unknown'), 'error');
    }
  }

  // Archive — available for any status in the Panel (the card only
  // shows Archive on done tasks). HZL's server-side rule is strict:
  // only tasks already in `done` can transition to `archived`. To keep
  // the UX promise "archive from any status", we chain — set done
  // first (auto-releases any active claim), then archive.
  async function confirmArchive() {
    const t = taskRef.current;
    if (!t) return;
    setArchiveConfirmOpen(false);
    try {
      if (t.status !== 'done') {
        // T-186: archive-from-review must approve first (review -> done is
        // sensitive). Other non-done sources still chain via PUT.
        const doneRes = (t.status === 'review')
          ? await apiFetch(`/projects/${project}/tasks/${t.id}/approve`, {
              method: 'POST',
              body: { actor: window.appState?.agentId || 'human' },
            })
          : await apiFetch(`/projects/${project}/tasks/${t.id}`, {
              method: 'PUT',
              body: { status: 'done' },
            });
        if (doneRes?.error) throw new Error(doneRes.error);
      }
      const res = await apiFetch(`/projects/${project}/tasks/${t.id}`, {
        method: 'PUT',
        body: { status: 'archived' },
      });
      if (res?.error) throw new Error(res.error);
      mergeTaskResponse(res, t);
      showToast(`${t.id} archived`, 'success');
      close();
    } catch (err) {
      showToast('Archive failed: ' + (err.message || 'Unknown'), 'error');
    }
  }

  // Restore from archive — set status back to `done`. HZL auto-
  // restores child tasks. From `done` the user can move the task
  // anywhere via the Status-Picker.
  async function handleRestoreArchive() {
    const t = taskRef.current;
    if (!t) return;
    try {
      const res = await apiFetch(`/projects/${project}/tasks/${t.id}`, {
        method: 'PUT',
        body: { status: 'done' },
      });
      if (res?.error) throw new Error(res.error);
      mergeTaskResponse(res, t);
      showToast(`${t.id} restored`, 'success');
      close();
    } catch (err) {
      showToast('Restore failed: ' + (err.message || 'Unknown'), 'error');
    }
  }

  // Delete — soft delete → Trash.
  async function handleTrashTask() {
    const t = taskRef.current;
    if (!t) return;
    try {
      const res = await apiFetch(`/projects/${project}/tasks/${t.id}`, {
        method: 'PUT',
        body: { trashedAt: new Date().toISOString() },
      });
      if (res?.error) throw new Error(res.error);
      mergeTaskResponse(res, t);
      showToast(`${t.id} moved to Trash`, 'success');
      close();
    } catch (err) {
      showToast('Delete failed: ' + (err.message || 'Unknown'), 'error');
    }
  }

  async function handleToggleBlocked() {
    const t = taskRef.current;
    if (!t) return;
    const oldBlocked = t.blocked;

    const updated = { ...t, blocked: !t.blocked };
    syncPanelTask(updated);

    try {
      const res = await apiFetch(`/projects/${project}/tasks/${t.id}`, {
        method: 'PUT',
        body: { blocked: updated.blocked },
      });
      if (res?.error && !res.ok) throw new Error(res.error || 'Update failed');
      mergeTaskResponse(res, updated);
      addSyntheticItem('status', updated.blocked ? 'Task blocked' : 'Task unblocked');
      showToast(updated.blocked ? 'Task blocked' : 'Task unblocked', 'success');
    } catch (err) {
      const reverted = { ...t, blocked: oldBlocked };
      syncPanelTask(reverted);
      if (err.message?.includes('503') || err.message?.includes('HZL not enabled')) {
        setHzlAvailable(false);
      }
      showToast('Failed to update blocked status: ' + (err.message || 'Unknown error'), 'error');
    }
  }

  // --- Title inline edit ---
  function startEditingTitle() {
    if (loading || !task) return;
    setEditTitle(task.title || '');
    setIsEditingTitle(true);
  }

  function cancelEditingTitle() {
    setIsEditingTitle(false);
    setEditTitle('');
  }

  function autoResizeTitleTextarea() {
    const ta = titleTextareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  }

  async function saveTitle() {
    const newTitle = editTitle.trim();
    if (!newTitle || !task || !project) {
      cancelEditingTitle();
      return;
    }
    if (newTitle === task.title) {
      setIsEditingTitle(false);
      return;
    }

    const oldTitle = task.title;
    const updated = { ...task, title: newTitle };
    syncPanelTask(updated);
    setIsEditingTitle(false);

    try {
      const res = await apiFetch(`/projects/${project}/tasks/${task.id}`, {
        method: 'PUT',
        body: { title: newTitle },
      });
      if (res?.error) throw new Error(res.error);
      mergeTaskResponse(res, updated);
      showToast('Task title updated', 'success');
      try { window.Telegram?.WebApp?.HapticFeedback?.impactOccurred('light'); } catch {}
    } catch (err) {
      const reverted = { ...updated, title: oldTitle };
      syncPanelTask(reverted);
      showToast('Title update failed: ' + (err.message || 'Unknown error'), 'error');
    }
  }

  function handleTitleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      saveTitle();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEditingTitle();
    }
  }

  // --- Comment submission ---
  async function handleSubmitComment() {
    const text = comment.trim();
    if (!text || !taskId) return;
    setSubmitting(true);
    try {
      const result = await apiFetch(`/projects/${project}/tasks/${taskId}/comment`, {
        method: 'POST',
        body: { message: text, author: currentHumanAuthor() },
      });
      if (!result?.error) {
        setComment('');
        showToast('Comment sent', 'success');
        loadActivity();
      } else {
        showToast('Failed to send comment', 'danger');
      }
    } catch {
      showToast('Network error', 'danger');
    } finally {
      setSubmitting(false);
    }
  }

  function handleCommentKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmitComment();
    }
  }

  // T-161-4 Zone 3: description inline-edit.
  function startEditingDescription() {
    setEditDescription(task?.description || '');
    setIsEditingDescription(true);
  }
  async function saveDescription() {
    const t = taskRef.current;
    if (!t) { setIsEditingDescription(false); return; }
    const next = editDescription;
    if (next === (t.description || '')) { setIsEditingDescription(false); return; }
    const oldDescription = t.description || '';
    syncPanelTask({ ...t, description: next });
    setIsEditingDescription(false);
    try {
      const res = await apiFetch(`/projects/${project}/tasks/${t.id}`, {
        method: 'PUT',
        body: { description: next },
      });
      if (res?.error) throw new Error(res.error);
      mergeTaskResponse(res, taskRef.current);
    } catch (err) {
      syncPanelTask({ ...t, description: oldDescription });
      showToast('Description save failed: ' + (err.message || 'Unknown'), 'error');
    }
  }
  function cancelEditingDescription() {
    setIsEditingDescription(false);
    setEditDescription('');
  }

  // T-311: tag editor — same optimistic PUT pattern as the description.
  // milestone:<name> tags drive the overview milestones widget.
  async function saveTags(nextTags) {
    const t = taskRef.current;
    if (!t) return;
    const oldTags = t.tags || [];
    syncPanelTask({ ...t, tags: nextTags });
    try {
      const res = await apiFetch(`/projects/${project}/tasks/${t.id}`, {
        method: 'PUT',
        body: { tags: nextTags },
      });
      if (res?.error) throw new Error(res.error);
      mergeTaskResponse(res, taskRef.current);
    } catch (err) {
      syncPanelTask({ ...t, tags: oldTags });
      showToast('Saving tags failed: ' + (err.message || 'Unknown'), 'error');
    }
  }
  function addTag() {
    const tag = newTag.trim();
    setNewTag('');
    setIsAddingTag(false);
    if (!tag) return;
    const current = taskRef.current?.tags || [];
    if (current.includes(tag)) return;
    saveTags([...current, tag]);
  }
  function removeTag(tag) {
    const current = taskRef.current?.tags || [];
    saveTags(current.filter(x => x !== tag));
  }

  // Navigate the panel to another task (used by Back-to-Parent and
  // the Subtasks list). Reuses the existing window.openTaskDetail bridge
  // so the panel transitions cleanly.
  function navigateToTask(id) {
    if (id && window.openTaskDetail) window.openTaskDetail(id);
  }

  // --- Render ---
  if (!isOpen) return null;

  const allFeedItems = [
    ...feed,
    ...syntheticItems,
  ].sort((a, b) => {
    const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
    const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
    return ta - tb;
  });
  const taskProgress = taskProgressFor(task, allFeedItems);

  return createPortal(
    <>
      {/* Overlay */}
      <div
        onClick={close}
        className="fixed inset-0 z-[1500] bg-black/50 backdrop-blur-[2px] transition-opacity duration-300"
      />

      {/* Panel */}
      <div data-detail-panel="true" className="fixed top-0 right-0 z-[1600] h-full w-full max-w-[480px] bg-card border-l border-border shadow-[-4px_0_24px_rgba(0,0,0,0.3)] flex flex-col animate-slide-in-right">
        {/* Header */}
        <div className="px-5 pt-5 pb-3 border-b border-border">
          <div className="flex justify-between items-start mb-3">
            <span className="font-mono text-xs text-muted">{taskId}</span>
            <button
              onClick={close}
              className="w-8 h-8 flex items-center justify-center rounded-lg text-muted hover:text-text hover:bg-bg-hover transition-colors border-0 bg-transparent cursor-pointer"
            >
              <X size={16} />
            </button>
          </div>
          {loading ? (
            <h2 className="m-0 text-lg leading-tight text-text-strong font-semibold">Loading...</h2>
          ) : isEditingTitle ? (
            <div>
              <textarea
                ref={titleTextareaRef}
                value={editTitle}
                onChange={(e) => {
                  setEditTitle(e.target.value);
                  autoResizeTitleTextarea();
                }}
                onBlur={saveTitle}
                onKeyDown={handleTitleKeyDown}
                maxLength={128}
                rows={1}
                autoFocus
                onFocus={(e) => {
                  e.target.select();
                  autoResizeTitleTextarea();
                }}
                className="w-full m-0 p-0 text-lg leading-tight text-text-strong font-semibold bg-transparent border-0 border-b-2 border-accent outline-none resize-none overflow-hidden"
              />
              <div className={`text-xs mt-1 ${editTitle.length >= 120 ? 'text-red-400' : 'text-muted'}`}>
                {editTitle.length}/128 characters
              </div>
            </div>
          ) : (
            <h2
              className="m-0 text-lg leading-tight text-text-strong font-semibold cursor-pointer hover:opacity-80 transition-opacity"
              onClick={startEditingTitle}
              title="Click to edit title"
            >
              {task?.title || 'Task Title'}
            </h2>
          )}

          {/* T-161-4 Zone 1 — Status Rail. Status + Priority pickers are
              always visible for non-trashed tasks so the user can restore
              archived/done tasks by changing the status. The ClaimStateLine
              (agent identity + action CTA) only renders for active tasks. */}
          {task && hzlAvailable && showStatusRail(task) && (
            <div className="flex items-center gap-2 mt-4 flex-wrap">
              <Tooltip content="Change status">
                <button
                  type="button"
                  className={`${CHIP_BTN_BASE} bg-secondary text-text border-border hover:bg-bg-hover`}
                  onClick={(e) => openHeaderPopover(e, 'status')}
                  aria-label="Change status"
                >
                  <span className={`inline-block w-2 h-2 rounded-full status-dot-${task.status}`} />
                  <span>{STATUS_LABELS[task.status] || task.status}</span>
                  <ChevronDown size={11} />
                </button>
              </Tooltip>
              {task.priority && (
                <PriorityPill
                  priority={task.priority}
                  onClick={(e) => openHeaderPopover(e, 'priority')}
                />
              )}
              {showClaimLine(task) && (
                <ClaimStateLine
                  task={task}
                  currentAgent={currentAgent()}
                  onClaim={handleClaim}
                  onRelease={handleRelease}
                  onSteal={handleSteal}
                />
              )}
              {task.status === 'archived' && (
                <span className="text-[10px] uppercase tracking-wider text-muted ml-auto">
                  Archived — change status to restore
                </span>
              )}
            </div>
          )}
          {taskProgress !== null && (
            <div className="mt-3 rounded-md border border-border bg-bg-accent px-3 py-2">
              <div className="flex items-center justify-between gap-3 mb-1.5">
                <span className="text-[10px] uppercase tracking-wider text-muted font-semibold">Progress</span>
                <span className="font-mono text-[11px] text-text-strong">{taskProgress}%</span>
              </div>
              <div className="h-1.5 rounded-full bg-bg-hover overflow-hidden">
                <div className="h-full bg-danger" style={{ width: `${taskProgress}%` }} />
              </div>
            </div>
          )}
          {/* Shared popover for Status and Priority pickers */}
          <Popover
            open={headerPopover.type === 'status'}
            onClose={closeHeaderPopover}
            anchorRect={headerPopover.rect}
          >
            {statusOptionsFor(task).map((s) => (
              <Popover.Option
                key={s}
                onClick={() => { handleStatusChange(s); closeHeaderPopover(); }}
              >
                <span className="flex items-center gap-2">
                  <span className={`inline-block w-2 h-2 rounded-full status-dot-${s}`} />
                  <span>{s === 'archived' ? 'Archived' : STATUS_LABELS[s]}</span>
                </span>
              </Popover.Option>
            ))}
          </Popover>
          <Popover
            open={headerPopover.type === 'priority'}
            onClose={closeHeaderPopover}
            anchorRect={headerPopover.rect}
          >
            {/* Horizontal 3-pill layout — identical to the card's
                priority popover (see TaskCard render). */}
            <div className="flex gap-1 p-1.5">
              {['low', 'medium', 'high'].map((p) => (
                <PriorityPill
                  key={p}
                  priority={p}
                  onClick={() => { handlePriorityChange(p); closeHeaderPopover(); }}
                  className={p !== task?.priority ? 'opacity-50 hover:opacity-100' : ''}
                />
              ))}
            </div>
          </Popover>
        </div>

        {/* T-161-4 Zone 2 — Quick Actions: Route / Spec / Block on the
            left, Archive / Delete on the right. Only rendered for
            non-trashed tasks; trashed tasks (opened from the Trash panel
            or via direct link) shouldn't expose these admin actions. */}
        {task && hzlAvailable && !task.trashedAt && (
          <div className="flex items-center justify-between px-4 py-2 border-b border-border">
            <div className="flex items-center gap-1">
              {/* Route */}
              <Tooltip content={task.routedAgent ? `Routed to ${task.routedAgent}` : 'Route to agent'}>
                <button
                  type="button"
                  onClick={openRoutePopover}
                  className={[
                    ICON_BTN_BASE,
                    task.routedAgent
                      ? 'text-accent bg-accent-subtle border-accent-subtle hover:brightness-125'
                      : 'border-transparent bg-transparent text-muted hover:text-text hover:bg-bg-hover',
                  ].join(' ')}
                  aria-label="Route to agent"
                >
                  <UserPlus size={14} />
                </button>
              </Tooltip>
              {/* Spec — when a spec is linked, the button gets the same
                  accent-tinted treatment as the card's spec-badge so the
                  two surfaces stay visually consistent. */}
              <Tooltip content={task.specFile && task.specExists !== false ? 'Open spec' : 'Create spec'}>
                <button
                  type="button"
                  onClick={task.specFile && task.specExists !== false ? handleOpenSpec : handleCreateSpec}
                  className={[
                    ICON_BTN_BASE,
                    task.specFile && task.specExists !== false
                      ? 'text-accent bg-accent-subtle border-accent-subtle hover:brightness-125'
                      : 'border-transparent bg-transparent text-muted hover:text-text hover:bg-bg-hover',
                  ].join(' ')}
                  aria-label={task.specFile && task.specExists !== false ? 'Open spec' : 'Create spec'}
                >
                  {task.specFile && task.specExists !== false ? <FileText size={14} /> : <FilePlus size={14} />}
                </button>
              </Tooltip>
              {/* Block / Unblock — active state mirrors the accent/danger
                  bg+border treatment used by the Spec button. */}
              <Tooltip content={task.blocked ? 'Unblock' : 'Block (with optional reason)'}>
                <button
                  type="button"
                  onClick={task.blocked ? handleUnblock : startBlock}
                  className={[
                    ICON_BTN_BASE,
                    // Active state uses the same accent tinting as the
                    // Spec button so all "active / engaged" icon buttons
                    // in the panel share the red family.
                    task.blocked
                      ? 'text-accent bg-accent-subtle border-accent-subtle hover:brightness-125'
                      : 'border-transparent bg-transparent text-muted hover:text-text hover:bg-bg-hover',
                  ].join(' ')}
                  aria-label={task.blocked ? 'Unblock' : 'Block'}
                >
                  {task.blocked ? <Unlock size={14} /> : <Lock size={14} />}
                </button>
              </Tooltip>
            </div>
            <div className="flex items-center gap-1">
              {/* Archive / Restore — the button flips to Restore when the
                  task is already archived, so the user has a clear way out. */}
              {task.status === 'archived' ? (
                <Tooltip content="Restore from archive">
                  <button
                    type="button"
                    onClick={handleRestoreArchive}
                    className={`${ICON_BTN_BASE} border-transparent bg-transparent text-muted hover:text-ok hover:bg-ok-subtle`}
                    aria-label="Restore from archive"
                  >
                    <RotateCcw size={14} />
                  </button>
                </Tooltip>
              ) : (
                <Tooltip content="Archive task">
                  <button
                    type="button"
                    onClick={() => setArchiveConfirmOpen(true)}
                    className={`${ICON_BTN_BASE} border-transparent bg-transparent text-muted hover:text-warn hover:bg-warn-subtle`}
                    aria-label="Archive task"
                  >
                    <ArchiveIcon size={14} />
                  </button>
                </Tooltip>
              )}
              {/* Move / re-parent (T-302) */}
              <Tooltip content="Move / change parent">
                <button
                  type="button"
                  onClick={() => setMoveModalOpen(true)}
                  className={`${ICON_BTN_BASE} border-transparent bg-transparent text-muted hover:text-text hover:bg-bg-hover`}
                  aria-label="Move task or change parent"
                >
                  <FolderInput size={14} />
                </button>
              </Tooltip>
              {/* Delete — soft to Trash */}
              <Tooltip content="Move to Trash">
                <button
                  type="button"
                  onClick={handleTrashTask}
                  className={`${ICON_BTN_BASE} border-transparent bg-transparent text-muted hover:text-danger hover:bg-danger-subtle`}
                  aria-label="Delete task"
                >
                  <Trash2 size={14} />
                </button>
              </Tooltip>
            </div>
          </div>
        )}

        <MoveTaskModal
          open={moveModalOpen}
          onClose={() => setMoveModalOpen(false)}
          task={task}
          project={project}
          projects={state?.projects || []}
          onDone={({ type, task: result, toProject }) => {
            close();
            if (type === 'move' && toProject) {
              viewProject(toProject); // project switch reloads the board
            } else if (type === 'reparent') {
              // Same-project reparent changes parent/child links on both the task
              // and its old/new parent — refetch so the board reflects it
              // immediately instead of waiting for the next poll (T-355).
              refreshTasks(project);
            }
            goToTask(result.id);
          }}
        />

        {/* Route popover — lives here (outside the header) so it anchors
            to the Route button in Zone 2. */}
        <Popover open={routePopover.open} onClose={closeRoutePopover} anchorRect={routePopover.rect}>
          {(state?.agents || []).map((a) => (
            <Popover.Option key={a.agent_id} onClick={() => handleRoute(a.agent_id)}>
              <span className="flex items-center gap-2">
                <span className="font-mono text-xs">@{a.agent_id}</span>
                {a.active_project && <span className="text-[10px] text-muted">on {a.active_project}</span>}
              </span>
            </Popover.Option>
          ))}
          {(state?.agents || []).length === 0 && (
            <Popover.Option onClick={closeRoutePopover}>
              <span className="text-xs text-muted italic">No agents registered</span>
            </Popover.Option>
          )}
          {task?.routedAgent && (
            <Popover.Option onClick={() => handleRoute(null)}>
              <span className="text-xs text-danger">Clear route</span>
            </Popover.Option>
          )}
        </Popover>

        {/* Block-with-reason inline input. Uses the shared Input + Button
            primitives in their compact size so the row stays consistent
            with the rest of the app and doesn't dominate the panel. */}
        {blockReasonOpen && (
          <div className="px-4 py-3 border-b border-border bg-bg-accent">
            <div className="text-xs text-muted mb-2">Why is this blocked? (optional)</div>
            <div className="flex gap-2 items-center">
              <Input
                size="sm"
                type="text"
                autoFocus
                value={blockReasonText}
                onChange={(e) => setBlockReasonText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') confirmBlock();
                  if (e.key === 'Escape') setBlockReasonOpen(false);
                }}
                placeholder="e.g. waiting for API keys"
              />
              <Button size="xs" variant="ghost" onClick={() => setBlockReasonOpen(false)}>Cancel</Button>
              <Button size="xs" variant="accent" onClick={confirmBlock}>Block</Button>
            </div>
          </div>
        )}

        {/* Archive confirmation — lightweight inline confirm (reversible). */}
        {archiveConfirmOpen && (
          <div className="px-4 py-3 border-b border-border bg-bg-accent">
            <div className="text-xs text-muted mb-2">
              Archive {taskId}? It will be hidden from the board but kept in history.
            </div>
            <div className="flex gap-2 justify-end">
              <Button size="xs" variant="ghost" onClick={() => setArchiveConfirmOpen(false)}>Cancel</Button>
              <Button size="xs" variant="accent" onClick={confirmArchive}>Archive</Button>
            </div>
          </div>
        )}

        {/* T-161-4 Zone 3 — Content: parent-link (if subtask),
            description, subtasks list, dependencies. Linear sections,
            each only rendered when its data exists. */}
        <div ref={scrollRef} onScroll={handleScrollActivity} className="flex-1 overflow-y-auto">
          {task?.parentId && (
            <div className="px-4 pt-3">
              <button
                type="button"
                onClick={() => navigateToTask(task.parentId)}
                className="inline-flex items-center gap-1 text-xs text-muted hover:text-text transition-colors bg-transparent border-0 cursor-pointer p-0"
                title={`Open parent ${task.parentId}`}
              >
                <span style={{ transform: 'scaleX(-1)', display: 'inline-block' }}>
                  <ArrowRight size={12} />
                </span>
                <span>Parent: {task.parentId}</span>
                <span className="text-muted">
                  {(() => {
                    const parent = getTasks().find(t => t.id === task.parentId);
                    return parent?.title ? ` - ${parent.title}` : '';
                  })()}
                </span>
              </button>
            </div>
          )}

          {/* Description */}
          {task && (
            <div className="px-4 py-4 border-b border-border">
              <div className="text-[10px] uppercase tracking-wider text-muted font-semibold mb-2">Description</div>
              {isEditingDescription ? (
                <div>
                  <Textarea
                    value={editDescription}
                    onChange={(e) => setEditDescription(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') { e.preventDefault(); cancelEditingDescription(); }
                      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveDescription(); }
                    }}
                    autoFocus
                    rows={4}
                    placeholder="Describe what this task is about"
                  />
                  <div className="flex justify-end gap-2 mt-2">
                    <Button size="xs" variant="ghost" onClick={cancelEditingDescription}>Cancel</Button>
                    <Button size="xs" variant="accent" onClick={saveDescription}>Save</Button>
                  </div>
                </div>
              ) : (
                <div
                  onClick={startEditingDescription}
                  className="text-sm text-text whitespace-pre-wrap cursor-text hover:bg-bg-hover rounded px-1 py-0.5 -mx-1"
                  title="Click to edit"
                >
                  {task.description
                    ? task.description
                    : <span className="text-muted italic">Add description</span>}
                </div>
              )}
            </div>
          )}

          {/* T-311 Tags — chips with inline add/remove; milestone:<name>
              feeds the overview milestones widget */}
          {task && (
            <div className="px-4 py-4 border-b border-border">
              <div className="text-[10px] uppercase tracking-wider text-muted font-semibold mb-2">Tags</div>
              <div className="flex flex-wrap gap-1.5 items-center">
                {(task.tags || []).map(tag => (
                  <span
                    key={tag}
                    className={`inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full border text-[11px] font-mono ${
                      tag.startsWith('milestone:')
                        ? 'border-accent-2 text-accent-2'
                        : 'border-border text-text bg-bg-accent'
                    }`}
                  >
                    {tag}
                    <button
                      type="button"
                      onClick={() => removeTag(tag)}
                      aria-label={`Remove tag ${tag}`}
                      className="inline-flex items-center justify-center w-4 h-4 rounded-full border-0 bg-transparent text-muted cursor-pointer hover:text-danger"
                    >
                      <X size={10} />
                    </button>
                  </span>
                ))}
                {isAddingTag ? (
                  <input
                    autoFocus
                    value={newTag}
                    onChange={(e) => setNewTag(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); addTag(); }
                      if (e.key === 'Escape') { setIsAddingTag(false); setNewTag(''); }
                    }}
                    onBlur={addTag}
                    placeholder="tag or milestone:<name>"
                    className="px-2 py-0.5 text-[11px] font-mono bg-bg border border-border rounded-full outline-none focus:border-accent w-40"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => setIsAddingTag(true)}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-dashed border-border bg-transparent text-[11px] text-muted cursor-pointer hover:text-text hover:border-border-strong"
                  >
                    + Add tag
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Subtasks list — only for parent tasks with subtasks */}
          {task && !task.parentId && task.subtaskIds && task.subtaskIds.length > 0 && (
            <div className="px-4 py-4 border-b border-border">
              <div className="text-[10px] uppercase tracking-wider text-muted font-semibold mb-2">
                Subtasks
                {(() => {
                  const subs = getTasks().filter(t => t.parentId === task.id && t.status !== 'archived' && !t.trashedAt);
                  const done = subs.filter(t => t.status === 'done').length;
                  return <span className="ml-2 normal-case tracking-normal text-muted font-normal">{done}/{subs.length} done</span>;
                })()}
              </div>
              <div className="space-y-1">
                {getTasks()
                  .filter(t => t.parentId === task.id && !t.trashedAt)
                  .sort((a, b) => {
                    const na = parseInt((a.id.split('-').pop() || '0'), 10);
                    const nb = parseInt((b.id.split('-').pop() || '0'), 10);
                    return na - nb;
                  })
                  .map((sub) => (
                    <div
                      key={sub.id}
                      onClick={() => navigateToTask(sub.id)}
                      className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-bg-hover cursor-pointer"
                    >
                      <span className={`inline-block w-2 h-2 rounded-full status-dot-${sub.status}`} />
                      <span className="font-mono text-[11px] text-muted">{sub.id}</span>
                      <span className="text-sm text-text truncate flex-1">{sub.title}</span>
                      {sub.agent && <AgentChip name={sub.agent} size="xs" variant={isActivelyClaimed(sub) ? 'solid' : 'soft'} title={ownerLabel(sub)} pulse={isActivelyClaimed(sub)} />}
                      {!sub.agent && sub.routedAgent && <AgentChip name={sub.routedAgent} size="xs" variant="ring" title={`Routed to ${sub.routedAgent}`} />}
                      <LeaseIndicator task={sub} />
                    </div>
                  ))}
              </div>
            </div>
          )}

          {/* Dependencies placeholder (wiring lands with T-154) */}
          {task && ((Array.isArray(task.blockedBy) && task.blockedBy.length > 0) ||
                    (Array.isArray(task.blocking) && task.blocking.length > 0)) && (
            <div className="px-4 py-4 border-b border-border">
              <div className="text-[10px] uppercase tracking-wider text-muted font-semibold mb-2">Dependencies</div>
              {Array.isArray(task.blockedBy) && task.blockedBy.length > 0 && (
                <div className="text-xs text-text mb-1">
                  <span className="text-muted">Blocked by:</span>{' '}
                  {task.blockedBy.map((id) => (
                    <button key={id} type="button" onClick={() => navigateToTask(id)} className="font-mono text-accent hover:underline bg-transparent border-0 p-0 mr-2 cursor-pointer">{id}</button>
                  ))}
                </div>
              )}
              {Array.isArray(task.blocking) && task.blocking.length > 0 && (
                <div className="text-xs text-text">
                  <span className="text-muted">Blocking:</span>{' '}
                  {task.blocking.map((id) => (
                    <button key={id} type="button" onClick={() => navigateToTask(id)} className="font-mono text-accent hover:underline bg-transparent border-0 p-0 mr-2 cursor-pointer">{id}</button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Zone 4 - Activity Feed */}
          <div className="px-4 py-3">
            <div className="text-[10px] uppercase tracking-wider text-muted font-semibold mb-2">Activity</div>
            {loading && (
              <div className="text-sm text-muted py-4 text-center">Loading...</div>
            )}
            {!loading && allFeedItems.length === 0 && (
              <div className="text-sm text-muted py-4 text-center flex items-center justify-center gap-1.5">
                <Inbox size={16} /> No activity yet. Be the first to comment.
              </div>
            )}
            {allFeedItems.map((item, i) => (
              <ActivityItem key={`${item.timestamp}-${i}`} item={item} />
            ))}
          </div>
        </div>

        {/* Comment Footer — show the authenticated UI author while task-claim
            semantics keep using the reserved `human` agent internally. */}
        <div className="px-4 py-3 border-t border-border bg-card">
          <div className="flex gap-2 items-center">
            <AgentChip name={currentHumanAuthor()} size="sm" title={`Commenting as @${currentHumanAuthor()}`} />
            <Textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              onKeyDown={handleCommentKeyDown}
              placeholder="Write a comment..."
              rows={1}
              className="flex-1 resize-none"
            />
            <button
              onClick={handleSubmitComment}
              disabled={submitting || !comment.trim()}
              className="w-9 h-9 flex items-center justify-center rounded-lg bg-accent text-white border-0 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed hover:brightness-110 transition-all shrink-0"
            >
              <Send size={16} />
            </button>
          </div>
        </div>
      </div>
    </>,
    document.body
  );
}

// --- Sub-components ---

// T-161-4 Zone 4: Activity entry — three visually differentiated types.
// - Comment / Checkpoint: AgentChip + handle + timestamp + optional type
//   label + body. Checkpoint progress is consolidated in the task header.
// - Status event: dim one-liner, no chip, no bubble (system-info tone).
function ActivityItem({ item }) {
  const author = displayActivityAuthor(item.author || item.agent);
  const time = relativeTime(item.timestamp);
  const handle = author.startsWith('@') ? author : `@${author}`;

  if (item.type === 'status') {
    // Synthetic status events — rendered as a dim single line.
    return (
      <div className="flex items-baseline gap-2 py-1.5 text-xs text-muted">
        <span className="font-mono">{handle}</span>
        <span className="truncate">{item.message || ''}</span>
        <span className="ml-auto shrink-0 text-[10px]">{time}</span>
      </div>
    );
  }

  const typeLabel = item.type === 'checkpoint' ? ' - checkpoint' : '';

  return (
    <div className="flex gap-3 py-2.5">
      <div className="shrink-0 pt-0.5">
        <AgentChip name={author} size="sm" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 mb-1">
          <span className="font-mono text-xs text-text-strong font-medium">{handle}</span>
          <span className="text-xs text-muted">{time}{typeLabel}</span>
        </div>
        <div className="text-sm text-text break-words whitespace-pre-wrap">{item.message || ''}</div>
      </div>
    </div>
  );
}

// Relative timestamps for recent entries, absolute for older ones.
function relativeTime(ts) {
  if (!ts) return '';
  const diffMs = Date.now() - new Date(ts).getTime();
  if (diffMs < 60_000) return 'just now';
  const m = Math.round(diffMs / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  // Same day / older → fall back to the short absolute format.
  return fmtTime(ts);
}
