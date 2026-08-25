import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { createPortal } from 'react-dom';
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

function ActiveTaskRow({ task, onOpen }) {
  const id = taskId(task);
  const title = taskTitle(task);
  const status = activeAgentStatusLabel(task?.status);
  const checkpoint = checkpointTimestamp(task);
  const checkpointText = formatCheckpoint(checkpoint);
  const aria = `${id || 'Task'}: ${title}. Status: ${status}`
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
  popoverPosition,
}) {
  const handle = formatHandle(agentId);
  const single = claims.length === 1;
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
          // The aggregation model deliberately keeps lease health separate
          // from claim visibility. A single visible claim always has a
          // deterministic destination, even when its lease is stale/expired.
          if (single) {
            onOpenTask(task);
            return;
          }
          if (multi) onToggle(agentId);
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
        data-claim-count={claims.length}
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

      {multi && open && typeof document !== 'undefined' && createPortal(
        <div
          ref={popoverRef}
          id={id}
          className="active-agents-popover"
          role="dialog"
          aria-labelledby={`${id}-title`}
          style={{
            ...(popoverPosition || {}),
            visibility: popoverPosition ? 'visible' : 'hidden',
          }}
        >
          <div className="active-agents-popover__header">
            <h2 id={`${id}-title`}>Active tasks · {claims.length}</h2>
          </div>
          <ul
            className="active-agents-popover__list"
            aria-label={`${handle} active tasks`}
          >
            {claims.map((claim, index) => (
              <li key={taskId(claim) || `${agentId}-${index}`}>
                <ActiveTaskRow task={claim} onOpen={onOpenTask} />
              </li>
            ))}
          </ul>
        </div>,
        document.body,
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
  const staleThresholdMinutes = state?.staleThresholdMinutes;
  const [now, setNow] = useState(() => Date.now());
  const [openAgentId, setOpenAgentId] = useState(null);
  const [popoverPosition, setPopoverPosition] = useState(null);
  const triggerRefs = useRef(new Map());
  const popoverRefs = useRef(new Map());
  const focusFirstRef = useRef(null);
  const pendingFocusRef = useRef(null);
  const barRef = useRef(null);

  // A lease can expire between dashboard snapshots. Re-evaluate cheaply so an
  // expired claim cannot stay visible until an unrelated state change.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(timer);
  }, []);

  const rows = useMemo(() => buildActiveAgentRows({
    agents,
    tasks,
    viewedProject,
    now,
    staleThresholdMinutes,
  }), [agents, tasks, viewedProject, now, staleThresholdMinutes]);
  const openRow = rows.find((row) => row.agentId === openAgentId);

  const focusSurvivingControl = useCallback((closingAgentId) => {
    const trigger = triggerRefs.current.get(closingAgentId);
    if (trigger?.isConnected) {
      trigger.focus();
      return;
    }

    const survivingRow = rows.find(({ agentId, claims }) => (
      agentId !== closingAgentId && claims.length > 0
    ));
    const survivingTrigger = survivingRow && triggerRefs.current.get(survivingRow.agentId);
    if (survivingTrigger?.isConnected) {
      survivingTrigger.focus();
      return;
    }

    if (barRef.current?.isConnected) {
      barRef.current.focus();
      return;
    }

    // The bar itself can disappear when the last claim expires. Keep focus in
    // the task surface instead of falling back to body/document.
    const nearbyTaskControl = document.querySelector(
      '.content [data-react-tasks][tabindex]:not([tabindex="-1"]), '
      + '.content [data-task-id][tabindex]:not([tabindex="-1"]), '
      + '#tabBar .tab[data-tab="tasks"]',
    );
    nearbyTaskControl?.focus?.();
  }, [rows]);

  const closePopover = useCallback((restoreFocus = true) => {
    const closing = openAgentId;
    setOpenAgentId(null);
    setPopoverPosition(null);
    if (restoreFocus && closing) pendingFocusRef.current = closing;
  }, [openAgentId]);

  const togglePopover = useCallback((agentId, focusFirst = false) => {
    if (openAgentId === agentId) {
      closePopover(true);
      return;
    }
    focusFirstRef.current = focusFirst ? agentId : null;
    setPopoverPosition(null);
    setOpenAgentId(agentId);
  }, [closePopover, openAgentId]);

  const openTask = useCallback((task) => {
    closePopover(false);
    const id = taskId(task);
    if (id && window.openTaskDetail) window.openTaskDetail(id);
  }, [closePopover]);

  useEffect(() => {
    const focusAgent = focusFirstRef.current;
    if (!focusAgent || focusAgent !== openAgentId) return;
    focusFirstRef.current = null;
    const frame = window.requestAnimationFrame(() => {
      popoverRefs.current.get(focusAgent)?.querySelector('button')?.focus?.();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [openAgentId, rows]);

  // The trigger may be gone by the time a lease/reassignment update closes
  // the popover. Wait for the closing render so the fallback cannot target a
  // detached element and leave focus on body.
  useLayoutEffect(() => {
    const closingAgentId = pendingFocusRef.current;
    if (!closingAgentId || openAgentId) return;
    pendingFocusRef.current = null;
    focusSurvivingControl(closingAgentId);
  }, [focusSurvivingControl, openAgentId, rows]);

  const updatePopoverPosition = useCallback(() => {
    if (!openAgentId) return;
    const trigger = triggerRefs.current.get(openAgentId);
    const popover = popoverRefs.current.get(openAgentId);
    if (!trigger || !popover) return;

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const gap = 12;
    const offset = 8;
    const triggerRect = trigger.getBoundingClientRect();
    const measured = popover.getBoundingClientRect();
    const width = Math.min(measured.width || 360, Math.max(0, viewportWidth - (gap * 2)));
    const height = Math.min(measured.height || 0, Math.max(0, viewportHeight - (gap * 2)));
    const belowSpace = viewportHeight - triggerRect.bottom - offset - gap;
    const aboveSpace = triggerRect.top - offset - gap;
    const placeAbove = measured.height > belowSpace && aboveSpace > belowSpace;
    const requestedTop = placeAbove
      ? triggerRect.top - offset - height
      : triggerRect.bottom + offset;
    const maxTop = Math.max(gap, viewportHeight - height - gap);
    const left = Math.min(
      Math.max(gap, triggerRect.left),
      Math.max(gap, viewportWidth - width - gap),
    );
    const top = Math.min(Math.max(gap, requestedTop), maxTop);
    const next = {
      left: `${left}px`,
      top: `${top}px`,
      width: `${width}px`,
      maxHeight: `${Math.max(0, viewportHeight - (gap * 2))}px`,
    };
    setPopoverPosition((previous) => (
      previous && Object.keys(next).every((key) => previous[key] === next[key])
        ? previous
        : next
    ));
  }, [openAgentId]);

  useLayoutEffect(() => {
    if (!openAgentId) return undefined;
    updatePopoverPosition();
    let frame = window.requestAnimationFrame(updatePopoverPosition);
    const onViewportChange = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(updatePopoverPosition);
    };
    window.addEventListener('resize', onViewportChange);
    document.addEventListener('scroll', onViewportChange, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', onViewportChange);
      document.removeEventListener('scroll', onViewportChange, true);
    };
  }, [openAgentId, rows, updatePopoverPosition]);

  // If a lease disappears while its list is open, close cleanly and restore
  // focus when the trigger still exists (it may have become a single-claim
  // button). If the owner vanished entirely, focusSurvivingControl chooses a
  // sibling pill, the bar, or a nearby task control.
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
      const popover = popoverRefs.current.get(openAgentId);
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
    <div
      ref={barRef}
      className="active-agents-bar"
      role="region"
      aria-label="Agents active on this project"
      tabIndex={-1}
    >
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
            popoverPosition={openAgentId === agentId ? popoverPosition : null}
            triggerRef={(element) => {
              if (element) triggerRefs.current.set(agentId, element);
              else triggerRefs.current.delete(agentId);
            }}
            popoverRef={(element) => {
              if (element) popoverRefs.current.set(agentId, element);
              else popoverRefs.current.delete(agentId);
            }}
          />
        ))}
      </div>
    </div>
  );
}
