'use strict';

const path = require('path');
const fs = require('fs');

// --- Module-level state (set during init, never before) ---
let _taskService = null;
let _projectService = null;
let _eventStore = null;
let _projectionEngine = null;
let _hookDrainService = null;
let _EventType = null; // EventType enum from hzl-core (loaded dynamically)
let _cacheDb = null; // better-sqlite3 handle to the HZL cache DB (shared with task/project services)
let _eventsDb = null; // better-sqlite3 handle to the HZL events DB (used by integrity checks)

// Completion callback — set via setOnComplete() by server.js for notifications
let _onCompleteCallback = null;

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
// Note: 'blocked' is NOT a status — it's a boolean flag on metadata.flowboard.blocked
const FB_TO_HZL = {
  'open':        'ready',
  'in-progress': 'in_progress',
  'review':      'in_progress',
  'done':        'done',
  'backlog':     'backlog',
  'archived':    'archived',
};

// HZL native status → default FlowBoard status (used only when metadata is missing)
const HZL_TO_FB = {
  'ready':       'open',
  'in_progress': 'in-progress',
  'done':        'done',
  'backlog':     'backlog',
  'blocked':     'open', // HZL blocked → treat as open (blocked flag is separate)
  'archived':    'archived',
};

const VALID_STATUSES = new Set(['open', 'in-progress', 'review', 'done', 'backlog', 'archived']);

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
    blocked: fb.blocked === true,
    priority: _priorityFromInt(hzlTask.priority),
    parentId: fb.parentId || null,
    subtaskIds: [], // populated by _populateSubtaskIds after full build
    specFile: null, // populated from specs index
    created: fb.created || null,
    completed: fb.completed || null,
    // Claim/Lease fields from HZL native columns
    agent: hzlTask.agent || null,
    claimedAt: hzlTask.claimed_at || null,
    leaseUntil: hzlTask.lease_until || null,
    // Checkpoint tracking
    lastCheckpointAt: fb.lastCheckpointAt || null,
    checkpointCount: fb.checkpointCount || 0,
    // Agent routing (explicit pre-assignment, separate from claim ownership)
    routedAgent: fb.routedAgent || null,
    // T-161-4: soft-delete pointer into Trash. Null = live task; ISO string =
    // task is in Trash and eligible for Empty-Trash bulk hard-delete.
    trashedAt: fb.trashedAt || null,
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

// T-161 cache-projection sync helpers.
//
// Background: HZL's projection (tasks_current) runs auto-side-effects on
// status changes — most notably, transitioning to in_progress without an
// explicit agent COALESCE-preserves the previous agent, and leaving
// in_progress preserves the agent for historical attribution. The dashboard
// has its own in-memory cache (_cache) that previously tried to mirror HZL
// via incremental field-by-field patches after each mutation. This was
// fragile: any HZL side-effect the dashboard didn't anticipate would cause
// cache ↔ projection drift, and the API/UI would show stale data while
// claim attempts hit a different state and got rejected (T-006 bug).
//
// Two helpers, used at the end of every mutation function:
//
//   _resyncCachedTask(ulid)           Authoritative direction: HZL → cache.
//                                     Reads the current tasks_current row,
//                                     runs _toFbTask, replaces the cache
//                                     entry. Always called last so the
//                                     return value matches projection truth.
//
//   _alignProjectionToCache(ulid, c)  Orchestrator direction: cache → HZL.
//                                     Used by updateTask after dashboard-
//                                     level processing (status change,
//                                     auto-release block) to neutralize
//                                     HZL's auto-COALESCE side-effects on
//                                     agent/claimed_at/lease_until — the
//                                     dashboard's cache reflects the user's
//                                     intent; the projection should match.
//                                     Direct SQL because HZL's event
//                                     vocabulary lacks a primitive for
//                                     "clear claimed_at without changing
//                                     status".
//
// Invariant enforced after every mutation:
//   _cache[key] === toFbTask(tasks_current[ulid])
//
// Invariant enforced by _alignProjectionToCache:
//   if cached.agent is null, claimed_at and lease_until are also null.
//   (No active claim → no claim metadata.)
function _resyncCachedTask(ulid) {
  if (!ulid) return null;
  const mapKey = _ulidToFb.get(ulid);
  if (!mapKey) return null;
  const sep = mapKey.indexOf(':');
  if (sep < 0) return null;
  const project = mapKey.slice(0, sep);
  const fbId = mapKey.slice(sep + 1);

  let hzlTask;
  try { hzlTask = _taskService.getTaskById(ulid); } catch { return null; }
  if (!hzlTask) {
    _cache.delete(mapKey);
    return null;
  }

  const fbTask = _toFbTask(hzlTask, project);
  if (!fbTask) {
    _cache.delete(mapKey);
    return null;
  }

  if (!_specsIndex.has(project)) _loadSpecsIndex(project);
  const specsIdx = _specsIndex.get(project) || {};
  fbTask.specFile = specsIdx[fbId] || null;

  _cache.set(mapKey, fbTask);
  return fbTask;
}

