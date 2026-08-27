'use strict';

/**
 * Read-only project review bundle exporter (T-468-3).
 *
 * The exporter is deliberately a small adapter around canonical server-owned
 * reads. It never opens SQLite, writes project files, or serializes an entire
 * server object. Callers provide the already-authoritative project, task,
 * canvas and overview reads; this module owns the portable projections,
 * file-boundary policy and bundle validation.
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  LIMITS,
  canonicalJson,
  createBundle,
  normalizeRelativePath,
  sha256,
  toPortableHistory,
  toPortableTask,
} = require('./project-bundle-schema.js');
const { validateBundle } = require('./project-bundle-validator.js');
const { scanSensitiveContent } = require('./project-bundle-secrets.js');

const DEFAULT_FILE_POLICY = Object.freeze({
  rootFiles: Object.freeze(['PROJECT.md', 'DECISIONS.md']),
  contextDirectory: 'context',
  contextExtension: '.md',
  excludedNames: Object.freeze([
    'SESSIONS.md',
    'AGENTS.md',
    'PROJECT-RULES.md',
    'canvas.json',
    'tasks.json',
  ]),
});

const WARNING_CODES = Object.freeze({
  OPTIONAL_FILE_MISSING: 'OPTIONAL_FILE_MISSING',
  OPTIONAL_FILE_UNREADABLE: 'OPTIONAL_FILE_UNREADABLE',
  SYMLINK_EXCLUDED: 'SYMLINK_EXCLUDED',
  EXCLUDED_FILE: 'EXCLUDED_FILE',
  OPTIONAL_FILE_TOO_LARGE: 'OPTIONAL_FILE_TOO_LARGE',
  SENSITIVE_CONTENT_EXCLUDED: 'SENSITIVE_CONTENT_EXCLUDED',
});

// This token is intentionally a stable, human-readable phrase rather than a
// generated value. The endpoint remains loopback-only and the phrase is only
// an accident-prevention acknowledgement, not an authentication credential.
const SENSITIVE_EXPORT_CONFIRMATION = 'export-sensitive-project';

const SPEC_DIAGNOSTIC_CODES = new Set([
  'SPEC_READ_FAILED',
  'SPEC_SYMLINK_UNSUPPORTED',
  'SPEC_TOO_LARGE',
]);

const EXCLUDED_PATH_SEGMENTS = new Set([
  '.git', '.env', 'credentials', 'hooks', 'secrets', 'sessions', 'settings',
  'backup', 'backups',
]);

function isExcludedKnowledgePath(relativePath) {
  const parts = String(relativePath).split('/');
  return parts.some((part) => {
    const lower = part.toLowerCase();
    return EXCLUDED_PATH_SEGMENTS.has(lower)
      || lower.includes('secret')
      || lower.includes('credential')
      || lower.endsWith('.bak')
      || lower.includes('.pre-db.bak')
      || lower === 'flowboard.db'
      || lower === 'flowboard.db-wal'
      || lower === 'flowboard.db-shm';
  });
}

class ProjectBundleExportError extends Error {
  constructor(message, code = 'PROJECT_EXPORT_FAILED', details = {}) {
    super(message);
    this.name = 'ProjectBundleExportError';
    this.code = code;
    Object.assign(this, details);
  }
}

function warning(code, message, filePath) {
  return {
    code,
    ...(filePath ? { path: filePath } : {}),
    message,
  };
}

function projectPath(projectDir, relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  const resolved = path.resolve(projectDir, ...normalized.split('/'));
  const root = path.resolve(projectDir);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new ProjectBundleExportError(`Project file escapes project root: ${normalized}`, 'PATH_UNSAFE');
  }
  return { normalized, resolved };
}

function isSymlink(fsModule, filename) {
  try { return fsModule.lstatSync(filename).isSymbolicLink(); } catch { return false; }
}

function addOptionalFileWarning(warnings, issue) {
  warnings.push(issue);
}

function readOptionalFile({ projectDir, relativePath, fsModule, warnings }) {
  const target = projectPath(projectDir, relativePath);
  if (isExcludedKnowledgePath(target.normalized)) {
    addOptionalFileWarning(warnings, warning(WARNING_CODES.EXCLUDED_FILE,
      'Backups, secrets and runtime files are excluded from review bundles.', target.normalized));
    return null;
  }
  if (isSymlink(fsModule, target.resolved)) {
    addOptionalFileWarning(warnings, warning(WARNING_CODES.SYMLINK_EXCLUDED,
      'Symlinked project files are excluded from review bundles.', target.normalized));
    return null;
  }
  let stat;
  try {
    stat = fsModule.lstatSync(target.resolved);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      addOptionalFileWarning(warnings, warning(WARNING_CODES.OPTIONAL_FILE_MISSING,
        'Optional project knowledge file is not present.', target.normalized));
      return null;
    }
    addOptionalFileWarning(warnings, warning(WARNING_CODES.OPTIONAL_FILE_UNREADABLE,
      'Optional project knowledge file could not be inspected.', target.normalized));
    return null;
  }
  if (!stat.isFile()) {
    addOptionalFileWarning(warnings, warning(WARNING_CODES.OPTIONAL_FILE_UNREADABLE,
      'Optional project knowledge path is not a regular file.', target.normalized));
    return null;
  }
  if (stat.size > LIMITS.fileBytes) {
    addOptionalFileWarning(warnings, warning(WARNING_CODES.OPTIONAL_FILE_TOO_LARGE,
      `Optional project knowledge file exceeds the ${LIMITS.fileBytes}-byte limit.`, target.normalized));
    return null;
  }
  try {
    const content = fsModule.readFileSync(target.resolved, 'utf8');
    if (scanSensitiveContent(content).length > 0) {
      addOptionalFileWarning(warnings, warning(WARNING_CODES.SENSITIVE_CONTENT_EXCLUDED,
        'Credential-like content was excluded from the review bundle.', target.normalized));
      return null;
    }
    return { path: target.normalized, content, encoding: 'utf8' };
  } catch (error) {
    addOptionalFileWarning(warnings, warning(WARNING_CODES.OPTIONAL_FILE_UNREADABLE,
      'Optional project knowledge file could not be read.', target.normalized));
    return null;
  }
}

function walkContextFiles({ projectDir, fsModule, warnings, policy, excludedPaths }) {
  const result = [];
  const contextRoot = projectPath(projectDir, policy.contextDirectory).resolved;

  function walk(directory, relativeDirectory) {
    let entries;
    try { entries = fsModule.readdirSync(directory, { withFileTypes: true }); } catch (error) {
      if (error?.code !== 'ENOENT') {
        addOptionalFileWarning(warnings, warning(WARNING_CODES.OPTIONAL_FILE_UNREADABLE,
          'The optional context directory could not be read.', relativeDirectory));
      }
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        addOptionalFileWarning(warnings, warning(WARNING_CODES.EXCLUDED_FILE,
          'Hidden project files are excluded from review bundles.', `${relativeDirectory}/${entry.name}`));
        continue;
      }
      const relativePath = `${relativeDirectory}/${entry.name}`;
      const absolutePath = path.join(directory, entry.name);
      if (excludedPaths.has(relativePath)) continue;
      if (isExcludedKnowledgePath(relativePath)) {
        addOptionalFileWarning(warnings, warning(WARNING_CODES.EXCLUDED_FILE,
          'Backups, secrets and runtime files are excluded from review bundles.', relativePath));
        continue;
      }
      if (entry.isSymbolicLink() || isSymlink(fsModule, absolutePath)) {
        addOptionalFileWarning(warnings, warning(WARNING_CODES.SYMLINK_EXCLUDED,
          'Symlinked project files are excluded from review bundles.', relativePath));
        continue;
      }
      if (entry.isDirectory()) {
        walk(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(policy.contextExtension)) {
        continue;
      }
      const file = readOptionalFile({
        projectDir,
        relativePath,
        fsModule,
        warnings,
      });
      if (file) result.push(file);
    }
  }

  if (isSymlink(fsModule, contextRoot)) {
    addOptionalFileWarning(warnings, warning(WARNING_CODES.SYMLINK_EXCLUDED,
      'Symlinked context directories are excluded from review bundles.', policy.contextDirectory));
    return result;
  }
  walk(contextRoot, policy.contextDirectory);
  return result;
}

function collectKnowledgeFiles({ projectDir, fsModule = fs, warnings = [], policy = DEFAULT_FILE_POLICY, excludedPaths = new Set() }) {
  if (!projectDir || typeof projectDir !== 'string') {
    throw new ProjectBundleExportError('A project directory is required', 'PROJECT_DIR_REQUIRED');
  }
  const files = [];
  for (const relativePath of policy.rootFiles) {
    const file = readOptionalFile({ projectDir, relativePath, fsModule, warnings });
    if (file) files.push(file);
  }
  files.push(...walkContextFiles({ projectDir, fsModule, warnings, policy, excludedPaths }));
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function linkedSpecDiagnostic(taskId, code = 'SPEC_READ_FAILED') {
  return {
    code: SPEC_DIAGNOSTIC_CODES.has(code) ? code : 'SPEC_READ_FAILED',
    taskId: typeof taskId === 'string' ? taskId : null,
  };
}

function linkedSpecError(task, code) {
  return new ProjectBundleExportError(
    'A linked task spec is missing or unreadable.',
    code,
    {
      diagnostics: [linkedSpecDiagnostic(task?.id, code)],
    },
  );
}

function readLinkedSpecs({ projectDir, tasks, fsModule = fs, allowSensitiveCanonicalData = false }) {
  const specs = [];
  const seen = new Set();
  for (const task of tasks) {
    if (!task?.specFile) continue;
    let target;
    try {
      target = projectPath(projectDir, task.specFile);
    } catch {
      throw new ProjectBundleExportError(`Task ${task.id} has an unsafe spec path`, 'SPEC_PATH_UNSAFE');
    }
    if (!target.normalized.startsWith('specs/') && !target.normalized.startsWith('context/')) {
      throw new ProjectBundleExportError(`Task ${task.id} spec must live below specs/ or context/`, 'SPEC_PATH_INVALID');
    }
    if (seen.has(target.normalized)) continue;
    seen.add(target.normalized);
    if (isSymlink(fsModule, target.resolved)) {
      throw linkedSpecError(task, 'SPEC_SYMLINK_UNSUPPORTED');
    }
    let stat;
    try { stat = fsModule.lstatSync(target.resolved); } catch {
      throw linkedSpecError(task, 'SPEC_READ_FAILED');
    }
    if (!stat.isFile()) throw linkedSpecError(task, 'SPEC_READ_FAILED');
    if (stat.size > LIMITS.fileBytes) throw linkedSpecError(task, 'SPEC_TOO_LARGE');
    let content;
    try { content = fsModule.readFileSync(target.resolved, 'utf8'); } catch {
      throw linkedSpecError(task, 'SPEC_READ_FAILED');
    }
    if (!allowSensitiveCanonicalData && scanSensitiveContent(content).length > 0) {
      throw new ProjectBundleExportError('Credential-like content detected in a linked canonical spec', 'SENSITIVE_CONTENT_DETECTED');
    }
    specs.push({ path: target.normalized, taskId: task.id, content });
  }
  return specs.sort((left, right) => left.path.localeCompare(right.path));
}

function normalizeProject(project, projectName) {
  if (!project || typeof project !== 'object') {
    throw new ProjectBundleExportError(`Project ${projectName} metadata is unavailable`, 'PROJECT_READ_FAILED');
  }
  const slug = project.slug || project.name || projectName;
  const displayName = project.displayName || project.display_name || slug;
  const config = typeof project.config === 'string' ? (() => {
    try { return JSON.parse(project.config); } catch { return {}; }
  })() : (project.config || {});
  return {
    slug,
    displayName,
    description: project.description || '',
    group: project.group ?? config.group ?? undefined,
    taskDiscipline: project.taskDiscipline || config.taskDiscipline || 'list',
    github: project.github !== undefined ? project.github : (config.github !== undefined ? config.github : null),
    createdAt: project.createdAt || project.created_at,
    updatedAt: project.updatedAt || project.updated_at,
  };
}

function historyIdentity(event, sequence) {
  if (typeof event?.sourceId === 'string' && event.sourceId.length > 0) return event.sourceId;
  return `history-${sha256(canonicalJson({
    taskId: event?.taskId,
    type: event?.type,
    body: event?.body ?? event?.message ?? '',
    kind: event?.kind || 'comment',
    createdAt: event?.createdAt,
    authorLabel: event?.authorLabel || null,
    progress: event?.progress ?? null,
    sequence,
  })).slice(0, 48)}`;
}

/** Convert the HZL service's event-shaped read into the portable history DTO. */
function toPortableHistoryFromEvents(events = []) {
  const ordered = [...events].sort((left, right) => {
    const task = String(left?.taskId || '').localeCompare(String(right?.taskId || ''));
    return task || Number(left?._eventRowId || 0) - Number(right?._eventRowId || 0);
  });
  const sourceIds = new Map();
  const perTaskSequence = new Map();
  for (const event of ordered) {
    const sequence = perTaskSequence.get(event.taskId) || 0;
    perTaskSequence.set(event.taskId, sequence + 1);
    sourceIds.set(event._eventRowId, historyIdentity(event, sequence));
  }
  const comments = [];
  const checkpoints = [];
  const seenByTask = new Map();
  for (const event of ordered) {
    const prior = seenByTask.get(event.taskId) || 0;
    seenByTask.set(event.taskId, prior + 1);
    const sequence = Number.isInteger(event.sequence) ? event.sequence : prior;
    const id = sourceIds.get(event._eventRowId) || historyIdentity(event, prior);
    if (event.type === 'comment') {
      comments.push({
        id,
        taskId: event.taskId,
        body: event.body,
        kind: event.kind || 'comment',
        createdAt: event.createdAt,
        ...(event.authorLabel ? { authorLabel: event.authorLabel } : {}),
        ...(event.sourceQuestionId || Number.isInteger(event.questionEventRowId)
          ? { questionId: event.sourceQuestionId || sourceIds.get(event.questionEventRowId) }
          : {}),
        sequence,
      });
    } else if (event.type === 'checkpoint') {
      checkpoints.push({
        id,
        taskId: event.taskId,
        message: event.message,
        ...(event.progress !== null && event.progress !== undefined ? { progress: event.progress } : {}),
        createdAt: event.createdAt,
        ...(event.authorLabel ? { authorLabel: event.authorLabel } : {}),
        sequence,
      });
    }
  }
  return toPortableHistory({ comments, checkpoints });
}

