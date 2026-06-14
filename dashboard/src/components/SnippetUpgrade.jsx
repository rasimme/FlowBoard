import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Sparkles, X, Check, AlertTriangle, ChevronRight, Plus, ArrowUpCircle, Database } from 'lucide-react';
import { apiFetch } from '../utils/apiFetch.js';
import ScrollArea from './ScrollArea.jsx';
import {
  fetchCanvasMigrationStatus,
  runCanvasMigration,
  applyRunResults,
  countsLine,
  projectLabel,
  pendingProjects,
  conflictProjects,
  CANVAS_MIGRATION_BACKUP_FILE,
} from '../utils/canvasMigration.mjs';

/**
 * SnippetUpgrade — FlowBoard setup / migration header chip + modal.
 *
 * Polls GET /api/snippets/status on mount. Renders nothing when the server
 * returns `chip: null` (setup complete, no legacy remaining). Otherwise shows
 * the chip whose text/variant is driven by server state:
 *   - "Migration required" (warn) when any legacy snippet (identical / drifted) exists
 *   - "FlowBoard setup" (warn) when existing AGENTS.md files can be onboarded
 *
 * The modal groups rows by state:
 *   - Upgrade  (identical) — batch safe, default-on checkboxes
 *   - Migration required (drifted) — per-file opt-in, force-replace
 *   - Add FlowBoard to existing AGENTS.md (missing) — per-file opt-in
 *
 * On Apply: POST /api/snippets/apply with `{ actions: [{id, action}] }`.
 * Every mutation writes a server-side `.bak-<timestamp>` first.
 *
 * This is also the single update center for the canvas.json → DB migration
 * (T-344-9, formerly a separate bottom banner): on mount it additionally
 * fetches GET /api/migrations/canvas/status (parallel, fail-silent). When
 * canvas projects are pending, the chip appears even if the server returns no
 * snippet chip, the modal renders a "Canvas data migration" group, and Apply
 * additionally POSTs /api/migrations/canvas/run.
 */
export default function SnippetUpgrade() {
  const [status, setStatus] = useState(null);
  const [canvasStatus, setCanvasStatus] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);

  const refresh = async () => {
    // Snippet status and canvas migration status are independent and both
    // fail-silent: each simply contributes nothing to the chip on error.
    const snippetReq = (async () => {
      try {
        const res = await apiFetch('/api/snippets/status');
        if (!res.ok) return null;
        return await res.json();
      } catch {
        return null;
      }
    })();
    const canvasReq = fetchCanvasMigrationStatus();
    const [snippetData, canvasData] = await Promise.all([snippetReq, canvasReq]);
    if (snippetData !== null) setStatus(snippetData);
    setCanvasStatus(canvasData);
  };

  useEffect(() => {
    refresh();
  }, []);

  const chip = resolveChip(status?.chip, canvasStatus);

  // Nothing to surface: no snippet chip AND no pending canvas migration.
  if (!chip) return null;

  return (
    <>
      <SetupChip chip={chip} onClick={() => setModalOpen(true)} />
      <span className="header-divider" />
      <UpgradeModal
        open={modalOpen}
        onClose={() => { setModalOpen(false); refresh(); }}
        status={status || { files: [] }}
        canvasStatus={canvasStatus}
        onApplied={refresh}
      />
    </>
  );
}

/**
 * Combine the server snippet chip with the canvas migration status into a
 * single header chip:
 *   - snippet chip + canvas pending → warn chip with a combined count
 *   - snippet chip only            → server chip unchanged
 *   - canvas pending only          → synthetic "Migration required" (warn)
 *   - neither                      → null (chip hidden)
 */
