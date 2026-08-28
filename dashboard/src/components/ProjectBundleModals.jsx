import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clipboard,
  Download,
  FileJson,
  FolderOpen,
  Info,
  RefreshCw,
  ShieldAlert,
  Upload,
  X,
} from 'lucide-react';
import Modal from './Modal.jsx';
import Button from './Button.jsx';
import Input from './Input.jsx';
import FormGroup from './FormGroup.jsx';
import Alert from './Alert.jsx';
import Spinner from './Spinner.jsx';
import { apiFetch } from '../utils/apiFetch.js';

const BUNDLE_MEDIA_TYPE = 'application/vnd.flowboard.project+json';
const SENSITIVE_EXPORT_CONFIRMATION = 'export-sensitive-project';
const MAX_WARNING_ITEMS = 5;
const IMPORT_PHASES = [
  'Validating bundle',
  'Staging files',
  'Creating project',
  'Importing tasks',
  'Importing files and specs',
  'Restoring canvas',
  'Verifying project',
];
const COUNT_LABELS = {
  tasks: 'Tasks',
  specs: 'Specs',
  canvasNotes: 'Canvas notes',
  canvasConnections: 'Connections',
  overviewWidgets: 'Overview widgets',
  files: 'Markdown files',
  historyComments: 'Comments',
  historyCheckpoints: 'Checkpoints',
};

const SPEC_DIAGNOSTIC_REASON_LABELS = Object.freeze({
  SPEC_READ_FAILED: 'The linked spec is missing or unreadable.',
  SPEC_SYMLINK_UNSUPPORTED: 'The linked spec is a symlink and cannot be exported.',
  SPEC_TOO_LARGE: 'The linked spec exceeds the supported size limit.',
});

const BUNDLE_DIAGNOSTIC_ACTION_LABELS = Object.freeze({
  REPAIR_OR_CLEAR_PARENT_REFERENCE: 'Repair or clear this task parent reference, then try the export again.',
  REPAIR_OR_CLEAR_DEPENDENCY_REFERENCE: 'Repair or clear this task dependency reference, then try the export again.',
  RELINK_OR_CLEAR_SPEC_REFERENCE: 'Relink this task to its own spec or clear the spec link, then try the export again.',
  REPAIR_MISSING_REFERENCE: 'Repair or clear the missing task reference, then try the export again.',
  REPAIR_INVALID_REFERENCE: 'Repair the invalid task reference, then try the export again.',
  REVIEW_TASK_DATA: 'Review this task data, then try the export again.',
  REVIEW_BUNDLE_DATA: 'Review the bundle data, then try the export again.',
});

function exportErrorMessage(data, status) {
  const code = data?.code;
  if (SPEC_DIAGNOSTIC_REASON_LABELS[code]) return SPEC_DIAGNOSTIC_REASON_LABELS[code];
  if (code === 'BUNDLE_INVALID') return 'The project contains inconsistent task or spec references.';
  if (code === 'SENSITIVE_CONTENT_DETECTED') return 'The project contains credential-like canonical data.';
  if (code === 'LOOPBACK_REQUIRED') return 'Sensitive export recovery is available only from a direct local connection.';
  return `Export failed (HTTP ${status}).`;
}

function responseFilename(response, fallback) {
  const header = response.headers?.get?.('Content-Disposition') || '';
  const encoded = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (encoded) {
    try { return decodeURIComponent(encoded[1].replace(/^"|"$/g, '')); } catch { /* use fallback */ }
  }
  const plain = header.match(/filename="?([^";]+)"?/i);
  return plain?.[1] || fallback;
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 63);
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function countValue(counts, key) {
  return Number.isFinite(Number(counts?.[key])) ? Number(counts[key]) : 0;
}

