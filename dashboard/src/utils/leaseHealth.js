/**
 * Lease health used by claim displays.
 *
 * Keep the threshold in one place for the task surfaces that need to show
 * claim health. Fifteen minutes is the existing LeaseIndicator threshold;
 * task-level staleAfterMinutes overrides it when present.
 */
export const DEFAULT_STALE_THRESHOLD_MINUTES = 15;
export const DEFAULT_STALE_THRESHOLD_MS = DEFAULT_STALE_THRESHOLD_MINUTES * 60 * 1000;

export const LEASE_HEALTH = Object.freeze({
  CURRENT: 'current',
  STALE: 'stale',
  EXPIRED: 'expired',
});

const HEALTH_RANK = Object.freeze({
  [LEASE_HEALTH.CURRENT]: 0,
  [LEASE_HEALTH.STALE]: 1,
  [LEASE_HEALTH.EXPIRED]: 2,
});

function leaseUntilFor(task) {
  return task?.leaseUntil ?? task?.lease_until ?? null;
}

function staleThresholdMs(task, options = {}) {
  const taskMinutes = task?.staleAfterMinutes;
  if (Number.isInteger(taskMinutes) && taskMinutes > 0) {
    return taskMinutes * 60 * 1000;
  }

  const configuredMinutes = options.staleThresholdMinutes;
  if (Number.isFinite(configuredMinutes) && configuredMinutes > 0) {
    return configuredMinutes * 60 * 1000;
  }

  return DEFAULT_STALE_THRESHOLD_MS;
}

function activityTimestamp(task) {
  const checkpoint = task?.lastCheckpointAt ?? task?.lastCheckpoint ?? task?.checkpointAt;
  if (checkpoint) return checkpoint;
  return task?.claimedAt ?? null;
}

/**
 * Resolve one claim's health without making lease health a claim filter.
 *
 * A missing lease remains compatible with legacy task payloads and can still
 * be current or stale based on activity. A malformed supplied lease is
 * unsafe to treat as live, so it is expired for display purposes.
 */
export function getLeaseHealth(task, now = Date.now(), options = {}) {
  if (!task?.agent || !task?.claimedAt) return null;
  if (task.status === 'done' || task.status === 'archived' || task.completedAt) return null;
  if (task.archived || task.trashedAt) return null;

  const leaseUntil = leaseUntilFor(task);
  if (leaseUntil !== null) {
    if (typeof leaseUntil !== 'string' || leaseUntil.trim() === '') {
      return LEASE_HEALTH.EXPIRED;
    }
    const leaseMs = Date.parse(leaseUntil);
    if (!Number.isFinite(leaseMs) || leaseMs <= now) {
      return LEASE_HEALTH.EXPIRED;
    }
  }

  const activity = activityTimestamp(task);
  if (activity) {
    const activityMs = Date.parse(activity);
    if (Number.isFinite(activityMs) && now - activityMs > staleThresholdMs(task, options)) {
      return LEASE_HEALTH.STALE;
    }
  }

  return LEASE_HEALTH.CURRENT;
}

/** Return the worst health among a group of claims. */
export function aggregateLeaseHealth(claims = [], now = Date.now(), options = {}) {
  let worst = LEASE_HEALTH.CURRENT;
  for (const claim of Array.isArray(claims) ? claims : []) {
    const health = getLeaseHealth(claim, now, options);
    if (!health) continue;
    if (HEALTH_RANK[health] > HEALTH_RANK[worst]) worst = health;
  }
  return worst;
}

// Descriptive alias for callers that want to make the worst-state contract
// explicit at the call site.
export const worstLeaseHealth = aggregateLeaseHealth;
