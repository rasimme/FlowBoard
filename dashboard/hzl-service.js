'use strict';

const path = require('path');
const fs = require('fs');

// --- Module-level state (set during init, never before) ---
let _taskService = null;
let _projectService = null;

// RAM cache: flowboardId (string like "T-042") → full FlowBoard task object
const _cache = new Map();

// Bidirectional ID map
const _fbToUlid = new Map(); // "T-042" → ULID
const _ulidToFb  = new Map(); // ULID → "T-042"

// specs/_index.json cache: projectName → { "T-042": "specs/T-042-foo.md" }
const _specsIndex = new Map();

const WORKSPACE = process.env.OPENCLAW_WORKSPACE || path.resolve(__dirname, '..');
const PROJECTS_DIR = path.join(WORKSPACE, 'projects');

// --- Status mapping helpers ---

// FlowBoard status → HZL native status
const FB_TO_HZL = {
  'open':        'ready',
  'in-progress': 'in_progress',
  'review':      'in_progress',
  'done':        'done',
  'backlog':     'backlog',
  'blocked':     'blocked',
  'archived':    'archived',
};

// HZL native status → default FlowBoard status (used only when metadata is missing)
const HZL_TO_FB = {
  'ready':       'open',
  'in_progress': 'in-progress',
  'done':        'done',
  'backlog':     'backlog',
  'blocked':     'blocked',
  'archived':    'archived',
};

function _fbStatus(hzlTask) {
  return hzlTask.metadata?.flowboard?.status
    || HZL_TO_FB[hzlTask.status]
    || 'open';
}

// --- Convert a raw HZL task to FlowBoard format ---
function _toFbTask(hzlTask, project) {
  const fb = hzlTask.metadata?.flowboard || {};
  const id = fb.id;
  if (!id) return null; // Skip tasks without flowboard metadata

  // Derive subtaskIds from other cached tasks (populated after full cache build)
  return {
    id,
    title: hzlTask.title,
    status: fb.status || HZL_TO_FB[hzlTask.status] || 'open',
    priority: _priorityFromInt(hzlTask.priority),
    parentId: fb.parentId || null,
    subtaskIds: [], // populated by _populateSubtaskIds after full build
    specFile: null, // populated from specs index
    created: fb.created || null,
    completed: fb.completed || null,
    _ulid: hzlTask.task_id,
    _project: project,
  };
}

// HZL uses int priority (0=low,1=medium,2=high,3=critical) — map to string
function _priorityFromInt(n) {
  if (n === undefined || n === null) return 'medium';
  if (n <= 0) return 'low';
  if (n === 1) return 'medium';
  if (n === 2) return 'high';
  return 'critical';
}

function _priorityToInt(s) {
  const map = { low: 0, medium: 1, high: 2, critical: 3 };
  return map[s] ?? 1;
}

// Populate subtaskIds on all tasks based on parentId cross-references
function _populateSubtaskIds(tasks) {
  // Reset all subtaskIds
  for (const t of tasks) t.subtaskIds = [];
  // Re-derive from parentId
  for (const t of tasks) {
    if (t.parentId) {
      const parent = tasks.find(p => p.id === t.parentId);
      if (parent) parent.subtaskIds.push(t.id);
    }
  }
  // Sort subtaskIds numerically (T-042-1 < T-042-2)
  for (const t of tasks) {
    if (t.subtaskIds.length > 1) {
      t.subtaskIds.sort((a, b) => {
        const na = parseInt(a.split('-').pop(), 10);
        const nb = parseInt(b.split('-').pop(), 10);
        return na - nb;
      });
    }
  }
}

// Load specs/_index.json for a project
function _loadSpecsIndex(project) {
  const indexPath = path.join(PROJECTS_DIR, project, 'specs', '_index.json');
  try {
    const raw = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    _specsIndex.set(project, raw);
    return raw;
  } catch {
    _specsIndex.set(project, {});
    return {};
  }
}

function _saveSpecsIndex(project, index) {
  const specsDir = path.join(PROJECTS_DIR, project, 'specs');
  if (!fs.existsSync(specsDir)) fs.mkdirSync(specsDir, { recursive: true });
  const indexPath = path.join(specsDir, '_index.json');
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
  _specsIndex.set(project, index);
}

// --- Init ---

