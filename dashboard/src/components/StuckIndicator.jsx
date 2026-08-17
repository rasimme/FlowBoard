import { AlertTriangle, RefreshCw, X } from 'lucide-react';
import Badge from './Badge.jsx';
import { getStuckIndicator, hasStuckAction } from '../utils/workState.js';

function displayTime(timestamp) {
  if (!timestamp) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString();
}

/**
 * Render the current transient attention signal. It deliberately has no
 * historical-feed shape and never offers a client-only dismiss operation.
 * Clearing/retrying is delegated to the parent, which may issue only the
 * backend-supplied same-origin POST descriptor and must publish its canonical
 * task response.
 */
export default function StuckIndicator({ task, onAction, busyAction = null }) {
  const indicator = getStuckIndicator(task);
  if (!indicator) return null;

  const checkAgainAt = displayTime(indicator.checkAgainAt);
  const detectedAt = displayTime(indicator.detectedAt);

  async function handleAction(action) {
    if (busyAction) return;
    await onAction?.(action, indicator);
  }

  return (
    <section
      data-stuck-indicator="true"
      className="mb-3 rounded-lg border border-solid border-warn bg-warn-subtle px-3 py-3"
      role="status"
      aria-live="polite"
      aria-labelledby="stuck-indicator-title"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle size={16} className="text-warn shrink-0 mt-0.5" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div id="stuck-indicator-title" className="flex items-center gap-2 text-xs font-semibold text-text-strong">
            Needs attention
            <Badge variant="warning" className="px-1.5 py-0.5 text-[10px]">Live</Badge>
          </div>
          <p className="m-0 mt-1 text-sm text-text break-words">{indicator.message}</p>
          {indicator.reason && indicator.reason !== indicator.message && (
            <p className="m-0 mt-1 text-[11px] text-muted break-words">Reason: {indicator.reason}</p>
          )}
          <div className="mt-2 space-y-0.5 text-[11px] text-muted">
            {detectedAt && <div>Detected {detectedAt}</div>}
            {checkAgainAt && <div>Check again at {checkAgainAt}</div>}
          </div>
          {(hasStuckAction(indicator, 'retry') || hasStuckAction(indicator, 'clear')) && (
            <div className="flex flex-wrap gap-2 mt-3">
              {hasStuckAction(indicator, 'retry') && (
                <button
                  type="button"
                  data-stuck-action="retry"
                  onClick={() => handleAction('retry')}
                  disabled={!!busyAction}
                  className="inline-flex items-center justify-center gap-1.5 min-h-[44px] min-w-[44px] rounded-md border border-solid border-warn bg-transparent px-2.5 text-[11px] font-medium text-text cursor-pointer hover:bg-warn disabled:opacity-50 disabled:cursor-not-allowed"
                  aria-label="Retry attention check"
                >
                  <RefreshCw size={13} aria-hidden="true" />
                  {busyAction === 'retry' ? 'Retrying…' : 'Retry'}
                </button>
              )}
              {hasStuckAction(indicator, 'clear') && (
                <button
                  type="button"
                  data-stuck-action="clear"
                  onClick={() => handleAction('clear')}
                  disabled={!!busyAction}
                  className="inline-flex items-center justify-center gap-1.5 min-h-[44px] min-w-[44px] rounded-md border border-solid border-border bg-transparent px-2.5 text-[11px] font-medium text-muted cursor-pointer hover:bg-bg-hover disabled:opacity-50 disabled:cursor-not-allowed"
                  aria-label="Clear attention indicator"
                >
                  <X size={13} aria-hidden="true" />
                  {busyAction === 'clear' ? 'Clearing…' : 'Clear'}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
