'use strict';

/**
 * Read-only preflight for portable project review bundles (T-468-4).
 *
 * This module intentionally has no database, filesystem write, HZL or
 * archive dependency. It accepts the application-level JSON document and
 * produces a safe preview that an importer can use as its admission gate.
 */

const {
  CONTENT_SECTIONS,
  IMPORTER_VERSION,
  LIMITS,
  canonicalJson,
  sha256,
  normalizeRelativePath,
} = require('./project-bundle-schema.js');
const { validateBundle } = require('./project-bundle-validator.js');
const { scanSensitiveContent } = require('./project-bundle-secrets.js');

// 64 MiB is the contract's aggregate file-content ceiling. The transport
// budget leaves room for JSON object keys, manifest and task metadata while
// remaining bounded before JSON.parse allocates the object graph.
const RAW_BODY_LIMIT = 72 * 1024 * 1024;
const SUPPORTED_MEDIA_TYPES = Object.freeze([
  'application/vnd.flowboard.project+json',
  'application/octet-stream',
]);
const TARGET_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

const ARCHIVE_METADATA_KEYS = Object.freeze([
  'symlink', 'isSymlink', 'symbolicLink', 'isSymbolicLink',
  'hardlink', 'isHardlink', 'hardLink', 'isHardLink', 'hard_link', 'is_hardlink',
  'linkTarget', 'target', 'type', 'mode', 'executable',
]);
const archiveMetadataToken = (key) => String(key).toLowerCase().replaceAll('_', '').replaceAll('-', '');
const ARCHIVE_METADATA_KEY_SET = new Set(ARCHIVE_METADATA_KEYS.map(archiveMetadataToken));
const REDACTED_VALUE = '[redacted]';

// Secret warning paths are a user-facing API surface. Only fields from the
// portable contract may be reflected; an arbitrary object key must collapse
// to the nearest known container so a bundle cannot smuggle data through a
// warning path.
const SAFE_CHILD_KEYS = Object.freeze({
  root: new Set(['manifest', 'project', 'tasks', 'specs', 'canvas', 'overview', 'files', 'history']),
  manifest: new Set(['identity', 'formatVersion', 'producer', 'bundleId', 'createdAt', 'source', 'counts', 'checksums', 'options', 'redactions', 'compatibility', 'warnings']),
  'manifest.source': new Set(['slug', 'displayName', 'group', 'description', 'taskDiscipline', 'github']),
  'source.github': new Set(['repo', 'branch']),
  project: new Set(['slug', 'displayName', 'description', 'group', 'taskDiscipline', 'github', 'createdAt', 'updatedAt']),
  task: new Set(['id', 'title', 'status', 'priority', 'description', 'tags', 'links', 'dependsOn', 'parentId', 'specFile', 'workState', 'updatedAt', 'dueAt', 'completedAt', 'createdAt', 'enteredStatusAt', 'order', 'workStateDetails']),
  'task.workStateDetails': new Set(['reason', 'waitingFor', 'responsible', 'checkAgainAt', 'setAt']),
  spec: new Set(['path', 'taskId', 'content']),
  file: new Set(['path', 'content', 'encoding', 'sizeBytes', 'sha256']),
  canvas: new Set(['version', 'notes', 'connections']),
  canvasNote: new Set(['id', 'text', 'x', 'y', 'color', 'size', 'created']),
  canvasConnection: new Set(['from', 'to', 'fromPort', 'toPort']),
  overview: new Set(['version', 'layout', 'preset', 'widgets']),
  overviewWidget: new Set(['id', 'type', 'title', 'props', 'grid']),
  overviewGrid: new Set(['x', 'y', 'w', 'h']),
  history: new Set(['comments', 'checkpoints']),
  historyComment: new Set(['id', 'taskId', 'body', 'kind', 'createdAt', 'authorLabel', 'questionId', 'sequence']),
  historyCheckpoint: new Set(['id', 'taskId', 'message', 'progress', 'createdAt', 'authorLabel', 'sequence']),
});

