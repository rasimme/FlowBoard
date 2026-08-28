import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useAppState } from '../context/AppStateContext.jsx';
import AgentChip from './AgentChip.jsx';
import {
  activeAgentLeaseHealthLabel,
  activeAgentStatusLabel,
  activeAgentTaskProgress,
  buildActiveAgentRows,
  getLeaseHealth,
  taskId,
} from '../utils/activeAgents.js';

function formatHandle(agentId) {
  const s = String(agentId || '');
  return s.startsWith('@') ? s : `@${s}`;
}

function popoverId(agentId) {
  return `active-agents-popover-${String(agentId || 'agent').replace(/[^a-zA-Z0-9_-]/g, '-')}`;
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

// Relative "Xm/h/d ago" for the popover row's time column (T-453). The row's
// title/aria-label carries the exact timestamp via formatCheckpoint above,
// so this stays a coarse, always-short label — never wraps, never truncates.
function formatRelativeTime(value, now = Date.now()) {
  if (!value) return '';
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return '';
  const diffMs = Math.max(0, now - ts);
  const m = Math.round(diffMs / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

/**
 * Lease health visual, shared by the pill (aggregate, dot-only) and every
 * popover row (per-claim, dot + word + mini progress bar). `showLabel` and
 * `showProgress` are independent because the pill never shows either, while
 * the popover row always shows both — this is the single place lease-health
 * color lives (`.active-agents-health--{current|stale|expired}` in
 * dashboard.css), so a row's progress fill automatically matches its dot.
 */
function LeaseHealthIndicator({ health, showLabel = false, showProgress = false, progress = 0 }) {
  if (!health) return null;
  const text = activeAgentLeaseHealthLabel(health);
  const rowMetaClass = showProgress ? ' active-agents-task-row__meta' : '';
  return (
    <span
      className={`active-agents-health active-agents-health--${health}${rowMetaClass}`}
      title={`Lease health: ${text}`}
      data-lease-health={health}
    >
      <span
        className="active-agents-health__dot"
        aria-hidden="true"
      />
      {showLabel && <span className="active-agents-health__label">{text}</span>}
      {showProgress && (
        <span className="active-agents-task-row__progress" aria-hidden="true">
          <span
            className="active-agents-task-row__progress-fill"
            style={{ width: `${progress}%` }}
          />
        </span>
      )}
    </span>
  );
}

function ActiveTaskRow({ task, onOpen, now, staleThresholdMinutes }) {
  const id = taskId(task);
  const title = taskTitle(task);
  const lifecycleStatus = activeAgentStatusLabel(task?.status);
  const health = getLeaseHealth(task, now, { staleThresholdMinutes });
  const healthLabel = activeAgentLeaseHealthLabel(health);
  const progress = activeAgentTaskProgress(task);
  const checkpoint = checkpointTimestamp(task);
  const checkpointText = formatCheckpoint(checkpoint);
  const timeSource = checkpoint || task?.claimedAt || null;
  const relativeText = formatRelativeTime(timeSource, now);
  const aria = `${id || 'Task'}: ${title}. Status: ${lifecycleStatus}. Lease health: ${healthLabel}.`
    + (checkpointText ? ` Last checkpoint: ${checkpointText}.` : '');

  return (
    <button
      type="button"
      className="active-agents-task-row"
      onClick={() => onOpen(task)}
      aria-label={aria}
      title={aria}
      data-task-id={id || undefined}
      data-lease-health={health || undefined}
    >
      <span className="active-agents-task-row__id">{id || '—'}</span>
      <span className="active-agents-task-row__body">
        <span className="active-agents-task-row__title">{title}</span>
        <LeaseHealthIndicator health={health} showLabel showProgress progress={progress} />
      </span>
      <span
        className="active-agents-task-row__checkpoint"
        data-checkpoint={checkpoint || undefined}
      >
        {relativeText}
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

function ActiveAgentMeasurePill({ agentId, claims, leaseHealth }) {
  const task = claims[0] || null;
  const multi = claims.length > 1;
  return (
    <span className={`active-agents-pill${multi ? ' active-agents-pill--multi' : ''}`} aria-hidden="true">
      <AgentAvatar agentId={agentId} />
      <span className="active-agents-pill__meta">
        <span className="active-agents-pill__name">{formatHandle(agentId)}</span>
        {!multi && task && <span className="active-agents-pill__task">{taskTitle(task)}</span>}
        {!claims.length && <span className="active-agents-pill__task active-agents-pill__task--idle">No active task</span>}
      </span>
      <LeaseHealthIndicator health={leaseHealth} />
      {multi && <span className="active-agents-pill__count">{claims.length} tasks</span>}
    </span>
  );
}

function ActiveAgentPill({
  agentId,
  claims,
  leaseHealth,
  open,
  onToggle,
  onOpenTask,
  triggerRef,
  popoverRef,
  popoverPosition,
  now,
  staleThresholdMinutes,
}) {
  const handle = formatHandle(agentId);
  const single = claims.length === 1;
  const multi = claims.length > 1;
  const task = claims[0] || null;
  const id = popoverId(agentId);
  const healthLabel = activeAgentLeaseHealthLabel(leaseHealth);

  const singleLabel = task
    ? `${handle}, ${taskId(task) || 'task'}: ${taskTitle(task)}. Lease health: ${healthLabel}`
    : handle;
  const multiLabel = `${handle}, ${claims.length} active tasks. Lease health: ${healthLabel}`;

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
        data-lease-health={leaseHealth || undefined}
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
        <LeaseHealthIndicator health={leaseHealth} />
        {multi && (
          <>
            <span className="active-agents-pill__count">{claims.length} tasks</span>
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
                <ActiveTaskRow
                  task={claim}
                  onOpen={onOpenTask}
                  now={now}
                  staleThresholdMinutes={staleThresholdMinutes}
                />
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
  const listRef = useRef(null);
  const measureRef = useRef(null);

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
  const [visibleCount, setVisibleCount] = useState(rows.length);
  const [overflowOpen, setOverflowOpen] = useState(false);
  useLayoutEffect(() => {
    const list = listRef.current;
    const measureList = measureRef.current;
    if (!list || !measureList) return undefined;
    const measure = () => {
      const items = [...measureList.querySelectorAll(':scope > .active-agents-pill-wrap')];
      if (!items.length) return;
      const tops = [...new Set(items.map((item) => item.offsetTop))].sort((a, b) => a - b);
      // Preserve two visual rows; a hidden full copy prevents feedback from
      // the overflow cutoff changing the dimensions being measured.
      const cutoff = tops[2] == null ? Infinity : tops[2];
      const count = items.filter((item) => item.offsetTop < cutoff).length;
      setVisibleCount((previous) => previous === count ? previous : count);
    };
    measure();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    observer?.observe(list);
    return () => observer?.disconnect();
  }, [rows]);
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
    const width = Math.min(measured.width || 300, Math.max(0, viewportWidth - (gap * 2)));
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
      <div ref={listRef} className="active-agents-bar__list">
        <div ref={measureRef} className="active-agents-bar__measure" aria-hidden="true">
          {rows.map(({ agentId, claims, leaseHealth }) => (
            <div key={agentId} className="active-agents-pill-wrap">
              <ActiveAgentMeasurePill agentId={agentId} claims={claims} leaseHealth={leaseHealth} />
            </div>
          ))}
        </div>
        <div className="active-agents-bar__visible">
          {rows.map(({ agentId, claims, leaseHealth }, index) => (
            <div key={agentId} className="active-agents-pill-wrap" hidden={index >= visibleCount}>
              <ActiveAgentPill
                agentId={agentId}
                claims={claims}
                leaseHealth={leaseHealth}
                open={openAgentId === agentId}
                onToggle={togglePopover}
                onOpenTask={openTask}
                popoverPosition={openAgentId === agentId ? popoverPosition : null}
                now={now}
                staleThresholdMinutes={staleThresholdMinutes}
                triggerRef={(element) => {
                  if (element) triggerRefs.current.set(agentId, element);
                  else triggerRefs.current.delete(agentId);
                }}
                popoverRef={(element) => {
                  if (element) popoverRefs.current.set(agentId, element);
                  else popoverRefs.current.delete(agentId);
                }}
              />
            </div>
          ))}
          {visibleCount < rows.length && (
            <div className="active-agents-overflow-wrap">
              <button type="button" className="active-agents-overflow" aria-expanded={overflowOpen} aria-haspopup="dialog" onClick={() => setOverflowOpen((open) => !open)} aria-label={`Show ${rows.length - visibleCount} more active agents`} title="Show all active agents">
                +{rows.length - visibleCount} more
              </button>
              {overflowOpen && (
                <div className="active-agents-overflow-popover" role="dialog" aria-label="All active agents">
                  {rows.map(({ agentId, claims, leaseHealth }) => (
                    <div key={agentId} className="active-agents-overflow-popover__row" title={`${formatHandle(agentId)} · ${activeAgentLeaseHealthLabel(leaseHealth)}`}>
                      <span>{formatHandle(agentId)}</span><span>{claims.length ? `${claims.length} active task${claims.length === 1 ? '' : 's'}` : 'No active task'}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
