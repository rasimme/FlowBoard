import { useMemo, useState, useCallback, useRef } from 'react';
import { useAppState } from '../context/AppStateContext.jsx';
import { Badge } from '../components/index.js';
import { Plus } from 'lucide-react';

const STATUS_KEYS = ['backlog', 'open', 'in-progress', 'review', 'done'];
const STATUS_LABELS = {
  backlog: 'Backlog',
  open: 'Open',
  'in-progress': 'In Progress',
  review: 'Review',
  done: 'Done',
};

const PRIORITY_VARIANT = {
  high: 'danger',
  medium: 'warning',
  low: 'default',
};

// Read initial values from localStorage (same keys as legacy kanbanState)
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
    <button
      type="button"
      className="flex items-center gap-1.5 w-full mt-1.5 cursor-pointer group"
      onClick={(e) => { e.stopPropagation(); onToggle(task.id); }}
    >
      <span
        className={`text-[10px] text-muted transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
      >
        &#9654;
      </span>
      <div className="flex-1 h-1.5 bg-bg-surface rounded-full overflow-hidden">
        <div className="h-full flex">
          <div className="bg-success" style={{ width: `${donePct}%` }} />
          <div className="bg-info" style={{ width: `${reviewPct}%` }} />
          <div className="bg-warning" style={{ width: `${activePct}%` }} />
        </div>
      </div>
      <span className="text-[10px] text-muted font-mono">{done}/{total}</span>
    </button>
  );
}

// --- Subtask card (compact) ---
function SubtaskCard({ task }) {
  const handleClick = () => {
    if (window.openTaskDetail) window.openTaskDetail(task.id);
  };

  const statusColors = {
    'done': 'bg-success',
    'review': 'bg-info',
    'in-progress': 'bg-warning',
    'open': 'bg-muted',
    'backlog': 'bg-muted',
  };

  return (
    <button
      type="button"
      className="w-full text-left bg-bg-surface/60 rounded-md px-2.5 py-1.5 hover:bg-bg-hover transition-colors cursor-pointer border border-border/50 flex items-center gap-2"
      onClick={handleClick}
    >
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusColors[task.status] || 'bg-muted'}`} />
      <span className="text-[11px] text-muted font-mono shrink-0">{task.id}</span>
      <span className="text-xs text-secondary truncate">{task.title}</span>
      {task.blocked && (
        <span className="text-[9px] text-danger font-medium uppercase tracking-wide ml-auto shrink-0">Blocked</span>
      )}
    </button>
  );
}

// --- Parent task card ---
function TaskCard({ task, allTasks, expanded, onToggleExpand }) {
  const handleClick = () => {
    if (window.openTaskDetail) window.openTaskDetail(task.id);
  };

  const hasSubtasks = task.subtaskIds && task.subtaskIds.length > 0;

  return (
    <div>
      <button
        type="button"
        className="w-full text-left bg-bg-elevated rounded-lg p-3 hover:bg-bg-hover transition-colors cursor-pointer border border-border"
        onClick={handleClick}
        data-react-tasks
      >
        <div className="flex items-start justify-between gap-2 mb-1">
          <span className="text-[11px] text-muted font-mono">{task.id}</span>
          {task.blocked && (
            <span className="text-[10px] text-danger font-medium uppercase tracking-wide">Blocked</span>
          )}
        </div>
        <div className="text-sm text-primary font-medium leading-snug mb-2">{task.title}</div>
        <div className="flex items-center gap-2">
          {task.priority && (
            <Badge variant={PRIORITY_VARIANT[task.priority] || 'default'}>
              {task.priority}
            </Badge>
          )}
        </div>
        {hasSubtasks && (
          <SubtaskProgress
            task={task}
            allTasks={allTasks}
            expanded={expanded}
            onToggle={onToggleExpand}
          />
        )}
      </button>
      {hasSubtasks && expanded && (
        <ExpandedSubtasks task={task} allTasks={allTasks} />
      )}
    </div>
  );
}