const KEY_TRANSITIONS = Object.freeze({
  root: { manifest: 'manifest', project: 'project', tasks: 'tasksArray', specs: 'specsArray', canvas: 'canvas', overview: 'overview', files: 'filesArray', history: 'history' },
  manifest: { source: 'manifest.source' },
  'manifest.source': { github: 'source.github' },
  project: { github: 'source.github' },
  task: { workStateDetails: 'task.workStateDetails', tags: 'scalarArray', links: 'scalarArray', dependsOn: 'scalarArray' },
  canvas: { notes: 'canvasNotesArray', connections: 'canvasConnectionsArray' },
  overview: { widgets: 'overviewWidgetsArray' },
  overviewWidget: { grid: 'overviewGrid' },
  history: { comments: 'historyCommentsArray', checkpoints: 'historyCheckpointsArray' },
});

const ARRAY_TRANSITIONS = Object.freeze({
  tasksArray: 'task', specsArray: 'spec', filesArray: 'file',
  canvasNotesArray: 'canvasNote', canvasConnectionsArray: 'canvasConnection',
  overviewWidgetsArray: 'overviewWidget', historyCommentsArray: 'historyComment',
  historyCheckpointsArray: 'historyCheckpoint', scalarArray: 'scalarArrayItem',
});
const COUNT_FIELDS = Object.freeze([
  'tasks', 'specs', 'canvasNotes', 'canvasConnections',
  'overviewWidgets', 'files', 'historyComments', 'historyCheckpoints',
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function addIssue(list, code, path, message) {
  list.push({ code, path, message });
}

function safeLocationPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > LIMITS.path) return undefined;
  // Never return a filename that itself looks like credential material. The
  // caller still gets the machine-readable warning code and container path.
  if (scanSensitiveContent(value).length > 0) return undefined;
  try {
    return normalizeRelativePath(value);
  } catch {
    return undefined;
  }
}

function sanitizeIssuePath(value) {
  const raw = typeof value === 'string' ? value : '$';
  // Validator paths normally use array indexes. Collapse content-bearing
  // identifiers (task IDs and filenames) to their containing field so an
  // untrusted bundle cannot reflect arbitrary values in an API error.
  if (/^(?:files|specs)\[\d+\]/.test(raw)) return raw.replace(/^(files|specs)\[(\d+)\].*$/, '$1[$2]');
  if (/^canvas\.(?:notes|connections)\[\d+\]/.test(raw)) return raw.replace(/^(canvas\.(?:notes|connections))\[\d+\].*$/, '$1');
  if (/^overview\.widgets\[\d+\]/.test(raw)) return raw.replace(/^overview\.widgets\[\d+\].*$/, 'overview.widgets');
  if (/^history\.(?:comments|checkpoints)\[\d+\]/.test(raw)) return raw.replace(/^(history\.(?:comments|checkpoints))\[\d+\].*$/, '$1');
  if (/^tasks\[\d+\]/.test(raw)) return raw.replace(/^tasks\[\d+\].*$/, 'tasks');
  if (raw.startsWith('tasks.')) return 'tasks';
  if (raw.startsWith('manifest.checksums.files')) return 'manifest.checksums.files';
  return /^[A-Za-z0-9_$.[\]-]+$/.test(raw) && raw.length <= 160 ? raw : '$';
}

function safeIssue(issue) {
  return {
    code: String(issue?.code || 'BUNDLE_INVALID'),
    path: sanitizeIssuePath(issue?.path),
  };
}

function parsePathTokens(location) {
  if (location === '$' || location === '') return [];
  const raw = String(location).startsWith('$.') ? String(location).slice(2) : String(location);
  const tokens = [];
  let cursor = 0;
  while (cursor < raw.length) {
    if (cursor > 0 && raw[cursor] === '.') cursor += 1;
    if (raw[cursor] === '[') {
      const match = raw.slice(cursor).match(/^\[(\d+)\]/);
      if (!match) return null;
      tokens.push({ type: 'index', value: Number(match[1]) });
      cursor += match[0].length;
    } else {
      const match = raw.slice(cursor).match(/^[A-Za-z][A-Za-z0-9_]*/);
      if (!match) return null;
      tokens.push({ type: 'key', value: match[0] });
      cursor += match[0].length;
    }
    if (cursor < raw.length && raw[cursor] !== '.' && raw[cursor] !== '[') return null;
  }
  return tokens;
}