async function init(dbPath) {
  const { createDatastore } = await import('hzl-core/db/datastore.js');
  const { EventStore }       = await import('hzl-core/events/store.js');
  const { ProjectionEngine } = await import('hzl-core/projections/engine.js');
  const { TasksCurrentProjector }  = await import('hzl-core/projections/tasks-current.js');
  const { DependenciesProjector }  = await import('hzl-core/projections/dependencies.js');
  const { TagsProjector }          = await import('hzl-core/projections/tags.js');
  const { ProjectsProjector }      = await import('hzl-core/projections/projects.js');
  const { TaskService }    = await import('hzl-core/services/task-service.js');
  const { ProjectService } = await import('hzl-core/services/project-service.js');

  // Ensure DB directory exists
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

  const eventsDbPath = dbPath;
  const cacheDbPath  = dbPath.replace(/\.db$/, '-cache.db');

  const datastore = createDatastore({
    events: { path: eventsDbPath },
    cache:  { path: cacheDbPath },
  });

  const eventStore       = new EventStore(datastore.eventsDb);
  const projectionEngine = new ProjectionEngine(datastore.cacheDb, datastore.eventsDb);
  projectionEngine.register(new TasksCurrentProjector());
  projectionEngine.register(new DependenciesProjector());
  projectionEngine.register(new TagsProjector());
  projectionEngine.register(new ProjectsProjector());

  _projectService = new ProjectService(datastore.cacheDb, eventStore, projectionEngine);
  _taskService    = new TaskService(datastore.cacheDb, eventStore, projectionEngine, _projectService, datastore.eventsDb);

  await rebuildCache();

  console.log('[hzl-service] Initialized. Tasks in cache:', _cache.size);
}

// --- Cache rebuild ---

async function rebuildCache() {
  _cache.clear();
  _fbToUlid.clear();
  _ulidToFb.clear();

  // listTasks with large sinceDays to get all non-archived tasks
  const allActive = _taskService.listTasks({ sinceDays: 99999 });
  const allTasks = allActive;

  // Collect tasks per project to group them
  const byProject = new Map();
  for (const t of allTasks) {
    if (!byProject.has(t.project)) byProject.set(t.project, []);
    byProject.get(t.project).push(t);
  }

  // Check for duplicate flowboard.id values per project — hard fail
  const seen = new Map();
  for (const t of allTasks) {
    const fbId = t.metadata?.flowboard?.id;
    if (!fbId) continue;
    const scopedKey = `${t.project}:${fbId}`;
    if (seen.has(scopedKey)) {
      throw new Error(`[hzl-service] DUPLICATE flowboard.id detected: ${fbId} in project ${t.project} on ULIDs ${seen.get(scopedKey)} and ${t.task_id}`);
    }
    seen.set(scopedKey, t.task_id);
  }

  // Build raw FB tasks per project
  const fbByProject = new Map();
  for (const [project, hzlTasks] of byProject) {
    // Load specs index for this project
    _loadSpecsIndex(project);

    const fbTasks = [];
    for (const hzlTask of hzlTasks) {
      // Get full task data (listTasks doesn't return metadata)
      let fullTask;
      try { fullTask = _taskService.getTaskById(hzlTask.task_id); } catch { continue; }
      if (!fullTask) continue;

      const fbTask = _toFbTask(fullTask, project);
      if (!fbTask) continue;

      _fbToUlid.set(`${project}:${fbTask.id}`, fullTask.task_id);
      _ulidToFb.set(fullTask.task_id, `${project}:${fbTask.id}`);
      fbTasks.push(fbTask);
    }

    // Populate subtaskIds cross-references
    _populateSubtaskIds(fbTasks);

    // Apply specs index
    const specsIdx = _specsIndex.get(project) || {};
    for (const t of fbTasks) {
      t.specFile = specsIdx[t.id] || null;
      // Store in cache (keyed by "project:fbId" for multi-project support)
      _cache.set(`${project}:${t.id}`, t);
    }

    fbByProject.set(project, fbTasks);
  }

  // Fix #3: Load archived tasks into ID maps + cache to prevent ID reuse after restart
  const archivedRows = _taskService.db.prepare(
    "SELECT * FROM tasks_current WHERE status = 'archived'"
  ).all();
  for (const row of archivedRows) {
    let hzlTask;
    try { hzlTask = _taskService.rowToTask(row); } catch { continue; }
    if (!hzlTask) continue;
    const fbId = hzlTask.metadata?.flowboard?.id;
    if (!fbId) continue;
    const proj = hzlTask.project;
    const mapKey = `${proj}:${fbId}`;
    if (_fbToUlid.has(mapKey)) continue; // active version already loaded
    _fbToUlid.set(mapKey, hzlTask.task_id);
    _ulidToFb.set(hzlTask.task_id, mapKey);
    // Build and store in cache (for includeArchived support)
    if (!_specsIndex.has(proj)) _loadSpecsIndex(proj);
    const fbTask = _toFbTask(hzlTask, proj);
    if (fbTask) {
      const specsIdx = _specsIndex.get(proj) || {};
      fbTask.specFile = specsIdx[fbId] || null;
      _cache.set(mapKey, fbTask);
    }
  }

  return fbByProject;
}