function exportProjectReviewBundle({
  projectName,
  project,
  tasks,
  canvas,
  overview,
  history,
  projectDir,
  fsModule = fs,
  options = {},
}) {
  if (!projectName || typeof projectName !== 'string') {
    throw new ProjectBundleExportError('Project name is required', 'PROJECT_REQUIRED');
  }
  if (!Array.isArray(tasks)) throw new ProjectBundleExportError('Canonical task read failed', 'TASKS_READ_FAILED');
  if (!canvas || typeof canvas !== 'object') throw new ProjectBundleExportError('Canonical canvas read failed', 'CANVAS_READ_FAILED');
  if (!overview || typeof overview !== 'object') throw new ProjectBundleExportError('Canonical overview read failed', 'OVERVIEW_READ_FAILED');

  const warnings = [];
  const publicProject = normalizeProject(project, projectName);
  const publicTasks = tasks.map(toPortableTask);
  const includeHistory = options.includeHistory === true;
  const portableHistory = includeHistory ? toPortableHistoryFromEvents(history || []) : undefined;
  const allowSensitiveCanonicalData = options.allowSensitiveCanonicalData === true;
  const specs = readLinkedSpecs({
    projectDir,
    tasks: publicTasks,
    fsModule,
    allowSensitiveCanonicalData,
  });
  const files = collectKnowledgeFiles({
    projectDir,
    fsModule,
    warnings,
    excludedPaths: new Set(specs.filter((spec) => spec.path.startsWith('context/')).map((spec) => spec.path)),
  });
  const bundle = createBundle({
    project: publicProject,
    tasks: publicTasks,
    specs,
    canvas,
    overview,
    files,
    ...(portableHistory ? { history: portableHistory } : {}),
  }, {
    producerName: options.producerName || 'FlowBoard',
    producerVersion: options.producerVersion,
    bundleId: options.bundleId,
    createdAt: options.createdAt,
    includeHistory,
    warnings,
  });
  const canonicalSections = [
    ['project', bundle.project],
    ['tasks', bundle.tasks],
    ['specs', bundle.specs],
    ['canvas', bundle.canvas],
    ['overview', bundle.overview],
    ...(bundle.history ? [['history', bundle.history]] : []),
  ];
  for (const [, section] of canonicalSections) {
    if (!allowSensitiveCanonicalData && scanSensitiveContent(section).length > 0) {
      throw new ProjectBundleExportError('Credential-like content detected in canonical project data', 'SENSITIVE_CONTENT_DETECTED');
    }
  }
  const validation = validateBundle(bundle);
  if (!validation.ok) {
    throw new ProjectBundleExportError('Generated project bundle failed schema validation', 'BUNDLE_INVALID', { errors: validation.errors });
  }
  return { bundle: validation.bundle, warnings: validation.warnings.concat(warnings) };
}

function safeDownloadFilename(slug) {
  const safe = String(slug || 'project').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63) || 'project';
  return `flowboard-${safe}.flowboard.json`;
}

module.exports = {
  DEFAULT_FILE_POLICY,
  ProjectBundleExportError,
  SENSITIVE_EXPORT_CONFIRMATION,
  WARNING_CODES,
  collectKnowledgeFiles,
  exportProjectReviewBundle,
  normalizeProject,
  readLinkedSpecs,
  toPortableHistoryFromEvents,
  safeDownloadFilename,
};