function WarningList({ title, items = [], variant = 'warn', safeSpecDiagnostics = false, safeBundleDiagnostics = false }) {
  const [expanded, setExpanded] = useState(false);
  if (!items.length) return null;
  const shown = expanded ? items : items.slice(0, MAX_WARNING_ITEMS);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[11px] font-semibold text-text-strong">{title}</div>
      <ul className="m-0 flex list-none flex-col gap-1 rounded-lg border border-solid border-border bg-bg-elevated p-2 text-[11px]">
        {shown.map((item, index) => {
          const code = typeof item === 'string' ? item : item.code || 'Warning';
          const path = safeSpecDiagnostics || safeBundleDiagnostics || typeof item === 'string' ? '' : item.path || '';
          const taskId = typeof item === 'string' ? '' : item.taskId || '';
          const field = safeBundleDiagnostics && typeof item !== 'string' ? item.field || '' : '';
          const guidance = safeBundleDiagnostics
            ? BUNDLE_DIAGNOSTIC_ACTION_LABELS[item.action] || 'Review the listed bundle data, then try the export again.'
            : safeSpecDiagnostics
            ? SPEC_DIAGNOSTIC_REASON_LABELS[code] || 'The linked spec is unavailable.'
            : typeof item === 'string' ? '' : item.guidance || item.action || item.message || '';
          return (
            <li key={`${code}-${path}-${index}`} className="flex min-w-0 items-start gap-1.5 text-muted">
              {variant === 'error' ? <ShieldAlert size={12} className="mt-0.5 shrink-0 text-danger" /> : <AlertTriangle size={12} className="mt-0.5 shrink-0 text-warn" />}
              <span className="min-w-0 break-words">
                <span className="font-mono text-[10px] text-text">{code}</span>
                {taskId && <span className="ml-1 font-mono text-[10px]">Task {taskId}</span>}
                {field && <span className="ml-1 font-mono text-[10px]">Field {field}</span>}
                {path && <span className="ml-1 font-mono text-[10px]">{path}</span>}
                {guidance && <span className="block">{guidance}</span>}
              </span>
            </li>
          );
        })}
      </ul>
      {items.length > MAX_WARNING_ITEMS && (
        <button type="button" className="self-start border-0 bg-transparent p-0 text-[11px] text-accent hover:underline" onClick={() => setExpanded((value) => !value)}>
          {expanded ? 'Show fewer' : `Show all ${items.length} warnings`}
        </button>
      )}
    </div>
  );
}

function CountGrid({ counts, includeHistory = false }) {
  const keys = includeHistory
    ? ['tasks', 'specs', 'canvasNotes', 'canvasConnections', 'overviewWidgets', 'files', 'historyComments', 'historyCheckpoints']
    : ['tasks', 'specs', 'canvasNotes', 'canvasConnections', 'overviewWidgets', 'files'];
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4" data-testid="bundle-counts">
      {keys.map((key) => (
        <div key={key} className="rounded-lg border border-solid border-border bg-bg-elevated px-2.5 py-2">
          <span className="block font-mono text-base leading-none text-text-strong">{countValue(counts, key)}</span>
          <span className="mt-1 block truncate text-[10px] text-muted">{COUNT_LABELS[key]}</span>
        </div>
      ))}
    </div>
  );
}

function ScopeLists({ includeHistory }) {
  const included = [
    'Tasks and their current state',
    'Linked specs and safe Markdown content',
    'Canvas notes, connections and overview layout',
    ...(includeHistory ? ['Task comments and checkpoints'] : []),
  ];
  const excluded = [
    'Agents, claims, leases, routing and notifications',
    'Sessions, audit logs and credentials',
    'Executable, hidden and backup files',
  ];
  return (
    <div className="grid gap-4 border-t border-solid border-border pt-3 sm:grid-cols-2" data-testid="bundle-scope">
      <div>
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.09em] text-ok">Included</div>
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-xs leading-5 text-text">
          {included.map((item) => <li key={item} className="flex items-start gap-1.5"><Check size={13} className="mt-1 shrink-0 text-ok" />{item}</li>)}
        </ul>
      </div>
      <div>
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.09em] text-muted">Not included</div>
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-xs leading-5 text-muted">
          {excluded.map((item) => <li key={item} className="flex items-start gap-1.5"><X size={13} className="mt-1 shrink-0" />{item}</li>)}
        </ul>
      </div>
    </div>
  );
}

function BundleHeader({ icon: Icon, title, subtitle }) {
  return (
    <div className="mb-4 flex items-start gap-3">
      <span className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-solid border-border bg-bg-elevated text-accent"><Icon size={18} /></span>
      <div>
        <div className="text-sm font-semibold text-text-strong">{title}</div>
        {subtitle && <div className="mt-1 text-xs leading-5 text-muted">{subtitle}</div>}
      </div>
    </div>
  );
}

