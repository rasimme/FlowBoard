/**
 * canvasMigration — pure helpers for the canvas.json → DB migration (T-344-9).
 *
 * Extracted from the former CanvasMigrationBanner.jsx so the canvas migration
 * can be folded into the existing SnippetUpgrade header-chip + modal as one
 * unified update center. The bottom banner (and its sessionStorage "Later"
 * dismissal) is gone — the header chip pattern needs no per-session dismissal.
 *
 * Driven by the T-344-3/T-344-5 migration API contract:
 *   GET  /api/migrations/canvas/status
 *     → { pending:   [{project, displayName, notes, connections, bytes}],
 *         migrated:  [{project, displayName, migratedAt}],
 *         conflicts: [{project, displayName, bytes, migratedAt}],
 *         total }
 *   POST /api/migrations/canvas/run  { projects?: [name] }
 *     → { results: [{project, ok, notes, connections, error?, skipped?, warning?, conflict?}], failed }
 *
 * These are DOM-less, fetch-injectable functions covered by
 * test-canvas-migration-ui.mjs.
 */

import { apiFetch } from './apiFetch.js';

export const CANVAS_MIGRATION_STATUS_PATH = '/api/migrations/canvas/status';
export const CANVAS_MIGRATION_RUN_PATH = '/api/migrations/canvas/run';

/** Backup file each project's canvas.json is preserved as before switch-over. */
export const CANVAS_MIGRATION_BACKUP_FILE = 'canvas.json.pre-db.bak';

/**
 * Fetch migration status. Returns the parsed status object or null on any
 * error (chip simply does not appear — same fail-silent policy as the snippet
 * status; the API may not exist yet on older servers).
 */
export async function fetchCanvasMigrationStatus({ fetchImpl = apiFetch } = {}) {
  try {
    const res = await fetchImpl(CANVAS_MIGRATION_STATUS_PATH);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !Array.isArray(data.pending)) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Run the migration for the given project names (empty/omitted = all pending).
 * Resolves with the parsed run response; throws on transport/contract errors.
 */
export async function runCanvasMigration(projects, { fetchImpl = apiFetch } = {}) {
  const body = Array.isArray(projects) && projects.length > 0 ? { projects } : {};
  const res = await fetchImpl(CANVAS_MIGRATION_RUN_PATH, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  if (!data || !Array.isArray(data.results)) throw new Error('Unexpected migration response');
  return data;
}

/**
 * Map a run response onto the previous status: successfully migrated projects
 * leave the pending list (chip stays only for remaining/failed ones).
 * Returns { nextStatus, succeeded, failed }.
 */
export function applyRunResults(status, response) {
  const results = Array.isArray(response?.results) ? response.results : [];
  const succeeded = results.filter((r) => r && r.ok);
  const failed = results.filter((r) => r && !r.ok);
  const migratedNames = new Set(succeeded.map((r) => r.project));
  const pending = Array.isArray(status?.pending) ? status.pending : [];
  const nextPending = pending.filter((p) => !migratedNames.has(p.project));
  return {
    nextStatus: { ...status, pending: nextPending },
    succeeded,
    failed,
  };
}

/** Human-readable byte count for the project list. */
export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KB`;
}

/** Display label for a pending/migrated/conflict entry. */
export function projectLabel(p) {
  return p.displayName || p.project;
}

/** "N notes · M connections [· size]" summary line for one pending project. */
export function countsLine(p) {
  const parts = [
    `${p.notes ?? 0} ${p.notes === 1 ? 'note' : 'notes'}`,
    `${p.connections ?? 0} ${p.connections === 1 ? 'connection' : 'connections'}`,
  ];
  const size = formatBytes(p.bytes);
  if (size) parts.push(size);
  return parts.join(' · ');
}

/** Pending projects from a status (safe on null/garbage). */
export function pendingProjects(status) {
  return Array.isArray(status?.pending) ? status.pending : [];
}

/** Conflict entries from a status (safe on null/garbage). */
export function conflictProjects(status) {
  return Array.isArray(status?.conflicts) ? status.conflicts : [];
}

/** True when a status has at least one pending canvas migration. */
export function hasPendingCanvasMigration(status) {
  return pendingProjects(status).length > 0;
}
