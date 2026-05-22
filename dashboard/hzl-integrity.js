'use strict';

/**
 * HZL integrity watermark — boot-time check that detects when the events
 * table has shrunk against its last known state.
 *
 * The events table has `events_no_update` and `events_no_delete` triggers
 * (ADR-0007 / ADR-0008), so data cannot disappear via SQL. Triggers do not
 * protect against filesystem-level rollback though: if the `flowboard.db`
 * file itself is replaced by an older copy (Time Machine restore, snapshot
 * script, manual copy), the SQL-layer invariants are silently violated and
 * the dashboard happily serves the older state without any signal.
 *
 * This module persists the highest seen `events.id` and `events` row count
 * in `hzl_local_meta` (the per-instance metadata table that already lives
 * in `flowboard-cache.db`). On every service start, the current values are
 * compared to the stored watermark. Shrinkage produces a regression record
 * the caller logs loudly — and, with `HZL_INTEGRITY_STRICT=true` set, the
 * service refuses to start.
 *
 * The module is intentionally side-effect-free apart from the explicit
 * `storeWatermark` call. Everything else (logging, exit-on-strict,
 * exposing via API) is the caller's responsibility, so adopters with
 * different alerting setups can wire their own behaviour.
 */

const WATERMARK_KEY_MAX_ID = 'integrity.events_max_id';
const WATERMARK_KEY_COUNT = 'integrity.events_count';
const WATERMARK_KEY_TS = 'integrity.last_check_at';

/**
 * Read the live state of the events table — used both for comparison and
 * for the next watermark write.
 *
 * @param {object} eventsDb - better-sqlite3-style Database for events.db
 * @returns {{ max_id: number, count: number, last_event_at: string|null }}
 */
function getCurrentWatermark(eventsDb) {
  const row = eventsDb
    .prepare('SELECT MAX(id) AS max_id, COUNT(*) AS count, MAX(timestamp) AS last_event_at FROM events')
    .get();
  return {
    max_id: row && row.max_id ? row.max_id : 0,
    count: row && row.count ? row.count : 0,
    last_event_at: row && row.last_event_at ? row.last_event_at : null,
  };
}

/**
 * Read the previously stored watermark from `hzl_local_meta`. Returns
 * null when no watermark has been stored yet (first run after upgrade).
 *
 * @param {object} cacheDb - better-sqlite3-style Database for flowboard-cache.db
 * @returns {{ max_id: number, count: number, last_check_at: string|null } | null}
 */
function getStoredWatermark(cacheDb) {
  const stmt = cacheDb.prepare('SELECT value FROM hzl_local_meta WHERE key = ?');
  const maxIdRow = stmt.get(WATERMARK_KEY_MAX_ID);
  const countRow = stmt.get(WATERMARK_KEY_COUNT);
  const tsRow = stmt.get(WATERMARK_KEY_TS);

  // No watermark has been written yet → first run, nothing to compare against
  if (!maxIdRow && !countRow) return null;

  return {
    max_id: maxIdRow ? parseInt(maxIdRow.value, 10) || 0 : 0,
    count: countRow ? parseInt(countRow.value, 10) || 0 : 0,
    last_check_at: tsRow ? tsRow.value : null,
  };
}

/**
 * Persist the current watermark. Idempotent — overwrites any previous values.
 *
 * @param {object} cacheDb - better-sqlite3-style Database for flowboard-cache.db
 * @param {{ max_id: number, count: number }} current
 */
function storeWatermark(cacheDb, current) {
  const ts = new Date().toISOString();
  const stmt = cacheDb.prepare('INSERT OR REPLACE INTO hzl_local_meta (key, value) VALUES (?, ?)');
  stmt.run(WATERMARK_KEY_MAX_ID, String(current.max_id));
  stmt.run(WATERMARK_KEY_COUNT, String(current.count));
  stmt.run(WATERMARK_KEY_TS, ts);
}

/**
 * Compare stored vs current watermarks and return a regression record when
 * the events table has shrunk, or null when growth/no-change.
 *
 * max_id regression takes priority over count regression because a lower
 * max_id is the more informative signal (it tells you the highest write
 * has been rolled back, which implies multiple events are gone). A count-
 * only regression is rare in practice but defended against — it would
 * indicate the events table was truncated to a lower count without the
 * max_id changing (e.g. a partial restore that copied a subset of rows).
 *
 * @param {{max_id, count}|null} stored
 * @param {{max_id, count}} current
 * @returns {null | { type: string, before: number, after: number, detected_at: string }}
 */
function checkRegression(stored, current) {
  if (!stored) return null;

  if (current.max_id < stored.max_id) {
    return {
      type: 'max_id_regressed',
      before: stored.max_id,
      after: current.max_id,
      detected_at: new Date().toISOString(),
    };
  }
  if (current.count < stored.count) {
    return {
      type: 'count_regressed',
      before: stored.count,
      after: current.count,
      detected_at: new Date().toISOString(),
    };
  }
  return null;
}

/**
 * Build a one-line human-readable regression message. Used as the `text`
 * field in the webhook body so that gateway-style consumers (which only
 * read `text`) get a useful payload without having to parse the structured
 * fields.
 *
 * @param {{type, before, after}} regression
 * @param {string|null} host - LOCAL_HOSTNAME for multi-instance disambiguation
 * @returns {string}
 */
function formatRegressionMessage(regression, host) {
  const what = regression.type === 'max_id_regressed' ? 'max_id' : 'count';
  const where = host ? ` on ${host}` : '';
  return `⚠️ FlowBoard integrity regression — events ${what} shrank from ${regression.before} to ${regression.after}${where}. Inspect the workspace git history or backup chain for the last good state.`;
}

/**
 * Build the JSON body for the regression webhook. The `message` field
 * carries the one-line human-readable summary and matches the OpenClaw
 * gateway's `/hooks/agent` contract (verified against a live install:
 * the gateway rejects `text` with `400 message required`). The
 * structured fields (`regression`, `current`, `stored`, `host`) ride
 * alongside `message` for monitoring tools and dashboards that prefer
 * parsed data over string scraping.
 *
 * Adopters running a different notification surface (Slack incoming
 * webhook expects `text`, Discord expects `content`, PagerDuty expects
 * `payload.summary`) can wire a small relay between FlowBoard and their
 * channel; the body schema documented here is stable.
 *
 * @returns {object}
 */
function buildWebhookBody(regression, current, stored, host) {
  return {
    message: formatRegressionMessage(regression, host),
    regression,
    current,
    stored,
    host: host || null,
  };
}

module.exports = {
  getCurrentWatermark,
  getStoredWatermark,
  storeWatermark,
  checkRegression,
  formatRegressionMessage,
  buildWebhookBody,
};