function ExportProjectModal({ open, onClose, project }) {
  const [includeHistory, setIncludeHistory] = useState(false);
  const [state, setState] = useState('loading');
  const [bundle, setBundle] = useState(null);
  const [bodyText, setBodyText] = useState('');
  const [filename, setFilename] = useState('project-review-bundle.flowboard.json');
  const [error, setError] = useState(null);
  const [confirmation, setConfirmation] = useState('');
  const abortRef = useRef(null);

  const fallbackName = `${slugify(project?.name) || 'project'}-review-bundle.flowboard.json`;

  const loadBundle = useCallback(async (history, signal, sensitiveOverride = false) => {
    setState('loading');
    setError(null);
    setBundle(null);
    try {
      const query = history ? '?includeHistory=true' : '';
      const response = await apiFetch(`/api/projects/${encodeURIComponent(project?.name || '')}/export${query}`, {
        method: sensitiveOverride ? 'POST' : 'GET',
        ...(sensitiveOverride ? { body: { confirmation: SENSITIVE_EXPORT_CONFIRMATION } } : {}),
        signal,
      });
      const text = await response.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { /* handled below */ }
      if (!response.ok) {
        const failure = new Error(exportErrorMessage(data, response.status));
        failure.code = data?.code || null;
        failure.diagnostics = Array.isArray(data?.diagnostics) ? data.diagnostics : [];
        throw failure;
      }
      if (!data || typeof data !== 'object' || !data.manifest) throw new Error('The server returned an invalid project bundle.');
      setBundle(data);
      setBodyText(text);
      setFilename(responseFilename(response, fallbackName));
      setState(Array.isArray(data.manifest?.warnings) && data.manifest.warnings.length > 0 ? 'warnings' : 'ready');
    } catch (err) {
      if (err?.name === 'AbortError') return;
      setError({
        message: err?.message || 'Project export failed.',
        code: err?.code || null,
        diagnostics: Array.isArray(err?.diagnostics) ? err.diagnostics : [],
      });
      setState('blocked');
    }
  }, [fallbackName, project?.name]);

  useEffect(() => {
    if (!open) return undefined;
    const controller = new AbortController();
    abortRef.current = controller;
    loadBundle(includeHistory, controller.signal);
    return () => {
      controller.abort();
      if (abortRef.current === controller) abortRef.current = null;
    };
  }, [open]); // Loading is intentionally reset only when opening; checkbox changes call it explicitly.

  useEffect(() => {
    if (!open) {
      setIncludeHistory(false);
      setState('loading');
      setBundle(null);
      setBodyText('');
      setError(null);
      setConfirmation('');
    }
  }, [open]);

  async function toggleHistory(event) {
    const next = event.target.checked;
    setIncludeHistory(next);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    await loadBundle(next, controller.signal);
  }

  function handleDownload() {
    if (!bodyText || !['ready', 'warnings'].includes(state)) return;
    setState('downloading');
    // Give the state announcement a paint before constructing the Blob. This
    // keeps the ready/downloading transition observable to keyboard and AT users.
    window.setTimeout(() => {
      try {
        const blob = new Blob([bodyText], { type: BUNDLE_MEDIA_TYPE });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename || fallbackName;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 0);
        setState('ready');
      } catch (err) {
        setError({ message: err?.message || 'The bundle could not be downloaded.', code: null, diagnostics: [] });
        setState('blocked');
      }
    }, 0);
  }

  async function continueWithoutHistory() {
    setIncludeHistory(false);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    await loadBundle(false, controller.signal);
  }

  async function confirmSensitiveExport() {
    if (confirmation !== SENSITIVE_EXPORT_CONFIRMATION) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    await loadBundle(includeHistory, controller.signal, true);
  }

  const counts = bundle?.manifest?.counts || {};
  const manifestWarnings = bundle?.manifest?.warnings || [];
  const dismissible = state !== 'downloading';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Export project"
      size="lg"
      showClose
      dismissible={dismissible}
      actions={state === 'blocked' ? (
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
          {includeHistory && <Button variant="secondary" size="sm" onClick={continueWithoutHistory}>Continue without history</Button>}
          <Button size="sm" onClick={() => loadBundle(includeHistory)}><RefreshCw size={13} /> Try again</Button>
        </>
      ) : (
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={state === 'downloading'}>Cancel</Button>
          <Button size="sm" onClick={handleDownload} disabled={!['ready', 'warnings'].includes(state)}>
            {state === 'downloading' ? <><Spinner size="sm" /> Downloading…</> : <><Download size={13} /> Download project bundle</>}
          </Button>
        </>
      )}
    >
      <div className="bundle-modal-body flex flex-col gap-4" aria-live="polite" data-bundle-state={state}>
        {state === 'loading' && (
          <div className="flex items-center gap-3 rounded-lg border border-solid border-border bg-bg-elevated p-4" data-testid="export-loading">
            <Spinner size="md" />
            <div><div className="text-sm font-semibold text-text-strong">Preparing project review bundle…</div><div className="mt-1 text-xs text-muted">Reading the project manifest and content counts.</div></div>
          </div>
        )}
        {state === 'blocked' && (
          <div className="flex flex-col gap-3">
            <Alert variant="error" title={error?.code === 'BUNDLE_INVALID' ? 'Export blocked — repair required' : 'Export blocked'}><span data-testid="export-error">{error?.message || 'The project could not be exported.'}</span></Alert>
            {error?.code === 'BUNDLE_INVALID' && (
              <Alert variant="info" title="How to recover">
                <span data-testid="export-recovery-guidance">Repair or clear the listed task references in FlowBoard, then try the export again.</span>
              </Alert>
            )}
            {error?.diagnostics?.length > 0 && (
              <div data-testid="export-diagnostics">
                <WarningList
                  title={error?.code === 'BUNDLE_INVALID' ? 'Bundle integrity recovery' : 'Linked spec recovery'}
                  items={error.diagnostics}
                  variant="error"
                  safeSpecDiagnostics={error?.code !== 'BUNDLE_INVALID'}
                  safeBundleDiagnostics={error?.code === 'BUNDLE_INVALID'}
                />
              </div>
            )}
            {error?.code === 'SENSITIVE_CONTENT_DETECTED' && (
              <div className="flex flex-col gap-3 rounded-lg border border-solid border-warn bg-warn-subtle p-3" data-testid="sensitive-export-recovery">
                <div className="text-xs leading-5 text-text">The canonical project data contains credential-like text. Review the project locally before intentionally downloading it.</div>
                <FormGroup label={`Type ${SENSITIVE_EXPORT_CONFIRMATION} to confirm`} htmlFor="sensitive-export-confirmation" hint="This recovery action is available only from a direct loopback connection and is audited.">
                  <Input
                    id="sensitive-export-confirmation"
                    value={confirmation}
                    onChange={(event) => setConfirmation(event.target.value)}
                    autoComplete="off"
                    spellCheck="false"
                  />
                </FormGroup>
                <Button
                  variant="danger-outline"
                  size="sm"
                  onClick={confirmSensitiveExport}
                  disabled={confirmation !== SENSITIVE_EXPORT_CONFIRMATION}
                >
                  <ShieldAlert size={13} /> Confirm and export sensitive content
                </Button>
              </div>
            )}
          </div>
        )}
        {state !== 'blocked' && state !== 'loading' && bundle && (
          <>
            <BundleHeader icon={FileJson} title={bundle.project?.displayName || project?.displayName || project?.name} subtitle={`Project review bundle · ${bundle.project?.slug || project?.name || ''}`} />
            <CountGrid counts={counts} includeHistory={includeHistory} />
            <div className="rounded-lg border border-solid border-border bg-bg-elevated p-3">
              <label className="flex cursor-pointer items-start gap-2 text-xs text-text" htmlFor="include-task-history">
                <input id="include-task-history" type="checkbox" checked={includeHistory} onChange={toggleHistory} className="mt-0.5 h-4 w-4 accent-accent" disabled={state === 'downloading'} />
                <span><span className="font-medium text-text-strong">Include task history</span><span className="mt-1 block text-[11px] leading-4 text-muted">Includes comments and checkpoints. Agent attribution and historical context may contain sensitive information.</span></span>
              </label>
            </div>
            {includeHistory && <Alert variant="warn" title="History may contain sensitive context">Review comments and checkpoints before sharing this project bundle.</Alert>}
            <ScopeLists includeHistory={includeHistory} />
            <WarningList title="Manifest warnings" items={manifestWarnings} />
          </>
        )}
      </div>
    </Modal>
  );
}