export function resolveChip(snippetChip, canvasStatus) {
  const canvasCount = pendingProjects(canvasStatus).length;
  const conflictCount = conflictProjects(canvasStatus).length;
  if (!snippetChip && canvasCount === 0 && conflictCount === 0) return null;
  if (snippetChip && canvasCount === 0) return snippetChip; // snippet chip opens the modal; conflicts render inside it
  if (!snippetChip && canvasCount > 0) {
    return { text: 'Migration required', variant: 'warn' };
  }
  // Conflict-only (no snippet, no pending): a canvas.json re-appeared next to a
  // migrated project (ADR-0018 restore). Surface a chip so the operator reaches
  // the conflict section — otherwise it lives only in the server log.
  if (!snippetChip && canvasCount === 0 && conflictCount > 0) {
    return { text: 'Canvas data conflict', variant: 'warn' };
  }
  // Both present: combined warn chip.
  const word = canvasCount === 1 ? 'canvas project' : 'canvas projects';
  return {
    text: `Updates required · ${canvasCount} ${word}`,
    variant: 'warn',
  };
}

function SetupChip({ chip, onClick }) {
  const classes = ['migration-chip'];
  if (chip.variant === 'info') classes.push('migration-chip-info');
  return (
    <button className={classes.join(' ')} onClick={onClick} title={chip.text}>
      <span className="migration-chip-icon">
        {chip.variant === 'warn' ? <AlertTriangle size={13} /> : <Sparkles size={13} />}
      </span>
      <span>{chip.text}</span>
    </button>
  );
}

