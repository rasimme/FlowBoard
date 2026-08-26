'use strict';

/**
 * Portable project review bundle contract (T-468-2).
 *
 * This module deliberately has no FlowBoard server, HZL, SQLite or filesystem
 * dependency. A bundle is an application-level document; the importer may map
 * it to whatever local persistence version it uses.
 */

const crypto = require('node:crypto');

const BUNDLE_IDENTITY = 'flowboard.project-bundle';
const BUNDLE_FORMAT_VERSION = 1;
const IMPORTER_VERSION = '1.0.0';
const CHECKSUM_ALGORITHM = 'sha256';

const CONTENT_SECTIONS = Object.freeze([
  'project',
  'tasks',
  'specs',
  'canvas',
  'overview',
  'files',
]);

const OPTIONAL_CONTENT_SECTIONS = Object.freeze(['history']);

// These are policy labels, rather than implementation details. They make the
// privacy boundary visible in a preview and allow a future importer to reject
// a producer which does not make the redaction claim explicitly.
const REQUIRED_REDACTIONS = Object.freeze([
  'hzl-identifiers',
  'raw-events',
  'raw-metadata',
  'agent-ownership',
  'claims-and-leases',
  'sessions',
  'correlations',
  'hooks',
  'settings',
  'credentials',
]);

const REVIEW_CONTENT_CONTRACT = Object.freeze({
  default: Object.freeze({
    included: Object.freeze([...CONTENT_SECTIONS]),
    excluded: Object.freeze(['history', 'executable-files']),
  }),
  optional: Object.freeze({
    history: Object.freeze({
      included: Object.freeze(['comments', 'checkpoints']),
      excluded: Object.freeze(['sessions', 'agent-identities', 'raw-events']),
    }),
    executable: Object.freeze({
      supported: false,
      reason: 'Executable content is outside the v1 review bundle contract.',
    }),
  }),
});

const LIMITS = Object.freeze({
  bundleId: 128,
  producerName: 128,
  producerVersion: 64,
  projectSlug: 63,
  projectDisplayName: 500,
  projectDescription: 64 * 1024,
  id: 128,
  title: 500,
  description: 16 * 1024,
  text: 50 * 1024,
  tag: 128,
  link: 4096,
  path: 512,
  fileBytes: 4 * 1024 * 1024,
  totalFileBytes: 64 * 1024 * 1024,
  widgets: 200,
  canvasNotes: 5000,
  canvasConnections: 10000,
  tasks: 10000,
  specs: 10000,
  files: 10000,
  historyItems: 50000,
  propsBytes: 64 * 1024,
  warnings: 1000,
  warningMessage: 1024,
});

const TASK_STATUSES = Object.freeze(['backlog', 'open', 'in-progress', 'review', 'done', 'archived']);
const TASK_PRIORITIES = Object.freeze(['low', 'medium', 'high']);
const TASK_WORK_STATES = Object.freeze(['working', 'waiting', 'blocked', 'paused']);
const TASK_DISCIPLINES = Object.freeze(['list', 'standard', 'development']);
const WORK_STATE_DETAIL_KEYS = Object.freeze(['reason', 'waitingFor', 'responsible', 'checkAgainAt', 'setAt']);
// Union observed in current and legacy Canvas stores. Keep this wider than the
// toolbar palette so an export never rejects an existing persisted color.
const CANVAS_COLORS = Object.freeze(['grey', 'yellow', 'blue', 'green', 'red', 'teal', 'orange', 'purple']);
const CANVAS_SIZES = Object.freeze(['small', 'medium', 'large']);
const CANVAS_PORTS = Object.freeze(['top', 'right', 'bottom', 'left']);
const HISTORY_COMMENT_KINDS = Object.freeze(['comment', 'question', 'answer', 'decision']);

const FORBIDDEN_FIELD_NAMES = Object.freeze([
  'agent', 'agentid', 'actor', 'claimedby', 'claim', 'claims', 'correlationid',
  'correlation', 'credential', 'credentials', 'eventid', 'event_id', 'hook',
  'hooks', 'hzlid', 'lease', 'leaseuntil', 'lease_until', 'metadata',
  'owner', 'ownerid', 'policyledger', 'raw', 'rawevent', 'raw_event',
  'rawmetadata', 'raw_metadata', 'route', 'routes', 'secret', 'secrets',
  'session', 'sessions', 'setting', 'settings', 'task_id', 'token', 'tokens',
  'ulid',
]);

