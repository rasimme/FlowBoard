import { useEffect, useState } from 'react';
import { CheckCircle2, XCircle } from 'lucide-react';
import { apiFetch } from '../utils/apiFetch.js';
import { showToast } from '../utils/toast.js';
import Modal from './Modal.jsx';
import Button from './Button.jsx';
import Alert from './Alert.jsx';
import Spinner from './Spinner.jsx';
import DataList from './DataList.jsx';

/**
 * CanvasMigrationBanner — Update window for the canvas.json → DB migration (T-344-4).
 *
 * Follows the SnippetUpgrade pattern (banner → modal → confirm → run → result),
 * driven by the T-344-3 migration API contract:
 *   GET  /api/migrations/canvas/status
 *     → { pending: [{project, displayName, notes, connections, bytes}], migrated: [...], total }
 *   POST /api/migrations/canvas/run  { projects?: [name] }
 *     → { results: [{project, ok, notes, connections, error?}], failed }
 *
 * Behavior:
 * - Status is fetched exactly once on dashboard init (component mount, no polling).
 * - pending > 0 → unobtrusive fixed banner (dashboard stays fully usable — the
 *   dual-read path keeps unmigrated projects working; this is an invitation).
 * - Modal lists pending projects with note/connection counts, points out the
 *   automatic backup (canvas.json.pre-db.bak), and runs the migration on confirm.
 * - Partial failure → result list in the modal, banner stays for the remaining
 *   pending projects (the run endpoint is idempotent, retry is safe).
 * - Full success → toast + banner disappears.
 * - "Later" hides the banner for the rest of the browser session (sessionStorage).
 *
 * Pure helpers are exported for DOM-less tests (test-canvas-migration-ui.mjs).
 */

export const CANVAS_MIGRATION_DISMISS_KEY = 'flowboardCanvasMigrationDismissed';
export const CANVAS_MIGRATION_STATUS_PATH = '/api/migrations/canvas/status';
export const CANVAS_MIGRATION_RUN_PATH = '/api/migrations/canvas/run';