// --- Expanded subtask list ---
function ExpandedSubtasks({ task, allTasks }) {
  const subtasks = allTasks.filter(t => t.parentId === task.id && t.status !== 'archived');
  if (subtasks.length === 0) return null;

  return (
    <div className="flex flex-col gap-1 ml-3 mt-1 pl-2 border-l-2 border-border/40">
      {subtasks.map(st => <SubtaskCard key={st.id} task={st} />)}
    </div>
  );
}

// --- Archived task card (read-only, dimmed) ---
function ArchivedTaskCard({ task }) {
  return (
    <div className="w-full text-left bg-bg-elevated/50 rounded-lg p-3 border border-border/40 opacity-50">
      <div className="flex items-start justify-between gap-2 mb-1">
        <span className="text-[11px] text-muted font-mono">{task.id}</span>
      </div>
      <div className="text-sm text-muted font-medium leading-snug mb-1">{task.title}</div>
      {task.priority && (
        <Badge variant="default">{task.priority}</Badge>
      )}
    </div>
  );
}

// --- Inline Add-Task form (Backlog only) ---
function AddTaskForm({ project, onCreated }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState('medium');
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef(null);

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
      const res = await fetch(`/api/projects/${project}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: trimmed, priority, status: 'backlog' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create task');
      window.Telegram?.WebApp?.HapticFeedback?.impactOccurred('medium');
      if (window.showToast) window.showToast(`Created ${data.task?.id || 'task'}`, 'success');
      onCreated?.();
      setTitle('');
      setPriority('medium');
      setSubmitting(false);
      setTimeout(() => inputRef.current?.focus(), 0);
    } catch (err) {
      console.warn('[add-task]', err);
      window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('error');
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
      <button
        type="button"
        className="flex items-center gap-1.5 w-full px-3 py-2 text-xs text-muted hover:text-secondary hover:bg-bg-hover rounded-lg transition-colors cursor-pointer"
        onClick={handleOpen}
      >
        <Plus size={14} />
        <span>Add Task</span>
      </button>
    );
  }

  return (
    <div className="bg-bg-elevated rounded-lg p-2.5 border border-border flex flex-col gap-2">
      <input
        ref={inputRef}
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Task title…"
        disabled={submitting}
        className="w-full px-2.5 py-1.5 text-sm rounded-md bg-bg-surface text-text border border-border placeholder:text-muted outline-none focus:border-accent-subtle transition-colors"
      />
      <div className="flex items-center gap-2">
        <select
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
          disabled={submitting}
          className="px-2 py-1 text-xs rounded-md bg-bg-surface text-text border border-border outline-none cursor-pointer"
        >
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
        <div className="flex-1" />
        <button
          type="button"
          className="text-xs text-muted hover:text-secondary px-2 py-1 cursor-pointer"
          onClick={reset}
        >
          Cancel
        </button>
        <button
          type="button"
          className="text-xs bg-accent text-white px-3 py-1 rounded-md hover:brightness-110 disabled:opacity-50 cursor-pointer"
          onClick={handleSubmit}
          disabled={!title.trim() || submitting}
        >
          {submitting ? 'Adding…' : 'Add'}
        </button>
      </div>
    </div>
  );
}

// --- Column ---
function Column({ status, tasks, archivedTasks, allTasks, showArchived, onToggleArchived, expandedParents, onToggleExpand, sortNewestFirst, project, onTaskCreated }) {
  const isDone = status === 'done';
  const isBacklog = status === 'backlog';
  const archivedCount = isDone ? archivedTasks.length : 0;
  const sortedArchived = isDone && showArchived ? sortTasks(archivedTasks, sortNewestFirst) : [];

  return (
    <div className="flex flex-col min-w-[260px] max-w-[320px] flex-1 bg-bg-surface rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border">
        <span className="text-xs font-semibold text-secondary uppercase tracking-wide">
          {STATUS_LABELS[status]}
        </span>
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-muted bg-bg-elevated rounded-full px-2 py-0.5 font-mono">
            {tasks.length}
          </span>
          {isDone && archivedCount > 0 && (
            <button
              type="button"
              className={`text-[11px] font-mono px-1.5 py-0.5 rounded transition-colors ${showArchived ? 'text-accent bg-accent/10' : 'text-muted hover:text-secondary'}`}
              onClick={onToggleArchived}
              title="Show/hide archived tasks"
            >
              &#128451; {archivedCount}
            </button>
          )}
        </div>
      </div>
      <div className="flex flex-col gap-2 p-2 overflow-y-auto flex-1 min-h-0">
        {isBacklog && project && (
          <AddTaskForm project={project} onCreated={onTaskCreated} />
        )}
        {tasks.length === 0 && sortedArchived.length === 0 && !isBacklog ? (
          <div className="text-xs text-muted text-center py-6">No tasks</div>
        ) : (
          <>
            {tasks.map(t => (
              <TaskCard
                key={t.id}
                task={t}
                allTasks={allTasks}
                expanded={expandedParents.has(t.id)}
                onToggleExpand={onToggleExpand}
              />
            ))}
            {sortedArchived.length > 0 && (
              <>
                <hr className="border-border/40 my-1" />
                {sortedArchived.map(t => <ArchivedTaskCard key={t.id} task={t} />)}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default function TasksView() {
  const { state } = useAppState();
  const viewedProject = state?.viewedProject;
  const allTasks = state?.tasks || [];

  const [sortNewestFirst, setSortNewestFirst] = useState(getInitialSort);
  const [showArchived, setShowArchived] = useState(getInitialArchived);
  const [expandedParents, setExpandedParents] = useState(() => {
    // Sync initial state from legacy kanbanState if available
    try { return new Set(window.kanbanState?.expandedParents || []); } catch { return new Set(); }
  });

  const handleToggleSort = useCallback(() => {
    setSortNewestFirst(prev => {
      const next = !prev;
      localStorage.setItem('sortNewestFirst', next);
      // Sync to legacy kanbanState so toggling back to legacy view stays consistent
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
      // Sync to legacy kanbanState
      try { if (window.kanbanState) { window.kanbanState.expandedParents = next; } } catch { /* noop */ }
      return next;
    });
  }, []);

  const { grouped, archivedTopLevel } = useMemo(() => {
    const topLevel = allTasks.filter(t => !t.parentId);
    const groups = {};
    STATUS_KEYS.forEach(s => { groups[s] = []; });
    const archived = [];
    for (const t of topLevel) {
      if (t.status === 'archived') {
        archived.push(t);
      } else if (groups[t.status]) {
        groups[t.status].push(t);
      }
    }
    // Sort each column
    for (const s of STATUS_KEYS) {
      groups[s] = sortTasks(groups[s], sortNewestFirst);
    }
    return { grouped: groups, archivedTopLevel: archived };
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
      <div className="flex items-center justify-center h-full text-muted text-sm" data-react-tasks>
        No tasks
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full" data-react-tasks>
      {/* Control row */}
      <div className="flex items-center justify-end px-3 pt-2 pb-1 gap-2 shrink-0">
        <button
          type="button"
          className="text-xs text-muted hover:text-secondary transition-colors flex items-center gap-1 px-2 py-1 rounded hover:bg-bg-elevated"
          onClick={handleToggleSort}
        >
          <span>{sortNewestFirst ? '↓' : '↑'}</span>
          <span>{sortNewestFirst ? 'Newest first' : 'Oldest first'}</span>
        </button>
      </div>
      {/* Kanban columns */}
      <div className="flex gap-3 px-3 pb-3 flex-1 overflow-x-auto min-h-0">
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
            onTaskCreated={() => {}}
          />
        ))}
      </div>
    </div>
  );
}
