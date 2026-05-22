'use strict';

// project-lifecycle.js — T-131-6: Canonical project creation orchestration.
// Called by POST /api/projects in server.js.

const path = require('path');
const fs = require('fs');

// Slug validation: lowercase letters, digits, hyphens; must start with a letter or digit
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * Validate and normalize project creation input.
 * Throws { code: 'VALIDATION_ERROR', message } on failure.
 */
function _validateInput({ name, displayName, description, group }) {
  if (!name || typeof name !== 'string') {
    throw Object.assign(new Error('name is required'), { code: 'VALIDATION_ERROR' });
  }
  const slug = name.trim().toLowerCase();
  if (!NAME_RE.test(slug)) {
    throw Object.assign(
      new Error('name must be a lowercase slug (letters, digits, hyphens; max 63 chars)'),
      { code: 'VALIDATION_ERROR' }
    );
  }
  let cleanGroup = null;
  if (group !== undefined && group !== null) {
    if (typeof group !== 'string') {
      throw Object.assign(new Error('group must be a string'), { code: 'VALIDATION_ERROR' });
    }
    const g = group.trim();
    if (g.length > 60) {
      throw Object.assign(new Error('group name too long (max 60 chars)'), { code: 'VALIDATION_ERROR' });
    }
    cleanGroup = g || null;
  }
  return {
    name: slug,
    displayName: (typeof displayName === 'string' && displayName.trim()) || slug,
    description: (typeof description === 'string' && description.trim()) || '',
    group: cleanGroup,
  };
}

/**
 * Scaffold filesystem project structure under projectsDir/<name>/.
 * Required: project root dir, PROJECT.md, SESSIONS.md, DECISIONS.md.
 * Optional: context/, specs/, canvas.json (failures produce warnings).
 * Throws if required pieces cannot be created.
 * Returns { warnings: string[] }.
 */
function _scaffoldFilesystem(projectsDir, name, displayName, description) {
  const projectDir = path.join(projectsDir, name);
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // Required: project root directory
  fs.mkdirSync(projectDir, { recursive: true });

  // Required: PROJECT.md (post-m005 — no embedded session log)
  const projectMd = [
    `# ${displayName}`,
    '',
    description ? `${description}\n` : '',
    '## Goal',
    '[What should be achieved?]',
    '',
    '## Current Status',
    'Project created.',
    '',
    '## Key Next Steps',
    '- [ ] Define project scope',
    '',
  ].join('\n');

  // Required: SESSIONS.md
  const sessionsMd = [
    `# Sessions — ${displayName}`,
    '',
    `### ${today}`,
    '- Project created',
    '',
  ].join('\n');

  // Required: DECISIONS.md
  const decisionsMd = [
    `# Decisions — ${displayName}`,
    '',
    'Decisions are logged here when significant choices are made. Only loaded on demand.',
    '',
    '<!-- Format:',
    '### [DATE] — [Short Title]',
    '**Decision:** What was decided',
    '**Reasoning:** Why',
    '**Alternatives considered:** What else was on the table',
    '-->',
    '',
  ].join('\n');

  fs.writeFileSync(path.join(projectDir, 'PROJECT.md'), projectMd);
  fs.writeFileSync(path.join(projectDir, 'SESSIONS.md'), sessionsMd);
  fs.writeFileSync(path.join(projectDir, 'DECISIONS.md'), decisionsMd);

  // Optional pieces — failures become warnings
  const warnings = [];

  try {
    fs.mkdirSync(path.join(projectDir, 'context'), { recursive: true });
  } catch (e) {
    warnings.push(`Could not create context/: ${e.message}`);
  }

  try {
    fs.mkdirSync(path.join(projectDir, 'specs'), { recursive: true });
  } catch (e) {
    warnings.push(`Could not create specs/: ${e.message}`);
  }

  try {
    fs.writeFileSync(
      path.join(projectDir, 'canvas.json'),
      JSON.stringify({ notes: [], connections: [] }, null, 2)
    );
  } catch (e) {
    warnings.push(`Could not create canvas.json: ${e.message}`);
  }

  return { warnings };
}