function suggestedCopyName(name) {
  const base = slugify(name) || 'imported-project';
  return `${base.slice(0, 58)}-copy`;
}

function errorSummary(data, status) {
  if (data?.error) return `${data.error}${data.code ? ` (${data.code})` : ''}`;
  if (status === 415) return 'This file format is not supported. Select a FlowBoard project bundle JSON file.';
  if (status === 422) return 'The bundle did not pass the safety and compatibility checks.';
  return `Import failed (HTTP ${status}).`;
}

function ImportSteps({ stage }) {
  const steps = [['select', 'Select'], ['review', 'Review'], ['progress', 'Import']];
  const activeIndex = stage === 'success' || stage === 'failure' ? 2 : steps.findIndex(([key]) => key === stage);
  return (
    <div className="mb-3 flex items-center gap-4 text-[11px]" aria-label="Import steps">
      {steps.map(([key, label], index) => (
        <span key={key} className={`inline-flex items-center gap-1.5 ${index < activeIndex ? 'text-ok' : index === activeIndex ? 'font-semibold text-text-strong' : 'text-muted'}`}>
          <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-solid border-border-strong text-[10px]">{index < activeIndex ? <Check size={11} /> : index + 1}</span>{label}
        </span>
      ))}
    </div>
  );
}

function ImportPreviewSummary({ preview, targetName, onTargetChange, onUseSuggested, targetInputRef }) {
  const counts = preview?.counts || {};
  const conflict = preview?.target?.availability === 'conflict';
  const targetValid = /^[a-z0-9][a-z0-9-]{0,62}$/.test(targetName);
  const errors = preview?.errors || [];
  const manifestWarnings = preview?.manifestWarnings || preview?.warnings || [];
  const securityWarnings = preview?.securityWarnings || [];
  return (
    <div className="flex flex-col gap-4" data-testid="import-review">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-solid border-border bg-bg-elevated p-3">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.09em] text-muted">Source</div>
          <div className="truncate text-sm font-semibold text-text-strong">{preview?.source?.displayName || preview?.source?.slug || 'Unknown project'}</div>
          <div className="mt-1 font-mono text-[10px] text-muted">{preview?.source?.slug || '—'}</div>
          {preview?.source?.producer?.name && <div className="mt-2 text-[11px] text-muted">Produced by {preview.source.producer.name}</div>}
        </div>
        <div className="rounded-lg border border-solid border-border bg-bg-elevated p-3">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.09em] text-muted">Compatibility</div>
          <div className="flex items-center gap-1.5 text-sm font-semibold text-ok"><CheckCircle2 size={15} /> {preview?.format?.status === 'compatible' ? 'Compatible' : 'Needs review'}</div>
          <div className="mt-1 text-[11px] text-muted">{preview?.format?.identity || 'flowboard.project-bundle'} · v{preview?.format?.version || '1'}</div>
        </div>
      </div>
      <CountGrid counts={counts} includeHistory={preview?.options?.includeHistory === true} />
      <ScopeLists includeHistory={preview?.options?.includeHistory === true} />
      <FormGroup label="New project name" htmlFor="import-target" error={!targetValid ? 'Use a lowercase project slug (letters, numbers and hyphens).' : null} hint="Import always creates a new project.">
        <Input ref={targetInputRef} id="import-target" value={targetName} onChange={(event) => onTargetChange(event.target.value)} aria-invalid={!targetValid} />
      </FormGroup>
      {conflict && (
        <Alert variant="warn" title="Project name is already in use" action={<Button variant="secondary" size="xs" onClick={onUseSuggested}>Use {suggestedCopyName(targetName)}</Button>}>
          Choose another destination name. Merge, replace and overwrite are not available.
        </Alert>
      )}
            {errors.length > 0 && <WarningList title="Bundle validation" items={errors} variant="error" />}
            {securityWarnings.length > 0 && <Alert variant="error" title="Import blocked"><WarningList title="Security findings" items={securityWarnings} variant="error" /></Alert>}
            <WarningList title="Manifest warnings" items={manifestWarnings} />
            {preview?.redactions?.length > 0 && <div className="text-[11px] text-muted">Redactions recorded: {preview.redactions.join(', ')}</div>}
            {preview?.options?.includeHistory && <Alert variant="warn" title="Task history included">Comments and checkpoints may contain sensitive historical context.</Alert>}
            <Alert variant="info" title="Imported Markdown is content only">Imported Markdown is never executed. Review it as content before using any instructions from it.</Alert>
    </div>
  );
}