// --- Public API ---

/**
 * List all tasks for a project from RAM cache.
 * Returns FlowBoard-format objects (without _ulid/_project internals).
 */
function listTasks(project, opts = {}) {
  const tasks = [];
  for (const [key, task] of _cache) {
    if (!key.startsWith(`${project}:`)) continue;
    if (!opts.includeArchived && task.status === 'archived') continue;
    tasks.push(_publicTask(task));
  }
  return tasks;
}

/**
 * Get a single task by FlowBoard ID.
 */
function getTask(project, flowboardId) {
  const task = _cache.get(`${project}:${flowboardId}`);
  return task ? _publicTask(task) : null;
}

function _publicTask(t) {
  // Return a copy without internal fields
  const { _ulid, _project, ...pub } = t;
  return pub;
}

/**
 * Create a task and update cache.
 * opts: { title, priority?, parentId?, status? }
 * Returns FlowBoard-format task.
 */
function createTask(project, opts) {
  const { title, priority = 'medium', parentId = null, status = 'open' } = opts;

  // Generate next FlowBoard ID
  let newId;
  if (parentId) {
    newId = _nextSubtaskId(project, parentId);
  } else {
    newId = _nextTaskId(project);
  }

  const hzlStatus = FB_TO_HZL[status] || 'ready';
  const created = new Date().toISOString().slice(0, 10);

  // Ensure project exists in HZL (lazy creation on first task)
  if (!_projectService.projectExists(project)) {
    try { _projectService.createProject(project); } catch (e) { console.warn('[hzl-service] createProject:', e.message); }
  }

  const hzlTask = _taskService.createTask({
    title,
    project,
    metadata: {
      flowboard: {
        id: newId,
        status,
        created,
        completed: null,
        parentId: parentId || null,
      }
    },
    priority: _priorityToInt(priority),
    ...(parentId && _fbToUlid.get(`${project}:${parentId}`) ? { parent_id: _fbToUlid.get(`${project}:${parentId}`) } : {}),
    initial_status: hzlStatus,
    tags: [],
  });

  // If HZL created with a different status, force it
  if (hzlTask.status !== hzlStatus) {
    try { _taskService.setStatus(hzlTask.task_id, hzlStatus); } catch (e) { console.warn('[hzl-service] changeStatus on create:', e.message); }
  }

  // Build FB task and add to cache
  const fbTask = {
    id: newId,
    title,
    status,
    priority,
    parentId,
    subtaskIds: [],
    specFile: null,
    created,
    completed: null,
    _ulid: hzlTask.task_id,
    _project: project,
  };

  _fbToUlid.set(`${project}:${newId}`, hzlTask.task_id);
  _ulidToFb.set(hzlTask.task_id, `${project}:${newId}`);
  _cache.set(`${project}:${newId}`, fbTask);

  // If subtask: add to parent's subtaskIds in cache
  if (parentId) {
    const parentCached = _cache.get(`${project}:${parentId}`);
    if (parentCached && !parentCached.subtaskIds.includes(newId)) {
      parentCached.subtaskIds.push(newId);
    }
  }

  return _publicTask(fbTask);
}

/**
 * Update a task (title, status, priority, specFile, completed).
 * Handles dual status sync: both HZL native + metadata.flowboard.status.
 */
