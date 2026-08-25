import { ChevronDown, Hourglass, Ban, PauseCircle } from 'lucide-react';

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
 * T-452-2 TODO / seam: `onClick` currently opens the legacy WorkStatePicker
 * inline as an interim measure (see DetailPanel's `workStateEditorOpen`
 * toggle). Replace this whole trigger with the shared headerPopover +
 * Popover.jsx pattern already used for Status/Priority (DetailPanel.jsx
 * `openHeaderPopover`/`closeHeaderPopover`) and drop the toggle.
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
      aria-label={`Work state: ${label}. Change work state`}
      title={`Work state: ${label}`}
      className="inline-flex items-center gap-1 px-2 py-[3px] text-[11px] font-medium text-text bg-transparent border-0 appearance-none cursor-pointer outline-none hover:bg-bg-hover transition-colors duration-fast"
    >
      <Icon size={11} />
      <span>{label}</span>
    </button>
  );
}