function _alignProjectionToCache(ulid, cached) {
  if (!ulid || !cached) return;
  // Invariant: claim metadata (claimed_at, lease_until) only makes sense
  // when an agent is set. If the dashboard's cache says "unclaimed", the
  // projection should reflect that fully — not just the agent field.
  const agent = cached.agent ?? null;
  const claimedAt = agent ? (cached.claimedAt ?? null) : null;
  const leaseUntil = agent ? (cached.leaseUntil ?? null) : null;
  try {
    _taskService.db.prepare(`
      UPDATE tasks_current
      SET agent = ?, claimed_at = ?, lease_until = ?
      WHERE task_id = ?
    `).run(agent, claimedAt, leaseUntil, ulid);
  } catch (e) {
    console.warn('[hzl-service] _alignProjectionToCache:', e.message);
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

// --- Metadata update helper ---
// hzl-core's updateTask() does not emit events for metadata field changes.
// The projection (TasksCurrentProjector) DOES support it via SAFE_COLUMNS + JSON_FIELDS.
// We emit the TaskUpdated event directly to work around this gap.
// Internal helpers for cascading archive/restore on children (no recursion, no validation)
function _archiveChild(project, cached) {
  const ulid = _fbToUlid.get(`${project}:${cached.id}`);
  if (!ulid) return;
  _taskService.archiveTask(ulid);
  const meta = { flowboard: { ...(_taskService.getTaskById(ulid)?.metadata?.flowboard || {}), status: 'archived' } };
  _updateMetadata(ulid, meta);
  cached.status = 'archived';
}

function _restoreChild(project, cached) {
  const ulid = _fbToUlid.get(`${project}:${cached.id}`);
  if (!ulid) return;
  // Direct event emission — hzl-core rejects setStatus from archived
  const event = _eventStore.append({ task_id: ulid, type: 'status_changed', data: { from: 'archived', to: 'done' } });
  _projectionEngine.applyEvent(event);
  const meta = { flowboard: { ...(_taskService.getTaskById(ulid)?.metadata?.flowboard || {}), status: 'done' } };
  _updateMetadata(ulid, meta);
  cached.status = 'done';
}

function _updateMetadata(ulid, newMetadata) {
  if (!_eventStore || !_projectionEngine || !_EventType) {
    throw new Error('[hzl-service] Not initialized — call init() first');
  }
  const current = _taskService.getTaskById(ulid);
  if (!current) throw new Error(`[hzl-service] Task not found: ${ulid}`);
  const oldMeta = current.metadata || {};
  const event = _eventStore.append({
    task_id: ulid,
    type: _EventType.TaskUpdated,
    data: { field: 'metadata', old_value: oldMeta, new_value: newMetadata },
  });
  _projectionEngine.applyEvent(event);
}

// --- Init ---

async function init(dbPath) {
  const { createDatastore } = await import('hzl-core/db/datastore.js');
  const { EventStore }       = await import('hzl-core/events/store.js');
  const { EventType }        = await import('hzl-core/events/types.js');
  const { ProjectionEngine } = await import('hzl-core/projections/engine.js');
  const { TasksCurrentProjector }  = await import('hzl-core/projections/tasks-current.js');
  const { DependenciesProjector }  = await import('hzl-core/projections/dependencies.js');
  const { TagsProjector }          = await import('hzl-core/projections/tags.js');
  const { ProjectsProjector }      = await import('hzl-core/projections/projects.js');
  const { CommentsCheckpointsProjector } = await import('hzl-core/projections/comments-checkpoints.js');
  const { TaskService }    = await import('hzl-core/services/task-service.js');
  const { ProjectService } = await import('hzl-core/services/project-service.js');
  const { HookDrainService } = await import('hzl-core');

  // Ensure DB directory exists
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

  const eventsDbPath = dbPath;
  const cacheDbPath  = dbPath.replace(/\.db$/, '-cache.db');

  const datastore = createDatastore({
    events: { path: eventsDbPath },
    cache:  { path: cacheDbPath },
  });

  _eventStore       = new EventStore(datastore.eventsDb);
  _projectionEngine = new ProjectionEngine(datastore.cacheDb, datastore.eventsDb);
  _projectionEngine.register(new TasksCurrentProjector());
  _projectionEngine.register(new DependenciesProjector());
  _projectionEngine.register(new TagsProjector());
  _projectionEngine.register(new ProjectsProjector());
  _projectionEngine.register(new CommentsCheckpointsProjector());
  _EventType = EventType;

  // Configure on_done hook — posts to FlowBoard's own receiver endpoint.
  // Read FLOWBOARD_PORT first (project convention); fall back to PORT for
  // legacy compat with environments that pre-date the rename.
  const hookPort = process.env.FLOWBOARD_PORT || process.env.PORT || 18790;
  const onDoneHook = {
    url: `http://127.0.0.1:${hookPort}/api/hooks/task-complete`,
    headers: {},
  };

  _cacheDb        = datastore.cacheDb;
  _eventsDb       = datastore.eventsDb;
  _projectService = new ProjectService(datastore.cacheDb, _eventStore, _projectionEngine);
  _taskService    = new TaskService(datastore.cacheDb, _eventStore, _projectionEngine, _projectService, datastore.eventsDb, { onDone: onDoneHook });

  // Initialize HookDrainService for outbox processing
  _hookDrainService = new HookDrainService(datastore.cacheDb, {
    requestTimeoutMs: 5000,
    maxAttempts: 3,
  });

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

  // Load archived task IDs for duplicate detection (before building active cache)
  let archivedForDupCheck = [];
  try {
    archivedForDupCheck = _taskService.db.prepare(
      "SELECT task_id, project, metadata FROM tasks_current WHERE status = 'archived'"
    ).all().map(row => {
      try {
        const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {});
        return { task_id: row.task_id, project: row.project, metadata: meta };
      } catch { return null; }
    }).filter(Boolean);
  } catch (e) { console.warn('[hzl-service] archived dup-check query:', e.message); }

  // Check for duplicate flowboard.id values per project over ALL tasks (active + archived) — hard fail
  const seen = new Map();
  for (const t of [...allTasks, ...archivedForDupCheck]) {
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
  // Derive subtaskIds on read so push-update races (parent missing the
  // forward pointer after a subtask insert) cannot hide children. Full
  // cache abolition tracked in T-176.
  _populateSubtaskIds(tasks);
  return tasks;
}

/**
 * Get a single task by FlowBoard ID.
 */
function getTask(project, flowboardId, opts = {}) {
  const task = _cache.get(`${project}:${flowboardId}`);
  if (!task) return null;
  // Archived tasks are kept in cache for ID-reuse prevention but hidden by default
  if (!opts.includeArchived && task.status === 'archived') return null;
  return _publicTask(task);
}

function _publicTask(t) {
  // Return a copy without internal fields; ensure blocked is always present
  const { _ulid, _project, ...pub } = t;
  pub.blocked = pub.blocked === true;
  // Ensure claim/checkpoint fields are always present
  pub.agent = pub.agent || null;
  pub.claimedAt = pub.claimedAt || null;
  pub.leaseUntil = pub.leaseUntil || null;
  pub.lastCheckpointAt = pub.lastCheckpointAt || null;
  pub.checkpointCount = pub.checkpointCount || 0;
  pub.routedAgent = pub.routedAgent || null;
  pub.trashedAt = pub.trashedAt || null;
  return pub;
}

/**
 * Create a task and update cache.
 * opts: { title, priority?, parentId?, status? }
 * Returns FlowBoard-format task.
 */
function createTask(project, opts) {
  const { title, priority = 'medium', parentId = null, status = 'backlog', forceId = null } = opts;
  if (!VALID_STATUSES.has(status)) throw new Error(`Invalid status: "${status}". Must be one of: ${[...VALID_STATUSES].join(', ')}`);

  // Validate parent if provided
  if (parentId) {
    const parentUlid = _fbToUlid.get(`${project}:${parentId}`);
    if (!parentUlid) throw new Error(`Parent task not found: ${parentId}`);
    // Enforce max 1 nesting level — parent must not itself be a subtask
    const parentCached = _cache.get(`${project}:${parentId}`);
    if (parentCached && parentCached.parentId) throw new Error(`Cannot create subtask of subtask (max 1 nesting level): ${parentId} is already a subtask`);
  }

  // Generate or force FlowBoard ID
  let newId;
  if (forceId) {
    // Migration mode: use exact ID, check for duplicates
    if (_fbToUlid.has(`${project}:${forceId}`)) throw new Error(`Duplicate forceId: ${forceId}`);
    newId = forceId;
  } else if (parentId) {
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

  // If HZL created with a different status, force it — throw on failure to avoid inconsistent state
  if (hzlTask.status !== hzlStatus) {
    _taskService.setStatus(hzlTask.task_id, hzlStatus);
  }

  // Build FB task and add to cache
  const fbTask = {
    id: newId,
    title,
    status,
    blocked: false,
    priority,
    parentId,
    subtaskIds: [],
    specFile: null,
    created,
    completed: null,
    agent: null,
    claimedAt: null,
    leaseUntil: null,
    lastCheckpointAt: null,
    checkpointCount: 0,
    routedAgent: null,
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
    if (!VALID_STATUSES.has(updates.status)) throw new Error(`Invalid status: "${updates.status}". Must be one of: ${[...VALID_STATUSES].join(', ')}`);

    // Archive validation
    if (updates.status === 'archived') {
      // Subtasks cannot be archived individually — only via parent
      if (cached.parentId) throw new Error('Cannot archive subtasks individually. Archive the parent task instead.');
      if (cached.status !== 'done') throw new Error('Can only archive tasks with status "done"');
      // All children must be done (or already archived)
      if (cached.subtaskIds && cached.subtaskIds.length > 0) {
        const children = cached.subtaskIds.map(id => _cache.get(`${project}:${id}`)).filter(Boolean);
        const blocking = children.filter(c => c.status !== 'done' && c.status !== 'archived');
        if (blocking.length > 0) {
          throw new Error(`Cannot archive: ${blocking.length} subtask(s) not done (${blocking.map(c => c.id).join(', ')})`);
        }
        // Auto-archive all children
        for (const child of children) {
          if (child.status !== 'archived') {
            try { _archiveChild(project, child); } catch (e) { console.warn('[hzl-service] auto-archive child:', e.message); }
          }
        }
        cached.subtaskIds = [];
      }
    }

    // Restore from archived: auto-restore all children to done
    if (cached.status === 'archived' && updates.status !== 'archived') {
      const restoredChildIds = [];
      for (const [key, child] of _cache) {
        if (child._project === project && child.parentId === flowboardId && child.status === 'archived') {
          try {
            _restoreChild(project, child);
            restoredChildIds.push(child.id);
          } catch (e) { console.warn('[hzl-service] auto-restore child:', e.message); }
        }
      }
      if (restoredChildIds.length > 0) {
        cached.subtaskIds = restoredChildIds.sort((a, b) => {
          const na = parseInt(a.split('-').pop(), 10);
          const nb = parseInt(b.split('-').pop(), 10);
          return (isNaN(na) || isNaN(nb)) ? a.localeCompare(b) : na - nb;
        });
      }
    }

    metaUpdates.flowboard.status = updates.status;
    if (updates.status === 'done') {
      const completedDate = updates.completed || new Date().toISOString().slice(0, 10);
      metaUpdates.flowboard.completed = completedDate;
      updates.completed = completedDate; // ensure cache gets updated below
    } else if (updates.status !== 'done' && cached.status === 'done') {
      metaUpdates.flowboard.completed = null;
      updates.completed = null; // ensure cache gets updated below
    }
    // Clear blocked flag when moving to done or backlog (AD-5)
    if (updates.status === 'done' || updates.status === 'backlog') {
      metaUpdates.flowboard.blocked = false;
      updates.blocked = false;
    }
  }

  // Handle blocked flag update
  if (Object.prototype.hasOwnProperty.call(updates, 'blocked')) {
    metaUpdates.flowboard.blocked = updates.blocked === true;
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'completed')) {
    metaUpdates.flowboard.completed = updates.completed;
  }

  // T-161-4: trashedAt soft-delete pointer. ISO string to send to Trash,
  // null to restore. Does not touch HZL status — Trash state is orthogonal
  // to the operational status flow; a task's previous status is preserved
  // so Restore returns it to where it was.
  if (Object.prototype.hasOwnProperty.call(updates, 'trashedAt')) {
    metaUpdates.flowboard.trashedAt = updates.trashedAt || null;
  }

  // Write scalar updates (title, priority, etc.) via updateTask — metadata handled separately
  if (Object.keys(hzlUpdates).length > 0) {
    _taskService.updateTask(ulid, hzlUpdates);
  }

  // Update HZL native status FIRST — if this fails, metadata is NOT written
  if (updates.status !== undefined) {
    const targetHzlStatus = FB_TO_HZL[updates.status] || 'ready';
    if (cached.status === 'archived') {
      // hzl-core setStatus() rejects transitions from archived — emit StatusChanged directly
      const event = _eventStore.append({
        task_id: ulid,
        type: 'status_changed',
        data: { from: 'archived', to: targetHzlStatus },
      });
      _projectionEngine.applyEvent(event);
    } else {
      _taskService.setStatus(ulid, targetHzlStatus);
    }
  }

  // T-161-4: setting status to review or done implicitly releases an active
  // claim. The old UI had an explicit "Complete → Review" button that bundled
  // both operations; the redesigned panel drives this via the Status-Picker,
  // so the release must happen server-side.
  if (
    updates.status !== undefined &&
    (updates.status === 'review' || updates.status === 'done') &&
    cached.agent
  ) {
    // Mirror HZL's leave-in_progress semantics in the cache: claimed_at and
    // lease_until are cleared. This must happen UNCONDITIONALLY because the
    // setStatus call above already triggered HZL's projection to clear them
    // — even if the releaseTask call below throws (which it often does for
    // already-terminal tasks; that's the "that's fine" expected case).
    // Preserve cached.agent for historical attribution (T-161 soft chip).
    cached.claimedAt = null;
    cached.leaseUntil = null;
    metaUpdates.flowboard.lastCheckpointAt = null;
    try {
      _taskService.releaseTask(ulid, { agent_id: cached.agent, author: cached.agent });
    } catch (e) {
      // releaseTask can reject if lease already expired / no active claim; that's fine
      console.warn('[hzl-service] auto-release on status change:', e.message);
    }
  }

  // Write metadata via direct event emission (hzl-core updateTask ignores metadata)
  _updateMetadata(ulid, metaUpdates);

  // Update cache to reflect the orchestrator's intent (the explicit fields
  // in `updates`). After this loop, `cached` holds the dashboard's view of
  // truth — including any null-clears applied by the auto-release block
  // above (when transitioning to review/done).
  const ALLOWED = ['title', 'status', 'priority', 'specFile', 'completed', 'blocked', 'trashedAt', 'agent'];
  for (const key of ALLOWED) {
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      if (key === 'blocked') cached[key] = updates[key] === true;
      else if (key === 'trashedAt') cached[key] = updates[key] || null;
      else cached[key] = updates[key];
    }
  }

  // T-161 cache-projection sync (see helper docs near the top of the file):
  // 1. Push the dashboard's intent down to HZL's projection so HZL's auto-
  //    COALESCE side-effects on agent/claimed_at/lease_until are neutralized.
  // 2. Re-read the projection back into the cache so the return value
  //    matches the authoritative on-disk state.
  _alignProjectionToCache(ulid, cached);
  const refreshed = _resyncCachedTask(ulid);
  return _publicTask(refreshed || cached);
}

/**
 * T-161-4: Empty the Trash for a project — hard-delete every task whose
 * metadata.flowboard.trashedAt is set.
 *
 * Earlier versions of this function looped over `deleteTask(project, id,
 * 'all')`, which ends in `_taskService.archiveTask(ulid)`. Trashed tasks
 * are already `status='archived'` (that's how the delete→Trash flow
 * marks them), so archiveTask rejected every call with "Task is
 * already archived" and nothing actually got removed from the DB.
 *
 * Correct path: call hzl-core's internal `deleteTasksFromEvents` and
 * `deleteTasksFromProjections` directly. These are the same primitives
 * `pruneEligible` uses, but we feed them our own task-id list (the
 * trashed ones) instead of going through the age-gated prune query.
 * We wrap the calls in write transactions on the underlying better-
 * sqlite3 handles so we get the same locking behaviour prune uses.
 */
function emptyTrash(project) {
  const removed = [];
  const failed = [];

  const victims = []; // { id, ulid }
  for (const [key, cached] of _cache) {
    if (!key.startsWith(`${project}:`)) continue;
    if (!cached.trashedAt) continue;
    const ulid = _fbToUlid.get(`${project}:${cached.id}`);
    if (ulid) victims.push({ id: cached.id, ulid });
  }
  if (victims.length === 0) return { removed, failed };

  const taskIds = victims.map(v => v.ulid);
  const cacheDb = _taskService.db;
  const eventsDb = _taskService.eventsDb;

  try {
    if (!eventsDb || eventsDb === cacheDb) {
      // Single-DB mode: one transaction covers both tables.
      cacheDb.transaction(() => {
        _taskService.deleteTasksFromEvents(cacheDb, taskIds, 'main');
        _taskService.deleteTasksFromProjections(cacheDb, taskIds);
      }).immediate();
    } else {
      // Split-DB mode (FlowBoard default — cache.db + events.db): two
      // separate transactions, events first (source of truth) then the
      // projection cache. Mirrors pruneEligibleWithJournalFallback.
      eventsDb.transaction(() => {
        _taskService.deleteTasksFromEvents(eventsDb, taskIds, 'main');
      }).immediate();
      cacheDb.transaction(() => {
        _taskService.deleteTasksFromProjections(cacheDb, taskIds);
      }).immediate();
    }

    for (const { id, ulid } of victims) {
      _cache.delete(`${project}:${id}`);
      _ulidToFb.delete(ulid);
      // Note: _fbToUlid entry intentionally kept — _nextTaskId scans it
      // to prevent ID reuse of deleted tasks.
      removed.push(id);
    }
  } catch (err) {
    console.error('[emptyTrash]', err);
    failed.push({ error: err.message });
  }

  return { removed, failed };
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
          // Update metadata before archiving so status persists across restarts
          try {
            const subFull = _taskService.getTaskById(subUlid);
            const subMeta = { ...(subFull?.metadata || {}), flowboard: { ...(subFull?.metadata?.flowboard || {}), status: 'archived' } };
            _updateMetadata(subUlid, subMeta);
            _taskService.archiveTask(subUlid);
          } catch (e) { console.warn(e); }
          _ulidToFb.delete(subUlid); // Fix #5: clean up reverse map
        }
        _cache.delete(`${project}:${subId}`);
        // Note: _fbToUlid entry kept intentionally — _nextTaskId scans it to prevent ID reuse
      }
    } else if (mode === 'keep-children') {
      try { _taskService.orphanSubtasks(ulid); } catch (e) { console.warn('[hzl-service] orphanSubtasks:', e.message); }
      // Update metadata + RAM cache for each child so parentId=null survives restart
      for (const subId of cached.subtaskIds) {
        const subUlid = _fbToUlid.get(`${project}:${subId}`);
        if (subUlid) {
          try {
            const subFull = _taskService.getTaskById(subUlid);
            if (subFull) {
              const subMeta = { ...(subFull.metadata || {}), flowboard: { ...(subFull.metadata?.flowboard || {}), parentId: null } };
              _updateMetadata(subUlid, subMeta);
            }
          } catch (e) { console.warn('[hzl-service] orphan metadata update:', e.message); }
        }
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

  // Update metadata before archiving so status persists across restarts
  try {
    const currentFull = _taskService.getTaskById(ulid);
    const archiveMeta = { ...(currentFull?.metadata || {}), flowboard: { ...(currentFull?.metadata?.flowboard || {}), status: 'archived' } };
    _updateMetadata(ulid, archiveMeta);
  } catch (e) { console.warn('[hzl-service] metadata update before archive:', e.message); }
  // If archiveTask throws, do NOT touch cache/maps — task is still in DB
  _taskService.archiveTask(ulid);
  _cache.delete(`${project}:${flowboardId}`);
  // Note: _fbToUlid entry kept intentionally — _nextTaskId scans it to prevent ID reuse
  _ulidToFb.delete(ulid);

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
  const counts = { backlog: 0, open: 0, 'in-progress': 0, review: 0, done: 0, archived: 0 };
  let blockedCount = 0;
  for (const t of tasks) {
    if (counts[t.status] !== undefined) counts[t.status]++;
    if (t.blocked) blockedCount++;
  }
  const parts = [];
  if (counts.backlog)        parts.push(`${counts.backlog} backlog`);
  if (counts.open)           parts.push(`${counts.open} open`);
  if (counts['in-progress']) parts.push(`${counts['in-progress']} in-progress`);
  if (counts.review)         parts.push(`${counts.review} review`);
  if (blockedCount)          parts.push(`${blockedCount} blocked`);
  if (counts.done)           parts.push(`${counts.done} done`);
  if (counts.archived)       parts.push(`${counts.archived} archived`);
  return parts.join(', ') || 'no tasks';
}

/**
 * Get task counts per status for the project list sidebar.
 */
function getTaskCounts(project) {
  const counts = { open: 0, 'in-progress': 0, review: 0, done: 0, backlog: 0, archived: 0, blocked: 0 };
  for (const [key, task] of _cache) {
    if (!key.startsWith(`${project}:`)) continue;
    if (task.parentId) continue; // top-level only for badge counts
    // blocked tasks count in their base lane
    if (counts[task.status] !== undefined) counts[task.status]++;
    if (task.blocked) counts.blocked++;
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
  // Scan both cache (live) and _fbToUlid (includes archived/deleted) to prevent ID reuse
  const prefix = `${project}:${parentId}-`;
  let maxNum = 0;
  for (const key of _cache.keys()) {
    if (!key.startsWith(prefix)) continue;
    const suffix = key.slice(prefix.length);
    const n = parseInt(suffix, 10);
    if (!isNaN(n) && n > maxNum) maxNum = n;
  }
  for (const key of _fbToUlid.keys()) {
    if (!key.startsWith(prefix)) continue;
    const suffix = key.slice(prefix.length);
    const n = parseInt(suffix, 10);
    if (!isNaN(n) && n > maxNum) maxNum = n;
  }
  return `${parentId}-${maxNum + 1}`;
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
  } else if (!anyStarted && (parent.status === 'in-progress' || parent.status === 'review')) {
    // Demotion: all subtasks back to open/backlog
    // If all subtasks are backlog (none open), parent reverts to backlog; otherwise open
    const allSubtasksBacklog = subtasks.every(t => t.status === 'backlog');
    newStatus = allSubtasksBacklog ? 'backlog' : 'open';
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

/**
 * Explicitly create a HZL project. Throws if project already exists or if not initialized.
 * Used by project-lifecycle.js for canonical project creation (T-131-6).
 * @param {string} name
 * @param {string|null} description
 */
function createProject(name, description) {
  if (!_projectService) throw new Error('[hzl-service] Not initialized — call init() first');
  _projectService.createProject(name, description ? { description } : undefined);
}

// =============================================================================
// Phase 5: Coordination Primitives (T-128)
// Uses hzl-core native claim/release/complete/checkpoint/comment APIs
// =============================================================================

/**
 * Claim a task for an agent with a lease.
 * Uses hzl-core native claimTask() which handles atomic status transitions.
 * @param {string} project
 * @param {string} flowboardId
 * @param {object} opts - { agent: string, lease?: number (minutes, default 30) }
 */
function claimTask(project, flowboardId, opts) {
  const { agent, lease = 30 } = opts;
  if (!agent) throw new Error('Agent name is required');

  const ulid = _fbToUlid.get(`${project}:${flowboardId}`);
  if (!ulid) throw new Error(`Task not found: ${flowboardId}`);

  const cached = _cache.get(`${project}:${flowboardId}`);
  if (!cached) throw new Error(`Task not found in cache: ${flowboardId}`);

  // Validation: Parent tasks (with subtasks) are not claimable
  if (cached.subtaskIds && cached.subtaskIds.length > 0) {
    throw Object.assign(new Error('Cannot claim parent task — claim subtasks instead'), { code: 'PARENT_NOT_CLAIMABLE' });
  }

  // Validation: Agent routing enforcement
  if (cached.routedAgent && cached.routedAgent !== agent) {
    throw Object.assign(new Error(`Task is routed to agent "${cached.routedAgent}", not "${agent}"`), { code: 'ROUTING_MISMATCH' });
  }

  // Validation: Status must be claimable
  const CLAIMABLE_STATUSES = new Set(['open', 'in-progress', 'backlog']);
  if (!CLAIMABLE_STATUSES.has(cached.status)) {
    throw Object.assign(new Error(`Cannot claim task in status "${cached.status}"`), { code: 'NOT_CLAIMABLE' });
  }

  // Validation: Lease must be positive finite number (minutes)
  if (typeof lease !== 'number' || !Number.isFinite(lease) || lease <= 0) {
    throw Object.assign(new Error('Lease must be a positive number of minutes'), { code: 'INVALID_LEASE' });
  }
  const clampedLease = Math.min(Math.max(lease, 1), 1440); // 1min..24h

  // Validation: Already actively claimed by another agent — allow re-claim
  // only if lease expired or there's no active claim. With T-161's soft-chip
  // semantic, `agent` may be set as historical attribution while
  // `claimed_at` is null (released task, owner preserved for "Last worked
  // by X"). A null claimed_at means the claim is no longer active and a
  // fresh agent can pick the task up.
  const hzlTask = _taskService.getTaskById(ulid);
  if (hzlTask && hzlTask.agent && hzlTask.agent !== agent && hzlTask.status === 'in_progress') {
    const hasActiveClaim = !!hzlTask.claimed_at;
    const leaseExpired = hzlTask.lease_until && new Date(hzlTask.lease_until).getTime() < Date.now();
    if (hasActiveClaim && !leaseExpired) {
      throw Object.assign(new Error(`Task already claimed by "${hzlTask.agent}"`), { code: 'ALREADY_CLAIMED' });
    }
    // Either no active claim (claimed_at=null, just historical attribution)
    // or lease expired — allow re-claim (steal).
  }

  // Calculate lease_until ISO timestamp
  const leaseUntil = new Date(Date.now() + clampedLease * 60 * 1000).toISOString();

  // Use hzl-core native claimTask
  const result = _taskService.claimTask(ulid, {
    agent_id: agent,
    author: agent,
    lease_until: leaseUntil,
  });

  // Update FlowBoard metadata
  const meta = {
    flowboard: {
      ...(result.metadata?.flowboard || {}),
      status: 'in-progress',
      previousStatus: cached.status, // remember for release rollback
      lastCheckpointAt: new Date().toISOString(), // claim starts the stale timer
    }
  };
  _updateMetadata(ulid, meta);

  // Update RAM cache
  cached.status = 'in-progress';
  cached.agent = agent;
  cached.claimedAt = result.claimed_at || new Date().toISOString();
  cached.leaseUntil = leaseUntil;
  cached.lastCheckpointAt = meta.flowboard.lastCheckpointAt;

  // Cache-projection sync: HZL's claimTask is authoritative. Re-read so the
  // return value matches projection truth (and any HZL field we didn't patch
  // incrementally above gets surfaced).
  const refreshed = _resyncCachedTask(ulid);
  return _publicTask(refreshed || cached);
}

/**
 * Release a claimed task.
 * Uses hzl-core native releaseTask() which transitions in_progress → ready.
 */
function releaseTask(project, flowboardId, opts = {}) {
  const { agent, force = false } = opts;

  const ulid = _fbToUlid.get(`${project}:${flowboardId}`);
  if (!ulid) throw new Error(`Task not found: ${flowboardId}`);

  const cached = _cache.get(`${project}:${flowboardId}`);
  if (!cached) throw new Error(`Task not found in cache: ${flowboardId}`);

  // Only owning agent or force can release
  if (!force && agent && cached.agent && cached.agent !== agent) {
    throw Object.assign(new Error(`Only the owning agent "${cached.agent}" can release (or use force=true)`), { code: 'NOT_OWNER' });
  }

  // Gracefully handle obsolete 'ready' status (data inconsistency from old HZL versions)
  if (cached.status === 'ready') {
    cached.agent = null;
    cached.claimedAt = null;
    cached.leaseUntil = null;
    cached.lastCheckpointAt = null;
    cached.status = 'open';
    const hzlTask = _taskService.getTaskById(ulid);
    if (hzlTask) {
      const fb = hzlTask.metadata?.flowboard || {};
      _updateMetadata(ulid, { flowboard: { ...fb, status: 'open' } });
    }
    return { ok: true };
  }

  // Use hzl-core native releaseTask
  _taskService.releaseTask(ulid, { agent_id: agent, author: agent });

  // Update FlowBoard metadata — restore previous status (default to 'open')
  const hzlTask = _taskService.getTaskById(ulid);
  const fb = hzlTask?.metadata?.flowboard || {};
  const restoreStatus = fb.previousStatus || 'open';
  const meta = {
    flowboard: {
      ...fb,
      status: restoreStatus,
      previousStatus: null, // clear
    }
  };
  _updateMetadata(ulid, meta);

  // Update RAM cache. Preserve cached.agent for historical attribution
  // (mirrors HZL's projection behaviour — see comment in updateTask's
  // auto-release block).
  cached.status = restoreStatus;
  cached.claimedAt = null;
  cached.leaseUntil = null;
  cached.lastCheckpointAt = null;

  // Cache-projection sync after release.
  _resyncCachedTask(ulid);
  return { ok: true };
}

/**
 * Complete a task (agent says "done implementing").
 * Uses hzl-core native completeTask() which transitions in_progress/blocked → done.
 * FlowBoard maps this to "review" status (human approval comes later).
 */
function completeTask(project, flowboardId, opts = {}) {
  const { agent } = opts;

  const ulid = _fbToUlid.get(`${project}:${flowboardId}`);
  if (!ulid) throw new Error(`Task not found: ${flowboardId}`);

  const cached = _cache.get(`${project}:${flowboardId}`);
  if (!cached) throw new Error(`Task not found in cache: ${flowboardId}`);

  // Owner check: if task is claimed, only the owning agent can complete
  if (cached.agent) {
    if (!agent) throw Object.assign(new Error('Agent is required to complete a claimed task'), { code: 'AGENT_REQUIRED' });
    if (cached.agent !== agent) throw Object.assign(new Error(`Only the owning agent "${cached.agent}" can complete`), { code: 'NOT_OWNER' });
  }

  // Use hzl-core native completeTask (validates status transition)
  _taskService.completeTask(ulid, { agent_id: agent, author: agent });

  // Update FlowBoard metadata — "review" not "done" (human approval needed)
  const completedDate = new Date().toISOString().slice(0, 10);
  const hzlTask = _taskService.getTaskById(ulid);
  const meta = {
    flowboard: {
      ...(hzlTask?.metadata?.flowboard || {}),
      status: 'review',
      completed: completedDate,
    }
  };
  _updateMetadata(ulid, meta);

  // Update RAM cache. Preserve cached.agent for historical attribution
  // (the soft-chip "Done by X" relies on agent staying set after complete).
  const completingAgent = cached.agent;
  cached.status = 'review';
  cached.completed = completedDate;
  cached.claimedAt = null;
  cached.leaseUntil = null;

  // Fire completion callback (for notifications)
  if (_onCompleteCallback) {
    try {
      _onCompleteCallback({
        project,
        taskId: flowboardId,
        title: cached.title,
        agent: completingAgent || agent,
      });
    } catch (e) { console.warn('[hzl-service] onComplete callback error:', e.message); }
  }

  // Cache-projection sync after complete. Pushes cache.agent=null down to
  // HZL's projection (HZL preserves agent on leave-in_progress); then
  // re-reads to confirm consistency. Without this, the projection still
  // shows agent='main' while the cache says null — the same drift class
  // as the T-006 bug.
  _alignProjectionToCache(ulid, cached);
  const refreshed = _resyncCachedTask(ulid);
  return _publicTask(refreshed || cached);
}

/**
 * Add a checkpoint to a task.
 * Uses hzl-core native addCheckpoint().
 */
function addCheckpoint(project, flowboardId, opts) {
  const { message, agent, progress } = opts;
  if (!message) throw new Error('Checkpoint message is required');

  const ulid = _fbToUlid.get(`${project}:${flowboardId}`);
  if (!ulid) throw new Error(`Task not found: ${flowboardId}`);

  const cached = _cache.get(`${project}:${flowboardId}`);
  if (!cached) throw new Error(`Task not found in cache: ${flowboardId}`);

  // Owner check: only the claiming agent can checkpoint (prevents lease hijacking)
  if (cached.agent && agent && cached.agent !== agent) {
    throw Object.assign(new Error(`Only the owning agent "${cached.agent}" can checkpoint`), { code: 'NOT_OWNER' });
  }

  // Use hzl-core native addCheckpoint (name=message, data={})
  const result = _taskService.addCheckpoint(ulid, message, {}, {
    agent_id: agent,
    author: agent,
    ...(progress !== undefined ? { progress } : {}),
  });

  // Update lastCheckpointAt in FlowBoard metadata
  const now = new Date().toISOString();
  const hzlTask = _taskService.getTaskById(ulid);
  const fb = hzlTask?.metadata?.flowboard || {};
  const meta = {
    flowboard: {
      ...fb,
      lastCheckpointAt: now,
      checkpointCount: (fb.checkpointCount || 0) + 1,
    }
  };
  _updateMetadata(ulid, meta);

  // Update RAM cache
  cached.lastCheckpointAt = now;
  cached.checkpointCount = meta.flowboard.checkpointCount;

  return {
    id: result.event_rowid,
    taskId: flowboardId,
    message,
    agent: agent || null,
    timestamp: result.timestamp,
  };
}

/**
 * Get all checkpoints for a task.
 * Uses hzl-core native getCheckpoints().
 */
function getCheckpoints(project, flowboardId) {
  const ulid = _fbToUlid.get(`${project}:${flowboardId}`);
  if (!ulid) throw new Error(`Task not found: ${flowboardId}`);

  const rows = _taskService.getCheckpoints(ulid);
  return rows.map(r => ({
    id: r.event_rowid,
    taskId: flowboardId,
    message: r.name,
    data: r.data,
    timestamp: r.timestamp,
  }));
}

/**
 * Add a comment to a task.
 * Uses hzl-core native addComment().
 */
function addComment(project, flowboardId, opts) {
  const { message, author } = opts;
  if (!message) throw new Error('Comment message is required');

  const ulid = _fbToUlid.get(`${project}:${flowboardId}`);
  if (!ulid) throw new Error(`Task not found: ${flowboardId}`);

  const result = _taskService.addComment(ulid, message, {
    author: author || null,
  });

  return {
    id: result.event_rowid,
    taskId: flowboardId,
    message,
    author: author || null,
    timestamp: result.timestamp,
  };
}

/**
 * Get all comments for a task.
 * Uses hzl-core native getComments().
 */
function getComments(project, flowboardId) {
  const ulid = _fbToUlid.get(`${project}:${flowboardId}`);
  if (!ulid) throw new Error(`Task not found: ${flowboardId}`);

  const rows = _taskService.getComments(ulid);
  return rows.map(r => ({
    id: r.event_rowid,
    taskId: flowboardId,
    message: r.text,
    author: r.author || r.agent_id || null,
    timestamp: r.timestamp,
  }));
}

/**
 * T-161-4: Get the status-event timeline for a task. Pulls from the
 * hzl-core event store and filters to the types that make sense as
 * "status events" in the UI — explicitly excluding `comment_added`
 * and `checkpoint_recorded` because those have their own endpoints
 * and panel renderers.
 *
 * Returns a normalized shape the DetailPanel merges into the Activity
 * Feed alongside comments and checkpoints:
 *   { type: 'status', event: '<hzl type>', message, agent, timestamp }
 *
 * `message` is a pre-rendered human-readable summary so the frontend
 * doesn't need to know every HZL event payload shape. For unknown
 * event types it falls back to the raw type name, which keeps the
 * feed usable even if hzl-core adds new events we haven't mapped yet.
 */
function getStatusEvents(project, flowboardId) {
  const ulid = _fbToUlid.get(`${project}:${flowboardId}`);
  if (!ulid) throw new Error(`Task not found: ${flowboardId}`);

  const raw = _eventStore.getByTaskId(ulid);
  const out = [];
  for (const ev of raw) {
    // Skip the two event types that already surface via their own
    // endpoints — we don't want them duplicated in the Activity Feed.
    if (ev.type === 'comment_added' || ev.type === 'checkpoint_recorded') continue;

    const data = (typeof ev.data === 'string') ? safeJson(ev.data) : (ev.data || {});
    const message = renderStatusEventMessage(ev.type, data);
    if (!message) continue; // skip events with no user-visible meaning

    out.push({
      type: 'status',
      event: ev.type,
      message,
      agent: ev.author || ev.agent_id || null,
      timestamp: ev.timestamp,
    });
  }
  return out;
}

function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }

// HZL-native status names → FlowBoard-UI names. Internally HZL uses
// `ready` and `in_progress`; FlowBoard surfaces those as `open` and
// `in-progress`. Keep the feed consistent with what the user clicks.
function hzlStatusLabel(s) {
  if (s === 'ready') return 'open';
  if (s === 'in_progress') return 'in-progress';
  return s;
}

function renderStatusEventMessage(type, data) {
  switch (type) {
    case 'task_created':
      return 'Created';
    case 'status_changed': {
      const from = hzlStatusLabel(data.from) || '?';
      const to = hzlStatusLabel(data.to) || '?';
      return `Status: ${from} -> ${to}`;
    }
    case 'task_archived':
      return 'Archived';
    case 'dependency_added':
      return data.blocker_task_id ? `Blocked by ${data.blocker_task_id}` : 'Dependency added';
    case 'dependency_removed':
      return data.blocker_task_id ? `No longer blocked by ${data.blocker_task_id}` : 'Dependency removed';
    case 'task_moved':
      return data.to_project ? `Moved to project ${data.to_project}` : 'Moved';
    case 'task_updated': {
      // Real payload shape (hzl-core): { field, old_value, new_value }.
      // For metadata changes we diff old vs new to identify which
      // FlowBoard fields mutated and narrate only those. Anything else
      // (completed, lastCheckpointAt, etc.) is swallowed — we don't want
      // every bookkeeping update spamming the Activity Feed.
      if (data.field !== 'metadata') return null;
      const oldFb = data.old_value?.flowboard || {};
      const newFb = data.new_value?.flowboard || {};
      const parts = [];
      if (newFb.blocked !== oldFb.blocked) {
        parts.push(newFb.blocked ? 'Blocked' : 'Unblocked');
      }
      if (newFb.routedAgent !== oldFb.routedAgent) {
        parts.push(newFb.routedAgent ? `Routed to ${newFb.routedAgent}` : 'Route cleared');
      }
      if (newFb.trashedAt !== oldFb.trashedAt) {
        parts.push(newFb.trashedAt ? 'Moved to Trash' : 'Restored from Trash');
      }
      if (parts.length === 0) return null;
      return parts.join(', ');
    }
    default:
      return null; // swallow event types we don't want to show
  }
}

/**
 * Get stuck tasks (stale + expired leases) across all projects.
 * Stale = in_progress + lastCheckpointAt older than threshold.
 * Expired = leaseUntil in the past.
 * Returns combined list with reason field.
 */
function getStuckTasks(opts = {}) {
  const staleThreshold = opts.staleThreshold !== undefined ? opts.staleThreshold : 10; // minutes
  const now = Date.now();
  const stuck = [];

  for (const [key, task] of _cache) {
    if (task.status !== 'in-progress') continue;
    if (task.status === 'archived') continue;

    const entry = {
      project: task._project,
      taskId: task.id,
      title: task.title,
      agent: task.agent || null,
      status: task.status,
    };

    // Check stale (no checkpoint for > threshold minutes)
    if (task.lastCheckpointAt) {
      const lastCp = new Date(task.lastCheckpointAt).getTime();
      const staleMs = now - lastCp;
      if (staleMs > staleThreshold * 60 * 1000) {
        stuck.push({
          ...entry,
          reason: 'stale',
          lastCheckpointAt: task.lastCheckpointAt,
          staleMinutes: Math.floor(staleMs / 60000),
        });
        continue; // Don't double-list as stale AND expired
      }
    }

    // Check expired lease
    if (task.leaseUntil) {
      const leaseEnd = new Date(task.leaseUntil).getTime();
      if (leaseEnd < now) {
        stuck.push({
          ...entry,
          reason: 'expired',
          leaseUntil: task.leaseUntil,
          expiredMinutes: Math.floor((now - leaseEnd) / 60000),
        });
      }
    }
  }

  return stuck;
}

/**
 * Get handoff context for spawning a CC/ACP session.
 * Assembles spec, repo path, CLAUDE.md, constraints, and recent checkpoints.
 */
function getHandoffContext(project, flowboardId) {
  const cached = _cache.get(`${project}:${flowboardId}`);
  if (!cached) throw new Error(`Task not found: ${flowboardId}`);

  const projectDir = path.join(PROJECTS_DIR, project);
  let spec = null;
  let repo = null;
  let claudeMd = null;
  const constraints = [];

  // Read spec file (with path traversal guard)
  if (cached.specFile) {
    const specPath = path.resolve(projectDir, cached.specFile);
    if (specPath.startsWith(projectDir + path.sep)) {
      try { spec = fs.readFileSync(specPath, 'utf8'); } catch { /* graceful */ }
    }
  }

  // Read PROJECT.md for repo path
  const projectMdPath = path.join(projectDir, 'PROJECT.md');
  try {
    const projectMd = fs.readFileSync(projectMdPath, 'utf8');
    // Extract repo path from "## Git Repositories" section
    const repoMatch = projectMd.match(/(?:Repo|Repository|Git)[:\s]+[`"]?([~/][^\s`"]+)/i);
    if (repoMatch) {
      repo = repoMatch[1].replace('~', process.env.HOME || '/home/jetson');
    }

    // Extract constraints
    const constraintMatch = projectMd.match(/## Constraints\n([\s\S]*?)(?=\n## |\n---|\Z)/);
    if (constraintMatch) {
      constraintMatch[1].split('\n').filter(l => l.trim().startsWith('-')).forEach(l => {
        constraints.push(l.trim().replace(/^-\s*/, ''));
      });
    }
  } catch { /* graceful */ }

  // Read CLAUDE.md from repo
  if (repo) {
    const claudePath = path.join(repo, 'CLAUDE.md');
    try { claudeMd = fs.readFileSync(claudePath, 'utf8'); } catch { /* graceful */ }
  }

  // Get recent checkpoints
  let checkpoints = [];
  try { checkpoints = getCheckpoints(project, flowboardId); } catch { /* graceful */ }

  return {
    spec,
    repo,
    claudeMd,
    constraints: constraints.length > 0 ? constraints : null,
    taskId: flowboardId,
    project,
    checkpoints: checkpoints.length > 0 ? checkpoints : null,
  };
}

/**
 * Route a task to a specific agent.
 * Sets metadata.flowboard.routedAgent — enforced by claimTask().
 */
function routeTask(project, flowboardId, agent) {
  const ulid = _fbToUlid.get(`${project}:${flowboardId}`);
  if (!ulid) throw new Error(`Task not found: ${flowboardId}`);

  const cached = _cache.get(`${project}:${flowboardId}`);
  if (!cached) throw new Error(`Task not found in cache: ${flowboardId}`);

  const hzlTask = _taskService.getTaskById(ulid);
  const meta = {
    flowboard: {
      ...(hzlTask?.metadata?.flowboard || {}),
      routedAgent: agent || null,
    }
  };
  _updateMetadata(ulid, meta);

  // Also set hzl-core native agent field for claimNext routing
  _taskService.updateTask(ulid, { assignee: agent || null });

  cached.routedAgent = agent || null;
  return _publicTask(cached);
}

/** Set the completion notification callback */
function setOnComplete(fn) { _onCompleteCallback = fn; }

/** Drain pending hook_outbox entries (call periodically from server.js) */
async function drainHooks() {
  if (!_hookDrainService) return { delivered: 0 };
  return _hookDrainService.drain();
}

/** Returns total number of tasks in RAM cache (all projects, incl. archived). */
function getCacheSize() { return _cache.size; }

/** Returns the better-sqlite3 handle to the HZL cache DB. Used by flowboard-metadata. */
function getCacheDb() { return _cacheDb; }

/** Returns the better-sqlite3 handle to the HZL events DB. Used by integrity checks. */
function getEventsDb() { return _eventsDb; }

/** Returns HZL native project list: [{ name, description, is_protected, created_at }] */
function listHzlProjects() {
  if (!_projectService) throw new Error('[hzl-service] Not initialized — call init() first');
  return _projectService.listProjects();
}

/**
 * List all tasks actively claimed by a given agent across all projects.
 * "Actively claimed" = task.agent === agentId AND task.claimedAt is set
 * AND task is not archived. Status is irrelevant (in-progress/review/etc.
 * all valid as long as claim is active). Used by DELETE /api/agents/:id
 * to gate agent removal on outstanding work. T-180.
 */
function listTasksClaimedBy(agentId) {
  const out = [];
  if (!agentId) return out;
  for (const [, task] of _cache) {
    if (task.agent !== agentId) continue;
    if (!task.claimedAt) continue;
    if (task.status === 'archived') continue;
    out.push({
      project: task._project,
      id: task.id,
      title: task.title,
      status: task.status,
      claimedAt: task.claimedAt,
      leaseUntil: task.leaseUntil,
    });
  }
  return out;
}

module.exports = {
  init,
  rebuildCache,
  listTasks,
  getTask,
  createTask,
  updateTask,
  emptyTrash,
  deleteTask,
  getTaskSummary,
  getTaskCounts,
  setSpecLink,
  getSpecsIndex,
  recalcParentStatus,
  ensureProject,
  createProject,
  getCacheSize,
  // Phase 5: Coordination primitives
  claimTask,
  releaseTask,
  completeTask,
  addCheckpoint,
  getCheckpoints,
  getStatusEvents,
  addComment,
  getComments,
  getStuckTasks,
  getHandoffContext,
  routeTask,
  setOnComplete,
  drainHooks,
  getCacheDb,
  getEventsDb,
  listHzlProjects,
  listTasksClaimedBy,
};