function updateTask(project, flowboardId, updates) {
  const ulid = _fbToUlid.get(`${project}:${flowboardId}`);
  if (!ulid) throw new Error(`Task not found in ID map: ${flowboardId}`);

  const cached = _cache.get(`${project}:${flowboardId}`);
  if (!cached) throw new Error(`Task not found in cache: ${flowboardId}`);

  const hzlUpdates = {};
  const metaUpdates = { flowboard: { ...(_taskService.getTaskById(ulid)?.metadata?.flowboard || {}) } };

  if (updates.title !== undefined) hzlUpdates.title = updates.title;
  if (updates.priority !== undefined) hzlUpdates.priority = _priorityToInt(updates.priority);

  if (updates.status !== undefined) {
    metaUpdates.flowboard.status = updates.status;
    if (updates.status === 'done') {
      const completedDate = updates.completed || new Date().toISOString().slice(0, 10);
      metaUpdates.flowboard.completed = completedDate;
      updates.completed = completedDate; // ensure cache gets updated below
    } else if (updates.status !== 'done' && cached.status === 'done') {
      metaUpdates.flowboard.completed = null;
      updates.completed = null; // ensure cache gets updated below
    }
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'completed')) {
    metaUpdates.flowboard.completed = updates.completed;
  }

  hzlUpdates.metadata = metaUpdates;

  // Write metadata + scalar updates
  _taskService.updateTask(ulid, hzlUpdates);

  // Update HZL native status via changeStatus (separate call required)
  if (updates.status !== undefined) {
    const targetHzlStatus = FB_TO_HZL[updates.status] || 'ready';
    try {
      _taskService.setStatus(ulid, targetHzlStatus);
    } catch (e) {
      console.warn(`[hzl-service] changeStatus(${ulid}, ${targetHzlStatus}) failed:`, e.message);
    }
  }

  // Update cache
  const ALLOWED = ['title', 'status', 'priority', 'specFile', 'completed'];
  for (const key of ALLOWED) {
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      cached[key] = updates[key];
    }
  }

  return _publicTask(cached);
}

/**
 * Delete a task (and optionally its subtasks).
 * mode: 'all' | 'keep-children' | undefined (simple task)
 */
function deleteTask(project, flowboardId, mode) {
  const ulid = _fbToUlid.get(`${project}:${flowboardId}`);
  if (!ulid) throw new Error(`Task not found: ${flowboardId}`);

  const cached = _cache.get(`${project}:${flowboardId}`);
  if (!cached) throw new Error(`Task not found in cache: ${flowboardId}`);

  if (cached.subtaskIds && cached.subtaskIds.length > 0) {
    if (!mode) throw Object.assign(new Error('Task has subtasks'), { subtaskCount: cached.subtaskIds.length });

    if (mode === 'all') {
      // Delete all subtasks first
      for (const subId of [...cached.subtaskIds]) {
        const subUlid = _fbToUlid.get(`${project}:${subId}`);
        if (subUlid) {
          try { _taskService.archiveTask(subUlid); } catch (e) { console.warn(e); }
          _ulidToFb.delete(subUlid); // Fix #5: clean up reverse map
        }
        _cache.delete(`${project}:${subId}`);
        _fbToUlid.delete(`${project}:${subId}`);
      }
    } else if (mode === 'keep-children') {
      // Fix #2: use orphanSubtasks instead of manual reparenting (parent_id: null is rejected by hzl-core)
      try { _taskService.orphanSubtasks(ulid); } catch (e) { console.warn('[hzl-service] orphanSubtasks:', e.message); }
      // Update RAM cache for each child
      for (const subId of cached.subtaskIds) {
        const subCached = _cache.get(`${project}:${subId}`);
        if (subCached) subCached.parentId = null;
      }
    } else {
      throw new Error('Invalid mode. Use "all" or "keep-children"');
    }
  } else if (cached.parentId) {
    // Remove from parent's subtaskIds in cache
    const parentCached = _cache.get(`${project}:${cached.parentId}`);
    if (parentCached && parentCached.subtaskIds) {
      parentCached.subtaskIds = parentCached.subtaskIds.filter(id => id !== flowboardId);
    }
  }

  // Archive the task itself
  try { _taskService.archiveTask(ulid); } catch (e) { console.warn('[hzl-service] archiveTask:', e.message); }
  _cache.delete(`${project}:${flowboardId}`);
  _fbToUlid.delete(`${project}:${flowboardId}`);
  _ulidToFb.delete(ulid); // Fix #5: clean up reverse map

  return { ok: true };
}

/**
 * Get a task summary string for hooks/bootstrap context.
 */
function getTaskSummary(project) {
  const tasks = [];
  for (const [key, task] of _cache) {
    if (!key.startsWith(`${project}:`)) continue;
    if (!task.parentId) tasks.push(task); // top-level only
  }
  const counts = { backlog: 0, open: 0, 'in-progress': 0, review: 0, done: 0, blocked: 0, archived: 0 };
  for (const t of tasks) {
    if (counts[t.status] !== undefined) counts[t.status]++;
  }
  const parts = [];
  if (counts.backlog)        parts.push(`${counts.backlog} backlog`);
  if (counts.open)           parts.push(`${counts.open} open`);
  if (counts['in-progress']) parts.push(`${counts['in-progress']} in-progress`);
  if (counts.review)         parts.push(`${counts.review} review`);
  if (counts.blocked)        parts.push(`${counts.blocked} blocked`);
  if (counts.done)           parts.push(`${counts.done} done`);
  return parts.join(', ') || 'no tasks';
}