const FORBIDDEN_PATH_SEGMENTS = Object.freeze([
  '.git', '.env', 'credentials', 'hooks', 'secrets', 'sessions', 'settings',
]);

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

const BUNDLE_SCHEMA = deepFreeze({
  identity: BUNDLE_IDENTITY,
  formatVersion: BUNDLE_FORMAT_VERSION,
  required: ['manifest', ...CONTENT_SECTIONS],
  optional: OPTIONAL_CONTENT_SECTIONS,
  reviewContent: REVIEW_CONTENT_CONTRACT,
  limits: LIMITS,
  enums: {
    taskStatuses: TASK_STATUSES,
    taskPriorities: TASK_PRIORITIES,
    taskWorkStates: TASK_WORK_STATES,
    taskDisciplines: TASK_DISCIPLINES,
    canvasColors: CANVAS_COLORS,
    canvasSizes: CANVAS_SIZES,
    canvasPorts: CANVAS_PORTS,
    historyCommentKinds: HISTORY_COMMENT_KINDS,
  },
  forbiddenFields: FORBIDDEN_FIELD_NAMES,
});

class BundlePathError extends Error {
  constructor(message, code = 'PATH_UNSAFE') {
    super(message);
    this.name = 'BundlePathError';
    this.code = code;
  }
}

/**
 * Normalize a project-relative POSIX path. Backslashes are rejected so a
 * Windows-produced bundle cannot introduce aliases after extraction.
 * Traversal, absolute paths and empty segments are rejected.
 */
function normalizeRelativePath(input) {
  if (typeof input !== 'string' || input.length === 0) {
    throw new BundlePathError('path must be a non-empty string');
  }
  if (input.includes('\0')) throw new BundlePathError('path contains a NUL byte');

  // Do not normalize backslashes: accepting both spellings would allow two
  // archive entries to alias after extraction on a platform that uses '\\'.
  // Exporters must emit POSIX paths; importers reject non-canonical input.
  if (input.includes('\\')) throw new BundlePathError('path must use POSIX separators', 'PATH_NON_CANONICAL');
  const slashPath = input;
  if (slashPath.startsWith('/') || slashPath.startsWith('//') || /^[A-Za-z]:\//.test(slashPath)) {
    throw new BundlePathError('path must be relative');
  }

  const parts = slashPath.split('/');
  const normalized = [];
  for (const part of parts) {
    if (part === '' || part === '.') {
      if (part === '') throw new BundlePathError('path contains an empty segment');
      continue;
    }
    if (part === '..') throw new BundlePathError('path traversal is not allowed');
    normalized.push(part);
  }
  if (normalized.length === 0) throw new BundlePathError('path must name a file');
  if (normalized.some((part) => FORBIDDEN_PATH_SEGMENTS.includes(part.toLowerCase()))) {
    throw new BundlePathError('path is outside the review content boundary', 'PATH_EXCLUDED');
  }
  const result = normalized.join('/');
  if (result.length > LIMITS.path) throw new BundlePathError(`path exceeds ${LIMITS.path} characters`, 'LIMIT_EXCEEDED');
  return result;
}

function canonicalizeJson(value) {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const key of Object.keys(value).sort()) output[key] = canonicalizeJson(value[key]);
  return output;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalizeJson(value));
}