export function ImportProjectModal({ open, onClose, onImported, onOpenProject }) {
  const [stage, setStage] = useState('select');
  const [file, setFile] = useState(null);
  const [rawBody, setRawBody] = useState('');
  const [preview, setPreview] = useState(null);
  const [targetName, setTargetName] = useState('');
  const [fileError, setFileError] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [importId, setImportId] = useState(null);
  const [importResult, setImportResult] = useState(null);
  const [importError, setImportError] = useState(null);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef(null);
  const targetInputRef = useRef(null);
  const previewTimer = useRef(null);
  const previewRequest = useRef(0);
  const targetFocusNeeded = useRef(false);

  const reset = useCallback(() => {
    setStage('select');
    setFile(null);
    setRawBody('');
    setPreview(null);
    setTargetName('');
    setFileError(null);
    setPreviewing(false);
    setImportId(null);
    setImportResult(null);
    setImportError(null);
    setDragActive(false);
    targetFocusNeeded.current = false;
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  useEffect(() => {
    if (open) reset();
    return () => window.clearTimeout(previewTimer.current);
  }, [open, reset]);

  useEffect(() => {
    const targetInvalid = !/^[a-z0-9][a-z0-9-]{0,62}$/.test(targetName);
    const targetConflict = preview?.target?.availability === 'conflict';
    const needsFocus = stage === 'review' && (targetInvalid || targetConflict);
    const wasNeeded = targetFocusNeeded.current;
    targetFocusNeeded.current = needsFocus;
    if (needsFocus && !wasNeeded) window.setTimeout(() => targetInputRef.current?.focus(), 0);
  }, [preview?.target?.availability, stage, targetName]);

  const requestPreview = useCallback(async (body, target) => {
    if (!body) return;
    const requestId = ++previewRequest.current;
    setPreviewing(true);
    setFileError(null);
    try {
      const query = target ? `?targetName=${encodeURIComponent(target)}` : '';
      const response = await apiFetch(`/api/projects/import/preview${query}`, {
        method: 'POST',
        headers: { 'Content-Type': BUNDLE_MEDIA_TYPE },
        body,
      });
      const data = await response.json().catch(() => ({}));
      if (requestId !== previewRequest.current) return;
      if (!response.ok) {
        setPreview({ ...data, canImport: false, blocked: true });
        setFileError(errorSummary(data, response.status));
      } else {
        setPreview(data);
        setTargetName(data.target?.name && data.target.name !== '[invalid]' ? data.target.name : target);
      }
      setStage('review');
    } catch (error) {
      if (requestId !== previewRequest.current) return;
      setFileError(error?.message || 'The bundle preview could not be loaded.');
      setStage('review');
    } finally {
      if (requestId === previewRequest.current) setPreviewing(false);
    }
  }, []);

  const processPickedFile = useCallback(async (picked) => {
    if (!picked) return;
    setFileError(null);
    setPreview(null);
    const looksLikeJson = picked.type === 'application/json' || picked.type === BUNDLE_MEDIA_TYPE || picked.name.toLowerCase().endsWith('.json');
    if (!looksLikeJson) {
      setFile(null);
      setFileError('Unsupported media type. Select a FlowBoard project bundle JSON file.');
      return;
    }
    if (picked.size > 72 * 1024 * 1024) {
      setFile(null);
      setFileError('This file is too large for a project bundle import.');
      return;
    }
    try {
      const text = await picked.text();
      let parsed;
      try { parsed = JSON.parse(text); } catch { throw new Error('The selected file is not valid JSON.'); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The selected file is not a FlowBoard project bundle.');
      const inferredTarget = slugify(parsed.project?.slug || parsed.manifest?.source?.slug || picked.name.replace(/\.json$/i, '')) || 'imported-project';
      setFile(picked);
      setRawBody(text);
      setTargetName(inferredTarget);
      await requestPreview(text, inferredTarget);
    } catch (error) {
      setFile(null);
      setRawBody('');
      setFileError(error?.message || 'The selected file could not be read.');
      setStage('select');
    }
  }, [requestPreview]);

  async function handleFile(event) {
    await processPickedFile(event.target.files?.[0]);
  }

  function handleDragEnter(event) {
    event.preventDefault();
    event.stopPropagation();
    setDragActive(true);
  }

  function handleDragOver(event) {
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    setDragActive(true);
  }

  function handleDragLeave(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!event.currentTarget.contains(event.relatedTarget)) setDragActive(false);
  }

  async function handleDrop(event) {
    event.preventDefault();
    event.stopPropagation();
    setDragActive(false);
    await processPickedFile(event.dataTransfer?.files?.[0]);
  }

  function updateTarget(value) {
    setTargetName(value);
    if (!rawBody) return;
    window.clearTimeout(previewTimer.current);
    // Keep intermediate edits (including an empty field) local. Sending an
    // empty target omits the query parameter, so the server legitimately
    // falls back to the source slug and used to overwrite the user's input.
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(value)) {
      previewRequest.current += 1;
      return;
    }
    previewTimer.current = window.setTimeout(() => requestPreview(rawBody, value), 250);
  }

  function useSuggestedTarget() {
    const suggestion = suggestedCopyName(targetName);
    setTargetName(suggestion);
    requestPreview(rawBody, suggestion);
  }

  async function submitImport() {
    if (!rawBody || !preview?.canImport || previewing) return;
    setStage('progress');
    setImportError(null);
    try {
      const response = await apiFetch(`/api/projects/import?targetName=${encodeURIComponent(targetName)}`, {
        method: 'POST',
        headers: { 'Content-Type': BUNDLE_MEDIA_TYPE },
        body: rawBody,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setImportId(data.importId || null);
        setImportError(errorSummary(data, response.status));
        setStage('failure');
        return;
      }
      setImportId(data.importId || null);
      setImportResult(data);
      setStage('success');
    } catch (error) {
      setImportError(error?.message || 'The project import failed.');
      setStage('failure');
    }
  }

  async function retryImport() {
    await submitImport();
  }

  async function copyImportId() {
    if (!importId) return;
    try { await navigator.clipboard?.writeText(importId); } catch { /* clipboard is optional */ }
  }

  const dismissible = stage !== 'progress';
  const canImport = !!preview?.canImport && !previewing && /^[a-z0-9][a-z0-9-]{0,62}$/.test(targetName);
  const projectName = importResult?.project?.displayName || importResult?.project?.name || targetName;

  return (
    <Modal
      open={open}
      onClose={dismissible ? onClose : undefined}
      title={stage === 'success' ? 'Project imported' : 'Import project'}
      size="lg"
      showClose
      dismissible={dismissible}
      actions={stage === 'select' ? (
        <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
      ) : stage === 'review' ? (
        <>
          <Button variant="ghost" size="sm" onClick={() => { setStage('select'); setFileError(null); }}>Choose another file</Button>
          <Button size="sm" onClick={submitImport} disabled={!canImport} data-testid="import-submit">{previewing ? <><Spinner size="sm" /> Checking…</> : <><Upload size={13} /> Import as new project</>}</Button>
        </>
      ) : stage === 'progress' ? null : stage === 'failure' ? (
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
          <Button size="sm" onClick={retryImport}><RefreshCw size={13} /> Retry import</Button>
        </>
      ) : (
        <>
          <Button variant="ghost" size="sm" onClick={() => { onImported?.(importResult?.project); onClose?.(); }}>Done</Button>
          <Button size="sm" onClick={() => { onImported?.(importResult?.project); onOpenProject?.(importResult?.project?.name || targetName); onClose?.(); }}><FolderOpen size={13} /> Open project</Button>
        </>
      )}
    >
      <div className="bundle-modal-body flex flex-col gap-4" aria-live="polite" data-import-stage={stage}>
        {stage !== 'success' && <ImportSteps stage={stage === 'failure' ? 'progress' : stage} />}
        {stage === 'select' && (
          <>
            <BundleHeader icon={Upload} title="Choose a project bundle" subtitle="Select a sanitized FlowBoard JSON review bundle to inspect before importing." />
            <label
              htmlFor="project-bundle-file"
              className={`flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed px-5 py-9 text-center transition-colors ${dragActive ? 'border-accent bg-accent-subtle' : 'border-border-strong bg-bg-elevated hover:border-accent'}`}
              data-testid="import-dropzone"
              data-drag-active={dragActive ? 'true' : 'false'}
              role="button"
              tabIndex={0}
              onDragEnter={handleDragEnter}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onKeyDown={(event) => {
                if ((event.key === 'Enter' || event.key === ' ') && event.target === event.currentTarget) {
                  event.preventDefault();
                  fileInputRef.current?.click();
                }
              }}
            >
              <FileJson size={28} className="text-muted" />
              <span className="text-sm text-text-strong">Choose a .flowboard.json file</span>
              <span className="text-xs text-muted">The file is sent to the server for a read-only safety preview.</span>
              <Button size="sm" onClick={(event) => { event.preventDefault(); fileInputRef.current?.click(); }}><FolderOpen size={13} /> Browse files</Button>
            </label>
            <input ref={fileInputRef} id="project-bundle-file" type="file" accept=".json,application/json,application/vnd.flowboard.project+json" onChange={handleFile} className="sr-only" />
            {fileError && <Alert variant="error" title="File could not be used"><span data-testid="import-file-error">{fileError}</span></Alert>}
            {file && <div className="flex items-center gap-2 text-xs text-muted"><FileJson size={14} /> {file.name} · {formatBytes(file.size)}</div>}
          </>
        )}
        {stage === 'review' && (
          <>
            <BundleHeader icon={Info} title="Review before importing" subtitle="The destination is always a new project. No agents are activated and no existing project is modified." />
            {fileError && <Alert
              variant="error"
              title="Bundle cannot be imported"
              action={rawBody ? <Button variant="secondary" size="xs" onClick={() => requestPreview(rawBody, targetName)}><RefreshCw size={12} /> Try again</Button> : null}
            ><span data-testid="import-preview-error">{fileError}</span></Alert>}
            <ImportPreviewSummary preview={preview} targetName={targetName} onTargetChange={updateTarget} onUseSuggested={useSuggestedTarget} targetInputRef={targetInputRef} />
          </>
        )}
        {stage === 'progress' && (
          <div className="flex flex-col gap-4" data-testid="import-progress">
            <BundleHeader icon={Upload} title="Importing project…" subtitle="Keep this dialog open while FlowBoard writes the new project." />
            <div className="flex items-center gap-3 rounded-lg border border-solid border-border bg-bg-elevated p-4"><Spinner size="md" /><div><div className="text-sm font-semibold text-text-strong">Import in progress</div><div className="mt-1 text-xs text-muted">FlowBoard is processing the named import phases below.</div></div></div>
            <ul className="m-0 flex list-none flex-col gap-2 rounded-lg border border-solid border-border bg-bg-elevated p-3 text-xs text-muted" data-testid="import-phases">
              {IMPORT_PHASES.map((phase) => <li key={phase} className="flex items-center gap-2"><span className="h-1.5 w-1.5 rounded-full bg-border-strong" aria-hidden="true" />{phase}</li>)}
            </ul>
            <div className="text-[11px] text-muted">This operation cannot be cancelled while writing.</div>
          </div>
        )}
        {stage === 'failure' && (
          <div className="flex flex-col gap-4" data-testid="import-failure">
            <Alert variant="error" title="Import interrupted"><span>{importError || 'The project could not be imported.'}</span></Alert>
            {importId && <div className="flex items-center justify-between gap-2 rounded-lg border border-solid border-border bg-bg-elevated p-3"><span className="min-w-0 truncate font-mono text-[11px] text-muted">Import ID: {importId}</span><Button variant="ghost" size="xs" onClick={copyImportId}><Clipboard size={12} /> Copy ID</Button></div>}
            <div className="text-xs text-muted">If the failure is recoverable, retrying the same bundle and destination is safe.</div>
          </div>
        )}
        {stage === 'success' && (
          <div className="flex flex-col gap-4" data-testid="import-success">
            <div className="flex items-start gap-3 rounded-lg border border-solid border-ok bg-ok-subtle p-4"><CheckCircle2 size={20} className="mt-0.5 shrink-0 text-ok" /><div><div className="text-sm font-semibold text-text-strong">{projectName} is ready</div><div className="mt-1 text-xs leading-5 text-muted">No agents were activated. Choose Open project when you are ready to view the imported copy.</div></div></div>
            <CountGrid counts={importResult?.counts || {}} includeHistory={preview?.options?.includeHistory === true} />
            {importId && <div className="font-mono text-[11px] text-muted">Import ID: {importId}</div>}
          </div>
        )}
      </div>
    </Modal>
  );
}

export { ExportProjectModal };
export default ImportProjectModal;