function safeFindingPath(location) {
  const tokens = parsePathTokens(location);
  if (!tokens) return '$';
  let state = 'root';
  let output = '$';
  for (const token of tokens) {
    if (token.type === 'index') {
      if (!Object.prototype.hasOwnProperty.call(ARRAY_TRANSITIONS, state)) return output;
      output += `[${token.value}]`;
      state = ARRAY_TRANSITIONS[state];
      continue;
    }
    const allowed = SAFE_CHILD_KEYS[state];
    if (!allowed || !allowed.has(token.value)) return output;
    output = output === '$' ? token.value : `${output}.${token.value}`;
    state = KEY_TRANSITIONS[state]?.[token.value] || 'scalar';
  }
  return output;
}

function safeManifestWarning(warning) {
  const candidateCode = String(warning?.code || '');
  const output = {
    code: /^[A-Z][A-Z0-9_:-]{0,63}$/.test(candidateCode) && scanSensitiveContent(candidateCode).length === 0
      ? candidateCode
      : 'MANIFEST_WARNING',
  };
  const path = safeLocationPath(warning?.path);
  if (path) output.path = path;
  return output;
}

function safeSourceValue(value) {
  if (typeof value !== 'string') return value;
  return scanSensitiveContent(value).length > 0 ? REDACTED_VALUE : value;
}

function buildSourcePreview(manifest) {
  const source = manifest?.source || {};
  const output = {};
  for (const key of ['slug', 'displayName', 'description', 'group', 'taskDiscipline']) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    output[key] = key === 'slug' || key === 'taskDiscipline' ? source[key] : safeSourceValue(source[key]);
  }
  if (source.github === null) {
    output.github = null;
  } else if (isObject(source.github)) {
    const github = {};
    for (const key of ['repo', 'branch']) {
      if (Object.prototype.hasOwnProperty.call(source.github, key)) github[key] = safeSourceValue(source.github[key]);
    }
    output.github = github;
  }
  const producer = {};
  for (const key of ['name', 'version']) {
    if (Object.prototype.hasOwnProperty.call(manifest?.producer || {}, key)) {
      producer[key] = safeSourceValue(manifest.producer[key]);
    }
  }
  output.producer = producer;
  output.createdAt = manifest?.createdAt;
  return output;
}

function buildCompatibilityPreview(compatibility) {
  const output = { minImporterVersion: compatibility?.minImporterVersion };
  if (compatibility?.maxImporterVersion !== undefined) output.maxImporterVersion = compatibility.maxImporterVersion;
  return output;
}

function buildOptionsPreview(options) {
  return {
    includeHistory: options?.includeHistory === true,
    includeExecutable: options?.includeExecutable === true,
  };
}

function buildCountsPreview(counts) {
  return Object.fromEntries(COUNT_FIELDS.map((key) => [key, counts[key]]));
}

function buildRedactionsPreview(redactions) {
  if (!Array.isArray(redactions)) return [];
  return redactions.filter((value) => typeof value === 'string'
    && /^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(value)
    && scanSensitiveContent(value).length === 0);
}

function mediaType(value) {
  return String(value || '').split(';', 1)[0].trim().toLowerCase();
}

function isSupportedMediaType(value) {
  return SUPPORTED_MEDIA_TYPES.includes(mediaType(value));
}

function strictDecodeUtf8(body) {
  if (!Buffer.isBuffer(body)) throw Object.assign(new Error('request body must be a raw buffer'), { code: 'BODY_NOT_RAW' });
  if (body.length > RAW_BODY_LIMIT) throw Object.assign(new Error('request body exceeds the JSON upload limit'), { code: 'RAW_SIZE_LIMIT' });
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw Object.assign(new Error('request body is not valid UTF-8'), { code: 'INVALID_UTF8' });
  }
}

function parseJsonBody(body) {
  const text = strictDecodeUtf8(body);
  try {
    return { bundle: JSON.parse(text), decodedBytes: Buffer.byteLength(text, 'utf8') };
  } catch {
    throw Object.assign(new Error('request body is not valid JSON'), { code: 'MALFORMED_JSON' });
  }
}

