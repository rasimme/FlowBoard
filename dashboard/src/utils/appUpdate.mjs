/**
 * appUpdate — pure helpers for the in-dashboard self-update flow (T-353).
 *
 * Folded into the SnippetUpgrade header-chip + modal (the single update center).
 * After `openclaw plugins update flowboard` the on-disk plugin version is higher
 * than the running dashboard; this surfaces that and triggers a rebuild+restart
 * via the server, then waits for the new build to come back up.
 *
 * Server contract (server.js, T-353):
 *   GET  /api/update/status → { ok, running, installed, updateAvailable, selfUpdateEnabled }
 *   POST /api/update/run    → 202 { ok, started, command } (rebuild+restart)
 *   GET  /api/info          → { version, ... }   (used to detect the new build)
 *   GET  /api/health        → { ok }             (used to detect "back up")
 *
 * DOM-less and fetch-/sleep-injectable so it is covered by test-app-update-ui.mjs.
 */

import { apiFetch } from './apiFetch.js';

export const UPDATE_STATUS_PATH = '/api/update/status';
export const UPDATE_RUN_PATH = '/api/update/run';
export const INFO_PATH = '/api/info';
export const HEALTH_PATH = '/api/health';

/**
 * Fetch update status. Returns the parsed object or null on any error (the
 * update section/chip simply does not appear — same fail-silent policy as the
 * snippet/canvas status; older servers may not have the endpoint).
 */
export async function fetchUpdateStatus({ fetchImpl = apiFetch } = {}) {
  try {
    const res = await fetchImpl(UPDATE_STATUS_PATH);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || typeof data.running !== 'string') return null;
    return {
      running: data.running,
      installed: typeof data.installed === 'string' ? data.installed : null,
      updateAvailable: !!data.updateAvailable,
      selfUpdateEnabled: data.selfUpdateEnabled !== false,
    };
  } catch {
    return null;
  }
}

/**
 * Trigger the rebuild+restart. Returns { ok, started, command } on success, or
 * { ok:false, error } on failure (network or non-2xx). Never throws.
 * Requires { confirmation: 'update-confirmed' } in request body (T-417-6).
 */
export async function runUpdate({ fetchImpl = apiFetch } = {}) {
  try {
    const res = await fetchImpl(UPDATE_RUN_PATH, {
      method: 'POST',
      body: { confirmation: 'update-confirmed' },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.ok === false) {
      return { ok: false, error: data?.error || `HTTP ${res.status}` };
    }
    return { ok: true, started: !!data.started, command: data.command || [] };
  } catch (err) {
    return { ok: false, error: err?.message || 'Network error' };
  }
}

const realSleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Poll until the dashboard is back up on a DIFFERENT version than `fromVersion`
 * (i.e. the restart completed and the new build is serving). Returns the new
 * version string on success, or null on timeout. During the restart window the
 * server is briefly unreachable — those errors are swallowed and retried.
 *
 * Injectable fetch + sleep + now() keep it deterministic in tests.
 */
export async function pollUntilUpdated({
  fromVersion,
  fetchImpl = apiFetch,
  sleep = realSleep,
  now = () => Date.now(),
  timeoutMs = 120000,
  intervalMs = 1500,
} = {}) {
  const start = now();
  // Small initial delay so we don't race the still-old process before it dies.
  await sleep(intervalMs);
  while (now() - start < timeoutMs) {
    try {
      const health = await fetchImpl(HEALTH_PATH);
      if (health.ok) {
        const info = await fetchImpl(INFO_PATH);
        if (info.ok) {
          const data = await info.json().catch(() => null);
          const v = data?.version;
          if (typeof v === 'string' && v !== fromVersion) return v;
        }
      }
    } catch { /* server down mid-restart — keep polling */ }
    await sleep(intervalMs);
  }
  return null;
}
