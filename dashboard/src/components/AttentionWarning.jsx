import { useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { formatNoCheckpoint, formatSince } from './ClaimStateLine.jsx';

/**
 * AttentionWarning — T-452-4. Facts-only amber banner in the DetailPanel
 * header (same area as the exceptionReview block, which is its visual
 * template) for a claimed task whose lease is stale or expired.
 *
 * Spec (T-452-workstate-im-ui-vereinfachen-kombi-chip.md, "Der
 * Attention-Alarm bekommt keine Handlungsknöpfe"): no action buttons at
 * all. Waiting/Blocked/Paused already live in the T-452-1 combo chip,
 * Steal already lives in ClaimStateLine's agent half, and "let it keep
 * working" would mean a human faking a checkpoint in the agent's name —
 * which poisons the very staleness signal this banner is reporting. So
 * this renders only the facts plus a dismiss ("x").
 *
 * T-452-6 already collapsed stale/expired into one visual amber signal
 * (see LeaseIndicator.jsx); this banner keeps the textual distinction
 * (only the color collapsed, not the words) since knowing "stale" vs
 * "expired since Xm" is itself one of the facts being reported.
 *
 * Dismiss ("x") snooze: THERE IS NO BACKEND FIELD FOR THIS. The backend
 * owns `task.stuckIndicator` / getNotifiableStuckTasks() (hzl-service.js)
 * for its own, separately-rendered attention signal (see
 * StuckIndicator.jsx) — that lane is out of scope here and untouched.
 * This banner's dismiss state is client-only, kept in
 * localStorage["flowboard.attentionWarningSnooze"] as
 * `{ [taskId]: expiresAtEpochMs }`, and expires after a fixed 60-minute
 * window — the same default window getNotifiableStuckTasks() uses to
 * throttle its own repeats (hzl-service.js). It deliberately expires by
 * wall-clock time rather than being deleted-on-dismiss: the underlying
 * staleness persists and would otherwise never resurface, which would
 * make a genuinely dead task invisible instead of just quiet for a while.
 *
 * Props:
 *   task     — the task object (agent/lastCheckpointAt/leaseUntil/id)
 *   health   — 'stale' | 'expired' | null, precomputed by the caller via
 *              LeaseIndicator.jsx's computeHealth() so DetailPanel only
 *              has one staleThresholdMinutes call site per consumer
 *              (see test-t448-1-lease-threshold.mjs)
 *   progress — the same 0-100 value already shown in the Progress bar
 */

const SNOOZE_STORAGE_KEY = 'flowboard.attentionWarningSnooze';
const SNOOZE_WINDOW_MS = 60 * 60 * 1000; // 60 minutes

function readSnoozeMap() {
  try {
    const raw = window.localStorage.getItem(SNOOZE_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch {
    return {};
  }
}

function writeSnoozeMap(map) {
  try {
    window.localStorage.setItem(SNOOZE_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // localStorage unavailable (private mode / quota) — dismiss just won't
    // persist across a reload. Failing open (banner keeps showing) is the
    // safe direction here, not failing closed.
  }
}

function isSnoozed(taskId, now) {
  if (!taskId) return false;
  const expiresAt = readSnoozeMap()[taskId];
  return typeof expiresAt === 'number' && expiresAt > now;
}

function snoozeTask(taskId, now) {
  if (!taskId) return;
  const map = readSnoozeMap();
  map[taskId] = now + SNOOZE_WINDOW_MS;
  // Opportunistic cleanup so the map doesn't grow forever across a long
  // session — drop anything that's already expired.
  for (const id of Object.keys(map)) {
    if (typeof map[id] !== 'number' || map[id] <= now) delete map[id];
  }
  writeSnoozeMap(map);
}

export default function AttentionWarning({ task, health, progress }) {
  // Local tick so clicking dismiss re-renders this component out of the
  // tree immediately, without needing DetailPanel to know about snoozing.
  const [dismissTick, setDismissTick] = useState(0);

  if (!task || !health) return null; // health: 'stale' | 'expired' | null — computed by the caller (DetailPanel), same computeHealth() ClaimStateLine uses
  if (isSnoozed(task.id, Date.now())) return null;

  const noCheckpointText = formatNoCheckpoint(task); // e.g. "no checkpoint 18m"
  const headline = noCheckpointText.charAt(0).toUpperCase() + noCheckpointText.slice(1);
  const leaseStateText = health === 'expired'
    ? `Lease expired ${formatSince(task.leaseUntil)}`
    : 'Lease is stale';
  const lastCheckpointText = task.lastCheckpointAt
    ? new Date(task.lastCheckpointAt).toLocaleString()
    : 'never';
  const progressText = typeof progress === 'number' ? `${progress}%` : 'n/a';

  function handleDismiss(e) {
    e.stopPropagation();
    snoozeTask(task.id, Date.now());
    setDismissTick((n) => n + 1);
  }

  return (
    <div
      className="mt-3 rounded-md border border-warn bg-warn-subtle px-3 py-2"
      data-attention-warning={health}
      role="status"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2 min-w-0">
          <AlertTriangle size={14} className="text-warn shrink-0 mt-0.5" aria-hidden="true" />
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-wider text-warn font-semibold">
              {headline}
            </div>
            <div className="text-xs text-muted mt-1 space-y-0.5">
              <div>Agent: {task.agent || 'unknown'}</div>
              <div>Last checkpoint: {lastCheckpointText}</div>
              <div>Progress: {progressText}</div>
              <div>{leaseStateText}</div>
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={handleDismiss}
          aria-label="Dismiss for now"
          title="Dismiss for now — reappears if it's still stale in an hour"
          className="shrink-0 w-6 h-6 inline-flex items-center justify-center rounded-md text-muted hover:text-text hover:bg-bg-hover border-0 bg-transparent appearance-none outline-none cursor-pointer transition-colors duration-fast"
        >
          <X size={13} />
        </button>
      </div>
    </div>
  );
}