function scanArchiveMetadata(bundle, errors) {
  for (const section of ['files', 'specs']) {
    if (!Array.isArray(bundle?.[section])) continue;
    bundle[section].forEach((entry, index) => {
      if (!isObject(entry)) return;
      for (const key of Object.keys(entry)) {
        if (!ARCHIVE_METADATA_KEY_SET.has(archiveMetadataToken(key))) continue;
        addIssue(errors, 'ARCHIVE_METADATA_UNSUPPORTED', `${section}[${index}].${key}`, 'link and archive metadata are not supported in JSON v1');
      }
    });
  }
}

function scanPathCollisions(bundle, errors) {
  const seen = new Map();
  for (const section of ['specs', 'files']) {
    if (!Array.isArray(bundle?.[section])) continue;
    bundle[section].forEach((entry, index) => {
      if (typeof entry?.path !== 'string') return;
      let normalized;
      try { normalized = normalizeRelativePath(entry.path); } catch { return; }
      const folded = normalized.toLocaleLowerCase('en-US');
      const previous = seen.get(folded);
      if (previous) {
        const exact = previous.path === normalized;
        addIssue(
          errors,
          exact ? 'DUPLICATE_CONTENT_PATH' : 'PATH_CASE_COLLISION',
          `${section}[${index}].path`,
          exact
            ? `path duplicates ${previous.section} content`
            : `path collides case-insensitively with ${previous.section} content`,
        );
      } else {
        seen.set(folded, { section, path: normalized });
      }
    });
  }
}

function isSuspiciousFilename(value) {
  const lower = String(value).toLowerCase();
  const base = lower.split('/').pop() || lower;
  return base.startsWith('.')
    || base.endsWith('~')
    || base.endsWith('.bak')
    || base.endsWith('.swp')
    || base.endsWith('.tmp')
    || base === 'flowboard.db'
    || base.startsWith('flowboard.db-')
    || /(?:^|[-_.])(secret|credential|password|token|private[-_]?key)(?:[-_.]|$)/i.test(base)
    || /(?:^|\/)(?:node_modules|\.git)(?:\/|$)/i.test(lower);
}

function scanSuspiciousFilenames(bundle, errors) {
  for (const section of ['files', 'specs']) {
    if (!Array.isArray(bundle?.[section])) continue;
    bundle[section].forEach((entry, index) => {
      if (typeof entry?.path === 'string' && isSuspiciousFilename(entry.path)) {
        addIssue(errors, 'SUSPICIOUS_FILENAME', `${section}[${index}].path`, 'filename is outside the review content boundary');
      }
    });
  }
}

function collectSensitiveFindings(value, location = '$', findings = [], seen = new Set()) {
  if (value === null || value === undefined) return findings;
  if (typeof value === 'string') {
    for (const finding of scanSensitiveContent(value)) {
      findings.push({ code: finding.code, path: safeFindingPath(location) });
    }
    return findings;
  }
  if (typeof value !== 'object') return findings;
  if (seen.has(value)) return findings;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((child, index) => collectSensitiveFindings(child, `${location}[${index}]`, findings, seen));
  } else {
    Object.entries(value).forEach(([key, child]) => {
      // Unknown keys are content too: scan them, but report only their safe
      // parent container if the key is not part of the portable grammar.
      for (const finding of scanSensitiveContent(key)) {
        findings.push({ code: finding.code, path: safeFindingPath(location) });
      }
      collectSensitiveFindings(child, location === '$' ? key : `${location}.${key}`, findings, seen);
    });
  }
  seen.delete(value);
  return findings;
}

