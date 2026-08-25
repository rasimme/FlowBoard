import { AlertTriangle, X } from 'lucide-react';
import { getStuckIndicator, hasStuckAction } from '../utils/workState.js';

/**
 * AttentionWarning — T-452-8. The single, merged attention banner in the
 * DetailPanel header (Zone 1). Before this task there were two banners for
 * one concept: this component (introduced T-452-4, client-computed via
 * computeHealth, dismissed into localStorage) and the older
 * StuckIndicator.jsx (backend-driven from task.stuckIndicator, rendered
 * separately down in Zone 4, since deleted). After a restart both showed at
 * once, saying the same thing twice.
 *
 * Sourced exclusively from task.stuckIndicator via getStuckIndicator() —
 * deliberately no computeHealth() fallback. If this banner could also be
 * produced client-side, the backend's `clear` (below) would not make it
 * disappear: the client would just recompute the same stale/expired signal
 * on the very next render, and the dismiss ("x") would be silently
 * ineffective. Both thresholds already sit at 30 minutes, and the
 * scheduler's detection delay is immaterial for a signal that spans hours
 * to days, not seconds (T-452-8 task description).
 *
 * Facts-only, one dismiss ("x"), no action row — spec, "Der Attention-Alarm
 * bekommt keine Handlungsknöpfe": Waiting/Blocked/Paused already live in the
 * T-452-1 combo chip, and "Retry" is redundant with the scheduler's own
 * reevaluateStuckIndicator — a second path onto the same mutation, so it is
 * not rendered at all here. The "x" invokes the backend-supplied `clear`
 * action descriptor through the caller's `onDismiss` (DetailPanel's
 * handleStuckIndicatorAction / buildStuckIndicatorActionRequest) — never a
 * client-only/localStorage dismiss. Clearing is real server state, shared
 * across devices and visible to agents via /api/status; the scheduler
 * re-raises the indicator on its own schedule if the underlying condition
 * persists, so a clear is a real "not now", not a permanent hide.
 * StuckIndicator.jsx's former doc comment called this "never a
 * client-only dismiss operation" — that guarantee is what this banner now
 * inherits, in the one place it renders.
 *
 * Props:
 *   task      — the task object (passed straight to getStuckIndicator)
 *   project   — authoritative project context for the exact action route;
 *               project-scoped task-list responses do not repeat the
 *               project on the task itself
 *   onDismiss — (indicator) => void, invoked on "x" click; the caller
 *               resolves this to the backend clear descriptor and issues
 *               the POST
 *   busy      — true while a previously-triggered clear request is still
 *               in flight (disables the button, no duplicate submits)
 */

function displayTime(timestamp) {
  if (!timestamp) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString();
}

export default function AttentionWarning({ task, project = null, onDismiss, busy = false }) {
  const indicator = getStuckIndicator(task, project);
  if (!indicator) return null;

  const detectedAt = displayTime(indicator.detectedAt);
  const checkAgainAt = displayTime(indicator.checkAgainAt);
  const canDismiss = hasStuckAction(indicator, 'clear');

  function handleDismiss(e) {
    e.stopPropagation();
    if (busy) return;
    onDismiss?.(indicator);
  }

  return (
    <div
      className="mt-3 rounded-md border border-warn bg-warn-subtle px-3 py-2"
      data-stuck-indicator="true"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2 min-w-0">
          <AlertTriangle size={14} className="text-warn shrink-0 mt-0.5" aria-hidden="true" />
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-wider text-warn font-semibold">
              Needs attention
            </div>
            <div className="text-xs text-text mt-1 break-words">{indicator.message}</div>
            {indicator.reason && indicator.reason !== indicator.message && (
              <div className="text-[11px] text-muted mt-1 break-words">Reason: {indicator.reason}</div>
            )}
            <div className="mt-1 space-y-0.5 text-[11px] text-muted">
              {detectedAt && <div>Detected {detectedAt}</div>}
              {checkAgainAt && <div>Check again at {checkAgainAt}</div>}
            </div>
          </div>
        </div>
        {canDismiss && (
          <button
            type="button"
            data-stuck-action="clear"
            onClick={handleDismiss}
            disabled={busy}
            aria-label="Clear attention indicator"
            title="Clear — reappears automatically if it's still stale"
            className="shrink-0 min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-md text-muted hover:text-text hover:bg-bg-hover border-0 bg-transparent appearance-none outline-none cursor-pointer transition-colors duration-fast disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <X size={13} />
          </button>
        )}
      </div>
    </div>
  );
}
