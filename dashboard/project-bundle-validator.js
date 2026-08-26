'use strict';

/** Pure preflight validation for portable project review bundles. */

const {
  BUNDLE_IDENTITY,
  BUNDLE_FORMAT_VERSION,
  CANVAS_COLORS,
  CANVAS_PORTS,
  CANVAS_SIZES,
  CHECKSUM_ALGORITHM,
  FORBIDDEN_FIELD_NAMES,
  HISTORY_COMMENT_KINDS,
  IMPORTER_VERSION,
  LIMITS,
  REQUIRED_REDACTIONS,
  TASK_DISCIPLINES,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_WORK_STATES,
  WORK_STATE_DETAIL_KEYS,
  canonicalizeBundle,
  normalizeRelativePath,
  payloadForChecksum,
  sha256,
} = require('./project-bundle-schema.js');

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function byteLength(value) {
  return typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : 0;
}

function fieldToken(name) {
  return String(name).toLowerCase().replaceAll('-', '');
}

const FORBIDDEN_TOKENS = new Set(FORBIDDEN_FIELD_NAMES.map(fieldToken));

function isForbiddenField(name) {
  // taskId is a portable reference and is deliberately allowed. The HZL
  // spelling task_id, however, is an implementation detail and is forbidden.
  if (String(name) === 'taskId') return false;
  return FORBIDDEN_TOKENS.has(fieldToken(name));
}

function addIssue(list, code, path, message, extra = {}) {
  list.push({ code, path, message, ...extra });
}

function requireObject(value, path, errors) {
  if (!isObject(value)) {
    addIssue(errors, 'TYPE_INVALID', path, 'must be an object');
    return false;
  }
  return true;
}

function requireArray(value, path, errors, max = Infinity) {
  if (!Array.isArray(value)) {
    addIssue(errors, 'TYPE_INVALID', path, 'must be an array');
    return false;
  }
  if (value.length > max) addIssue(errors, 'LIMIT_EXCEEDED', path, `contains more than ${max} items`);
  return true;
}

function requiredField(object, key, path, errors) {
  if (!Object.prototype.hasOwnProperty.call(object, key)) {
    addIssue(errors, 'FIELD_REQUIRED', `${path}.${key}`, 'is required');
    return false;
  }
  return true;
}

function stringField(object, key, path, errors, { required = false, max = Infinity, min = 0, pattern } = {}) {
  const present = Object.prototype.hasOwnProperty.call(object, key);
  if (!present) {
    if (required) requiredField(object, key, path, errors);
    return undefined;
  }
  const value = object[key];
  if (typeof value !== 'string') {
    addIssue(errors, 'TYPE_INVALID', `${path}.${key}`, 'must be a string');
    return undefined;
  }
  if (value.length < min) addIssue(errors, 'LENGTH_INVALID', `${path}.${key}`, `must contain at least ${min} characters`);
  if (byteLength(value) > max) addIssue(errors, 'LIMIT_EXCEEDED', `${path}.${key}`, `must not exceed ${max} UTF-8 bytes`);
  if (pattern && !pattern.test(value)) addIssue(errors, 'FORMAT_INVALID', `${path}.${key}`, 'has an invalid format');
  return value;
}

function idField(object, key, path, errors, { required = false } = {}) {
  return stringField(object, key, path, errors, {
    required,
    max: LIMITS.id,
    min: 1,
    pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/,
  });
}

function isoDateTime(value) {
  if (typeof value !== 'string' || !/T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) return false;
  return Number.isFinite(Date.parse(value));
}

function isoDateOrDateTime(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return Number.isFinite(Date.parse(`${value}T00:00:00Z`));
  }
  return isoDateTime(value);
}

