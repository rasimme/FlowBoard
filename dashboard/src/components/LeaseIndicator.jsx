/**
 * LeaseIndicator — compact claim-health dot for TaskCard / SubtaskCard.
 *
 * Renders nothing when the task is healthy or not actively claimed.
 * Shows a small amber dot next to the ownership AgentChip when:
 *   - stale:   claimed but no checkpoint past the shared threshold
 *   - expired: leaseUntil is in the past
 *
 * T-452-6 collapsed this to one visual attention state: a human reacts to
 * stale and expired the same way, so both render identically (amber, no
 * pulse). The severity distinction survives only in the tooltip text and in
 * computeHealth()'s three-valued return — callers such as ClaimStateLine.jsx
 * still branch on 'stale' vs 'expired' to gate the lease-recovery ("Steal")
 * action, so that return contract is unchanged here.
 *
 * Health applies only to *active* claims. HZL-core preserves task.agent
 * past release/done as historical attribution, so a done task with an old
 * lastCheckpointAt would otherwise look "stale" forever.
 *
 * Deliberately tiny (8 px) so it layers alongside AgentChip without
 * adding badge soup.  Tooltip carries the detail.
 */

import { isActivelyClaimed } from '../utils/formatting.js';
import { getLeaseHealth, LEASE_HEALTH } from '../utils/leaseHealth.js';

function computeHealth(task, now = Date.now(), { staleThresholdMinutes } = {}) {
  if (!isActivelyClaimed(task)) return null; // not actively claimed — no health to report
  const health = getLeaseHealth(task, now, { staleThresholdMinutes });
  return health === LEASE_HEALTH.CURRENT ? null : health;
}

// One shared amber look for both attention levels — see the module comment.
// Only the tooltip text still distinguishes stale from expired.
const STYLES = {
  stale: {
    bg: 'var(--warn)',
    shadow: 'none',
    title: 'Lease activity is stale',
  },
  expired: {
    bg: 'var(--warn)',
    shadow: 'none',
    title: 'Lease expired',
  },
};

export default function LeaseIndicator({ task, style, staleThresholdMinutes }) {
  const health = computeHealth(task, Date.now(), { staleThresholdMinutes });
  if (!health) return null;

  const s = STYLES[health];

  return (
    <span
      title={s.title}
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
