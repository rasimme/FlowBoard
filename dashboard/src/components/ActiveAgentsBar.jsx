import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useAppState } from '../context/AppStateContext.jsx';
import AgentChip from './AgentChip.jsx';
import {
  activeAgentStatusLabel,
  buildActiveAgentRows,
  taskId,
} from '../utils/activeAgents.js';

const STATUS_CLASS = {
  backlog: 'backlog',
  open: 'open',
  'in-progress': 'in-progress',
  review: 'review',
  done: 'done',
};

function formatHandle(agentId) {
  const s = String(agentId || '');
  return s.startsWith('@') ? s : `@${s}`;
}

function popoverId(agentId) {
  return `active-agents-popover-${String(agentId || 'agent').replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

function statusClass(status) {
  return STATUS_CLASS[status] || 'unknown';
}

function taskTitle(task) {
  return String(task?.title || 'Untitled task');
}

function taskProgress(task) {
  const value = task?.progress ?? task?.progressPercent;
  if (value === '' || value == null) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(100, number));
}

function checkpointTimestamp(task) {
  return task?.lastCheckpointAt || task?.lastCheckpoint || task?.checkpointAt || null;
}

function formatCheckpoint(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
}

function StatusDot({ status, label = false }) {
  const text = activeAgentStatusLabel(status);
  return (
    <span className="active-agents-status" title={text}>
      <span
        className={`active-agents-status-dot active-agents-status-dot--${statusClass(status)}`}
        aria-hidden="true"
      />
      {label && <span className="active-agents-status-label">{text}</span>}
    </span>
  );
}

function TaskProgress({ task }) {
  const progress = taskProgress(task);
  if (progress == null) return null;
  return (
    <span className="active-agents-task-progress" title={`${progress}% complete`}>
      <span
        className="active-agents-task-progress__track"
        role="progressbar"
        aria-label={`${progress}% complete`}
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow={progress}
      >
        <span className="active-agents-task-progress__fill" style={{ width: `${progress}%` }} />
      </span>
      <span className="active-agents-task-progress__value">{progress}%</span>
    </span>
  );
}

function ActiveTaskRow({ task, onOpen }) {
  const id = taskId(task);
  const title = taskTitle(task);
  const status = activeAgentStatusLabel(task?.status);
  const checkpoint = checkpointTimestamp(task);
  const checkpointText = formatCheckpoint(checkpoint);
  const aria = `${id || 'Task'}: ${title}. Status: ${status}`
    + (taskProgress(task) == null ? '' : `. Progress: ${taskProgress(task)}%`)
    + (checkpointText ? `. Last checkpoint: ${checkpointText}` : '');

  return (
    <button
      type="button"
      className="active-agents-task-row"
      onClick={() => onOpen(task)}
      aria-label={aria}
      title={aria}
      data-task-id={id || undefined}
    >
      <span className="active-agents-task-row__topline">
        <span className="active-agents-task-row__id mono">{id || '—'}</span>
        <span className="active-agents-task-row__title">{title}</span>
      </span>
      <span className="active-agents-task-row__meta">
        <StatusDot status={task?.status} label />
        <TaskProgress task={task} />
        {checkpointText && (
          <time
            className="active-agents-task-row__checkpoint"
            dateTime={checkpoint}
            title={`Last checkpoint: ${checkpointText}`}
            data-checkpoint={checkpoint}
          >
            checkpoint {checkpointText}
          </time>
        )}
      </span>
    </button>
  );
}

function AgentAvatar({ agentId }) {
  return (
    <span aria-hidden="true" className="active-agents-pill__avatar">
      <AgentChip name={agentId} size="sm" />
    </span>
  );
}

function ActiveAgentPill({
  agentId,
  claims,
  open,
  onToggle,
  onOpenTask,
  triggerRef,
  popoverRef,
}) {
  const handle = formatHandle(agentId);
  const multi = claims.length > 1;
  const task = claims[0] || null;
  const id = popoverId(agentId);

  const singleLabel = task
    ? `${handle}, ${taskId(task) || 'task'}: ${taskTitle(task)}`
    : handle;
  const multiLabel = `${handle}, ${claims.length} active tasks`;

  if (!claims.length) {
    return (
      <span className="active-agents-pill active-agents-pill--idle" title={handle}>
        <AgentAvatar agentId={agentId} />
        <span className="active-agents-pill__meta">
          <span className="active-agents-pill__name">{handle}</span>
          <span className="active-agents-pill__task active-agents-pill__task--idle">No active task</span>
        </span>
      </span>
    );
  }

  return (
    <div className="active-agents-pill-wrap">
      <button
        ref={triggerRef}
        type="button"
        className={`active-agents-pill active-agents-pill--trigger${multi ? ' active-agents-pill--multi' : ' active-agents-pill--single'}`}
        onClick={() => {
          if (!multi) {
            onOpenTask(task);
            return;
          }
          onToggle(agentId);
        }}
        onKeyDown={(event) => {
          if (multi && event.key === 'ArrowDown') {
            event.preventDefault();
            onToggle(agentId, true);
          }
        }}
        aria-label={multi ? multiLabel : singleLabel}
        aria-haspopup={multi ? 'dialog' : undefined}
        aria-expanded={multi ? open : undefined}
        aria-controls={multi ? id : undefined}
        title={singleLabel}
        data-agent-id={agentId}
      >
        <AgentAvatar agentId={agentId} />
        <span className="active-agents-pill__meta">
          <span className="active-agents-pill__name">{handle}</span>
          {!multi && (
            <span className="active-agents-pill__task" title={taskTitle(task)}>
              {taskTitle(task)}
            </span>
          )}
        </span>
        <StatusDot status={multi ? 'in-progress' : task?.status} />
        {multi && (
          <>
            <span className="active-agents-pill__count">{claims.length}</span>
            <ChevronDown className="active-agents-pill__caret" size={13} aria-hidden="true" />
          </>
        )}
      </button>

      {multi && open && (
        <div
          ref={popoverRef}
          id={id}
          className="active-agents-popover"
          role="dialog"
          aria-labelledby={`${id}-title`}
        >
          <div className="active-agents-popover__header">
            <span id={`${id}-title`}>Active tasks · {claims.length}</span>
          </div>
          <div className="active-agents-popover__list">
            {claims.map((claim) => (
              <ActiveTaskRow key={taskId(claim) || `${agentId}-${claims.indexOf(claim)}`} task={claim} onOpen={onOpenTask} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * T-446: project-local active claims, grouped by agent slug.
 *
 * Agents without a claim remain visible when their /api/agents row says they
 * are active on this project. Claims are always rendered from the task
 * payload, so a second claim for one slug cannot overwrite the first one.
 */
export default function ActiveAgentsBar() {
  const { state } = useAppState();
  const viewedProject = state?.viewedProject;
  const agents = state?.agents || [];
  const tasks = state?.tasks || [];
  const [now, setNow] = useState(() => Date.now());
  const [openAgentId, setOpenAgentId] = useState(null);
  const triggerRefs = useRef(new Map());
  const firstTaskRefs = useRef(new Map());
  const focusFirstRef = useRef(null);

  // A lease can expire between dashboard snapshots. Re-evaluate cheaply so an
  // expired claim cannot stay visible until an unrelated state change.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(timer);
  }, []);

  const rows = useMemo(() => buildActiveAgentRows({ agents, tasks, viewedProject, now }), [agents, tasks, viewedProject, now]);
  const openRow = rows.find((row) => row.agentId === openAgentId);

  const restoreTriggerFocus = useCallback((agentId) => {
    triggerRefs.current.get(agentId)?.focus?.();
  }, []);

  const closePopover = useCallback((restoreFocus = true) => {
    const closing = openAgentId;
    setOpenAgentId(null);
    if (restoreFocus && closing) restoreTriggerFocus(closing);
  }, [openAgentId, restoreTriggerFocus]);

  const togglePopover = useCallback((agentId, focusFirst = false) => {
    if (openAgentId === agentId) {
      closePopover(true);
      return;
    }
    focusFirstRef.current = focusFirst ? agentId : null;
    setOpenAgentId(agentId);
  }, [closePopover, openAgentId]);

  const openTask = useCallback((task) => {
    closePopover(false);
    const id = taskId(task);
    if (id && window.openTaskDetail) window.openTaskDetail(id);
  }, [closePopover]);

  useLayoutEffect(() => {
    const focusAgent = focusFirstRef.current;
    if (!focusAgent || focusAgent !== openAgentId) return;
    focusFirstRef.current = null;
    firstTaskRefs.current.get(focusAgent)?.querySelector('button')?.focus?.();
  }, [openAgentId, rows]);

  // If a lease disappears while its list is open, close cleanly and restore
  // focus when the trigger still exists (it may have become a single-claim
  // button). If the owner vanished entirely, there is no unsafe focus target.
  useEffect(() => {
    if (!openAgentId) return;
    if (openRow && openRow.claims.length > 1) return;
    closePopover(true);
  }, [closePopover, openAgentId, openRow]);

  useEffect(() => {
    if (!openAgentId) return undefined;
    const onEscape = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closePopover(true);
    };
    const onPointerDown = (event) => {
      const target = event.target;
      const trigger = triggerRefs.current.get(openAgentId);
      const popover = firstTaskRefs.current.get(openAgentId);
      if (!trigger?.contains(target) && !popover?.contains(target)) closePopover(false);
    };
    document.addEventListener('keydown', onEscape);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onEscape);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [closePopover, openAgentId]);

  if (!viewedProject || rows.length === 0) return null;

  return (
    <div className="active-agents-bar" role="region" aria-label="Agents active on this project">
      <div className="active-agents-bar__label">Active on this project</div>
      <div className="active-agents-bar__list">
        {rows.map(({ agentId, claims }) => (
          <ActiveAgentPill
            key={agentId}
            agentId={agentId}
            claims={claims}
            open={openAgentId === agentId}
            onToggle={togglePopover}
            onOpenTask={openTask}
            triggerRef={(element) => {
              if (element) triggerRefs.current.set(agentId, element);
              else triggerRefs.current.delete(agentId);
            }}
            popoverRef={(element) => {
              if (element) firstTaskRefs.current.set(agentId, element);
              else firstTaskRefs.current.delete(agentId);
            }}
          />
        ))}
      </div>
    </div>
  );
}