/**
 * Create a new project — canonical orchestration.
 *
 * @param {object} input        - { name, displayName?, description? }
 * @param {object} deps
 * @param {object} deps.hzlService  - hzl-service module (must be initialized)
 * @param {object} deps.fbMeta      - flowboard-metadata module (must be initialized)
 * @param {string} deps.projectsDir - absolute path to shared projects root
 *
 * @returns {{ project: object, warnings: string[] }}
 * @throws Error with .code in:
 *   'VALIDATION_ERROR' | 'DUPLICATE' | 'HZL_ERROR' | 'METADATA_ERROR' | 'SCAFFOLD_ERROR'
 */
function createProject(input, { hzlService, fbMeta, projectsDir }) {
  // 1. Validate
  const { name, displayName, description, group } = _validateInput(input);

  // 2. Duplicate detection across all canonical layers
  const hzlProjects = hzlService.listHzlProjects();
  if (hzlProjects.some(p => p.name === name)) {
    throw Object.assign(
      new Error(`Project "${name}" already exists in HZL`),
      { code: 'DUPLICATE' }
    );
  }

  if (fbMeta.getProject(name)) {
    throw Object.assign(
      new Error(`Project "${name}" already exists in FlowBoard metadata`),
      { code: 'DUPLICATE' }
    );
  }

  if (typeof fbMeta.isProjectDeleted === 'function' && fbMeta.isProjectDeleted(name)) {
    throw Object.assign(
      new Error(`Project "${name}" was deleted. Pick a different name (or restore from projects/.trash/)`),
      { code: 'DUPLICATE' }
    );
  }

  const projectDir = path.join(projectsDir, name);
  if (fs.existsSync(projectDir)) {
    throw Object.assign(
      new Error(`Project directory already exists: ${projectDir}`),
      { code: 'DUPLICATE' }
    );
  }

  // 3. Create HZL project (hard failure — abort on error)
  try {
    hzlService.createProject(name, description || null);
  } catch (e) {
    throw Object.assign(
      new Error(`HZL project creation failed: ${e.message}`),
      { code: 'HZL_ERROR' }
    );
  }

  // 4. Create FlowBoard metadata row (hard failure — do not silently continue)
  try {
    fbMeta.upsertProject(name, {
      displayName,
      status: 'active',
      createdAt: new Date().toISOString(),
      config: group ? { group } : {},
    }, true);
  } catch (e) {
    throw Object.assign(
      new Error(`FlowBoard metadata creation failed: ${e.message}`),
      { code: 'METADATA_ERROR' }
    );
  }

  if (!fbMeta.getProject(name)) {
    throw Object.assign(
      new Error('FlowBoard metadata row missing after creation'),
      { code: 'METADATA_ERROR' }
    );
  }

  // 5. Scaffold filesystem (required files → hard failure; optional → warnings)
  let warnings = [];
  try {
    ({ warnings } = _scaffoldFilesystem(projectsDir, name, displayName, description));
  } catch (e) {
    throw Object.assign(
      new Error(`Filesystem scaffold failed: ${e.message}`),
      { code: 'SCAFFOLD_ERROR' }
    );
  }

  const project = {
    name,
    displayName,
    description: description || null,
    status: 'active',
    group: group || null,
  };
  return { project, warnings };
}

// --- T-136: update + hard-delete ---

const VALID_UPDATE_STATUSES = new Set(['active', 'archived']);