function UpgradeModal({ open, onClose, status, canvasStatus, onApplied }) {
  const identicalFiles = (status.files || []).filter(f => f.state === 'identical');
  const driftedFiles = (status.files || []).filter(f => f.state === 'drifted');
  const missingFiles = (status.files || []).filter(f => f.state === 'missing');
  const canvasPending = pendingProjects(canvasStatus);
  const canvasConflicts = conflictProjects(canvasStatus);
  const bootLegacyFiles = status.bootLegacyFiles || [];
  const legacyStateFiles = status.legacyStateFiles || [];
  const configAdvisories = status.configAdvisories || [];
  const bootstrapDocAdvisories = status.bootstrapDocAdvisories || [];

  // Selection maps per group. Defaults follow the "mandatory vs optional"
  // distinction: anything needed for FlowBoard to function correctly is
  // pre-selected; optional additions are not.
  //   identical: all-on (byte-match legacy, safe auto-upgrade)
  //   drifted:   all-on (mandatory — legacy references deprecated ACTIVE-PROJECT.md,
  //              agent would keep calling the old path; user can uncheck per file
  //              if they want to preserve a specific customization)
  //   missing:   all-off (optional — the workspace may not need FlowBoard at all;
  //              user opts in per workspace, or dismisses)
  const [selectedUpgrade, setSelectedUpgrade] = useState({});
  const [selectedMigrate, setSelectedMigrate] = useState({});
  const [selectedAdd, setSelectedAdd] = useState({});
  // Canvas group is mandatory like drifted snippets: pre-selected, all pending
  // projects migrate together (per-project opt-out via the master checkbox).
  const [canvasSelected, setCanvasSelected] = useState(true);
  const [expandedId, setExpandedId] = useState(null);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState(null);
  // Separate canvas run result so partial failures per area show independently.
  const [canvasResult, setCanvasResult] = useState(null);

  useEffect(() => {
    if (!open) return;
    const initUpgrade = {};
    identicalFiles.forEach(f => { initUpgrade[f.id] = true; });
    setSelectedUpgrade(initUpgrade);
    const initMigrate = {};
    driftedFiles.forEach(f => { initMigrate[f.id] = true; });
    setSelectedMigrate(initMigrate);
    setSelectedAdd({}); // optional; user opts in per workspace
    setCanvasSelected(canvasPending.length > 0);
    setExpandedId(null);
    setResult(null);
    setCanvasResult(null);
    setApplying(false);
  }, [open, status, canvasStatus]);

  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [open, onClose]);

  const upgradeCount = identicalFiles.filter(f => selectedUpgrade[f.id]).length;
  const migrateCount = driftedFiles.filter(f => selectedMigrate[f.id]).length;
  const addCount = missingFiles.filter(f => selectedAdd[f.id]).length;
  const snippetSelected = upgradeCount + migrateCount + addCount;
  const canvasCount = canvasSelected && canvasPending.length > 0 ? canvasPending.length : 0;
  const totalSelected = snippetSelected + canvasCount;

  const allUpgradeSelected = identicalFiles.length > 0 && upgradeCount === identicalFiles.length;
  const someUpgradeSelected = upgradeCount > 0 && !allUpgradeSelected;
  const allMigrateSelected = driftedFiles.length > 0 && migrateCount === driftedFiles.length;
  const someMigrateSelected = migrateCount > 0 && !allMigrateSelected;
  const allAddSelected = missingFiles.length > 0 && addCount === missingFiles.length;
  const someAddSelected = addCount > 0 && !allAddSelected;

  if (!open) return null;

  const toggleUpgrade = (id) => setSelectedUpgrade(prev => ({ ...prev, [id]: !prev[id] }));
  const toggleMigrate = (id) => setSelectedMigrate(prev => ({ ...prev, [id]: !prev[id] }));
  const toggleAdd = (id) => setSelectedAdd(prev => ({ ...prev, [id]: !prev[id] }));
  const toggleExpand = (id) => setExpandedId(prev => (prev === id ? null : id));
  const toggleAllUpgrade = () => {
    const next = {};
    if (!allUpgradeSelected) identicalFiles.forEach(f => { next[f.id] = true; });
    setSelectedUpgrade(next);
  };
  const toggleAllMigrate = () => {
    const next = {};
    if (!allMigrateSelected) driftedFiles.forEach(f => { next[f.id] = true; });
    setSelectedMigrate(next);
  };
  const toggleAllAdd = () => {
    const next = {};
    if (!allAddSelected) missingFiles.forEach(f => { next[f.id] = true; });
    setSelectedAdd(next);
  };
  const toggleCanvas = () => setCanvasSelected(prev => !prev);

  const handleApply = async () => {
    if (applying || totalSelected === 0) return;
    setApplying(true);

    // Run snippets and canvas independently; collect both outcomes so a
    // partial failure in one area does not mask success in the other.
    let snippetData = null;
    let canvasOutcome = null;

    // --- Snippets ---
    if (snippetSelected > 0) {
      const actions = [];
      identicalFiles.forEach(f => { if (selectedUpgrade[f.id]) actions.push({ id: f.id, action: 'upgrade' }); });
      driftedFiles.forEach(f => { if (selectedMigrate[f.id]) actions.push({ id: f.id, action: 'migrate' }); });
      missingFiles.forEach(f => { if (selectedAdd[f.id]) actions.push({ id: f.id, action: 'add' }); });
      try {
        const res = await apiFetch('/api/snippets/apply', {
          method: 'POST',
          body: JSON.stringify({ actions }),
        });
        snippetData = await res.json();
      } catch {
        snippetData = { ok: false, error: 'Network error' };
      }
      setResult(snippetData);
    }

    // --- Canvas migration (all pending) ---
    if (canvasCount > 0) {
      try {
        const response = await runCanvasMigration(canvasPending.map(p => p.project));
        canvasOutcome = applyRunResults(canvasStatus, response);
        setCanvasResult(canvasOutcome);
      } catch (err) {
        canvasOutcome = { succeeded: [], failed: [], requestError: err?.message || 'Migration request failed' };
        setCanvasResult(canvasOutcome);
      }
    }

    setApplying(false);

    // Reload status (chip recomputed) and close only when everything succeeded.
    const snippetOk = snippetSelected === 0
      || (snippetData?.ok && (snippetData?.applied?.length || 0) > 0 && (snippetData?.skipped?.length || 0) === 0);
    const canvasOk = canvasCount === 0
      || (!!canvasOutcome && !canvasOutcome.requestError && canvasOutcome.failed.length === 0 && canvasOutcome.succeeded.length > 0);

    if (snippetOk && canvasOk) {
      setTimeout(() => {
        onApplied?.();
        onClose?.();
      }, 900);
    }
    // On partial failure we keep the result phase visible (failed rows + error
    // footer). The chip/status is refreshed when the modal closes (onClose),
    // so resolved areas drop off without wiping the visible result.
  };

  const appliedCount = result?.applied?.length || 0;
  const skippedCount = result?.skipped?.length || 0;
  const snippetApplied = !!result?.ok && appliedCount > 0 && skippedCount === 0;
  const snippetFailed = !!result && (!result.ok || appliedCount === 0 || skippedCount > 0);

  // Canvas outcome flags (separate area; partial failures shown independently).
  const canvasMigrated = canvasResult?.succeeded?.length || 0;
  const canvasFailedCount = canvasResult?.failed?.length || 0;
  const canvasApplied = !!canvasResult && !canvasResult.requestError
    && canvasFailedCount === 0 && canvasMigrated > 0;
  const canvasFailed = !!canvasResult
    && (!!canvasResult.requestError || canvasFailedCount > 0 || (canvasMigrated === 0 && !canvasResult.requestError));

  // Used to mark snippet FileRows as done in the result phase.
  const applied = snippetApplied;

  // Whole-window state: everything attempted, all succeeded.
  const attemptedSnippet = snippetSelected > 0;
  const attemptedCanvas = canvasCount > 0;
  const fullyApplied = (result !== null || canvasResult !== null)
    && (!attemptedSnippet || snippetApplied)
    && (!attemptedCanvas || canvasApplied)
    && (attemptedSnippet || attemptedCanvas);
  const anyFailed = snippetFailed || canvasFailed;
  const hasAnything = identicalFiles.length + driftedFiles.length + missingFiles.length + bootLegacyFiles.length + legacyStateFiles.length + configAdvisories.length + bootstrapDocAdvisories.length + canvasPending.length + canvasConflicts.length > 0;

  // Modal title & subtitle follow the chip variant. Any pending migration
  // (snippet drift or canvas) makes this a "Migration" window.
  const isWarn = status.chip?.variant === 'warn' || canvasPending.length > 0;
  const title = isWarn
    ? 'FlowBoard · Migration'
    : 'FlowBoard · Setup';
  const subtitle = [
    identicalFiles.length > 0 && `${identicalFiles.length} safe upgrade${identicalFiles.length !== 1 ? 's' : ''}`,
    driftedFiles.length > 0 && `${driftedFiles.length} migration${driftedFiles.length !== 1 ? 's' : ''}`,
    missingFiles.length > 0 && `${missingFiles.length} AGENTS.md file${missingFiles.length !== 1 ? 's' : ''} missing FlowBoard`,
    canvasPending.length > 0 && `${canvasPending.length} canvas migration${canvasPending.length !== 1 ? 's' : ''}`,
    bootLegacyFiles.length > 0 && `${bootLegacyFiles.length} legacy BOOT.md advisory${bootLegacyFiles.length !== 1 ? 'ies' : ''}`,
    legacyStateFiles.length > 0 && `${legacyStateFiles.length} legacy state file${legacyStateFiles.length !== 1 ? 's' : ''}`,
    configAdvisories.length > 0 && `${configAdvisories.length} OpenClaw config advisory${configAdvisories.length !== 1 ? 'ies' : ''}`,
    bootstrapDocAdvisories.length > 0 && `${bootstrapDocAdvisories.length} project doc warning${bootstrapDocAdvisories.length !== 1 ? 's' : ''}`,
  ].filter(Boolean).join(' · ');

  return createPortal(
    <div
      className="snippet-modal-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    >
      <div className="upgrade-modal" role="dialog" aria-modal="true" aria-labelledby="upgrade-title">
        <div className="modal-header">
          <div className="modal-header-left">
            <div className="modal-header-icon"><Sparkles size={16} /></div>
            <div>
              <div id="upgrade-title" className="modal-title">{title}</div>
              <div className="modal-subtitle">{subtitle || 'Nothing to do'}</div>
            </div>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <ScrollArea className="modal-body-wrap" innerClassName="modal-body-v2">
          {missingFiles.length > 0 && (
            <div className="group setup-explainer">
              <div className="group-header">
                <div className="group-header-text">
                  <div className="group-title">Add FlowBoard to existing AGENTS.md</div>
                  <div className="group-sub">These existing agent instruction files are not broken. They simply do not contain the FlowBoard project trigger yet. Select only the agents that should use FlowBoard project context.</div>
                </div>
              </div>
            </div>
          )}

          {identicalFiles.length > 0 && (
            <GroupSection
              title="Upgrade"
              sub={`${upgradeCount} of ${identicalFiles.length} selected · byte-identical, safe auto-upgrade`}
              icon={<ArrowUpCircle size={13} />}
              iconVariant="ok"
              allSelected={allUpgradeSelected}
              someSelected={someUpgradeSelected}
              onToggleAll={toggleAllUpgrade}
              files={identicalFiles}
              selected={selectedUpgrade}
              onToggleFile={toggleUpgrade}
              expandedId={expandedId}
              onExpand={toggleExpand}
              applied={applied}
              actionLabel="Upgraded"
            />
          )}

          {driftedFiles.length > 0 && (
            <GroupSection
              title="Migration required"
              sub={`${migrateCount} of ${driftedFiles.length} selected · mandatory for FlowBoard to work — force-replace with the canonical snippet. A .bak-<timestamp> is written first; uncheck to preserve a specific customization.`}
              icon={<AlertTriangle size={13} />}
              iconVariant="warn"
              allSelected={allMigrateSelected}
              someSelected={someMigrateSelected}
              onToggleAll={toggleAllMigrate}
              files={driftedFiles}
              selected={selectedMigrate}
              onToggleFile={toggleMigrate}
              expandedId={expandedId}
              onExpand={toggleExpand}
              applied={applied}
              actionLabel="Migrated"
            />
          )}

          {missingFiles.length > 0 && (
            <GroupSection
              title="Existing AGENTS.md without FlowBoard"
              sub={`${addCount} of ${missingFiles.length} selected · optional — check only agents that should use FlowBoard.`}
              icon={<Plus size={13} />}
              iconVariant="info"
              allSelected={allAddSelected}
              someSelected={someAddSelected}
              onToggleAll={toggleAllAdd}
              files={missingFiles}
              selected={selectedAdd}
              onToggleFile={toggleAdd}
              expandedId={expandedId}
              onExpand={toggleExpand}
              applied={applied}
              actionLabel="Added"
            />
          )}

          {canvasPending.length > 0 && (
            <CanvasMigrationSection
              pending={canvasPending}
              selected={canvasSelected}
              onToggle={toggleCanvas}
              result={canvasResult}
            />
          )}

          {canvasConflicts.length > 0 && (
            <CanvasConflictSection conflicts={canvasConflicts} />
          )}

          {bootLegacyFiles.length > 0 && (
            <BootLegacySection files={bootLegacyFiles} />
          )}

          {legacyStateFiles.length > 0 && (
            <LegacyStateSection files={legacyStateFiles} />
          )}

          {configAdvisories.length > 0 && (
            <ConfigAdvisorySection files={configAdvisories} />
          )}

          {bootstrapDocAdvisories.length > 0 && (
            <BootstrapDocAdvisorySection files={bootstrapDocAdvisories} />
          )}

          {!hasAnything && (
            <div className="group">
              <div className="group-header">
                <div className="group-header-text">
                  <div className="group-title">Nothing to do</div>
                  <div className="group-sub">All workspaces are configured correctly.</div>
                </div>
              </div>
            </div>
          )}
        </ScrollArea>

        <div className="modal-footer">
          <div className="footer-left">
            {fullyApplied ? (
              <span className="footer-status ok">
                <Check size={12} /> Done
                {attemptedSnippet && ` · ${appliedCount} change${appliedCount !== 1 ? 's' : ''}`}
                {attemptedCanvas && ` · ${canvasMigrated} canvas project${canvasMigrated !== 1 ? 's' : ''}`}
              </span>
            ) : anyFailed ? (
              <span className="footer-hint" style={{ color: 'var(--danger)' }}>
                {snippetFailed && (result.error || `Snippets incomplete — ${appliedCount} applied, ${skippedCount} skipped`)}
                {snippetFailed && canvasFailed && ' · '}
                {canvasFailed && (canvasResult.requestError || `Canvas migration: ${canvasFailedCount} failed`)}
              </span>
            ) : (
              <span className="footer-hint">
                Every change writes a backup copy first.
              </span>
            )}
          </div>
          <div className="footer-actions">
            <button className="btn btn-secondary btn-sm" onClick={onClose}>
              {fullyApplied ? 'Close' : 'Not now'}
            </button>
            <button
              className="btn btn-primary btn-sm"
              onClick={handleApply}
              disabled={totalSelected === 0 || applying || fullyApplied}
            >
              {fullyApplied
                ? 'Applied'
                : applying
                  ? 'Applying…'
                  : totalSelected === 0
                    ? 'Nothing selected'
                    : `Apply ${totalSelected} change${totalSelected !== 1 ? 's' : ''}`}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.getElementById('modalRoot') || document.body
  );
}