function isoDateOnly(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`));
}

function timestampField(object, key, path, errors, { required = false, dateOnly = false, dateOnlyStrict = false, nullable = false } = {}) {
  const present = Object.prototype.hasOwnProperty.call(object, key);
  if (!present) {
    if (required) requiredField(object, key, path, errors);
    return;
  }
  const value = object[key];
  if (nullable && value === null) return;
  const valid = dateOnlyStrict ? isoDateOnly(value) : (dateOnly ? isoDateOrDateTime(value) : isoDateTime(value));
  if (!valid) {
    addIssue(errors, 'TIMESTAMP_INVALID', `${path}.${key}`, 'must be an ISO-8601 timestamp with timezone');
  }
}

function enumField(object, key, path, errors, values, { required = false } = {}) {
  const present = Object.prototype.hasOwnProperty.call(object, key);
  if (!present) {
    if (required) requiredField(object, key, path, errors);
    return;
  }
  if (!values.includes(object[key])) {
    addIssue(errors, 'ENUM_INVALID', `${path}.${key}`, `must be one of: ${values.join(', ')}`);
  }
}

function finiteNumberField(object, key, path, errors, { required = false, min = -Infinity, max = Infinity, integer = false } = {}) {
  const present = Object.prototype.hasOwnProperty.call(object, key);
  if (!present) {
    if (required) requiredField(object, key, path, errors);
    return;
  }
  const value = object[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isInteger(value))) {
    addIssue(errors, 'TYPE_INVALID', `${path}.${key}`, integer ? 'must be a finite integer' : 'must be a finite number');
    return;
  }
  if (value < min || value > max) addIssue(errors, 'RANGE_INVALID', `${path}.${key}`, `must be between ${min} and ${max}`);
}

function validateStringArray(value, path, errors, { maxItems = 100, maxItemBytes = LIMITS.link, unique = false } = {}) {
  if (!Array.isArray(value)) {
    addIssue(errors, 'TYPE_INVALID', path, 'must be an array');
    return;
  }
  if (value.length > maxItems) addIssue(errors, 'LIMIT_EXCEEDED', path, `contains more than ${maxItems} items`);
  const seen = new Set();
  value.forEach((item, index) => {
    if (typeof item !== 'string') addIssue(errors, 'TYPE_INVALID', `${path}[${index}]`, 'must be a string');
    else {
      if (byteLength(item) > maxItemBytes) addIssue(errors, 'LIMIT_EXCEEDED', `${path}[${index}]`, `must not exceed ${maxItemBytes} UTF-8 bytes`);
      if (unique && seen.has(item)) addIssue(errors, 'DUPLICATE_ID', `${path}[${index}]`, 'is duplicated');
      seen.add(item);
    }
  });
}

function scanForbiddenFields(value, path, errors, seen = new Set()) {
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) {
    addIssue(errors, 'CYCLE_IN_JSON', path, 'object graph must not contain cycles');
    return;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((child, index) => scanForbiddenFields(child, `${path}[${index}]`, errors, seen));
  } else {
    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      if (isForbiddenField(key)) addIssue(errors, 'FORBIDDEN_FIELD', childPath, 'is not portable and must be redacted');
      scanForbiddenFields(child, childPath, errors, seen);
    }
  }
  seen.delete(value);
}

function validateManifest(manifest, errors, warnings) {
  const path = 'manifest';
  if (!requireObject(manifest, path, errors)) return;
  stringField(manifest, 'identity', path, errors, { required: true, max: 128 });
  if (manifest.identity !== BUNDLE_IDENTITY) addIssue(errors, 'IDENTITY_UNSUPPORTED', `${path}.identity`, `must be ${BUNDLE_IDENTITY}`);
  if (manifest.formatVersion !== BUNDLE_FORMAT_VERSION) {
    addIssue(errors, 'FORMAT_UNSUPPORTED', `${path}.formatVersion`, `only format version ${BUNDLE_FORMAT_VERSION} is supported`);
  }
  if (!requireObject(manifest.producer, `${path}.producer`, errors)) return;
  stringField(manifest.producer, 'name', `${path}.producer`, errors, { required: true, max: LIMITS.producerName, min: 1 });
  stringField(manifest.producer, 'version', `${path}.producer`, errors, { required: true, max: LIMITS.producerVersion, min: 1 });
  stringField(manifest, 'bundleId', path, errors, { required: true, max: LIMITS.bundleId, min: 1, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/ });
  timestampField(manifest, 'createdAt', path, errors, { required: true });

  if (!requireObject(manifest.source, `${path}.source`, errors)) return;
  stringField(manifest.source, 'slug', `${path}.source`, errors, {
    required: true, max: LIMITS.projectSlug, min: 1, pattern: /^[a-z0-9][a-z0-9-]{0,62}$/,
  });
  stringField(manifest.source, 'displayName', `${path}.source`, errors, { required: true, max: LIMITS.projectDisplayName, min: 1 });
  stringField(manifest.source, 'group', `${path}.source`, errors, { max: LIMITS.projectDisplayName });
  stringField(manifest.source, 'description', `${path}.source`, errors, { max: LIMITS.projectDescription });
  enumField(manifest.source, 'taskDiscipline', `${path}.source`, errors, TASK_DISCIPLINES, { required: true });
  validateGithub(manifest.source.github, `${path}.source.github`, errors);

  if (!requireObject(manifest.counts, `${path}.counts`, errors)) return;
  for (const key of ['tasks', 'specs', 'canvasNotes', 'canvasConnections', 'overviewWidgets', 'files', 'historyComments', 'historyCheckpoints']) {
    finiteNumberField(manifest.counts, key, `${path}.counts`, errors, { required: true, min: 0, max: 100000, integer: true });
  }

  if (!requireObject(manifest.checksums, `${path}.checksums`, errors)) return;
  if (manifest.checksums.algorithm !== CHECKSUM_ALGORITHM) addIssue(errors, 'ENUM_INVALID', `${path}.checksums.algorithm`, `must be ${CHECKSUM_ALGORITHM}`);
  stringField(manifest.checksums, 'payload', `${path}.checksums`, errors, { required: true, max: 64, min: 64, pattern: /^[a-f0-9]{64}$/ });
  if (!requireObject(manifest.checksums.files, `${path}.checksums.files`, errors)) return;
  for (const [filePath, checksum] of Object.entries(manifest.checksums.files || {})) {
    try { normalizeRelativePath(filePath); } catch (error) { addIssue(errors, error.code || 'PATH_UNSAFE', `${path}.checksums.files.${filePath}`, error.message); }
    if (typeof checksum !== 'string' || !/^[a-f0-9]{64}$/.test(checksum)) {
      addIssue(errors, 'CHECKSUM_INVALID', `${path}.checksums.files.${filePath}`, 'must be a lowercase SHA-256 hex digest');
    }
  }

  if (!requireObject(manifest.options, `${path}.options`, errors)) return;
  if (typeof manifest.options.includeHistory !== 'boolean') addIssue(errors, 'TYPE_INVALID', `${path}.options.includeHistory`, 'must be a boolean');
  if (typeof manifest.options.includeExecutable !== 'boolean') addIssue(errors, 'TYPE_INVALID', `${path}.options.includeExecutable`, 'must be a boolean');
  if (manifest.options.includeExecutable === true) addIssue(errors, 'EXECUTABLE_UNSUPPORTED', `${path}.options.includeExecutable`, 'executable content is not supported in v1');

  if (!Array.isArray(manifest.redactions)) {
    addIssue(errors, 'TYPE_INVALID', `${path}.redactions`, 'must be an array');
  } else {
    validateStringArray(manifest.redactions, `${path}.redactions`, errors, { maxItems: 100, maxItemBytes: 128, unique: true });
    for (const redaction of REQUIRED_REDACTIONS) {
      if (!manifest.redactions.includes(redaction)) addIssue(errors, 'REDACTION_MISSING', `${path}.redactions`, `must include ${redaction}`);
    }
  }

  if (!requireObject(manifest.compatibility, `${path}.compatibility`, errors)) return;
  const minimum = manifest.compatibility.minImporterVersion;
  if (typeof minimum !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(minimum)) {
    addIssue(errors, 'VERSION_INVALID', `${path}.compatibility.minImporterVersion`, 'must be a semantic version');
  } else if (compareVersions(minimum, IMPORTER_VERSION) > 0) {
    addIssue(errors, 'COMPATIBILITY_UNSUPPORTED', `${path}.compatibility.minImporterVersion`, `requires importer ${minimum} or newer`);
  }
  if (manifest.compatibility.maxImporterVersion !== undefined) {
    if (typeof manifest.compatibility.maxImporterVersion !== 'string') addIssue(errors, 'TYPE_INVALID', `${path}.compatibility.maxImporterVersion`, 'must be a semantic version');
    else if (compareVersions(IMPORTER_VERSION, manifest.compatibility.maxImporterVersion) > 0) addIssue(errors, 'COMPATIBILITY_UNSUPPORTED', `${path}.compatibility.maxImporterVersion`, `is incompatible with importer ${IMPORTER_VERSION}`);
  }

  if (manifest.warnings !== undefined) {
    if (!requireArray(manifest.warnings, `${path}.warnings`, errors, LIMITS.warnings)) return;
    manifest.warnings.forEach((warning, index) => {
      const warningPath = `${path}.warnings[${index}]`;
      if (!requireObject(warning, warningPath, errors)) return;
      stringField(warning, 'code', warningPath, errors, { required: true, max: 128, min: 1, pattern: /^[A-Z0-9_:-]+$/ });
      stringField(warning, 'path', warningPath, errors, { max: LIMITS.path, min: 1 });
      stringField(warning, 'message', warningPath, errors, { required: true, max: LIMITS.warningMessage, min: 1 });
    });
  }
}

function compareVersions(a, b) {
  const parse = (value) => String(value).split('-')[0].split('.').map((part) => Number(part));
  const left = parse(a); const right = parse(b);
  for (let index = 0; index < 3; index += 1) {
    if ((left[index] || 0) !== (right[index] || 0)) return (left[index] || 0) - (right[index] || 0);
  }
  return 0;
}

function validateProject(project, errors) {
  const path = 'project';
  if (!requireObject(project, path, errors)) return;
  stringField(project, 'slug', path, errors, { required: true, max: LIMITS.projectSlug, min: 1, pattern: /^[a-z0-9][a-z0-9-]{0,62}$/ });
  stringField(project, 'displayName', path, errors, { required: true, max: LIMITS.projectDisplayName, min: 1 });
  stringField(project, 'description', path, errors, { max: LIMITS.projectDescription });
  stringField(project, 'group', path, errors, { max: LIMITS.projectDisplayName });
  enumField(project, 'taskDiscipline', path, errors, TASK_DISCIPLINES, { required: true });
  validateGithub(project.github, `${path}.github`, errors);
  timestampField(project, 'createdAt', path, errors);
  timestampField(project, 'updatedAt', path, errors);
}

function validateGithub(github, path, errors) {
  if (github === undefined || github === null) return;
  if (!requireObject(github, path, errors)) return;
  stringField(github, 'repo', path, errors, {
    required: true, max: 256, min: 3,
    pattern: /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/,
  });
  if (github.branch !== undefined) {
    stringField(github, 'branch', path, errors, {
      max: 120, min: 1, pattern: /^[\w./-]{1,120}$/,
    });
    if (typeof github.branch === 'string' && (github.branch.includes('..') || github.branch.endsWith('/') || github.branch.startsWith('/'))) {
      addIssue(errors, 'FORMAT_INVALID', `${path}.branch`, 'must be a valid Git branch name');
    }
  }
}

function validateTasks(tasks, errors) {
  if (!requireArray(tasks, 'tasks', errors, LIMITS.tasks)) return new Map();
  const ids = new Set();
  const byId = new Map();
  tasks.forEach((task, index) => {
    const path = `tasks[${index}]`;
    if (!requireObject(task, path, errors)) return;
    const id = idField(task, 'id', path, errors, { required: true });
    if (id) {
      if (ids.has(id)) addIssue(errors, 'DUPLICATE_ID', `${path}.id`, `task id ${id} is duplicated`);
      ids.add(id); byId.set(id, task);
    }
    stringField(task, 'title', path, errors, { required: true, max: LIMITS.title, min: 1 });
    enumField(task, 'status', path, errors, TASK_STATUSES, { required: true });
    enumField(task, 'priority', path, errors, TASK_PRIORITIES, { required: true });
    enumField(task, 'workState', path, errors, TASK_WORK_STATES);
    stringField(task, 'description', path, errors, { max: LIMITS.description });
    if (task.tags !== undefined) validateStringArray(task.tags, `${path}.tags`, errors, { maxItems: 100, maxItemBytes: LIMITS.tag, unique: true });
    if (task.links !== undefined) validateStringArray(task.links, `${path}.links`, errors, { maxItems: 100, maxItemBytes: LIMITS.link, unique: true });
    if (task.dependsOn !== undefined) validateStringArray(task.dependsOn, `${path}.dependsOn`, errors, { maxItems: 100, maxItemBytes: LIMITS.id, unique: true });
    if (task.parentId !== undefined && task.parentId !== null) idField(task, 'parentId', path, errors);
    if (task.specFile !== undefined && task.specFile !== null) stringField(task, 'specFile', path, errors, { max: LIMITS.path, min: 1 });
    timestampField(task, 'createdAt', path, errors, { required: true, dateOnlyStrict: true });
    timestampField(task, 'updatedAt', path, errors);
    timestampField(task, 'dueAt', path, errors);
    timestampField(task, 'completedAt', path, errors, { required: true, dateOnlyStrict: true, nullable: true });
    // New tasks expose a zoned ISO timestamp; legacy rows fall back to the
    // public `created` date, so both exact representations are portable.
    timestampField(task, 'enteredStatusAt', path, errors, { required: true, dateOnly: true });
    if (!Object.prototype.hasOwnProperty.call(task, 'order')) requiredField(task, 'order', path, errors);
    else if (task.order !== null) finiteNumberField(task, 'order', path, errors);
    validateWorkStateDetails(task.workStateDetails, `${path}.workStateDetails`, errors);
  });

  const parentOf = new Map();
  const dependencyOf = new Map();
  for (const [id, task] of byId) {
    const parent = task.parentId;
    if (parent !== undefined && parent !== null) {
      if (!byId.has(parent)) addIssue(errors, 'REFERENCE_MISSING', `tasks.${id}.parentId`, `parent task ${parent} does not exist`);
      if (parent === id) addIssue(errors, 'HIERARCHY_CYCLE', `tasks.${id}.parentId`, 'a task cannot be its own parent');
      parentOf.set(id, parent);
      const grandparent = byId.get(parent)?.parentId;
      if (grandparent !== undefined && grandparent !== null) addIssue(errors, 'HIERARCHY_DEPTH', `tasks.${id}.parentId`, 'task hierarchy may contain at most one subtask level');
    }
    if (Array.isArray(task.dependsOn)) {
      dependencyOf.set(id, task.dependsOn);
      for (const dependency of task.dependsOn) {
        if (!byId.has(dependency)) addIssue(errors, 'REFERENCE_MISSING', `tasks.${id}.dependsOn`, `dependency task ${dependency} does not exist`);
        if (dependency === id) addIssue(errors, 'HIERARCHY_CYCLE', `tasks.${id}.dependsOn`, 'a task cannot depend on itself');
      }
    }
  }
  const visiting = new Set(); const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) { addIssue(errors, 'HIERARCHY_CYCLE', `tasks.${id}.parentId`, 'parent references contain a cycle'); return; }
    if (visited.has(id)) return;
    visiting.add(id);
    if (parentOf.has(id) && byId.has(parentOf.get(id))) visit(parentOf.get(id));
    visiting.delete(id); visited.add(id);
  }
  for (const id of byId.keys()) visit(id);
  const dependencyVisiting = new Set(); const dependencyVisited = new Set();
  function visitDependencies(id) {
    if (dependencyVisiting.has(id)) {
      addIssue(errors, 'DEPENDENCY_CYCLE', `tasks.${id}.dependsOn`, 'dependency references contain a cycle');
      return;
    }
    if (dependencyVisited.has(id)) return;
    dependencyVisiting.add(id);
    for (const dependency of dependencyOf.get(id) || []) {
      if (byId.has(dependency)) visitDependencies(dependency);
    }
    dependencyVisiting.delete(id); dependencyVisited.add(id);
  }
  for (const id of byId.keys()) visitDependencies(id);
  return byId;
}

function validateWorkStateDetails(details, path, errors) {
  if (!requireObject(details, path, errors)) return;
  for (const key of WORK_STATE_DETAIL_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(details, key)) {
      addIssue(errors, 'FIELD_REQUIRED', `${path}.${key}`, 'is required in normalized workStateDetails');
      continue;
    }
    const value = details[key];
    if (value !== null && typeof value !== 'string') addIssue(errors, 'TYPE_INVALID', `${path}.${key}`, 'must be a string or null');
    if (typeof value === 'string' && byteLength(value) > 512) addIssue(errors, 'LIMIT_EXCEEDED', `${path}.${key}`, 'must not exceed 512 UTF-8 bytes');
    if ((key === 'checkAgainAt' || key === 'setAt') && value !== null && !isoDateTime(value) && !(key === 'setAt' && isoDateOrDateTime(value))) {
      addIssue(errors, 'TIMESTAMP_INVALID', `${path}.${key}`, 'must be an ISO-8601 timestamp with timezone');
    }
  }
}

function validateSpecs(specs, tasks, errors) {
  if (!requireArray(specs, 'specs', errors, LIMITS.specs)) return new Map();
  const paths = new Map();
  specs.forEach((spec, index) => {
    const path = `specs[${index}]`;
    if (!requireObject(spec, path, errors)) return;
    const filePath = stringField(spec, 'path', path, errors, { required: true, max: LIMITS.path, min: 1 });
    let normalizedPath = filePath;
    if (filePath) {
      try {
        normalizedPath = normalizeRelativePath(filePath);
        if (!normalizedPath.startsWith('specs/')) addIssue(errors, 'PATH_INVALID', `${path}.path`, 'spec paths must live below specs/');
      } catch (error) { addIssue(errors, error.code || 'PATH_UNSAFE', `${path}.path`, error.message); }
    }
    const taskId = idField(spec, 'taskId', path, errors, { required: true });
    if (taskId && !tasks.has(taskId)) addIssue(errors, 'REFERENCE_MISSING', `${path}.taskId`, `task ${taskId} does not exist`);
    stringField(spec, 'content', path, errors, { required: true, max: LIMITS.fileBytes });
    if (filePath) {
      if (paths.has(normalizedPath)) addIssue(errors, 'DUPLICATE_ID', `${path}.path`, `spec path ${normalizedPath} is duplicated`);
      paths.set(normalizedPath, { taskId, spec });
    }
  });
  for (const [id, task] of tasks) {
    if (task.specFile === undefined || task.specFile === null) continue;
    let specPath = task.specFile;
    try { specPath = normalizeRelativePath(specPath); } catch (error) { addIssue(errors, 'PATH_UNSAFE', `tasks.${id}.specFile`, error.message); continue; }
    if (!paths.has(specPath)) addIssue(errors, 'REFERENCE_MISSING', `tasks.${id}.specFile`, `spec ${specPath} does not exist`);
    else if (paths.get(specPath).taskId !== id) addIssue(errors, 'REFERENCE_INVALID', `tasks.${id}.specFile`, `spec ${specPath} targets a different task`);
  }
  return paths;
}

function validateCanvas(canvas, errors) {
  if (!requireObject(canvas, 'canvas', errors)) return;
  if (canvas.version !== 1) addIssue(errors, 'FORMAT_UNSUPPORTED', 'canvas.version', 'must be 1');
  if (!requireArray(canvas.notes, 'canvas.notes', errors, LIMITS.canvasNotes)) return;
  if (!requireArray(canvas.connections, 'canvas.connections', errors, LIMITS.canvasConnections)) return;
  const ids = new Set();
  canvas.notes.forEach((note, index) => {
    const path = `canvas.notes[${index}]`;
    if (!requireObject(note, path, errors)) return;
    const id = idField(note, 'id', path, errors, { required: true });
    if (id && ids.has(id)) addIssue(errors, 'DUPLICATE_ID', `${path}.id`, `canvas note id ${id} is duplicated`);
    if (id) ids.add(id);
    stringField(note, 'text', path, errors, { required: true, max: LIMITS.text });
    finiteNumberField(note, 'x', path, errors, { required: true, min: -1_000_000, max: 1_000_000 });
    finiteNumberField(note, 'y', path, errors, { required: true, min: -1_000_000, max: 1_000_000 });
    enumField(note, 'color', path, errors, CANVAS_COLORS, { required: true });
    enumField(note, 'size', path, errors, CANVAS_SIZES, { required: true });
    timestampField(note, 'created', path, errors, { required: true, dateOnly: true });
  });
  const connections = new Set();
  canvas.connections.forEach((connection, index) => {
    const path = `canvas.connections[${index}]`;
    if (!requireObject(connection, path, errors)) return;
    const from = idField(connection, 'from', path, errors, { required: true });
    const to = idField(connection, 'to', path, errors, { required: true });
    if (from && !ids.has(from)) addIssue(errors, 'REFERENCE_MISSING', `${path}.from`, `note ${from} does not exist`);
    if (to && !ids.has(to)) addIssue(errors, 'REFERENCE_MISSING', `${path}.to`, `note ${to} does not exist`);
    if (from && to && from === to) addIssue(errors, 'CANVAS_SELF_CONNECTION', path, 'a note cannot connect to itself');
    if (from && to) {
      const key = from < to ? `${from}\0${to}` : `${to}\0${from}`;
      if (connections.has(key)) addIssue(errors, 'DUPLICATE_CONNECTION', path, 'connections are undirected and may not be duplicated');
      connections.add(key);
    }
    for (const key of ['fromPort', 'toPort']) {
      if (connection[key] !== undefined && connection[key] !== null && !CANVAS_PORTS.includes(connection[key])) {
        addIssue(errors, 'ENUM_INVALID', `${path}.${key}`, `must be one of: ${CANVAS_PORTS.join(', ')}`);
      }
    }
  });
}

function validateOverview(overview, errors) {
  if (!requireObject(overview, 'overview', errors)) return;
  if (overview.version !== 1) addIssue(errors, 'FORMAT_UNSUPPORTED', 'overview.version', 'must be 1');
  if (overview.layout !== 'grid') addIssue(errors, 'ENUM_INVALID', 'overview.layout', 'must be grid');
  if (!requireArray(overview.widgets, 'overview.widgets', errors, LIMITS.widgets)) return;
  const ids = new Set();
  overview.widgets.forEach((widget, index) => {
    const path = `overview.widgets[${index}]`;
    if (!requireObject(widget, path, errors)) return;
    const id = stringField(widget, 'id', path, errors, { required: true, max: 64, min: 1, pattern: /^[A-Za-z0-9_-]+$/ });
    if (id && ids.has(id)) addIssue(errors, 'DUPLICATE_ID', `${path}.id`, `widget id ${id} is duplicated`);
    if (id) ids.add(id);
    stringField(widget, 'type', path, errors, { required: true, max: 128, min: 1 });
    stringField(widget, 'title', path, errors, { max: 64 });
    if (widget.props !== undefined) {
      if (!isObject(widget.props)) addIssue(errors, 'TYPE_INVALID', `${path}.props`, 'must be an object');
      else if (byteLength(JSON.stringify(widget.props)) > LIMITS.propsBytes) addIssue(errors, 'LIMIT_EXCEEDED', `${path}.props`, `must not exceed ${LIMITS.propsBytes} bytes`);
    }
    if (!requireObject(widget.grid, `${path}.grid`, errors)) return;
    for (const key of ['x', 'y', 'w', 'h']) finiteNumberField(widget.grid, key, `${path}.grid`, errors, { required: true, integer: true });
    if (Number.isInteger(widget.grid.x) && (widget.grid.x < 0 || widget.grid.x > 11)) addIssue(errors, 'RANGE_INVALID', `${path}.grid.x`, 'must be 0..11');
    if (Number.isInteger(widget.grid.y) && (widget.grid.y < 0 || widget.grid.y > 99)) addIssue(errors, 'RANGE_INVALID', `${path}.grid.y`, 'must be 0..99');
    if (Number.isInteger(widget.grid.w) && (widget.grid.w < 1 || widget.grid.w > 12)) addIssue(errors, 'RANGE_INVALID', `${path}.grid.w`, 'must be 1..12');
    if (Number.isInteger(widget.grid.h) && (widget.grid.h < 1 || widget.grid.h > 12)) addIssue(errors, 'RANGE_INVALID', `${path}.grid.h`, 'must be 1..12');
    if (Number.isInteger(widget.grid.x) && Number.isInteger(widget.grid.w) && widget.grid.x + widget.grid.w > 12) addIssue(errors, 'GRID_OVERFLOW', `${path}.grid`, 'x + w must not exceed 12 columns');
  });
}

function validateFiles(files, specs, errors) {
  if (!requireArray(files, 'files', errors, LIMITS.files)) return;
  const paths = new Set();
  const specPaths = new Set(specs.keys());
  let totalBytes = 0;
  files.forEach((file, index) => {
    const path = `files[${index}]`;
    if (!requireObject(file, path, errors)) return;
    const filePath = stringField(file, 'path', path, errors, { required: true, max: LIMITS.path, min: 1 });
    let normalizedPath = filePath;
    if (filePath) {
      try { normalizedPath = normalizeRelativePath(filePath); } catch (error) { addIssue(errors, error.code || 'PATH_UNSAFE', `${path}.path`, error.message); }
      if (paths.has(normalizedPath)) addIssue(errors, 'DUPLICATE_ID', `${path}.path`, `file path ${normalizedPath} is duplicated`);
      paths.add(normalizedPath);
      if (specPaths.has(normalizedPath)) addIssue(errors, 'DUPLICATE_CONTENT_PATH', `${path}.path`, `spec ${normalizedPath} is represented twice`);
    }
    stringField(file, 'content', path, errors, { required: true, max: LIMITS.fileBytes });
    if (file.encoding !== undefined && file.encoding !== 'utf8') addIssue(errors, 'ENUM_INVALID', `${path}.encoding`, 'must be utf8');
    if (typeof file.content === 'string') {
      const bytes = byteLength(file.content);
      totalBytes += bytes;
      if (bytes > LIMITS.fileBytes) addIssue(errors, 'LIMIT_EXCEEDED', `${path}.content`, `must not exceed ${LIMITS.fileBytes} bytes`);
      if (file.sizeBytes !== bytes) addIssue(errors, 'FILE_SIZE_MISMATCH', `${path}.sizeBytes`, `must equal UTF-8 content size ${bytes}`);
      const actual = sha256(file.content, { canonical: false });
      if (typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) addIssue(errors, 'CHECKSUM_INVALID', `${path}.sha256`, 'must be a lowercase SHA-256 hex digest');
      else if (file.sha256 !== actual) addIssue(errors, 'CHECKSUM_MISMATCH', `${path}.sha256`, 'does not match file content');
    }
    if (file.executable === true || file.mode !== undefined && Number(file.mode) & 0o111) addIssue(errors, 'EXECUTABLE_UNSUPPORTED', path, 'executable file metadata is not portable in v1');
  });
  if (totalBytes > LIMITS.totalFileBytes) addIssue(errors, 'LIMIT_EXCEEDED', 'files', `total content exceeds ${LIMITS.totalFileBytes} bytes`);
}

function validateHistory(history, tasks, errors) {
  if (!requireObject(history, 'history', errors)) return;
  if (!requireArray(history.comments, 'history.comments', errors, LIMITS.historyItems)) return;
  if (!requireArray(history.checkpoints, 'history.checkpoints', errors, LIMITS.historyItems)) return;
  const validateHistoryId = (value, path) => {
    if (!(typeof value === 'string' || (Number.isInteger(value) && value >= 0))) addIssue(errors, 'TYPE_INVALID', path, 'must be a stable string or non-negative integer id');
  };
  const ids = { comments: new Set(), checkpoints: new Set() };
  history.comments.forEach((comment, index) => {
    const path = `history.comments[${index}]`;
    if (!requireObject(comment, path, errors)) return;
    requiredField(comment, 'id', path, errors); validateHistoryId(comment.id, `${path}.id`);
    if (ids.comments.has(String(comment.id))) addIssue(errors, 'DUPLICATE_ID', `${path}.id`, 'comment id is duplicated');
    ids.comments.add(String(comment.id));
    idField(comment, 'taskId', path, errors, { required: true });
    stringField(comment, 'body', path, errors, { required: true, max: LIMITS.description });
    enumField(comment, 'kind', path, errors, HISTORY_COMMENT_KINDS);
    stringField(comment, 'authorLabel', path, errors, { max: 128 });
    timestampField(comment, 'createdAt', path, errors, { required: true });
    if (comment.taskId && !tasks.has(comment.taskId)) addIssue(errors, 'REFERENCE_MISSING', `${path}.taskId`, `task ${comment.taskId} does not exist`);
  });
  history.checkpoints.forEach((checkpoint, index) => {
    const path = `history.checkpoints[${index}]`;
    if (!requireObject(checkpoint, path, errors)) return;
    requiredField(checkpoint, 'id', path, errors); validateHistoryId(checkpoint.id, `${path}.id`);
    if (ids.checkpoints.has(String(checkpoint.id))) addIssue(errors, 'DUPLICATE_ID', `${path}.id`, 'checkpoint id is duplicated');
    ids.checkpoints.add(String(checkpoint.id));
    idField(checkpoint, 'taskId', path, errors, { required: true });
    stringField(checkpoint, 'message', path, errors, { required: true, max: LIMITS.description });
    finiteNumberField(checkpoint, 'progress', path, errors, { min: 0, max: 100 });
    timestampField(checkpoint, 'createdAt', path, errors, { required: true });
    if (checkpoint.taskId && !tasks.has(checkpoint.taskId)) addIssue(errors, 'REFERENCE_MISSING', `${path}.taskId`, `task ${checkpoint.taskId} does not exist`);
  });
}

function validateCounts(bundle, errors) {
  const counts = bundle.manifest?.counts || {};
  const actual = {
    tasks: Array.isArray(bundle.tasks) ? bundle.tasks.length : 0,
    specs: Array.isArray(bundle.specs) ? bundle.specs.length : 0,
    canvasNotes: Array.isArray(bundle.canvas?.notes) ? bundle.canvas.notes.length : 0,
    canvasConnections: Array.isArray(bundle.canvas?.connections) ? bundle.canvas.connections.length : 0,
    overviewWidgets: Array.isArray(bundle.overview?.widgets) ? bundle.overview.widgets.length : 0,
    files: Array.isArray(bundle.files) ? bundle.files.length : 0,
    historyComments: Array.isArray(bundle.history?.comments) ? bundle.history.comments.length : 0,
    historyCheckpoints: Array.isArray(bundle.history?.checkpoints) ? bundle.history.checkpoints.length : 0,
  };
  for (const [key, value] of Object.entries(actual)) {
    if (counts[key] !== value) addIssue(errors, 'COUNT_MISMATCH', `manifest.counts.${key}`, `declares ${counts[key]}, actual content contains ${value}`);
  }
}

function validateFileInventory(bundle, errors) {
  const declared = bundle.manifest?.checksums?.files;
  if (!isObject(declared) || !Array.isArray(bundle.files)) return;
  const actual = {};
  for (const file of bundle.files) {
    if (!file || typeof file.path !== 'string' || typeof file.sha256 !== 'string') continue;
    try { actual[normalizeRelativePath(file.path)] = file.sha256; } catch { /* path error reported elsewhere */ }
  }
  const declaredCanonical = {};
  for (const [filePath, checksum] of Object.entries(declared)) {
    try { declaredCanonical[normalizeRelativePath(filePath)] = checksum; } catch { /* path error reported elsewhere */ }
  }
  const actualKeys = Object.keys(actual).sort(); const declaredKeys = Object.keys(declaredCanonical).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(declaredKeys)) addIssue(errors, 'CHECKSUM_INVENTORY_MISMATCH', 'manifest.checksums.files', 'must contain exactly one checksum for every file');
  for (const filePath of actualKeys) {
    if (declaredCanonical[filePath] !== actual[filePath]) addIssue(errors, 'CHECKSUM_MISMATCH', `manifest.checksums.files.${filePath}`, 'does not match file checksum');
  }
}

/**
 * Validate a bundle without touching the server or any persistence layer.
 * Unknown optional fields survive in the normalized result; known unsafe
 * fields, references, versions and checksums fail closed.
 */
function validateBundle(bundle, { verifyPayloadChecksum = true } = {}) {
  const errors = []; const warnings = [];
  if (!isObject(bundle)) return { ok: false, errors: [{ code: 'TYPE_INVALID', path: '$', message: 'bundle must be an object' }], warnings: [] };
  scanForbiddenFields(bundle, '', errors);
  for (const key of ['manifest', 'project', 'tasks', 'specs', 'canvas', 'overview', 'files']) {
    if (!Object.prototype.hasOwnProperty.call(bundle, key)) addIssue(errors, 'FIELD_REQUIRED', key, 'is required');
  }
  validateManifest(bundle.manifest, errors, warnings);
  validateProject(bundle.project, errors);
  const tasks = validateTasks(bundle.tasks, errors);
  const specs = validateSpecs(bundle.specs, tasks, errors);
  validateCanvas(bundle.canvas, errors);
  validateOverview(bundle.overview, errors);
  validateFiles(bundle.files, specs, errors);
  if (bundle.history !== undefined) validateHistory(bundle.history, tasks, errors);
  if (bundle.history !== undefined && bundle.manifest?.options?.includeHistory === false) {
    addIssue(errors, 'OPTION_CONFLICT', 'manifest.options.includeHistory', 'history content requires explicit includeHistory=true');
  }
  if (bundle.manifest?.options?.includeHistory === true && bundle.history === undefined) addIssue(warnings, 'HISTORY_NOT_PRESENT', 'history', 'history was requested but no optional history content was supplied');
  validateCounts(bundle, errors);
  validateFileInventory(bundle, errors);
  if (verifyPayloadChecksum && typeof bundle.manifest?.checksums?.payload === 'string') {
    const actual = sha256(payloadForChecksum(bundle));
    if (actual !== bundle.manifest.checksums.payload) addIssue(errors, 'CHECKSUM_MISMATCH', 'manifest.checksums.payload', 'does not match canonical bundle content');
  }
  if (errors.length > 0) return { ok: false, errors, warnings };
  return { ok: true, bundle: canonicalizeBundle(bundle), errors: [], warnings };
}

module.exports = {
  validateBundle,
  validateFileInventory,
  scanForbiddenFields,
};