function _validateUpdateInput(patch) {
  const out = {};
  if (patch.displayName !== undefined) {
    if (typeof patch.displayName !== 'string') {
      throw Object.assign(new Error('displayName must be a string'), { code: 'VALIDATION_ERROR' });
    }
    const dn = patch.displayName.trim();
    if (!dn) throw Object.assign(new Error('displayName cannot be empty'), { code: 'VALIDATION_ERROR' });
    if (dn.length > 120) throw Object.assign(new Error('displayName too long (max 120 chars)'), { code: 'VALIDATION_ERROR' });
    out.displayName = dn;
  }
  if (patch.archived !== undefined) {
    if (typeof patch.archived !== 'boolean') {
      throw Object.assign(new Error('archived must be boolean'), { code: 'VALIDATION_ERROR' });
    }
    out.archived = patch.archived;
  }
  if (patch.status !== undefined) {
    if (typeof patch.status !== 'string' || !VALID_UPDATE_STATUSES.has(patch.status)) {
      throw Object.assign(
        new Error(`status must be one of: ${[...VALID_UPDATE_STATUSES].join(', ')}`),
        { code: 'VALIDATION_ERROR' }
      );
    }
    out.status = patch.status;
  }
  if (patch.group !== undefined) {
    if (patch.group !== null && typeof patch.group !== 'string') {
      throw Object.assign(new Error('group must be a string or null'), { code: 'VALIDATION_ERROR' });
    }
    if (typeof patch.group === 'string') {
      const g = patch.group.trim();
      if (g.length > 60) {
        throw Object.assign(new Error('group too long (max 60 chars)'), { code: 'VALIDATION_ERROR' });
      }
      out.group = g || null;
    } else {
      out.group = null;
    }
  }
  if (patch.order !== undefined) {
    if (patch.order === null) {
      out.order = null;
    } else {
      const n = Number(patch.order);
      if (!Number.isFinite(n)) {
        throw Object.assign(new Error('order must be a finite number or null'), { code: 'VALIDATION_ERROR' });
      }
      out.order = n;
    }
  }
  if (Object.keys(out).length === 0) {
    throw Object.assign(new Error('No updatable fields provided'), { code: 'VALIDATION_ERROR' });
  }
  return out;
}

