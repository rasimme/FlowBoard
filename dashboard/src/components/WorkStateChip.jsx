import { ChevronDown, Hourglass, Ban, PauseCircle, AlertTriangle } from 'lucide-react';
import { computeHealth } from './LeaseIndicator.jsx';
import { normalizeTaskWorkState } from '../utils/workState.js';

/**
 * WorkStateChip — the "state half" of the DetailPanel's agent+workstate
 * combo chip (T-452-1, spec T-452-workstate-im-ui-vereinfachen-kombi-chip.md).
 *
 * Binding rule: `working`/Active is invisible — no chip, no label, no color
 * (spec "Verbindliche Entscheidungen"). When the task's canonical workState
 * is `working` this renders only a bare, muted chevron: no per-state icon,
 * no text, no tint — so it never reads as a state label, but the state
 * picker stays reachable (T-452-1 "Der Zustand darf nicht unsetzbar
 * werden"). For waiting/blocked/paused it renders the state icon + English
 * label (`Waiting` / `Blocked` / `Paused`).
 *
 * `onClick` is wired by DetailPanel to `openHeaderPopover(e, 'workState')`
 * (T-452-2), the same headerPopover + Popover.jsx mechanism already used for
 * Status/Priority — see WorkStatePopover.jsx for the popover content.
 */
const WORK_STATE_ICONS = {
  waiting: Hourglass,
  blocked: Ban,
  paused: PauseCircle,
};

const WORK_STATE_LABELS = {
  waiting: 'Waiting',
  blocked: 'Blocked',
  paused: 'Paused',
};

export default function WorkStateChip({ workState, onClick }) {
  const isActive = !workState || workState === 'working';

  if (isActive) {
    return (
      <button
        type="button"
        onClick={onClick}
        data-work-state-trigger="true"
        aria-label="Change work state"
        title="Change work state"
        className="inline-flex items-center justify-center px-1.5 self-stretch text-muted bg-transparent border-0 appearance-none cursor-pointer outline-none hover:text-text hover:bg-bg-hover transition-colors duration-fast"
      >
        <ChevronDown size={11} />
      </button>
    );
  }

  const Icon = WORK_STATE_ICONS[workState] || Hourglass;
  const label = WORK_STATE_LABELS[workState] || workState;

  return (
    <button
      type="button"
      onClick={onClick}
      data-work-state-trigger="true"
      aria-label={`Work state: ${label}. Change work state`}
      title={`Work state: ${label}`}
      className="inline-flex items-center gap-1 px-2 py-[3px] text-[11px] font-medium text-text bg-transparent border-0 appearance-none cursor-pointer outline-none hover:bg-bg-hover transition-colors duration-fast"
    >
      <Icon size={11} />
      <span>{label}</span>
    </button>
  );
}

/**
 * silentDurationText — "45m silent" / "4h silent" / "2d silent", the growing
 * unit the card uses for a stale-or-expired claim (T-452-5, spec "Stale-Text:
 * 2d silent, Einheit mitwachsend"). Deliberately distinct from
 * ClaimStateLine's formatNoCheckpoint()/formatSince(): those verbs
 * ("no checkpoint" / "expired") still carry the stale-vs-expired split, and
 * neither scales past hours. The card renders exactly one amber signal for
 * both severities (spec "Ein Attention-Zustand: visuell, nicht semantisch"),
 * so it needs one wording that also reads sensibly after a task has sat
 * silent for days.
 */
function silentDurationText(task, now = Date.now()) {
  const ts = task?.lastCheckpointAt || task?.claimedAt;
  if (!ts) return null;
  const ms = now - new Date(ts).getTime();
  if (!Number.isFinite(ms)) return null;
  const m = Math.max(1, Math.round(ms / 60000));
  if (m < 60) return `${m}m silent`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h silent`;
  const d = Math.round(h / 24);
  return `${d}d silent`;
}

/**
 * TaskCardStateChip — T-452-5's card-side state half of the agent+workstate
 * combo chip. Sits in TasksView's `.task-meta` row right after the agent
 * avatar; unlike the panel's WorkStateChip above, it is pure display (no
 * onClick) — the card as a whole already opens the detail panel, and a
 * card-level state popover is out of scope here (only T-452-2's panel one
 * exists). Callers render it unconditionally right after the AgentChip:
 *
 *   {task.agent && (
 *     <span className="inline-flex items-center gap-1">
 *       <AgentChip .../>
 *       <TaskCardStateChip task={task} staleThresholdMinutes={...} />
 *     </span>
 *   )}
 *
 * It renders its own leading divider + content, or null, so the caller
 * never has to know in advance whether there is a state half to show.
 *
 * Precedence: a stale/expired claim (T-452-6 collapses both to one amber
 * signal — see LeaseIndicator.jsx) always wins over the workState word. A
 * task can be simultaneously `waiting` and silent, and only one state half
 * fits in this row; "must I intervene" outranks "what is it doing" in the
 * spec's mental model. `working` with a healthy claim contributes nothing
 * on its own — Active is invisible by spec.
 *
 * No detail text ever appears here (spec "Kein Detail auf der Karte" —
 * `waitingFor`/`reason` are free-form user text of unbounded length that
 * would blow out this narrow row). The detail lives in the `title`
 * attribute instead, which costs no width.
 */
export function TaskCardStateChip({ task, staleThresholdMinutes }) {
  if (!task) return null;

  const health = computeHealth(task, Date.now(), { staleThresholdMinutes }); // 'stale' | 'expired' | null
  const normalized = normalizeTaskWorkState(task);
  const workState = normalized.workState;

  if (!health && workState === 'working') return null;

  const divider = <span className="w-px self-stretch bg-border" aria-hidden="true" />;

  if (health) {
    // Same text for 'stale' and 'expired' on purpose — see module comment:
    // a second wording would smuggle the two-tier distinction back in.
    const silent = silentDurationText(task) || 'silent';
    return (
      <>
        {divider}
        <span
          className="inline-flex items-center gap-1 text-[11px] font-medium text-warn"
          title="No recent claim activity — human attention needed"
        >
          <AlertTriangle size={11} />
          <span>{silent}</span>
        </span>
      </>
    );
  }

  const Icon = WORK_STATE_ICONS[workState] || Hourglass;
  const label = WORK_STATE_LABELS[workState] || workState;
  const detail = workState === 'waiting'
    ? normalized.workStateDetails?.waitingFor
    : normalized.workStateDetails?.reason;

  return (
    <>
      {divider}
      <span
        className="inline-flex items-center gap-1 text-[11px] font-medium text-text"
        title={detail ? `${label}: ${detail}` : `Work state: ${label}`}
      >
        <Icon size={11} />
        <span>{label}</span>
      </span>
    </>
  );
}