/**
 * Get task counts per status for the project list sidebar.
 */
function getTaskCounts(project) {
  const counts = { open: 0, 'in-progress': 0, review: 0, done: 0, backlog: 0, blocked: 0, archived: 0 };
  for (const [key, task] of _cache) {
    if (!key.startsWith(`${project}:`)) continue;
    if (task.parentId) continue; // top-level only for badge counts
    if (counts[task.status] !== undefined) counts[task.status]++;
  }
  return counts;
}

/**
 * Generate next top-level task ID for a project.
 */
function _nextTaskId(project) {
  let max = 0;
  for (const [key] of _cache) {
    if (!key.startsWith(`${project}:`)) continue;
    const id = key.slice(project.length + 1);
    if (id.includes('-') && id.split('-').length > 2) continue; // skip subtasks
    const m = id.match(/^T-(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  // Also scan _fbToUlid for IDs in this project not yet in cache
  const prefix = `${project}:`;
  for (const key of _fbToUlid.keys()) {
    if (!key.startsWith(prefix)) continue;
    const fbId = key.slice(prefix.length);
    if (_cache.has(key)) continue; // already counted above
    const m = fbId.match(/^T-(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `T-${String(max + 1).padStart(3, '0')}`;
}

/**
 * Generate next subtask ID (T-042-1, T-042-2, etc.)
 */
function _nextSubtaskId(project, parentId) {
  const parent = _cache.get(`${project}:${parentId}`);
  const existingSubtaskIds = parent?.subtaskIds || [];
  const nums = existingSubtaskIds.map(id => {
    const parts = id.split('-');
    return parseInt(parts[parts.length - 1], 10);
  }).filter(n => !isNaN(n));
  const next = nums.length ? Math.max(...nums) + 1 : 1;
  return `${parentId}-${next}`;
}

/**
 * Update specs/_index.json for a project (called by spec route in server.js).
 */
function setSpecLink(project, flowboardId, specFile) {
  const index = { ...(_specsIndex.get(project) || {}) };
  if (specFile === null) {
    delete index[flowboardId];
  } else {
    index[flowboardId] = specFile;
  }
  _saveSpecsIndex(project, index);

  // Update cache
  const cached = _cache.get(`${project}:${flowboardId}`);
  if (cached) cached.specFile = specFile;
}

/**
 * Get the specs index for a project.
 */
function getSpecsIndex(project) {
  return { ...(_specsIndex.get(project) || {}) };
}

/**
 * Recalculate and persist parent status after a subtask status change.
 * Returns { id, status } if parent was updated, null otherwise.
 */
function recalcParentStatus(project, parentId) {
  const parent = _cache.get(`${project}:${parentId}`);
  if (!parent || parent.status === 'done') return null;

  const subtasks = parent.subtaskIds
    .map(id => _cache.get(`${project}:${id}`))
    .filter(Boolean)
    .filter(t => t.status !== 'archived'); // archived subtasks excluded

  if (subtasks.length === 0) return null;

  const allDone    = subtasks.every(t => t.status === 'done');
  const anyStarted = subtasks.some(t => t.status !== 'open' && t.status !== 'backlog');

  let newStatus = parent.status;
  if (allDone) {
    newStatus = 'review';
  } else if (anyStarted && (parent.status === 'open' || parent.status === 'backlog')) {
    newStatus = 'in-progress';
  } else if (!allDone && parent.status === 'review') {
    newStatus = 'in-progress';
  }

  if (newStatus !== parent.status) {
    updateTask(project, parentId, { status: newStatus });
    return { id: parentId, status: newStatus };
  }
  return null;
}

/**
 * Ensure a HZL project exists. Called during init if needed.
 */
function ensureProject(projectName) {
  try {
    _projectService.requireProject(projectName);
  } catch {
    console.log(`[hzl-service] Project ${projectName} not yet in HZL — will be created on first task`);
  }
}

module.exports = {
  init,
  rebuildCache,
  listTasks,
  getTask,
  createTask,
  updateTask,
  deleteTask,
  getTaskSummary,
  getTaskCounts,
  setSpecLink,
  getSpecsIndex,
  recalcParentStatus,
  ensureProject,
};