/** True when the banner was dismissed for this browser session. */
export function isDismissedForSession(storage) {
  try {
    return storage?.getItem?.(CANVAS_MIGRATION_DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

/** Mark the banner as dismissed for this browser session. */
export function dismissForSession(storage) {
  try {
    storage?.setItem?.(CANVAS_MIGRATION_DISMISS_KEY, '1');
  } catch {
    // Storage unavailable (private mode etc.) — banner simply reappears on reload.
  }
}

/** Banner visibility: a valid status with pending projects and no session dismissal. */
export function shouldShowBanner(status, dismissed) {
  if (dismissed) return false;
  return !!(status && Array.isArray(status.pending) && status.pending.length > 0);
}

/**
 * Fetch migration status. Returns the parsed status object or null on any
 * error (banner simply does not appear — same fail-silent policy as
 * SnippetUpgrade; the API may not exist yet on older servers).
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
 * leave the pending list (banner stays only for remaining/failed ones).
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

function resolveStorage(storage) {
  if (storage !== undefined) return storage;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function toast(message, type) {
  // Prefer the global installed by DashboardContext; fall back to the module fn.
  if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
    window.showToast(message, type);
  } else {
    showToast(message, type);
  }
}

function projectLabel(p) {
  return p.displayName || p.project;
}

function countsLine(p) {
  const parts = [
    `${p.notes ?? 0} ${p.notes === 1 ? 'note' : 'notes'}`,
    `${p.connections ?? 0} ${p.connections === 1 ? 'connection' : 'connections'}`,
  ];
  const size = formatBytes(p.bytes);
  if (size) parts.push(size);
  return parts.join(' · ');
}

/**
 * @param {object}  [props.initialStatus] - Inject a status and skip the fetch (tests).
 * @param {object}  [props.storage]       - sessionStorage override (tests; null = none).
 * @param {function} [props.fetchImpl]    - fetch override (tests).
 */
export default function CanvasMigrationBanner({ initialStatus = null, storage = undefined, fetchImpl = undefined }) {
  const [status, setStatus] = useState(initialStatus);
  const [dismissed, setDismissed] = useState(() => isDismissedForSession(resolveStorage(storage)));
  const [modalOpen, setModalOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);

  // One-time status check on dashboard init — no polling by design.
  useEffect(() => {
    if (initialStatus !== null) return undefined; // injected (tests)
    if (isDismissedForSession(resolveStorage(storage))) return undefined;
    let cancelled = false;
    fetchCanvasMigrationStatus({ fetchImpl: fetchImpl || apiFetch }).then((s) => {
      if (!cancelled && s) setStatus(s);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!shouldShowBanner(status, dismissed)) return null;

  const pending = status.pending;
  const pendingWord = pending.length === 1 ? 'project' : 'projects';

  const handleLater = () => {
    dismissForSession(resolveStorage(storage));
    setDismissed(true);
    setModalOpen(false);
  };

  const openModal = () => {
    setResult(null);
    setModalOpen(true);
  };

  const closeModal = () => {
    if (running) return;
    setModalOpen(false);
  };

  const handleRun = async () => {
    if (running) return;
    setRunning(true);
    try {
      const response = await runCanvasMigration(
        pending.map((p) => p.project),
        { fetchImpl: fetchImpl || apiFetch },
      );
      const outcome = applyRunResults(status, response);
      setStatus(outcome.nextStatus);
      if (outcome.failed.length === 0 && outcome.succeeded.length > 0) {
        const n = outcome.succeeded.length;
        toast(`Canvas migration complete — ${n} ${n === 1 ? 'project' : 'projects'} migrated.`, 'success');
        setModalOpen(false);
      } else {
        setResult(outcome);
      }
    } catch (err) {
      setResult({ succeeded: [], failed: [], requestError: err?.message || 'Migration request failed' });
    } finally {
      setRunning(false);
    }
  };

  const resultPhase = result !== null;

  return (
    <>
      <div className="fixed bottom-4 right-4 z-[1500] w-full max-w-sm shadow-lg rounded-lg">
        <Alert
          variant="info"
          title="Update available"
          action={(
            <div className="flex items-center gap-1.5">
              <Button size="xs" variant="secondary" onClick={openModal}>Review</Button>
              <Button size="xs" variant="ghost" onClick={handleLater}>Later</Button>
            </div>
          )}
        >
          Canvas data migration pending for {pending.length} {pendingWord}.
        </Alert>
      </div>

      <Modal
        open={modalOpen}
        onClose={closeModal}
        title="Canvas Data Migration"
        size="lg"
        showClose
        dismissible={!running}
        actions={resultPhase ? (
          <Button variant="secondary" size="sm" onClick={closeModal}>Close</Button>
        ) : (
          <>
            <Button variant="secondary" size="sm" onClick={handleLater} disabled={running}>Later</Button>
            <Button variant="accent" size="sm" onClick={handleRun} disabled={running}>
              {running
                ? (<><Spinner size="sm" className="text-white" /> Migrating…</>)
                : `Migrate ${pending.length} ${pendingWord}`}
            </Button>
          </>
        )}
      >
        {resultPhase ? (
          <div className="flex flex-col gap-3">
            {result.requestError ? (
              <Alert variant="error" title="Migration request failed">
                {result.requestError} — no projects were changed. You can retry from this dialog.
              </Alert>
            ) : result.failed.length > 0 ? (
              <Alert variant="error" title="Migration finished with errors">
                {result.failed.length} of {result.succeeded.length + result.failed.length}{' '}
                {result.succeeded.length + result.failed.length === 1 ? 'project' : 'projects'} failed.
                Migrated projects are done; the banner stays available for the remaining ones — retry is safe.
              </Alert>
            ) : (
              <Alert variant="info" title="Nothing was migrated">
                The server reported no migration results. The pending projects may have been
                migrated elsewhere in the meantime — reload the dashboard to refresh the status.
              </Alert>
            )}
            {(result.succeeded.length > 0 || result.failed.length > 0) && (
              <ul className="list-none m-0 p-0 flex flex-col gap-1.5">
                {result.succeeded.map((r) => (
                  <li key={r.project} className="flex items-start gap-2 text-sm text-text">
                    <CheckCircle2 size={15} className="shrink-0 mt-0.5 text-ok" />
                    <span>
                      <span className="font-medium">{r.project}</span>
                      {' — '}{r.notes ?? 0} notes, {r.connections ?? 0} connections migrated
                    </span>
                  </li>
                ))}
                {result.failed.map((r) => (
                  <li key={r.project} className="flex items-start gap-2 text-sm text-text">
                    <XCircle size={15} className="shrink-0 mt-0.5 text-danger" />
                    <span>
                      <span className="font-medium">{r.project}</span>
                      {' — '}{r.error || 'unknown error'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="m-0 text-muted">
              These projects still store canvas data in a local <span className="font-mono">canvas.json</span> file.
              Running the migration imports all notes and connections into the database.
              The dashboard stays fully usable either way — you can do this anytime.
            </p>
            <DataList
              dense
              items={pending.map((p) => ({ label: projectLabel(p), value: countsLine(p) }))}
            />
            <Alert variant="info">
              Before switching over, each file is preserved as{' '}
              <span className="font-mono">canvas.json.pre-db.bak</span> — nothing is deleted.
            </Alert>
          </div>
        )}
      </Modal>
    </>
  );
}
