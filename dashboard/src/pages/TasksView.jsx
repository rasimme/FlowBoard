import { useMemo } from 'react';
import { useAppState } from '../context/AppStateContext.jsx';
import { Badge } from '../components/index.js';

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

function TaskCard({ task }) {
  const handleClick = () => {
    if (window.openTaskDetail) window.openTaskDetail(task.id);
  };

  return (
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
      {task.priority && (
        <Badge variant={PRIORITY_VARIANT[task.priority] || 'default'}>
          {task.priority}
        </Badge>
      )}
    </button>
  );
}

function Column({ status, tasks }) {
  return (
    <div className="flex flex-col min-w-[260px] max-w-[320px] flex-1 bg-bg-surface rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border">
        <span className="text-xs font-semibold text-secondary uppercase tracking-wide">
          {STATUS_LABELS[status]}
        </span>
        <span className="text-[11px] text-muted bg-bg-elevated rounded-full px-2 py-0.5 font-mono">
          {tasks.length}
        </span>
      </div>
      <div className="flex flex-col gap-2 p-2 overflow-y-auto flex-1 min-h-0">
        {tasks.length === 0 ? (
          <div className="text-xs text-muted text-center py-6">No tasks</div>
        ) : (
          tasks.map(t => <TaskCard key={t.id} task={t} />)
        )}
      </div>
    </div>
  );
}

export default function TasksView() {
  const { state } = useAppState();
  const viewedProject = state?.viewedProject;
  const allTasks = state?.tasks || [];

  const grouped = useMemo(() => {
    const topLevel = allTasks.filter(t => !t.parentId && t.status !== 'archived');
    const groups = {};
    STATUS_KEYS.forEach(s => { groups[s] = []; });
    for (const t of topLevel) {
      if (groups[t.status]) groups[t.status].push(t);
    }
    // Sort newest first by default (higher T-id = newer)
    for (const s of STATUS_KEYS) {
      groups[s].sort((a, b) => {
        const idA = parseInt(a.id.replace('T-', ''));
        const idB = parseInt(b.id.replace('T-', ''));
        return idB - idA;
      });
    }
    return groups;
  }, [allTasks]);

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
    <div className="flex gap-3 p-3 h-full overflow-x-auto" data-react-tasks>
      {STATUS_KEYS.map(status => (
        <Column key={status} status={status} tasks={grouped[status]} />
      ))}
    </div>
  );
}
