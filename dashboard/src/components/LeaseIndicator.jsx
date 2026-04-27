/**
 * LeaseIndicator — compact claim-health dot for TaskCard / SubtaskCard.
 *
 * Renders nothing when the task is healthy or not actively claimed.
 * Shows a small warning/critical dot next to the ownership AgentChip when:
 *   - stale:   claimed but no checkpoint in 15 min  (amber dot)
 *   - expired: leaseUntil is in the past            (red pulse dot)
 *
 * Health applies only to *active* claims. HZL-core preserves task.agent
 * past release/done as historical attribution, so a done task with an old
 * lastCheckpointAt would otherwise look "stale" forever.
 *
 * Deliberately tiny (8 px) so it layers alongside AgentChip without
 * adding badge soup.  Tooltip carries the detail.
 */

import { isActivelyClaimed } from '../utils.js';

const STALE_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes

function computeHealth(task) {
  if (!isActivelyClaimed(task)) return null; // not actively claimed — no health to report

  const now = Date.now();

  // Lease expired is the stronger signal — check first
  if (task.leaseUntil) {
    const lease = new Date(task.leaseUntil).getTime();
    if (lease <= now) return 'expired';
  }

  // Stale: claimed but no recent checkpoint
  if (task.lastCheckpointAt) {
    const last = new Date(task.lastCheckpointAt).getTime();
    if (now - last > STALE_THRESHOLD_MS) return 'stale';
  } else if (task.claimedAt) {
    // No checkpoint at all — fall back to claimedAt
    const claimed = new Date(task.claimedAt).getTime();
    if (now - claimed > STALE_THRESHOLD_MS) return 'stale';
  }

  return null; // healthy
}

const STYLES = {
  stale: {
    bg: 'var(--warn)',
    shadow: 'none',
    title: 'Stale — no checkpoint in 15+ min',
  },
  expired: {
    bg: 'var(--danger)',
    shadow: '0 0 0 2px var(--bg), 0 0 6px var(--danger)',
    title: 'Lease expired',
  },
};

export default function LeaseIndicator({ task, style }) {
  const health = computeHealth(task);
  if (!health) return null;

  const s = STYLES[health];

  return (
    <span
      title={s.title}
      className={health === 'expired' ? 'lease-indicator-pulse' : undefined}
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: s.bg,
        boxShadow: s.shadow,
        flexShrink: 0,
        ...(style || {}),
      }}
    />
  );
}

export { computeHealth };
