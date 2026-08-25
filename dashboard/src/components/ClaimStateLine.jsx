import AgentChip from './AgentChip.jsx';
import { computeHealth } from './LeaseIndicator.jsx';
import { isActivelyClaimed } from '../utils/formatting.js';

/**
 * ClaimStateLine — Zone 1 of the DetailPanel.
 *
 * Renders a context-dependent short line describing the task's
 * ownership state and the appropriate CTA button next to it.
 *
 * The full state matrix is specified in the design doc §5:
 *
 *   | Task state                           | line                                  | CTA    |
 *   | Unclaimed, no route                  | "Unclaimed"                           | Claim  |
 *   | Routed unclaimed                     | "Routed to @x"                        | Claim  |
 *   | Claimed by you, healthy              | "Claimed · 23m remaining"             | Release|
 *   | Claimed by you, stale                | "Stale" (warn)                        | Release|
 *   | Claimed by you, expired              | "Lease expired" (warn)                | Release|
 *   | Claimed by other, healthy            | "Claimed by @x · 23m remaining"       | —      |
 *   | Claimed by other, stale              | "@x · Stale" (warn)                   | —      |
 *   | Claimed by other, expired            | "@x · Lease expired" (warn)           | Steal  |
 *
 * T-452-6: expired no longer renders in danger/red. Red is reserved for
 * "something is being lost" — on the board it already means Done and the
 * blocked frame — so lease health carries exactly one attention color.
 * The stale/expired distinction survives in the wording, not the tint.
 *
 * T-452-4: the durations moved out of this line into AttentionWarning,
 * which states them once with the surrounding facts. This line keeps only
 * the bare condition, so it still signals a stale claim after the warning
 * has been snoozed — without repeating "no checkpoint 18m" twice, two
 * lines apart.
 *
 * Done / archived tasks should not render this component at all.
 *
 * Props:
 *   task       — the task object with agent/claimedAt/leaseUntil/routedAgent/lastCheckpointAt
 *   currentAgent — who "you" are (pass `'human'` from the dashboard)
 *   onClaim    — fires when user hits Claim
 *   onRelease  — fires when user hits Release
 *   onSteal    — fires when user hits Steal (lease expired by another)
 */
export default function ClaimStateLine({ task, currentAgent, onClaim, onRelease, onSteal, staleThresholdMinutes }) {
  if (!task) return null;

  // "Currently claimed" requires both agent + claimedAt (HZL-core preserves
  // agent past release as historical attribution, so agent alone is misleading).
  const isClaimed = isActivelyClaimed(task);
  const isSelf = isClaimed && task.agent === currentAgent;
  const health = computeHealth(task, Date.now(), { staleThresholdMinutes }); // 'stale' | 'expired' | null
  const routed = !isClaimed && task.routedAgent;

  let line = 'Unclaimed';
  let tone = 'muted';            // 'muted' | 'warn' | 'danger'
  let action = null;             // { label, onClick, variant }

  if (routed) {
    line = `Routed to ${task.routedAgent}`;
    action = { label: 'Claim', onClick: onClaim, variant: 'accent' };
  } else if (!isClaimed) {
    line = 'Unclaimed';
    action = { label: 'Claim', onClick: onClaim, variant: 'accent' };
  } else if (isSelf) {
    // Self-claim — Release is always the right action.
    if (health === 'expired') {
      line = 'Lease expired';
      tone = 'warn';
    } else if (health === 'stale') {
      line = 'Stale';
      tone = 'warn';
    } else {
      line = `Claimed · ${formatRemaining(task.leaseUntil)}`;
    }
    action = { label: 'Release', onClick: onRelease, variant: 'secondary' };
  } else {
    // Claimed by another agent.
    if (health === 'expired') {
      line = `${task.agent} · Lease expired`;
      tone = 'warn';
      // The Steal CTA stays danger-variant: that is a destructive action on
      // another agent's claim, not a lease-health tint.
      action = { label: 'Steal', onClick: onSteal, variant: 'danger' };
    } else if (health === 'stale') {
      line = `${task.agent} · Stale`;
      tone = 'warn';
    } else {
      line = `Claimed by ${task.agent} · ${formatRemaining(task.leaseUntil)}`;
    }
  }

  const toneClass = tone === 'danger' ? 'text-danger' : tone === 'warn' ? 'text-warn' : 'text-muted';

  return (
    <div className="flex items-center gap-2 min-w-0 flex-1">
      {isClaimed && (
        <AgentChip
          name={task.agent}
          size="md"
          variant="solid"
          title={`Claimed by ${task.agent}${isSelf ? ' (you)' : ''}`}
        />
      )}
      {!isClaimed && routed && (
        <AgentChip
          name={task.routedAgent}
          size="md"
          variant="ring"
          title={`Routed to ${task.routedAgent}`}
        />
      )}
      <span className={`text-xs truncate ${toneClass}`} title={line}>
        {line}
      </span>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className={[
            // Shared resets so the button doesn't render the browser default
            // outline/focus-ring on top of our own styling. Matches what
            // components/Button.jsx does for its themed buttons.
            'shrink-0 inline-flex items-center h-[22px] px-2.5 rounded-full',
            'text-[10px] font-semibold uppercase tracking-wide',
            'border border-transparent cursor-pointer transition-all duration-fast',
            'outline-none focus-visible:shadow-focus-accent',
            action.variant === 'accent'    && 'bg-accent-subtle text-accent border-accent-subtle hover:brightness-125',
            action.variant === 'secondary' && 'bg-secondary text-text border-border hover:bg-bg-hover',
            action.variant === 'danger'    && 'bg-danger-subtle text-danger border-danger-subtle hover:brightness-125',
          ].filter(Boolean).join(' ')}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

function formatRemaining(leaseUntil) {
  if (!leaseUntil) return '';
  const ms = new Date(leaseUntil).getTime() - Date.now();
  if (ms <= 0) return 'lease expired';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m remaining`;
  const h = Math.round(m / 60);
  return `${h}h remaining`;
}

// Exported (T-452-4): AttentionWarning.jsx reuses these two so the "no
// checkpoint" / "expired since" wording stays identical between the
// combo-chip's inline claim line and the new stale-lease warning banner —
// the point of that banner is to make the same fact louder, not to say it
// a second, differently-worded way.
export function formatSince(ts) {
  if (!ts) return '';
  const ms = Date.now() - new Date(ts).getTime();
  const m = Math.max(1, Math.round(ms / 60000));
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

export function formatNoCheckpoint(task) {
  const ts = task.lastCheckpointAt || task.claimedAt;
  if (!ts) return 'no checkpoint';
  const ms = Date.now() - new Date(ts).getTime();
  const m = Math.max(1, Math.round(ms / 60000));
  return `no checkpoint ${m}m`;
}