function sha256(value, { canonical = true } = {}) {
  const input = typeof value === 'string'
    ? value
    : (canonical ? canonicalJson(value) : JSON.stringify(value));
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function compareBy(key) {
  return (a, b) => String(a?.[key] ?? '').localeCompare(String(b?.[key] ?? ''));
}

function canvasConnectionKey(connection) {
  const from = String(connection?.from ?? '');
  const to = String(connection?.to ?? '');
  return from < to ? `${from}\0${to}` : `${to}\0${from}`;
}

/**
 * Return a copy with known entity arrays and paths in deterministic order.
 * Validation owns type/reference checks; this helper is intentionally tolerant
 * so it can also be used when constructing a preview from partially-filled UI
 * state.
 */
function canonicalizeBundle(bundle) {
  const output = cloneJson(bundle) || {};
  for (const key of ['tasks', 'specs', 'files']) {
    if (Array.isArray(output[key])) {
      output[key].sort(compareBy(key === 'tasks' ? 'id' : 'path'));
    }
  }
  if (Array.isArray(output.tasks)) {
    for (const task of output.tasks) {
      if (task?.tags && Array.isArray(task.tags)) task.tags.sort();
      if (task?.links && Array.isArray(task.links)) task.links.sort();
      if (task?.dependsOn && Array.isArray(task.dependsOn)) task.dependsOn.sort();
    }
  }
  if (output.canvas && typeof output.canvas === 'object') {
    if (Array.isArray(output.canvas.notes)) output.canvas.notes.sort(compareBy('id'));
    if (Array.isArray(output.canvas.connections)) output.canvas.connections.sort(
      (a, b) => canvasConnectionKey(a).localeCompare(canvasConnectionKey(b)),
    );
  }
  if (output.history && typeof output.history === 'object') {
    if (Array.isArray(output.history.comments)) output.history.comments.sort(compareBy('id'));
    if (Array.isArray(output.history.checkpoints)) output.history.checkpoints.sort(compareBy('id'));
  }
  if (Array.isArray(output.files)) {
    for (const file of output.files) {
      if (file && typeof file.path === 'string') {
        try { file.path = normalizeRelativePath(file.path); } catch { /* validator reports it */ }
      }
    }
  }
  if (Array.isArray(output.specs)) {
    for (const spec of output.specs) {
      if (spec && typeof spec.path === 'string') {
        try { spec.path = normalizeRelativePath(spec.path); } catch { /* validator reports it */ }
      }
    }
  }
  if (output.manifest?.checksums?.files && typeof output.manifest.checksums.files === 'object') {
    const checksums = {};
    for (const [filePath, checksum] of Object.entries(output.manifest.checksums.files)) {
      let normalizedPath = filePath;
      try { normalizedPath = normalizeRelativePath(filePath); } catch { /* validator reports it */ }
      checksums[normalizedPath] = checksum;
    }
    output.manifest.checksums.files = Object.fromEntries(
      Object.entries(checksums).sort(([a], [b]) => a.localeCompare(b)),
    );
  }
  return canonicalizeJson(output);
}

function payloadForChecksum(bundle) {
  const payload = {};
  for (const key of Object.keys(bundle || {})) {
    if (key !== 'manifest') payload[key] = bundle[key];
  }
  return canonicalizeBundle(payload);
}

function countContent(bundle) {
  return {
    tasks: Array.isArray(bundle?.tasks) ? bundle.tasks.length : 0,
    specs: Array.isArray(bundle?.specs) ? bundle.specs.length : 0,
    canvasNotes: Array.isArray(bundle?.canvas?.notes) ? bundle.canvas.notes.length : 0,
    canvasConnections: Array.isArray(bundle?.canvas?.connections) ? bundle.canvas.connections.length : 0,
    overviewWidgets: Array.isArray(bundle?.overview?.widgets) ? bundle.overview.widgets.length : 0,
    files: Array.isArray(bundle?.files) ? bundle.files.length : 0,
    historyComments: Array.isArray(bundle?.history?.comments) ? bundle.history.comments.length : 0,
    historyCheckpoints: Array.isArray(bundle?.history?.checkpoints) ? bundle.history.checkpoints.length : 0,
  };
}

function fileChecksums(files) {
  const checksums = {};
  for (const file of files || []) {
    if (!file || typeof file.path !== 'string' || typeof file.content !== 'string') continue;
    let path = file.path;
    try { path = normalizeRelativePath(path); } catch { /* validator reports it */ }
    checksums[path] = sha256(file.content, { canonical: false });
  }
  return Object.fromEntries(Object.entries(checksums).sort(([a], [b]) => a.localeCompare(b)));
}

function sourceFromProject(project, suppliedSource) {
  const derived = {
    slug: project?.slug || project?.name || '',
    displayName: project?.displayName || project?.slug || project?.name || '',
    ...(project?.description ? { description: project.description } : {}),
    ...(project?.group ? { group: project.group } : {}),
    ...(project?.taskDiscipline ? { taskDiscipline: project.taskDiscipline } : {}),
    ...(project?.github !== undefined ? { github: project.github } : {}),
  };
  const source = { ...derived, ...(suppliedSource || {}) };
  const output = pickDefined(source, ['slug', 'displayName', 'group', 'description', 'taskDiscipline']);
  if (source.github !== undefined) output.github = toPortableGithub(source.github);
  return output;
}

function pickDefined(input, keys) {
  const output = {};
  if (!input || typeof input !== 'object') return output;
  for (const key of keys) {
    if (input[key] !== undefined) output[key] = cloneJson(input[key]);
  }
  return output;
}

/** Portable DTO projections. These are explicit allowlists: operational HZL
 * fields cannot accidentally become part of an exported review bundle. */
function toPortableProject(project = {}) {
  const output = pickDefined({ ...project, slug: project.slug || project.name }, [
    'slug', 'displayName', 'description', 'group', 'createdAt', 'updatedAt', 'taskDiscipline', 'github',
  ]);
  if (project.github !== undefined) output.github = toPortableGithub(project.github);
  return output;
}

function toPortableGithub(github) {
  if (github === null) return null;
  return pickDefined(github, ['repo', 'branch']);
}

function normalizeWorkStateDetails(details) {
  const input = details && typeof details === 'object' && !Array.isArray(details) ? details : {};
  return Object.fromEntries(WORK_STATE_DETAIL_KEYS.map((key) => {
    const value = input[key];
    return [key, value === undefined || value === null || value === '' || typeof value !== 'string' ? null : value];
  }));
}

function toPortableTask(task = {}) {
  // Source names are the public Tasks API names (`created`, `completed`),
  // while the bundle uses explicit timestamp names (`createdAt`,
  // `completedAt`). This keeps the exchange contract stable if the API adds a
  // legacy alias later, and preserves the API's date-only values unchanged.
  const output = pickDefined(task, [
    'id', 'title', 'status', 'priority', 'description', 'tags', 'links', 'dependsOn',
    'parentId', 'specFile', 'workState', 'updatedAt', 'dueAt',
  ]);
  const created = task.createdAt !== undefined ? task.createdAt : task.created;
  if (created !== undefined) output.createdAt = cloneJson(created);
  const completed = task.completedAt !== undefined ? task.completedAt : task.completed;
  output.completedAt = completed === undefined ? null : cloneJson(completed);
  if (task.enteredStatusAt !== undefined) output.enteredStatusAt = cloneJson(task.enteredStatusAt);
  output.order = task.order === undefined ? null : cloneJson(task.order);
  output.workStateDetails = normalizeWorkStateDetails(task.workStateDetails);
  // `responsible` is portable semantic context (for example a role or
  // decision owner), not the live HZL claim owner.  Runtime ownership lives in
  // agent/claim fields, which are never part of this DTO.
  return output;
}

function toPortableSpec(spec = {}) {
  return pickDefined(spec, ['path', 'taskId', 'content']);
}

function toPortableCanvas(canvas = {}) {
  const notes = Array.isArray(canvas.notes) ? canvas.notes.map((note) => pickDefined(note, [
    'id', 'text', 'x', 'y', 'color', 'size', 'created',
  ])) : [];
  const connections = Array.isArray(canvas.connections) ? canvas.connections.map((connection) => pickDefined(connection, [
    'from', 'to', 'fromPort', 'toPort',
  ])) : [];
  return { version: canvas.version === undefined ? 1 : canvas.version, notes, connections };
}

function toPortableOverview(overview = {}) {
  const widgets = Array.isArray(overview.widgets) ? overview.widgets.map((widget) => pickDefined(widget, [
    'id', 'type', 'title', 'props', 'grid',
  ])) : [];
  return {
    version: overview.version === undefined ? 1 : overview.version,
    layout: overview.layout || 'grid',
    ...(overview.preset !== undefined ? { preset: overview.preset } : {}),
    widgets,
  };
}

function toPortableFile(file = {}) {
  return pickDefined(file, ['path', 'content', 'encoding']);
}

function toPortableHistory(history = {}) {
  const comments = Array.isArray(history.comments) ? history.comments.map((comment) => pickDefined(comment, [
    'id', 'taskId', 'body', 'kind', 'createdAt', 'authorLabel',
  ])) : [];
  const checkpoints = Array.isArray(history.checkpoints) ? history.checkpoints.map((checkpoint) => pickDefined(checkpoint, [
    'id', 'taskId', 'message', 'progress', 'createdAt',
  ])) : [];
  return { comments, checkpoints };
}

/**
 * Construct a complete v1 bundle from portable DTOs. It is useful to export
 * implementations and fixtures, while import code should still call
 * validateBundle() before writing anything.
 */
function createBundle(input = {}, options = {}) {
  const includeHistory = options.includeHistory === true;
  const payload = {
    project: toPortableProject(input.project || {}),
    tasks: Array.isArray(input.tasks) ? input.tasks.map(toPortableTask) : [],
    specs: Array.isArray(input.specs) ? input.specs.map(toPortableSpec) : [],
    canvas: toPortableCanvas(input.canvas || { version: 1, notes: [], connections: [] }),
    overview: toPortableOverview(input.overview || { version: 1, layout: 'grid', widgets: [] }),
    files: Array.isArray(input.files) ? input.files.map(toPortableFile) : [],
  };
  if (includeHistory && input.history !== undefined) payload.history = toPortableHistory(input.history);

  for (const file of payload.files) {
    if (file && typeof file.path === 'string') {
      file.path = normalizeRelativePath(file.path);
      if (typeof file.content === 'string') {
        file.sizeBytes = Buffer.byteLength(file.content, 'utf8');
        file.sha256 = sha256(file.content, { canonical: false });
      }
    }
  }
  const canonicalPayload = payloadForChecksum(payload);
  const project = payload.project;
  const createdAt = options.createdAt || new Date().toISOString();
  const producer = {
    name: options.producerName || 'FlowBoard',
    version: options.producerVersion || IMPORTER_VERSION,
  };
  const source = sourceFromProject(project, options.source);
  const manifest = {
    identity: BUNDLE_IDENTITY,
    formatVersion: BUNDLE_FORMAT_VERSION,
    producer,
    bundleId: options.bundleId || crypto.randomUUID(),
    createdAt,
    source,
    counts: countContent(payload),
    checksums: {
      algorithm: CHECKSUM_ALGORITHM,
      payload: sha256(canonicalPayload),
      files: fileChecksums(payload.files),
    },
    options: {
      includeHistory,
      includeExecutable: false,
    },
    redactions: [...REQUIRED_REDACTIONS],
    compatibility: {
      minImporterVersion: IMPORTER_VERSION,
    },
  };
  if (Array.isArray(options.warnings) && options.warnings.length > 0) {
    manifest.warnings = options.warnings.map((warning) => ({
      code: String(warning?.code || 'OPTIONAL_CONTENT_EXCLUDED'),
      ...(warning?.path ? { path: String(warning.path) } : {}),
      message: String(warning?.message || 'Optional content was excluded from the bundle.'),
    })).sort((a, b) => `${a.code}\0${a.path || ''}\0${a.message}`.localeCompare(`${b.code}\0${b.path || ''}\0${b.message}`));
  }
  return canonicalizeBundle({ manifest, ...payload });
}

module.exports = {
  BUNDLE_IDENTITY,
  BUNDLE_FORMAT_VERSION,
  BUNDLE_SCHEMA,
  CANVAS_COLORS,
  CANVAS_PORTS,
  CANVAS_SIZES,
  CHECKSUM_ALGORITHM,
  CONTENT_SECTIONS,
  FORBIDDEN_FIELD_NAMES,
  HISTORY_COMMENT_KINDS,
  IMPORTER_VERSION,
  LIMITS,
  OPTIONAL_CONTENT_SECTIONS,
  REQUIRED_REDACTIONS,
  REVIEW_CONTENT_CONTRACT,
  TASK_PRIORITIES,
  TASK_DISCIPLINES,
  TASK_STATUSES,
  TASK_WORK_STATES,
  WORK_STATE_DETAIL_KEYS,
  BundlePathError,
  canonicalJson,
  canonicalizeBundle,
  canonicalizeJson,
  cloneJson,
  countContent,
  createBundle,
  fileChecksums,
  normalizeRelativePath,
  normalizeWorkStateDetails,
  payloadForChecksum,
  sha256,
  toPortableCanvas,
  toPortableFile,
  toPortableGithub,
  toPortableHistory,
  toPortableOverview,
  toPortableProject,
  toPortableSpec,
  toPortableTask,
};
