import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X, Send, MessageSquare, CheckCircle2, ArrowRight, Inbox, ChevronDown } from 'lucide-react';
import { useAppState } from '../context/AppStateContext.jsx';
import Button from './Button.jsx';
import Badge from './Badge.jsx';
import Popover from './Popover.jsx';
import PriorityPill from './PriorityPill.jsx';
import ClaimStateLine from './ClaimStateLine.jsx';

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

// Whether Zone-1 (status-rail + claim-state-line) should render at all.
// Terminal / trashed tasks don't get a Claim affordance.
function showClaimState(task) {
  if (!task) return false;
  if (task.trashedAt) return false;
  return task.status !== 'done' && task.status !== 'archived';
}

const API = '/api';

async function apiFetch(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...opts.headers };
  // Telegram WebApp auth — send initData on every request
  const tg = window.Telegram?.WebApp;
  if (tg?.initData) headers['X-Telegram-Init-Data'] = tg.initData;

  const res = await fetch(API + path, {
    ...opts,
    headers,
    credentials: 'include',
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    if (data.error) throw new Error(data.error);
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json();
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

function refreshKanban() {
  if (window.appState?._refreshBoard) window.appState._refreshBoard();
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
  const { state } = useAppState();
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

  const scrollRef = useRef(null);
  const pollRef = useRef(null);
  const taskRef = useRef(null); // always-current task for action handlers
  const titleTextareaRef = useRef(null);

  const project = state?.viewedProject;
  const isOpen = taskId !== null;

  // Keep taskRef in sync
  taskRef.current = task;

  // --- Expose window.openTaskDetail for vanilla JS bridge ---
  useEffect(() => {
    const handler = (id) => {
      setTaskId(id);
      setTask(null);
      setFeed([]);
      setSyntheticItems([]);
      setHzlAvailable(true);
      setLoading(true);
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
        const data = await apiFetch(`/projects/${project}/tasks`);
        const tasks = Array.isArray(data) ? data : Array.isArray(data?.tasks) ? data.tasks : [];
        const found = tasks.find((t) => t.id === taskId);
        if (cancelled) return;
        if (!found) throw new Error('Task nicht gefunden');
        setTask(found);
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        showToast('Fehler beim Laden: ' + err.message, 'danger');
        close();
      }
    }
    load();
    return () => { cancelled = true; };
  }, [taskId, project]);

  // --- Load activity feed ---
  const loadActivity = useCallback(async () => {
    if (!taskId || !project) return;
    try {
      const [commentsResult, checkpointsResult] = await Promise.allSettled([
        apiFetch(`/projects/${project}/tasks/${taskId}/comments`),
        apiFetch(`/projects/${project}/tasks/${taskId}/checkpoints`),
      ]);

      if (commentsResult.status === 'rejected' || checkpointsResult.status === 'rejected') {
        const err = commentsResult.reason || checkpointsResult.reason;
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

      const merged = [
        ...comments.map((c) => ({ ...c, type: 'comment' })),
        ...checkpoints.map((c) => ({ ...c, type: 'checkpoint' })),
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

  // Scroll feed to bottom when items change
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [feed, syntheticItems]);

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
    setTaskId(null);
    setTask(null);
    setFeed([]);
    setSyntheticItems([]);
    clearInterval(pollRef.current);
  }

  function addSyntheticItem(type, message) {
    setSyntheticItems((prev) => [
      ...prev,
      { type, message, author: currentAgent(), timestamp: new Date().toISOString() },
    ]);
  }

  // --- Action Handlers (optimistic updates) ---

  async function handleClaim() {
    const t = taskRef.current;
    if (!t) return;
    const agent = currentAgent();
    const oldAgent = t.agent;
    const oldStatus = t.status;

    const updated = { ...t, agent, status: (t.status === 'open' || t.status === 'ready') ? 'in-progress' : t.status };
    setTask(updated);
    taskRef.current = updated;

    try {
      const res = await apiFetch(`/projects/${project}/tasks/${t.id}/claim`, {
        method: 'POST',
        body: { agent, lease: 60 },
      });
      if (res?.error) throw new Error(res.error);
      const merged = { ...updated };
      if (res.task) {
        merged.status = res.task.status ?? merged.status;
        merged.agent = res.task.agent ?? merged.agent;
        merged.blocked = res.task.blocked ?? merged.blocked;
        merged.previousStatus = res.task.previousStatus ?? merged.previousStatus;
      }
      setTask(merged);
      taskRef.current = merged;
      refreshKanban();
      addSyntheticItem('status', `Task claimed by ${agent}`);
      showToast('Task claimed', 'success');
    } catch (err) {
      const reverted = { ...t, agent: oldAgent, status: oldStatus };
      setTask(reverted);
      taskRef.current = reverted;
      if (err.message?.includes('503') || err.message?.includes('HZL not enabled')) {
        setHzlAvailable(false);
      }
      showToast('Claim failed: ' + (err.message || 'Unknown error'), 'error');
    }
  }

  async function handleRelease() {
    const t = taskRef.current;
    if (!t) return;
    const agent = currentAgent();
    const oldAgent = t.agent;
    const oldStatus = t.status;

    const updated = { ...t, agent: null, status: t.previousStatus || 'open' };
    setTask(updated);
    taskRef.current = updated;

    try {
      const res = await apiFetch(`/projects/${project}/tasks/${t.id}/release`, {
        method: 'POST',
        body: { agent, force: true },
      });
      if (res?.error) throw new Error(res.error);
      // Re-fetch to get accurate status
      const data = await apiFetch(`/projects/${project}/tasks`);
      const tasks = Array.isArray(data) ? data : Array.isArray(data?.tasks) ? data.tasks : [];
      const fresh = tasks.find((x) => x.id === t.id);
      if (fresh) {
        setTask(fresh);
        taskRef.current = fresh;
      }
      refreshKanban();
      addSyntheticItem('status', 'Task released');
      showToast('Task released', 'success');
    } catch (err) {
      const reverted = { ...t, agent: oldAgent, status: oldStatus };
      setTask(reverted);
      taskRef.current = reverted;
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
      const res = await apiFetch(`/projects/${project}/tasks/${t.id}/claim`, {
        method: 'POST',
        body: { agent, lease: 60 },
      });
      if (res?.error) throw new Error(res.error);
      const merged = { ...t };
      if (res.task) {
        merged.status = res.task.status ?? merged.status;
        merged.agent = res.task.agent ?? merged.agent;
        merged.claimedAt = res.task.claimedAt ?? merged.claimedAt;
        merged.leaseUntil = res.task.leaseUntil ?? merged.leaseUntil;
      }
      setTask(merged);
      taskRef.current = merged;
      refreshKanban();
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
    const optimistic = { ...t, status: newStatus };
    if (newStatus === 'review' || newStatus === 'done') {
      optimistic.agent = null;
      optimistic.claimedAt = null;
      optimistic.leaseUntil = null;
    }
    setTask(optimistic);
    taskRef.current = optimistic;
    try {
      const res = await apiFetch(`/projects/${project}/tasks/${t.id}`, {
        method: 'PUT',
        body: { status: newStatus },
      });
      if (res?.error) throw new Error(res.error);
      if (res.task) {
        const merged = { ...optimistic, ...res.task };
        setTask(merged);
        taskRef.current = merged;
      }
      refreshKanban();
      addSyntheticItem('status', `Status: ${oldStatus} -> ${newStatus}`);
    } catch (err) {
      setTask({ ...t, status: oldStatus });
      taskRef.current = { ...t, status: oldStatus };
      showToast('Status change failed: ' + (err.message || 'Unknown'), 'error');
    }
  }

  async function handlePriorityChange(newPriority) {
    const t = taskRef.current;
    if (!t || t.priority === newPriority) return;
    const oldPriority = t.priority;
    setTask({ ...t, priority: newPriority });
    taskRef.current = { ...t, priority: newPriority };
    try {
      const res = await apiFetch(`/projects/${project}/tasks/${t.id}`, {
        method: 'PUT',
        body: { priority: newPriority },
      });
      if (res?.error) throw new Error(res.error);
      refreshKanban();
    } catch (err) {
      setTask({ ...t, priority: oldPriority });
      taskRef.current = { ...t, priority: oldPriority };
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

  async function handleToggleBlocked() {
    const t = taskRef.current;
    if (!t) return;
    const oldBlocked = t.blocked;

    const updated = { ...t, blocked: !t.blocked };
    setTask(updated);
    taskRef.current = updated;

    try {
      const res = await apiFetch(`/projects/${project}/tasks/${t.id}`, {
        method: 'PUT',
        body: { blocked: updated.blocked },
      });
      if (res?.error && !res.ok) throw new Error(res.error || 'Update failed');
      refreshKanban();
      addSyntheticItem('status', updated.blocked ? 'Task blocked' : 'Task unblocked');
      showToast(updated.blocked ? 'Task blocked' : 'Task unblocked', 'success');
    } catch (err) {
      const reverted = { ...t, blocked: oldBlocked };
      setTask(reverted);
      taskRef.current = reverted;
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
    setTask(updated);
    taskRef.current = updated;
    setIsEditingTitle(false);

    try {
      await apiFetch(`/projects/${project}/tasks/${task.id}`, {
        method: 'PUT',
        body: { title: newTitle },
      });
      refreshKanban();
      showToast('Task title updated', 'success');
      try { window.Telegram?.WebApp?.HapticFeedback?.impactOccurred('light'); } catch {}
    } catch (err) {
      const reverted = { ...updated, title: oldTitle };
      setTask(reverted);
      taskRef.current = reverted;
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
        body: { message: text, author: currentAgent() },
      });
      if (!result?.error) {
        setComment('');
        showToast('Kommentar gesendet', 'success');
        loadActivity();
      } else {
        showToast('Senden fehlgeschlagen', 'danger');
      }
    } catch {
      showToast('Netzwerkfehler', 'danger');
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

  return createPortal(
    <>
      {/* Overlay */}
      <div
        onClick={close}
        className="fixed inset-0 z-[1500] bg-black/50 backdrop-blur-[2px] transition-opacity duration-300"
      />

      {/* Panel */}
      <div className="fixed top-0 right-0 z-[1600] h-full w-full max-w-[480px] bg-card border-l border-border shadow-[-4px_0_24px_rgba(0,0,0,0.3)] flex flex-col animate-slide-in-right">
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
            <h2 className="m-0 text-lg leading-tight text-text-strong font-semibold">Lade...</h2>
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

          {/* T-161-4 Zone 1 — Status Rail: Status chip + Priority chip +
              Claim state line with contextual CTA. Terminal tasks (done /
              archived / trashed) don't render the claim section. */}
          {task && hzlAvailable && showClaimState(task) && (
            <div className="flex items-center gap-2 mt-4 flex-wrap">
              <button
                type="button"
                className="inline-flex items-center gap-1 px-2 py-[3px] rounded-full text-[11px] font-medium border border-border bg-secondary text-text hover:bg-bg-hover cursor-pointer"
                onClick={(e) => openHeaderPopover(e, 'status')}
                title="Change status"
              >
                <span className={`inline-block w-2 h-2 rounded-full status-dot-${task.status}`} />
                <span>{STATUS_LABELS[task.status] || task.status}</span>
                <ChevronDown size={11} />
              </button>
              {task.priority && (
                <PriorityPill
                  priority={task.priority}
                  onClick={(e) => openHeaderPopover(e, 'priority')}
                />
              )}
              <ClaimStateLine
                task={task}
                currentAgent={currentAgent()}
                onClaim={handleClaim}
                onRelease={handleRelease}
                onSteal={handleSteal}
              />
            </div>
          )}
          {/* Shared popover for Status and Priority pickers */}
          <Popover
            open={headerPopover.type === 'status'}
            onClose={closeHeaderPopover}
            anchorRect={headerPopover.rect}
          >
            {STATUS_OPTIONS.map((s) => (
              <Popover.Option
                key={s}
                onClick={() => { handleStatusChange(s); closeHeaderPopover(); }}
              >
                <span className="flex items-center gap-2">
                  <span className={`inline-block w-2 h-2 rounded-full status-dot-${s}`} />
                  <span>{STATUS_LABELS[s]}</span>
                </span>
              </Popover.Option>
            ))}
          </Popover>
          <Popover
            open={headerPopover.type === 'priority'}
            onClose={closeHeaderPopover}
            anchorRect={headerPopover.rect}
          >
            {['low', 'medium', 'high'].map((p) => (
              <Popover.Option
                key={p}
                onClick={() => { handlePriorityChange(p); closeHeaderPopover(); }}
              >
                <PriorityPill priority={p} />
              </Popover.Option>
            ))}
          </Popover>
        </div>


        {/* Scrollable content */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          {/* Task Meta */}
          {task && (
            <div className="px-4 py-4 border-b border-border">
              <div className="mt-2.5 text-xs text-muted">
                {task.id} &middot; {task.status || ''}
                {!task.parentId && <> &middot; {task.priority || ''}</>}
                {task.parentId && (
                  <> &middot; <span className="text-sm text-muted">Priority: {(() => {
                    const parent = (window.appState?.tasks || []).find(t => t.id === task.parentId);
                    return parent?.priority || task.priority || '–';
                  })()} (inherited from {task.parentId})</span></>
                )}
              </div>
            </div>
          )}

          {/* Activity Feed */}
          <div className="px-4 py-3">
            {loading && (
              <div className="text-sm text-muted py-4 text-center">Daten werden geladen\u2026</div>
            )}
            {!loading && allFeedItems.length === 0 && (
              <div className="text-sm text-muted py-4 text-center flex items-center justify-center gap-1.5"><Inbox size={16} /> Noch keine Aktivit&auml;t</div>
            )}
            {allFeedItems.map((item, i) => (
              <ActivityItem key={`${item.timestamp}-${i}`} item={item} />
            ))}
          </div>
        </div>

        {/* Comment Footer */}
        <div className="px-4 py-3 border-t border-border bg-card">
          <div className="flex gap-2 items-end">
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              onKeyDown={handleCommentKeyDown}
              placeholder="Schreibe einen Kommentar..."
              rows={1}
              className="flex-1 resize-none rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text placeholder:text-muted focus:outline-none focus:border-accent"
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

function ActivityItem({ item }) {
  const icon = ACTIVITY_ICON[item.type] || <span>&middot;</span>;
  const author = item.author || item.agent || 'System';
  const time = fmtTime(item.timestamp);

  return (
    <div className="flex gap-3 py-2 text-sm">
      <div className="shrink-0 w-5 text-center">{icon}</div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="font-medium text-text-strong text-xs uppercase">{author}</span>
          <span className="text-xs text-muted">{time}</span>
        </div>
        <div className="text-text break-words">{item.message || ''}</div>
      </div>
    </div>
  );
}