function dedupeFindings(findings) {
  const seen = new Set();
  return findings
    .filter((finding) => {
      const key = `${finding.code}\0${finding.path}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => `${a.code}\0${a.path}`.localeCompare(`${b.code}\0${b.path}`));
}

function targetName(value, fallback) {
  const requested = value === undefined || value === null || value === '' ? fallback : String(value);
  return {
    name: requested,
    valid: TARGET_NAME_RE.test(requested),
  };
}

function contentSummary(bundle) {
  const includedSections = CONTENT_SECTIONS.filter((section) => bundle?.[section] !== undefined);
  const excludedSections = [];
  if (bundle?.history === undefined) excludedSections.push('history');
  if (bundle?.manifest?.options?.includeExecutable !== true) excludedSections.push('executable-files');
  return {
    included: {
      sections: includedSections,
      history: bundle?.history !== undefined,
      files: Array.isArray(bundle?.files) ? bundle.files.length : 0,
    },
    excluded: {
      sections: excludedSections,
      redactedRuntime: true,
    },
  };
}

function buildTargetAvailability(name, { existingProjects = [], deletedProjects = [], directoryExists = false } = {}) {
  const existing = new Set(existingProjects.map((project) => typeof project === 'string' ? project : project?.name).filter(Boolean));
  const deleted = new Set(deletedProjects.map((project) => typeof project === 'string' ? project : project?.name).filter(Boolean));
  const conflicts = [];
  if (existing.has(name)) conflicts.push('existing-project');
  if (deleted.has(name)) conflicts.push('deleted-project');
  if (directoryExists) conflicts.push('existing-directory');
  return {
    name: TARGET_NAME_RE.test(name) ? name : '[invalid]',
    valid: TARGET_NAME_RE.test(name),
    availability: conflicts.length === 0 ? 'available' : 'conflict',
    conflicts,
  };
}

function makeDigest(bundle) {
  try { return sha256(canonicalJson(bundle)); } catch { return null; }
}

/**
 * Build a no-write preview. `state` is deliberately supplied by the caller
 * as read-only data so this function cannot reach persistence accidentally.
 */
function previewBundle(bundle, { targetName: requestedTarget, existingProjects, deletedProjects, directoryExists = false } = {}) {
  const bundleDigest = makeDigest(bundle);
  const validation = validateBundle(bundle);
  const errors = [...validation.errors];
  scanArchiveMetadata(bundle, errors);
  scanPathCollisions(bundle, errors);
  scanSuspiciousFilenames(bundle, errors);

  const target = targetName(requestedTarget, bundle?.project?.slug);
  if (!target.valid) addIssue(errors, 'TARGET_INVALID', 'targetName', 'target name must be a lowercase project slug');

  const securityWarnings = dedupeFindings(collectSensitiveFindings(bundle)).map(({ code, path }) => ({
    code,
    path,
    guidance: 'Remove or redact sensitive content before importing this bundle.',
  }));
  const availability = buildTargetAvailability(target.name, {
    existingProjects,
    deletedProjects,
    directoryExists,
  });
  if (errors.length > 0) {
    return {
      ok: false,
      bundleDigest,
      errors: errors.map(safeIssue),
      warnings: (validation.warnings || []).map(safeIssue),
      securityWarnings,
      target: availability,
    };
  }

  const normalized = validation.bundle;
  const manifest = normalized.manifest;
  const canImport = securityWarnings.length === 0 && availability.valid && availability.conflicts.length === 0;
  return {
    ok: true,
    preview: {
      bundleDigest: makeDigest(normalized),
      source: buildSourcePreview(manifest),
      format: {
        identity: manifest.identity,
        version: manifest.formatVersion,
        importerVersion: IMPORTER_VERSION,
        compatibility: buildCompatibilityPreview(manifest.compatibility),
        status: 'compatible',
      },
      counts: buildCountsPreview(manifest.counts),
      options: buildOptionsPreview(manifest.options),
      redactions: buildRedactionsPreview(manifest.redactions),
      ...contentSummary(normalized),
      manifestWarnings: (manifest.warnings || []).map(safeManifestWarning),
      securityWarnings,
      target: availability,
      canImport,
    },
  };
}

module.exports = {
  ARCHIVE_METADATA_KEYS,
  RAW_BODY_LIMIT,
  REDACTED_VALUE,
  SUPPORTED_MEDIA_TYPES,
  TARGET_NAME_RE,
  buildTargetAvailability,
  collectSensitiveFindings,
  isSupportedMediaType,
  mediaType,
  parseJsonBody,
  previewBundle,
  safeIssue,
  safeLocationPath,
  safeFindingPath,
  sanitizeIssuePath,
  strictDecodeUtf8,
};