// Reusable checkbox styled as a button. Uses aria-pressed for state instead
// of a native <input>, which avoids two subtle bugs we hit with label+input:
//  (a) browsers forward label clicks to the wrapped input in addition to
//      firing the label's React onClick — `e.stopPropagation()` only stops
//      React's synthetic bubbling, not the native forward.
//  (b) `<input readOnly>` is not valid on checkboxes and causes inconsistent
//      click behavior across browsers.
// aria-pressed="true/false/mixed" covers a11y for toggle + indeterminate.
function CheckboxButton({ checked, indeterminate, onClick, className = '', title }) {
  const classes = ['cb-button', className].filter(Boolean).join(' ');
  const ariaPressed = indeterminate ? 'mixed' : !!checked;
  return (
    <button
      type="button"
      className={classes}
      onClick={(e) => { e.stopPropagation(); onClick?.(); }}
      aria-pressed={ariaPressed}
      title={title}
    >
      <span className="checkbox-box" aria-hidden="true">
        {indeterminate
          ? <span className="checkbox-dash" />
          : checked ? <Check size={11} /> : null}
      </span>
    </button>
  );
}

// Group-header + body wrapper. Every group has:
//   - a master checkbox on the left (toggles all in the group)
//   - a decorative icon in its own lane
//   - title + sub text
// Consistent across Upgrade / Migration / Add — no more "this group has a
// checkbox but that one doesn't" inconsistency.
function GroupSection({
  title, sub, icon, iconVariant = 'info',
  allSelected, someSelected, onToggleAll,
  files, selected, onToggleFile,
  expandedId, onExpand, applied, actionLabel,
}) {
  return (
    <div className="group">
      <div className="group-header group-header-v2">
        <CheckboxButton
          checked={allSelected}
          indeterminate={someSelected}
          onClick={onToggleAll}
          className="group-checkbox"
          title={allSelected ? 'Deselect all' : 'Select all'}
        />
        <div className={`group-header-icon ${iconVariant}`}>{icon}</div>
        <div className="group-header-text">
          <div className="group-title">{title}</div>
          <div className="group-sub">{sub}</div>
        </div>
      </div>
      <div className="group-body">
        {files.map(f => (
          <FileRow
            key={f.id}
            file={f}
            checked={!!selected[f.id]}
            onToggle={() => onToggleFile(f.id)}
            expanded={expandedId === f.id}
            onExpand={() => onExpand(f.id)}
            applied={applied && !!selected[f.id]}
            actionLabel={actionLabel}
          />
        ))}
      </div>
    </div>
  );
}

