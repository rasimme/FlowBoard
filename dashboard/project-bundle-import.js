'use strict';

/**
 * Create-only importer for portable FlowBoard project review bundles (T-468-5).
 *
 * This adapter is intentionally server-owned: it talks to the lifecycle,
 * HZL, metadata, canvas and overview modules and never opens either SQLite
 * database itself.  The only durable state it writes outside those modules is
 * the FlowBoard-owned import journal in flowboard-metadata.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  LIMITS,
  canonicalJson,
  normalizeRelativePath,
  sha256,
} = require('./project-bundle-schema.js');
const { validateBundle } = require('./project-bundle-validator.js');
const { previewBundle, TARGET_NAME_RE } = require('./project-bundle-import-preview.js');
const {
  IMPORT_JOURNAL_STATES,
  assertImportJournalTransition,
  importLockKey,
} = require('./project-bundle-safety.js');

const RESERVED_TARGET_NAMES = new Set([
  '.audit', '.trash', '_index', 'projects', 'workspace',
]);
const IMPORT_CONTENT_ROOTS = Object.freeze(['context/', 'specs/']);
const IMPORT_ROOT_FILES = Object.freeze(['PROJECT.md', 'DECISIONS.md']);
const IMPORT_FORBIDDEN_FILES = new Set([
  'sessions.md', 'agents.md', 'project-rules.md', 'canvas.json',
  'overview.json', 'tasks.json', '_index.md', 'flowboard.db',
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function errorWithCode(message, code, status = 500, details = {}) {
  const error = new Error(message);
  error.name = 'ProjectBundleImportError';
  error.code = code;
  error.status = status;
  Object.assign(error, details);
  return error;
}

class ProjectBundleImportError extends Error {
  constructor(message, code = 'PROJECT_IMPORT_FAILED', status = 500, details = {}) {
    super(message);
    this.name = 'ProjectBundleImportError';
    this.code = code;
    this.status = status;
    Object.assign(this, details);
  }
}

function safeProjectPath(projectsDir, projectName) {
  const root = path.resolve(projectsDir);
  const target = path.resolve(root, projectName);
  if (target === root || !target.startsWith(`${root}${path.sep}`)) {
    throw errorWithCode('Import target escapes the configured projects directory', 'TARGET_PATH_UNSAFE', 422);
  }
  return target;
}

function safeImportId(importId) {
  return typeof importId === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(importId);
}

function portableContentPath(relativePath, section) {
  let normalized;
  try { normalized = normalizeRelativePath(relativePath); } catch { return null; }
  const lower = normalized.toLowerCase();
  if (section === 'specs') {
    if (!lower.startsWith('specs/') && !lower.startsWith('context/')) return null;
    if (lower === 'specs/_index.json') return null;
    return normalized;
  }
  if (IMPORT_ROOT_FILES.includes(normalized)) return normalized;
  if (IMPORT_CONTENT_ROOTS.some(prefix => lower.startsWith(prefix))) return normalized;
  return null;
}

function sourceTaskComparable(task) {
  return {
    id: task?.id,
    title: task?.title,
    status: task?.status,
    priority: task?.priority,
    description: task?.description || '',
    tags: [...(task?.tags || [])].sort(),
    links: [...(task?.links || [])].sort(),
    dependsOn: [...(task?.dependsOn || [])].sort(),
    parentId: task?.parentId ?? null,
    workState: task?.workState || 'working',
    workStateDetails: task?.workStateDetails || {},
    created: task?.created ?? task?.createdAt ?? null,
    completed: task?.completed ?? task?.completedAt ?? null,
    enteredStatusAt: task?.enteredStatusAt ?? null,
    order: task?.order ?? null,
    dueAt: task?.dueAt ?? null,
  };
}

function sameTaskSemantics(existing, source) {
  const left = sourceTaskComparable(existing);
  const right = sourceTaskComparable(source);
  // `specFile` is intentionally not compared here.  The canonical specs index
  // is rebuilt in the file phase after all tasks exist.
  return canonicalJson(left) === canonicalJson(right);
}

function taskGraphOrder(tasks) {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const indegree = new Map(tasks.map(task => [task.id, 0]));
  const outgoing = new Map(tasks.map(task => [task.id, []]));
  for (const task of tasks) {
    const refs = [task.parentId, ...(Array.isArray(task.dependsOn) ? task.dependsOn : [])]
      .filter(Boolean);
    for (const ref of refs) {
      if (!byId.has(ref)) continue;
      indegree.set(task.id, indegree.get(task.id) + 1);
      outgoing.get(ref).push(task.id);
    }
  }
  const ready = tasks.filter(task => indegree.get(task.id) === 0)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const ordered = [];
  while (ready.length > 0) {
    const current = ready.shift();
    ordered.push(current);
    for (const child of outgoing.get(current.id) || []) {
      indegree.set(child, indegree.get(child) - 1);
      if (indegree.get(child) === 0) {
        ready.push(byId.get(child));
        ready.sort((a, b) => String(a.id).localeCompare(String(b.id)));
      }
    }
  }
  if (ordered.length !== tasks.length) {
    throw errorWithCode('Task hierarchy/dependency graph could not be ordered', 'TASK_GRAPH_INVALID', 422);
  }
  return ordered;
}

class ProjectBundleImporter {
  static locks = new Map();

  constructor({
    hzlService,
    fbMeta,
    projectsDir,
    overview,
    lifecycle,
    fsModule = fs,
    cryptoModule = crypto,
    audit = null,
    now = () => new Date().toISOString(),
    hooks = {},
  } = {}) {
    if (!hzlService || !fbMeta || !projectsDir || !overview || !lifecycle) {
      throw new Error('hzlService, fbMeta, projectsDir, overview and lifecycle are required');
    }
    this.hzlService = hzlService;
    this.fbMeta = fbMeta;
    this.projectsDir = path.resolve(projectsDir);
    this.overview = overview;
    this.lifecycle = lifecycle;
    this.fs = fsModule;
    this.crypto = cryptoModule;
    this.audit = typeof audit === 'function' ? audit : null;
    this.now = now;
    // Hooks are dependency-injected by focused tests.  Production callers do
    // not pass request/env-controlled failure switches.
    this.hooks = hooks && typeof hooks === 'object' ? hooks : {};
  }

  _maybeFail(phase) {
    if (this.hooks.failAt === phase) {
      throw errorWithCode(`Injected project import failure at ${phase}`, `IMPORT_INJECTED_${String(phase).toUpperCase()}`);
    }
    if (typeof this.hooks.onPhase === 'function') this.hooks.onPhase(phase);
  }

  _journal(importId) {
    return this.fbMeta.getProjectImportJournal(importId);
  }

  _transition(importId, nextState, progress = {}, errorCode, { clearError = false } = {}) {
    const current = this._journal(importId);
    if (!current) throw errorWithCode(`Import journal not found: ${importId}`, 'IMPORT_JOURNAL_NOT_FOUND');
    if (current.state !== nextState) {
      try { assertImportJournalTransition(current.state, nextState); } catch (error) {
        throw errorWithCode(error.message, error.code || 'IMPORT_JOURNAL_TRANSITION_INVALID', 500);
      }
    }
    return this.fbMeta.updateProjectImportJournal(importId, {
      state: nextState,
      progress: { ...current.progress, ...progress },
      ...(errorCode !== undefined ? { errorCode } : {}),
      clearError,
    });
  }

  _failJournal(importId, error, progress = {}) {
    if (!importId) return null;
    const current = this._journal(importId);
    if (!current) return null;
    const code = /^[A-Z0-9_:-]{1,96}$/.test(String(error?.code || 'IMPORT_FAILED'))
      ? String(error.code) : 'IMPORT_FAILED';
    if (current.state !== IMPORT_JOURNAL_STATES.FAILED) {
      try {
        return this._transition(importId, IMPORT_JOURNAL_STATES.FAILED, {
          ...progress,
          recoverable: true,
        }, code);
      } catch (transitionError) {
        // A failed journal is itself the recovery record.  Preserve the first
        // error if a secondary persistence failure occurs.
        try {
          return this.fbMeta.updateProjectImportJournal(importId, {
            state: IMPORT_JOURNAL_STATES.FAILED,
            progress: { ...current.progress, ...progress, recoverable: true },
            errorCode: code,
          });
        } catch { return null; }
      }
    }
    try {
      return this.fbMeta.updateProjectImportJournal(importId, {
        progress: { ...current.progress, ...progress, recoverable: true },
        errorCode: code,
      });
    } catch { return current; }
  }

  _stagingDir(importId) {
    if (!safeImportId(importId)) throw errorWithCode('Invalid import id', 'IMPORT_ID_INVALID');
    return path.join(this.projectsDir, '.flowboard-import-staging', importId);
  }

  _assertNoSymlink(target) {
    const root = path.resolve(this.projectsDir);
    const resolved = path.resolve(target);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
      throw errorWithCode('Import path escapes the configured project root', 'PATH_UNSAFE', 422);
    }
    let cursor = resolved;
    const segments = [];
    while (cursor !== root) {
      segments.push(cursor);
      cursor = path.dirname(cursor);
    }
    for (const segment of segments.reverse()) {
      try {
        if (this.fs.lstatSync(segment).isSymbolicLink()) {
          throw errorWithCode('Symlinked import path is not allowed', 'PATH_SYMLINK', 422);
        }
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
    }
  }

  _validateContentPaths(bundle) {
    for (const section of ['files', 'specs']) {
      for (const entry of bundle[section] || []) {
        const normalized = portableContentPath(entry.path, section);
        if (!normalized) {
          throw errorWithCode(`${section} path is outside the review content boundary`, 'IMPORT_PATH_FORBIDDEN', 422);
        }
        const base = normalized.split('/').pop().toLowerCase();
        if (IMPORT_FORBIDDEN_FILES.has(base) || base.startsWith('flowboard.db')) {
          throw errorWithCode(`${section} path is reserved runtime content`, 'IMPORT_PATH_FORBIDDEN', 422);
        }
      }
    }
  }

  _canonicalAdmission(bundle, requestedTarget) {
    const validation = validateBundle(bundle);
    if (!validation.ok) {
      throw new ProjectBundleImportError('Project bundle failed schema validation', 'BUNDLE_PREVIEW_INVALID', 422, {
        validation,
      });
    }
    const normalized = validation.bundle;
    this._validateContentPaths(normalized);
    const target = requestedTarget || normalized.project?.slug;
    if (RESERVED_TARGET_NAMES.has(String(target))) {
      throw errorWithCode('Import target name is reserved', 'TARGET_RESERVED', 409);
    }
    if (!TARGET_NAME_RE.test(String(target || ''))) {
      throw errorWithCode('Import target name is invalid', 'TARGET_INVALID', 422);
    }

    let hzlProjects;
    let existingProjects;
    let deletedProjects;
    try {
      hzlProjects = this.hzlService.listHzlProjects();
      existingProjects = this.fbMeta.listProjects(hzlProjects);
      deletedProjects = this.fbMeta.listDeletedProjects();
    } catch (error) {
      throw errorWithCode('Canonical project state could not be read', 'CANONICAL_STATE_READ_FAILED', 500);
    }
    const digest = sha256(canonicalJson(normalized));
    const latest = this.fbMeta.getLatestProjectImport(target);
    const resumable = latest && latest.bundleDigest === digest && latest.state === IMPORT_JOURNAL_STATES.FAILED;
    const targetRegistered = hzlProjects.some(project => project.name === target)
      || Boolean(this.fbMeta.getProject(target));
    const targetDeleted = typeof this.fbMeta.isProjectDeleted === 'function' && this.fbMeta.isProjectDeleted(target);
    const targetDir = safeProjectPath(this.projectsDir, target);
    const directoryExists = this.fs.existsSync(targetDir);
    const preview = previewBundle(normalized, {
      targetName: target,
      existingProjects: resumable ? existingProjects.filter(project => project.name !== target) : existingProjects,
      deletedProjects: resumable ? deletedProjects.filter(project => (project.name || project) !== target) : deletedProjects,
      directoryExists: resumable ? false : directoryExists,
    });
    if (!preview.ok || !preview.preview?.canImport) {
      const targetConflict = targetRegistered || targetDeleted || directoryExists || latest;
      throw new ProjectBundleImportError(
        targetConflict ? 'Import target is not available for create-only import' : 'Project bundle is not importable',
        targetConflict ? 'IMPORT_TARGET_CONFLICT' : 'BUNDLE_PREVIEW_INVALID',
        targetConflict ? 409 : 422,
        { preview: preview.ok ? preview.preview : preview },
      );
    }
    if (latest && latest.bundleDigest !== digest) {
      throw errorWithCode('A different bundle digest already targets this project name', 'IMPORT_DIGEST_CONFLICT', 409);
    }
    if (targetRegistered && !resumable) throw errorWithCode('Import target is already registered', 'IMPORT_TARGET_CONFLICT', 409);
    if (targetDeleted && !resumable) throw errorWithCode('Import target is tombstoned', 'IMPORT_TARGET_CONFLICT', 409);
    if (directoryExists && !resumable) throw errorWithCode('Import target directory already exists', 'IMPORT_TARGET_CONFLICT', 409);

    const overviewResult = this.overview.validateOverview(normalized.overview);
    if (!overviewResult.ok) {
      throw errorWithCode('Imported overview is incompatible with this FlowBoard instance', 'OVERVIEW_INVALID', 422, {
        errors: overviewResult.errors.slice(0, 20),
      });
    }
    return {
      bundle: normalized,
      target,
      digest,
      latest,
      resumable: Boolean(resumable),
      targetDir,
      overview: overviewResult.config,
      counts: normalized.manifest.counts,
    };
  }

  _stageBundle(importId, bundle) {
    const stagingDir = this._stagingDir(importId);
    const stagingRoot = path.dirname(stagingDir);
    this._assertNoSymlink(stagingRoot);
    if (this.fs.existsSync(stagingDir)) this.fs.rmSync(stagingDir, { recursive: true, force: true });
    this.fs.mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
    try { this.fs.chmodSync(stagingDir, 0o700); } catch {}
    const entries = [
      ...(bundle.files || []).map(file => ({ ...file, section: 'files' })),
      ...(bundle.specs || []).map(spec => ({ ...spec, section: 'specs' })),
    ];
    let stagedFiles = 0;
    let stagedSpecs = 0;
    for (const entry of entries) {
      const relative = portableContentPath(entry.path, entry.section);
      if (!relative) throw errorWithCode('Unsafe content path during staging', 'PATH_UNSAFE', 422);
      const destination = path.resolve(stagingDir, ...relative.split('/'));
      if (destination !== stagingDir && !destination.startsWith(`${stagingDir}${path.sep}`)) {
        throw errorWithCode('Staged path escapes importer directory', 'PATH_UNSAFE', 422);
      }
      this.fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      const content = String(entry.content);
      const expectedChecksum = entry.section === 'files'
        ? bundle.manifest.checksums.files[relative]
        : sha256(content, { canonical: false });
      const actualChecksum = sha256(content, { canonical: false });
      if (actualChecksum !== expectedChecksum) {
        throw errorWithCode('Staged content checksum mismatch', 'CHECKSUM_MISMATCH', 422);
      }
      this.fs.writeFileSync(destination, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      try { this.fs.chmodSync(destination, 0o600); } catch {}
      const reread = this.fs.readFileSync(destination, 'utf8');
      if (sha256(reread, { canonical: false }) !== actualChecksum) {
        throw errorWithCode('Staged content failed read-back verification', 'STAGING_VERIFY_FAILED', 500);
      }
      if (entry.section === 'files') stagedFiles += 1;
      else stagedSpecs += 1;
    }
    return { stagingDir, stagedFiles, stagedSpecs };
  }

  _publishStagedFiles(stagingDir, targetDir, bundle) {
    this._assertNoSymlink(targetDir);
    const entries = [
      ...(bundle.files || []).map(file => ({ ...file, section: 'files' })),
      ...(bundle.specs || []).map(spec => ({ ...spec, section: 'specs' })),
    ];
    let files = 0;
    let specs = 0;
    for (const entry of entries) {
      const relative = portableContentPath(entry.path, entry.section);
      const source = path.resolve(stagingDir, ...relative.split('/'));
      const target = path.resolve(targetDir, ...relative.split('/'));
      this._assertNoSymlink(source);
      this._assertNoSymlink(targetDir);
      if (target !== targetDir && !target.startsWith(`${targetDir}${path.sep}`)) {
        throw errorWithCode('Published path escapes target project', 'PATH_UNSAFE', 422);
      }
      const staged = this.fs.readFileSync(source, 'utf8');
      const expected = sha256(staged, { canonical: false });
      if (this.fs.existsSync(target)) {
        try {
          if (this.fs.lstatSync(target).isSymbolicLink()) throw errorWithCode('Symlinked target file is not allowed', 'PATH_SYMLINK', 422);
          const current = this.fs.readFileSync(target, 'utf8');
          if (sha256(current, { canonical: false }) !== expected) {
            if (!IMPORT_ROOT_FILES.includes(relative)) {
              throw errorWithCode(`Existing imported file differs: ${relative}`, 'IMPORT_FILE_CONFLICT', 409);
            }
          } else {
            if (entry.section === 'files') files += 1; else specs += 1;
            continue;
          }
        } catch (error) {
          if (error?.code === 'ENOENT') { /* race: write below */ }
          else throw error;
        }
      }
      this.fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      const temporary = `${target}.flowboard-import-${path.basename(stagingDir)}.tmp`;
      this._assertNoSymlink(path.dirname(target));
      this.fs.writeFileSync(temporary, staged, { encoding: 'utf8', mode: 0o600 });
      try { this.fs.chmodSync(temporary, 0o600); } catch {}
      this.fs.renameSync(temporary, target);
      const published = this.fs.readFileSync(target, 'utf8');
      if (sha256(published, { canonical: false }) !== expected) {
        throw errorWithCode(`Published file failed checksum verification: ${relative}`, 'PUBLISH_VERIFY_FAILED', 500);
      }
      if (entry.section === 'files') files += 1; else specs += 1;
    }
    return { files, specs };
  }

  _ensureProject(admission) {
    const { target, bundle, targetDir, resumable } = admission;
    const hzlProjects = this.hzlService.listHzlProjects();
    const inHzl = hzlProjects.some(project => project.name === target);
    const inMeta = Boolean(this.fbMeta.getProject(target));
    let result;
    if (!inHzl && !inMeta && !this.fs.existsSync(targetDir)) {
      result = this.lifecycle.createProject({
        name: target,
        displayName: bundle.project.displayName,
        description: bundle.project.description || '',
        group: bundle.project.group || null,
        taskDiscipline: bundle.project.taskDiscipline,
      }, {
        hzlService: this.hzlService,
        fbMeta: this.fbMeta,
        projectsDir: this.projectsDir,
      });
    } else if (resumable) {
      // A failure can occur after one lifecycle layer has been written.  The
      // lifecycle heal path fills any missing canonical HZL/metadata layer;
      // the scaffold helper only fills absent defaults and never overwrites
      // importer-owned content already present on disk.
      if (!inHzl || !inMeta) {
        this.lifecycle.healProject({
          name: target,
          displayName: bundle.project.displayName,
          description: bundle.project.description || '',
        }, {
          hzlService: this.hzlService,
          fbMeta: this.fbMeta,
          projectsDir: this.projectsDir,
        });
      }
      this.lifecycle.ensureProjectScaffold(
        this.projectsDir,
        target,
        bundle.project.displayName,
        bundle.project.description || '',
      );
      result = { project: { name: target, displayName: bundle.project.displayName } };
    } else {
      throw errorWithCode('Import target changed while import was running', 'IMPORT_TARGET_CONFLICT', 409);
    }
    if (!this.fs.existsSync(targetDir)) throw errorWithCode('Imported project scaffold is missing', 'PROJECT_SCAFFOLD_FAILED');
    try {
      if (!this.hzlService.canvasIsMigrated(target)) this.hzlService.canvasMarkMigrated(target);
    } catch (error) {
      throw errorWithCode('Imported project canvas backend could not be initialized', 'CANVAS_BACKEND_INIT_FAILED', 500);
    }
    return result;
  }

  _importTasks(admission, progress) {
    const { target, bundle } = admission;
    const ordered = taskGraphOrder(bundle.tasks);
    const sourceById = new Map(bundle.tasks.map(task => [task.id, task]));
    let imported = progress.tasksImported || 0;
    const taskMap = new Map();
    for (const source of ordered) {
      const existing = this.hzlService.getTask(target, source.id, { includeArchived: true });
      if (existing) {
        if (!sameTaskSemantics(existing, source)) {
          throw errorWithCode(`Existing task ${source.id} differs from bundle`, 'IMPORT_TASK_CONFLICT', 409);
        }
        taskMap.set(source.id, source.id);
        this.hzlService.clearTaskRuntimeStateForMigration(target, source.id);
        imported += 1;
        continue;
      }
      const dependencies = (source.dependsOn || []).map(id => this.hzlService.getTaskUlid(target, id));
      if ((source.dependsOn || []).some((id, index) => !dependencies[index])) {
        throw errorWithCode(`Dependency task is not available for ${source.id}`, 'IMPORT_TASK_DEPENDENCY_MISSING', 500);
      }
      const created = this.hzlService.createTaskForMigration(target, {
        title: source.title,
        priority: source.priority,
        parentId: source.parentId || null,
        status: source.status,
        forceId: source.id,
        tags: source.tags || [],
        links: source.links || [],
        description: source.description || '',
        workState: source.workState,
        workStateDetails: source.workStateDetails,
        preserveImportedWorkStateDetails: true,
        created: source.createdAt,
        completed: source.completedAt,
        enteredStatusAt: source.enteredStatusAt,
        order: source.order,
        dueAt: source.dueAt,
        dependsOnUlids: dependencies,
      });
      if (!created || created.id !== source.id) {
        throw errorWithCode(`Imported task ${source.id} could not be created`, 'IMPORT_TASK_CREATE_FAILED', 500);
      }
      // `order` is a FlowBoard metadata field; createTaskForMigration accepts
      // it for the initial DTO, then this update keeps the canonical writer in
      // one place on versions that do not materialize it during creation.
      const current = this.hzlService.getTask(target, source.id, { includeArchived: true });
      if (current && (current.order ?? null) !== (source.order ?? null)) {
        this.hzlService.updateTask(target, source.id, { order: source.order ?? null });
      }
      this.hzlService.clearTaskRuntimeStateForMigration(target, source.id);
      taskMap.set(source.id, source.id);
      imported += 1;
      if (progress.failAfterTask && imported >= progress.failAfterTask) break;
    }
    // A resumed import may have had a failure hook after one task; a normal
    // run must always verify every source task was handled.
    if (taskMap.size !== sourceById.size) {
      for (const source of ordered) {
        if (taskMap.has(source.id)) continue;
        const existing = this.hzlService.getTask(target, source.id, { includeArchived: true });
        if (!existing || !sameTaskSemantics(existing, source)) {
          throw errorWithCode(`Imported task ${source.id} is incomplete`, 'IMPORT_TASK_INCOMPLETE', 500);
        }
        taskMap.set(source.id, source.id);
        this.hzlService.clearTaskRuntimeStateForMigration(target, source.id);
      }
    }
    return { tasksImported: sourceById.size, taskMap };
  }

  _restoreSpecsIndex(target, bundle) {
    for (const spec of bundle.specs || []) {
      this.hzlService.setSpecLink(target, spec.taskId, spec.path);
    }
    // Re-emit every canonical link in stable order.  setSpecLink is an
    // idempotent server-owned writer and materializes specs/_index.json.
    for (const spec of [...(bundle.specs || [])].sort((a, b) => a.path.localeCompare(b.path))) {
      this.hzlService.setSpecLink(target, spec.taskId, spec.path);
    }
  }

  _restoreCanvas(target, bundle) {
    const imported = this.hzlService.canvasImportFromJson(target, bundle.canvas);
    const current = this.hzlService.canvasGet(target);
    if (current.notes.length !== bundle.canvas.notes.length
      || current.connections.length !== bundle.canvas.connections.length) {
      throw errorWithCode('Canvas count verification failed after import', 'CANVAS_COUNT_MISMATCH', 500);
    }
    this.hzlService.canvasMarkMigrated(target);
    return imported;
  }

  _restoreHistory(target, bundle) {
    if (!bundle.history) return { comments: 0, checkpoints: 0 };
    const existingComments = [];
    const existingCheckpoints = [];
    for (const task of bundle.tasks || []) {
      try { existingComments.push(...this.hzlService.getComments(target, task.id)); } catch {}
      try { existingCheckpoints.push(...this.hzlService.getCheckpoints(target, task.id)); } catch {}
    }
    const commentKey = item => `${item.taskId}\0${item.message || item.body || ''}\0${item.kind || 'comment'}`;
    const checkpointKey = item => `${item.taskId}\0${item.message || ''}\0${item.progress ?? ''}`;
    const commentKeys = new Set(existingComments.map(commentKey));
    const checkpointKeys = new Set(existingCheckpoints.map(checkpointKey));
    let comments = 0;
    let checkpoints = 0;
    for (const item of bundle.history.comments || []) {
      // A retry after a post-history failure must not duplicate content. HZL
      // event ids are intentionally not portable, so the stable semantic
      // tuple is the resume identity.
      const key = commentKey(item);
      if (commentKeys.has(key)) { comments += 1; continue; }
      this.hzlService.addComment(target, item.taskId, {
        message: item.body,
        author: item.authorLabel || null,
        ...(item.kind && item.kind !== 'comment' && item.kind !== 'answer' ? { kind: item.kind } : {}),
      });
      commentKeys.add(key);
      comments += 1;
    }
    for (const item of bundle.history.checkpoints || []) {
      const key = checkpointKey(item);
      if (checkpointKeys.has(key)) { checkpoints += 1; continue; }
      this.hzlService.addCheckpoint(target, item.taskId, {
        message: item.message,
        agent: null,
        ...(item.progress !== undefined ? { progress: item.progress } : {}),
      });
      checkpointKeys.add(key);
      checkpoints += 1;
    }
    return { comments, checkpoints };
  }

  _verify(admission) {
    const { target, bundle, targetDir, overview: expectedOverview } = admission;
    const tasks = this.hzlService.listTasks(target, { includeArchived: true });
    if (tasks.length !== bundle.tasks.length) throw errorWithCode('Imported task count verification failed', 'TASK_COUNT_MISMATCH', 500);
    for (const source of bundle.tasks) {
      const actual = this.hzlService.getTask(target, source.id, { includeArchived: true });
      if (!actual || !sameTaskSemantics(actual, source)) throw errorWithCode(`Imported task verification failed: ${source.id}`, 'TASK_VERIFY_FAILED', 500);
      const linkedSpec = (bundle.specs || []).find(spec => spec.taskId === source.id)?.path || null;
      const expectedSpec = source.specFile || linkedSpec;
      if ((actual.specFile || null) !== expectedSpec) throw errorWithCode(`Imported spec link verification failed: ${source.id}`, 'SPEC_LINK_VERIFY_FAILED', 500);
    }
    const index = this.hzlService.getSpecsIndex(target);
    for (const spec of bundle.specs || []) {
      const filename = path.resolve(targetDir, ...spec.path.split('/'));
      if (!this.fs.existsSync(filename) || this.fs.readFileSync(filename, 'utf8') !== spec.content) {
        throw errorWithCode(`Imported spec verification failed: ${spec.path}`, 'SPEC_VERIFY_FAILED', 500);
      }
      if (index[spec.taskId] !== spec.path) throw errorWithCode(`Imported spec index verification failed: ${spec.path}`, 'SPEC_INDEX_VERIFY_FAILED', 500);
    }
    for (const file of bundle.files || []) {
      const filename = path.resolve(targetDir, ...file.path.split('/'));
      if (!this.fs.existsSync(filename)) throw errorWithCode(`Imported file is missing: ${file.path}`, 'FILE_VERIFY_FAILED', 500);
      const content = this.fs.readFileSync(filename, 'utf8');
      if (sha256(content, { canonical: false }) !== file.sha256) throw errorWithCode(`Imported file checksum failed: ${file.path}`, 'FILE_CHECKSUM_FAILED', 500);
    }
    const actualCanvas = this.hzlService.canvasGet(target);
    if (actualCanvas.notes.length !== bundle.canvas.notes.length || actualCanvas.connections.length !== bundle.canvas.connections.length) {
      throw errorWithCode('Imported canvas verification failed', 'CANVAS_VERIFY_FAILED', 500);
    }
    const actualOverview = this.overview.readOverview(this.projectsDir, target);
    if (actualOverview.version !== expectedOverview.version || actualOverview.widgets.length !== expectedOverview.widgets.length) {
      throw errorWithCode('Imported overview verification failed', 'OVERVIEW_VERIFY_FAILED', 500);
    }
    return {
      tasks: tasks.length,
      specs: (bundle.specs || []).length,
      files: (bundle.files || []).length,
      canvasNotes: actualCanvas.notes.length,
      canvasConnections: actualCanvas.connections.length,
      overviewWidgets: actualOverview.widgets.length,
    };
  }

  async importBundle(bundle, { targetName } = {}) {
    const admission = this._canonicalAdmission(bundle, targetName);
    const lock = importLockKey(admission.target);
    if (ProjectBundleImporter.locks.has(lock)) {
      throw errorWithCode('Another import is already running for this target', 'IMPORT_IN_PROGRESS', 409);
    }
    ProjectBundleImporter.locks.set(lock, true);
    let importId = admission.latest?.importId || null;
    let stagingDir = null;
    let journal = null;
    try {
      if (!importId) {
        importId = this.crypto.randomUUID();
        journal = this.fbMeta.createProjectImportJournal({
          importId,
          targetName: admission.target,
          bundleDigest: admission.digest,
          state: IMPORT_JOURNAL_STATES.VALIDATING,
          progress: { phase: 'validating', recoverable: false },
        });
      } else {
        journal = this._journal(importId);
        if (!journal || journal.bundleDigest !== admission.digest) {
          throw errorWithCode('Import journal digest does not match the bundle', 'IMPORT_DIGEST_CONFLICT', 409);
        }
        if (journal.state !== IMPORT_JOURNAL_STATES.FAILED) {
          throw errorWithCode('Import journal is not resumable', 'IMPORT_NOT_RESUMABLE', 409);
        }
        journal = this._transition(importId, IMPORT_JOURNAL_STATES.STAGING, { phase: 'staging', resumed: true }, undefined, { clearError: true });
      }
      if (journal.state === IMPORT_JOURNAL_STATES.VALIDATING) {
        journal = this._transition(importId, IMPORT_JOURNAL_STATES.STAGING, { phase: 'staging' }, undefined, { clearError: true });
      }
      this._maybeFail('staging');
      const staged = this._stageBundle(importId, admission.bundle);
      stagingDir = staged.stagingDir;
      journal = this._transition(importId, IMPORT_JOURNAL_STATES.CREATING_PROJECT, {
        phase: 'creating-project', stagedFiles: staged.stagedFiles, stagedSpecs: staged.stagedSpecs,
      });
      this._maybeFail('project');
      this._ensureProject(admission);
      journal = this._transition(importId, IMPORT_JOURNAL_STATES.IMPORTING_TASKS, { phase: 'importing-tasks' });
      this._maybeFail('task');
      let taskResult;
      const importTasks = () => { taskResult = this._importTasks(admission, journal.progress); };
      if (typeof this.hzlService.withMigrationHooksSuppressed === 'function') this.hzlService.withMigrationHooksSuppressed(importTasks);
      else importTasks();
      journal = this._transition(importId, IMPORT_JOURNAL_STATES.IMPORTING_FILES, {
        phase: 'importing-files', tasksImported: taskResult.tasksImported,
      });
      this._maybeFail('file');
      const published = this._publishStagedFiles(stagingDir, admission.targetDir, admission.bundle);
      this._restoreSpecsIndex(admission.target, admission.bundle);
      this.overview.writeOverview(this.projectsDir, admission.target, admission.overview);
      const history = this._restoreHistory(admission.target, admission.bundle);
      journal = this._transition(importId, IMPORT_JOURNAL_STATES.IMPORTING_CANVAS, {
        phase: 'importing-canvas', filesImported: published.files, specsImported: published.specs,
        historyComments: history.comments, historyCheckpoints: history.checkpoints,
      });
      this._maybeFail('canvas');
      const canvas = this._restoreCanvas(admission.target, admission.bundle);
      journal = this._transition(importId, IMPORT_JOURNAL_STATES.VERIFYING, {
        phase: 'verifying', canvasNotes: canvas.notes, canvasConnections: canvas.connections,
      });
      this._maybeFail('finalize');
      const counts = this._verify(admission);
      if (stagingDir && this.fs.existsSync(stagingDir)) this.fs.rmSync(stagingDir, { recursive: true, force: true });
      journal = this._transition(importId, IMPORT_JOURNAL_STATES.COMMITTED, {
        phase: 'committed', ...counts, recoverable: false,
      }, undefined, { clearError: true });
      if (this.audit) {
        try { this.audit({ action: 'project.import', project: admission.target, target: importId }); } catch {}
      }
      return {
        ok: true,
        importId,
        state: journal.state,
        project: {
          name: admission.target,
          displayName: admission.bundle.project.displayName,
          description: admission.bundle.project.description || '',
        },
        counts,
      };
    } catch (error) {
      const failure = error instanceof ProjectBundleImportError
        ? error
        : errorWithCode(error?.message || 'Project import failed', error?.code || 'PROJECT_IMPORT_FAILED', error?.status || 500);
      const failed = this._failJournal(importId, failure, { phase: this._journal(importId)?.progress?.phase || 'failed' });
      if (stagingDir && this.fs.existsSync(stagingDir)) {
        try { this.fs.rmSync(stagingDir, { recursive: true, force: true }); } catch {}
      }
      failure.importId = importId;
      failure.journal = failed || this._journal(importId);
      throw failure;
    } finally {
      ProjectBundleImporter.locks.delete(lock);
    }
  }
}

function createProjectBundleImporter(deps) {
  return new ProjectBundleImporter(deps);
}

module.exports = {
  IMPORT_FORBIDDEN_FILES,
  IMPORT_ROOT_FILES,
  IMPORT_CONTENT_ROOTS,
  RESERVED_TARGET_NAMES,
  ProjectBundleImportError,
  ProjectBundleImporter,
  createProjectBundleImporter,
  portableContentPath,
  sameTaskSemantics,
  taskGraphOrder,
};