function _toPublic(row) {
  let config = {};
  try { config = JSON.parse(row.config || '{}'); } catch { /* keep {} */ }
  return {
    name: row.name,
    displayName: row.display_name || row.name,
    status: row.status || 'active',
    archived: (row.status || 'active') === 'archived',
    group: typeof config.group === 'string' ? config.group : null,
    order: typeof config.order === 'number' ? config.order : null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

/**
 * Update a project's metadata (display name, archived flag, group, order).
 * Lazily creates a flowboard_projects row for HZL-only legacy projects.
 *
 * @throws Error with .code in 'VALIDATION_ERROR' | 'NOT_FOUND' | 'METADATA_ERROR'
 */
function updateProject(name, input, { hzlService, fbMeta }) {
  if (typeof fbMeta.isProjectDeleted === 'function' && fbMeta.isProjectDeleted(name)) {
    throw Object.assign(new Error(`Project "${name}" is deleted`), { code: 'NOT_FOUND' });
  }
  const hzlProjects = hzlService.listHzlProjects();
  if (!hzlProjects.some(p => p.name === name)) {
    throw Object.assign(new Error(`Project "${name}" not found`), { code: 'NOT_FOUND' });
  }

  const patch = _validateUpdateInput(input || {});

  // Ensure a metadata row exists (HZL-only legacy projects)
  if (!fbMeta.getProject(name)) {
    fbMeta.upsertProject(name, { displayName: name, status: 'active' }, true);
  }

  const updated = fbMeta.updateProjectMeta(name, patch);
  if (!updated) {
    throw Object.assign(new Error('Metadata row missing after update'), { code: 'METADATA_ERROR' });
  }
  return _toPublic(updated);
}

/**
 * Hard-delete a project.
 *
 * Three-step sequence, best-effort with warnings (caller still sees ok=true):
 *   1. Archive every active top-level task in the project (cascade 'all')
 *   2. Move projects/<name>/ into projects/.trash/<name>-<ts>/
 *   3. Tombstone the metadata row so listProjects hides the name forever
 *
 * Step 3 is the only one that must succeed; otherwise we throw METADATA_ERROR.
 *
 * @throws Error with .code in 'NOT_FOUND' | 'METADATA_ERROR'
 */
function deleteProject(name, { hzlService, fbMeta, projectsDir }) {
  if (typeof fbMeta.isProjectDeleted === 'function' && fbMeta.isProjectDeleted(name)) {
    throw Object.assign(new Error(`Project "${name}" is already deleted`), { code: 'NOT_FOUND' });
  }
  const hzlProjects = hzlService.listHzlProjects();
  if (!hzlProjects.some(p => p.name === name)) {
    throw Object.assign(new Error(`Project "${name}" not found`), { code: 'NOT_FOUND' });
  }

  const warnings = [];
  let archivedTaskCount = 0;

  // 1. Archive top-level tasks (children cascade via mode='all')
  let tasks = [];
  try { tasks = hzlService.listTasks(name, { includeArchived: false }) || []; }
  catch (e) { warnings.push(`listTasks: ${e.message}`); }

  for (const t of tasks) {
    if (t.parentId) continue;
    const mode = t.subtaskIds && t.subtaskIds.length > 0 ? 'all' : undefined;
    try {
      hzlService.deleteTask(name, t.id, mode);
      archivedTaskCount++;
    } catch (e) {
      warnings.push(`archive ${t.id}: ${e.message}`);
    }
  }

  // 2. Move project dir into .trash (reversible by hand)
  const projectDir = path.join(projectsDir, name);
  if (fs.existsSync(projectDir)) {
    const trashRoot = path.join(projectsDir, '.trash');
    if (!fs.existsSync(trashRoot)) {
      try { fs.mkdirSync(trashRoot, { recursive: true }); }
      catch (e) { warnings.push(`mkdir .trash: ${e.message}`); }
    }
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(trashRoot, `${name}-${ts}`);
    try {
      fs.renameSync(projectDir, dest);
    } catch (e) {
      warnings.push(`trash move: ${e.message}`);
    }
  }

  // 3. Tombstone in flowboard metadata — must succeed
  try {
    fbMeta.deleteProjectMeta(name);
  } catch (e) {
    throw Object.assign(
      new Error(`Metadata tombstone failed: ${e.message}`),
      { code: 'METADATA_ERROR' }
    );
  }

  return { ok: true, archivedTaskCount, warnings };
}

/**
 * Heal a project whose state exists at the filesystem layer or in the
 * flowboard_projects metadata table but is missing a canonical HZL
 * project_created event. Idempotent: a no-op when the project is already
 * fully registered.
 *
 * createProject() refuses such inputs as DUPLICATE because its preconditions
 * are tuned for new projects. healProject() exists for the inverse case:
 * legacy migrations that wrote metadata rows without an event, or ad-hoc
 * filesystem dirs that bypassed the API. It explicitly does NOT scaffold
 * PROJECT.md/SESSIONS.md/DECISIONS.md and does NOT overwrite an existing
 * metadata row's displayName.
 *
 * @param {object} input        - { name, displayName?, description? }
 * @param {object} deps
 * @param {object} deps.hzlService  - initialized hzl-service
 * @param {object} deps.fbMeta      - initialized flowboard-metadata
 * @param {string} deps.projectsDir - shared projects root
 *
 * @returns {{ healed: boolean, project: object, actions: string[] }}
 *   actions ∈ { 'hzl_event', 'metadata_row' }
 *
 * @throws Error with .code in 'VALIDATION_ERROR' | 'NOT_FOUND' | 'HZL_ERROR' | 'METADATA_ERROR'
 */
function healProject(input, { hzlService, fbMeta, projectsDir }) {
  const { name, displayName: requestedDisplayName, description } = _validateInput(input);

  if (typeof fbMeta.isProjectDeleted === 'function' && fbMeta.isProjectDeleted(name)) {
    throw Object.assign(new Error(`Project "${name}" is deleted — heal not allowed`), { code: 'NOT_FOUND' });
  }

  const inHzl = hzlService.listHzlProjects().some(p => p.name === name);
  const metaRow = fbMeta.getProject(name);
  const inFs = fs.existsSync(path.join(projectsDir, name));

  if (!inHzl && !metaRow && !inFs) {
    throw Object.assign(
      new Error(`Project "${name}" not found at any layer — use POST /api/projects to create`),
      { code: 'NOT_FOUND' }
    );
  }

  const actions = [];

  if (!inHzl) {
    try {
      hzlService.createProject(name, description || null);
      actions.push('hzl_event');
    } catch (e) {
      throw Object.assign(new Error(`HZL event creation failed: ${e.message}`), { code: 'HZL_ERROR' });
    }
  }

  // Effective displayName precedence: explicit input → existing metadata row → slug
  const explicit = typeof input.displayName === 'string' && input.displayName.trim();
  const displayName = explicit
    ? requestedDisplayName
    : (metaRow ? (metaRow.display_name || name) : name);

  if (!metaRow) {
    try {
      fbMeta.upsertProject(name, {
        displayName,
        status: 'active',
        createdAt: new Date().toISOString(),
        config: {},
      }, true);
      actions.push('metadata_row');
    } catch (e) {
      throw Object.assign(new Error(`FlowBoard metadata creation failed: ${e.message}`), { code: 'METADATA_ERROR' });
    }
  }

  const finalMeta = fbMeta.getProject(name);
  return {
    healed: actions.length > 0,
    project: {
      name,
      displayName: (finalMeta && finalMeta.display_name) || displayName,
      status: (finalMeta && finalMeta.status) || 'active',
    },
    actions,
  };
}

/**
 * Read-only drift detector: names present in flowboard_projects metadata or
 * in the projects/ filesystem dir but absent from HZL. Each item carries the
 * sources it was found in so callers can decide how to surface the warning.
 *
 * Hidden dirs (starting with '.') are skipped — they are infrastructure
 * (.trash, .hzl, .DS_Store-like), not projects. Tombstoned names are also
 * skipped because their absence from HZL is intentional.
 *
 * @returns {Array<{ name: string, sources: string[] }>}
 */
function detectProjectDrift({ hzlService, fbMeta, projectsDir }) {
  const inHzl = new Set(hzlService.listHzlProjects().map(p => p.name));

  const metaNames = typeof fbMeta.listMetaProjects === 'function'
    ? fbMeta.listMetaProjects().map(r => r.name)
    : [];

  let fsNames = [];
  try {
    fsNames = fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'))
      // PROJECT.md is the canonical marker that a directory *claims* to be a
      // project. Dirs without it are agent manuals, ad-hoc backups, or
      // unrelated leftovers, and would otherwise produce noisy drift entries.
      .filter(d => fs.existsSync(path.join(projectsDir, d.name, 'PROJECT.md')))
      .map(d => d.name);
  } catch { /* dir may not exist yet — treat as empty */ }

  const isDeleted = typeof fbMeta.isProjectDeleted === 'function'
    ? n => fbMeta.isProjectDeleted(n)
    : () => false;

  const drift = new Map();
  for (const n of metaNames) {
    if (inHzl.has(n) || isDeleted(n)) continue;
    drift.set(n, { name: n, sources: ['metadata'] });
  }
  for (const n of fsNames) {
    if (inHzl.has(n) || isDeleted(n)) continue;
    const existing = drift.get(n);
    if (existing) existing.sources.push('filesystem');
    else drift.set(n, { name: n, sources: ['filesystem'] });
  }

  return [...drift.values()];
}

module.exports = { createProject, healProject, updateProject, deleteProject, detectProjectDrift };