// Canvas data migration group (T-344-9). One mandatory group with a master
// checkbox (all pending projects migrate together) — reuses the existing
// .group / .group-header-v2 / .group-body / .file-row structure, no new CSS.
function CanvasMigrationSection({ pending, selected, onToggle, result }) {
  const succeeded = new Set((result?.succeeded || []).map(r => r.project));
  const failedMap = new Map((result?.failed || []).map(r => [r.project, r]));
  return (
    <div className="group">
      <div className="group-header group-header-v2">
        <CheckboxButton
          checked={selected}
          onClick={onToggle}
          className="group-checkbox"
          title={selected ? 'Deselect' : 'Select'}
        />
        <div className="group-header-icon warn"><Database size={13} /></div>
        <div className="group-header-text">
          <div className="group-title">Canvas data migration</div>
          <div className="group-sub">
            {pending.length} project{pending.length !== 1 ? 's' : ''} still store canvas data in a local canvas.json file — import all notes and connections into the database. Each file is preserved as {CANVAS_MIGRATION_BACKUP_FILE} first; nothing is deleted.
          </div>
        </div>
      </div>
      <div className="group-body">
        {pending.map(p => {
          const failure = failedMap.get(p.project);
          const done = succeeded.has(p.project);
          return (
            <div key={p.project} className="file-row">
              <div className="file-row-main">
                <div className="file-row-text">
                  <div className="file-row-path">
                    <span className="mono" title={p.project}>{projectLabel(p)}</span>
                    {done && <span className="chip ok"><Check size={10} /> Migrated</span>}
                    {failure && <span className="chip warn">Failed</span>}
                  </div>
                  <div className="file-row-summary">{countsLine(p)}</div>
                  {failure && <div className="file-row-summary" style={{ color: 'var(--danger)' }}>{failure.error || 'unknown error'}</div>}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Canvas migration conflicts (T-344-5) — display-only, cannot be auto-resolved.
function CanvasConflictSection({ conflicts }) {
  return (
    <div className="group">
      <div className="group-header group-header-v2">
        <div className="group-header-icon warn"><AlertTriangle size={13} /></div>
        <div className="group-header-text">
          <div className="group-title">Canvas data conflict — resolve manually</div>
          <div className="group-sub">Display-only advisory: these projects have canvas data in both the database and a local canvas.json. FlowBoard will not overwrite either side automatically — reconcile them by hand before migrating.</div>
        </div>
      </div>
      <div className="group-body">
        {conflicts.map(c => (
          <div key={c.project} className="file-row">
            <div className="file-row-main">
              <div className="file-row-text">
                <div className="file-row-path">
                  <span className="mono" title={c.project}>{projectLabel(c)}</span>
                  <span className="chip warn">Conflict</span>
                </div>
                <div className="file-row-summary">{countsLine(c)}</div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function BootLegacySection({ files }) {
  return (
    <div className="group">
      <div className="group-header group-header-v2">
        <div className="group-header-icon warn"><AlertTriangle size={13} /></div>
        <div className="group-header-text">
          <div className="group-title">Legacy BOOT.md cleanup required</div>
          <div className="group-sub">Display-only advisory: BOOT.md is OpenClaw-owned, so FlowBoard will not edit it automatically.</div>
          <div className="group-sub">Open the file, remove only the deprecated FlowBoard section (for example “Project State Recovery (FlowBoard)”), keep all other OpenClaw/user content unchanged, save, then refresh this dashboard.</div>
        </div>
      </div>
      <div className="group-body">
        {files.map(file => (
          <div key={file.id} className="file-row">
            <div className="file-row-main">
              <div className="file-row-text">
                <div className="file-row-path">
                  <span className="mono" title={file.path}>{shortPath(file.path)}</span>
                  <span className="chip warn">Manual cleanup</span>
                </div>
                <div className="file-row-summary">{file.summary}</div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function LegacyStateSection({ files }) {
  return (
    <div className="group">
      <div className="group-header group-header-v2">
        <div className="group-header-icon warn"><AlertTriangle size={13} /></div>
        <div className="group-header-text">
          <div className="group-title">Legacy project-state cleanup required</div>
          <div className="group-sub">Display-only advisory: these files can contain stale active-project/session state and FlowBoard will not edit them automatically.</div>
          <div className="group-sub">Archive or remove them manually after checking they do not contain durable notes. Current project state comes from `/api/status` and `flowboard_agents`.</div>
        </div>
      </div>
      <div className="group-body">
        {files.map(file => (
          <div key={file.id} className="file-row">
            <div className="file-row-main">
              <div className="file-row-text">
                <div className="file-row-path">
                  <span className="mono" title={file.path}>{shortPath(file.path)}</span>
                  <span className="chip warn">Manual cleanup</span>
                </div>
                <div className="file-row-summary">{file.summary}</div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ConfigAdvisorySection({ files }) {
  return (
    <div className="group">
      <div className="group-header group-header-v2">
        <div className="group-header-icon warn"><AlertTriangle size={13} /></div>
        <div className="group-header-text">
          <div className="group-title">OpenClaw config cleanup required</div>
          <div className="group-sub">Display-only advisory: FlowBoard can detect stale OpenClaw config/runtime state, but will not rewrite config or restart OpenClaw automatically.</div>
          <div className="group-sub">Update the config if needed, then restart OpenClaw so new sessions and compaction prompts use the migrated API-first memoryFlush rules.</div>
        </div>
      </div>
      <div className="group-body">
        {files.map(file => (
          <div key={file.id} className="file-row">
            <div className="file-row-main">
              <div className="file-row-text">
                <div className="file-row-path">
                  <span className="mono" title={file.path}>{shortPath(file.path)}</span>
                  <span className="chip warn">Manual cleanup</span>
                </div>
                <div className="file-row-summary">{file.summary}</div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function BootstrapDocAdvisorySection({ files }) {
  return (
    <div className="group">
      <div className="group-header group-header-v2">
        <div className="group-header-icon warn"><AlertTriangle size={13} /></div>
        <div className="group-header-text">
          <div className="group-title">Project doc task-state warnings</div>
          <div className="group-sub">Display-only advisory: PROJECT.md should stay stable project knowledge. Current work, claims, priorities, and next steps belong to FlowBoard/HZL tasks.</div>
        </div>
      </div>
      <div className="group-body">
        {files.map(file => (
          <div key={file.id} className="file-row">
            <div className="file-row-main">
              <div className="file-row-text">
                <div className="file-row-path">
                  <span className="mono" title={file.path}>{shortPath(file.path)}:{file.line}</span>
                  <span className="chip warn">{file.rule}</span>
                </div>
                <div className="file-row-summary">{file.summary}</div>
                {file.snippet && <div className="file-row-summary mono">{file.snippet}</div>}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function FileRow({ file, checked, onToggle, expanded, onExpand, applied, actionLabel }) {
  const classes = ['file-row'];
  if (expanded) classes.push('expanded');
  if (applied) classes.push('upgraded');

  return (
    <div className={classes.join(' ')}>
      <div className="file-row-main" onClick={onExpand}>
        <CheckboxButton
          checked={checked}
          onClick={onToggle}
          className="file-row-checkbox"
          title={checked ? 'Deselect' : 'Select'}
        />
        <div className="file-row-text">
          <div className="file-row-path">
            <span className="mono" title={file.path}>{shortPath(file.path)}</span>
            <span className="file-row-bytes">{file.bytes}</span>
            {applied && <span className="chip ok"><Check size={10} /> {actionLabel}</span>}
          </div>
          <div className="file-row-summary">{file.summary}</div>
        </div>
        <button
          type="button"
          className="file-row-toggle"
          onClick={(e) => { e.stopPropagation(); onExpand?.(); }}
        >
          <ChevronRight size={13} className={expanded ? 'rot' : ''} />
          <span>{expanded ? 'Hide diff' : 'View diff'}</span>
        </button>
      </div>
      {expanded && (
        <div className="file-row-detail">
          <Diff diff={file.diff} />
        </div>
      )}
    </div>
  );
}

function Diff({ diff }) {
  if (!Array.isArray(diff) || diff.length === 0) {
    return <div className="diff"><div className="diff-body" style={{ padding: 12, color: 'var(--muted)' }}>No diff available</div></div>;
  }
  return (
    <div className="diff">
      <div className="diff-body">
        {diff.map((l, i) => {
          if (l.t === 'hunk') {
            return <div key={i} className="diff-line hunk"><span className="diff-text">{l.text}</span></div>;
          }
          return (
            <div key={i} className={`diff-line ${l.t}`}>
              <span className="diff-sigil" aria-hidden="true">{sigilFor(l.t)}</span>
              <span className="diff-ln">{l.n ?? ''}</span>
              <span className="diff-text">{l.text}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function sigilFor(type) {
  if (type === 'add') return '+';
  if (type === 'del') return '-';
  if (type === 'conflict') return '~';
  return ' ';
}

function shortPath(abs) {
  const m = String(abs).match(/\/\.openclaw\/([^/]+)\/([^/]+)$/);
  if (m) return `${m[1]}/${m[2]}`;
  return abs;
}
