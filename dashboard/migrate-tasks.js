'use strict';

/**
 * migrate-tasks.js — One-shot migration: tasks.json → HZL
 *
 * Usage:
 *   node dashboard/migrate-tasks.js [--execute] [--project <name>]
 *
 * Dry-run by default. Pass --execute to actually write to HZL.
 *
 * Notes:
 *   - Idempotent: tasks already in HZL are skipped.
 *   - ID order is enforced so _nextTaskId()/_nextSubtaskId() assigns correct IDs.
 *   - ID mismatch aborts the migration for that project.
 *   - specFile links are written via setSpecLink() (updates specs/_index.json).
 *   - `created` dates are preserved via direct hzl-core event emission after
 *     createTask (which always sets created=today). `completed` is set via updateTask.
 */

const path = require('path');
const fs   = require('fs');

// --- Config ---
// Match server.js: OPENCLAW_WORKSPACE env or parent of dashboard dir
const WORKSPACE    = process.env.OPENCLAW_WORKSPACE || path.resolve(__dirname, '..');
const PROJECTS_DIR = path.join(WORKSPACE, 'projects');
const HZL_DB_PATH  = process.env.HZL_DB_PATH || path.join(WORKSPACE, '.hzl', 'flowboard.db');

// --- Args ---
const args          = process.argv.slice(2);
const DRY_RUN       = !args.includes('--execute');
const projectFilter = (() => {
  const i = args.indexOf('--project');
  return i >= 0 ? args[i + 1] : null;
})();

// --- Helpers ---

function isSubtask(id) {
  return /^T-\d+-\d+$/.test(id);
}

function parentOf(id) {
  // T-105-2 → T-105
  return id.replace(/-\d+$/, '');
}

/** Sort key: T-042 → 42000, T-042-3 → 42003 (parents always before their subtasks) */
function sortKey(id) {
  const m = id.match(/^T-(\d+)(?:-(\d+))?$/);
  if (!m) return 0;
  return parseInt(m[1], 10) * 10000 + (m[2] ? parseInt(m[2], 10) : 0);
}

function readTasksJson(projectName) {
  const p = path.join(PROJECTS_DIR, projectName, 'tasks.json');
  if (!fs.existsSync(p)) return null;
  try {
    const { tasks } = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(tasks) ? tasks : [];
  } catch (e) {
    throw new Error(`Failed to parse tasks.json for ${projectName}: ${e.message}`);
  }
}

// --- Core init (separate connection for created-date patching) ---
// After hzl-service.init() we open a second hzl-core connection to the same
// DB so we can emit a metadata-fix event that preserves the original `created`
// date. Both connections share the same WAL-mode SQLite files; better-sqlite3
// serialises writes so this is safe in a single-process sequential script.

let _coreDb        = null; // cache DB connection (better-sqlite3)
let _coreEventStore = null;
let _coreProjEngine = null;
let _coreEventType  = null;

async function initCore(dbPath) {
  const { createDatastore }       = await import('hzl-core/db/datastore.js');
  const { EventStore }            = await import('hzl-core/events/store.js');
  const { EventType }             = await import('hzl-core/events/types.js');
  const { ProjectionEngine }      = await import('hzl-core/projections/engine.js');
  const { TasksCurrentProjector } = await import('hzl-core/projections/tasks-current.js');

  const cacheDbPath = dbPath.replace(/\.db$/, '-cache.db');
  const ds = createDatastore({
    events: { path: dbPath },
    cache:  { path: cacheDbPath },
  });

  _coreEventStore = new EventStore(ds.eventsDb);
  _coreProjEngine = new ProjectionEngine(ds.cacheDb, ds.eventsDb);
  _coreProjEngine.register(new TasksCurrentProjector());
  _coreDb        = ds.cacheDb;
  _coreEventType = EventType;
}

/**
 * Patch the `created` field in metadata for a just-created task.
 * Finds the ULID by querying the cache DB for the given project+flowboardId,
 * then emits a TaskUpdated event with the corrected metadata.
 */
function patchCreatedDate(project, flowboardId, originalCreated) {
  if (!originalCreated || !_coreDb) return;

  // Find the task in the cache DB
  let row;
  try {
    const rows = _coreDb.prepare(
      "SELECT task_id, metadata FROM tasks_current WHERE project = ?"
    ).all(project);
    row = rows.find(r => {
      try {
        const m = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata || {});
        return m?.flowboard?.id === flowboardId;
      } catch { return false; }
    });
  } catch (e) {
    console.warn(`  [warn] patchCreatedDate query failed for ${flowboardId}: ${e.message}`);
    return;
  }

  if (!row) {
    console.warn(`  [warn] patchCreatedDate: task ${flowboardId} not found in cache`);
    return;
  }

  let meta;
  try {
    meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {});
  } catch { return; }

  if (meta?.flowboard?.created === originalCreated) return; // already correct

  const newMeta = { ...meta, flowboard: { ...meta.flowboard, created: originalCreated } };
  try {
    const event = _coreEventStore.append({
      task_id: row.task_id,
      type: _coreEventType.TaskUpdated,
      data: { field: 'metadata', old_value: meta, new_value: newMeta },
    });
    _coreProjEngine.applyEvent(event);
  } catch (e) {
    console.warn(`  [warn] patchCreatedDate event failed for ${flowboardId}: ${e.message}`);
  }
}

// --- Migration ---

async function migrateProject(hzl, projectName) {
  const tasks = readTasksJson(projectName);
  if (tasks === null) return null;
  if (tasks.length === 0) return { created: 0, skipped: 0, errors: [] };

  // Sort: T-001 < T-002 < T-005-1 < T-005-2, parents always before subtasks
  const sorted = [...tasks].sort((a, b) => sortKey(a.id) - sortKey(b.id));

  const stats = { created: 0, skipped: 0, errors: [] };

  if (DRY_RUN) {
    for (const task of sorted) {
      const sub = isSubtask(task.id);
      console.log(
        `  [dry-run] ${task.id}: "${task.title}"` +
        ` (${task.status || 'open'}, ${task.priority || 'medium'})` +
        (sub ? ` → subtask of ${parentOf(task.id)}` : '') +
        (task.specFile ? ` [spec]` : '') +
        (task.completed ? ` [completed: ${task.completed}]` : '')
      );
      stats.created++;
    }
    return stats;
  }

  // --execute mode
  for (const task of sorted) {
    // Idempotency: skip if already in HZL
    const existing = hzl.getTask(projectName, task.id, { includeArchived: true });
    if (existing) {
      console.log(`  SKIP  ${task.id} (already exists)`);
      stats.skipped++;
      continue;
    }

    try {
      const parentId = isSubtask(task.id) ? parentOf(task.id) : null;
      const status   = task.status   || 'open';
      const priority = task.priority || 'medium';

      const created = hzl.createTask(projectName, {
        title:    task.title,
        priority,
        parentId,
        status,
      });

      // Verify assigned ID matches expected
      if (created.id !== task.id) {
        throw new Error(`ID mismatch: expected ${task.id}, got ${created.id} — aborting project`);
      }

      // Preserve original created date (createTask always uses today)
      if (task.created && task.created !== created.created) {
        patchCreatedDate(projectName, task.id, task.created);
      }

      // Preserve completed date
      if (task.completed) {
        hzl.updateTask(projectName, task.id, { completed: task.completed });
      }

      // Preserve spec link
      if (task.specFile) {
        hzl.setSpecLink(projectName, task.id, task.specFile);
      }

      console.log(`  CREATE ${task.id}: "${task.title}"`);
      stats.created++;
    } catch (e) {
      console.error(`  ERROR ${task.id}: ${e.message}`);
      stats.errors.push(`${task.id}: ${e.message}`);
      if (e.message.includes('ID mismatch') || e.message.includes('aborting project')) {
        throw e; // abort project on ID mismatch
      }
    }
  }

  return stats;
}

// --- Main ---

async function main() {
  console.log(`=== FlowBoard → HZL Migration ===`);
  console.log(`Mode:      ${DRY_RUN ? 'DRY-RUN (pass --execute to write)' : 'EXECUTE'}`);
  console.log(`DB path:   ${HZL_DB_PATH}`);
  console.log(`Projects:  ${projectFilter || 'all'}`);
  console.log('');

  // Discover projects
  let projects;
  if (projectFilter) {
    projects = [projectFilter];
  } else {
    projects = fs.readdirSync(PROJECTS_DIR)
      .filter(name => {
        const p = path.join(PROJECTS_DIR, name);
        return fs.statSync(p).isDirectory() &&
               fs.existsSync(path.join(p, 'tasks.json'));
      })
      .sort();
  }

  // Init HZL (only needed for --execute)
  let hzl = null;
  if (!DRY_RUN) {
    console.log('Initializing HZL service...');
    hzl = require('./hzl-service');
    await hzl.init(HZL_DB_PATH);
    console.log('Initializing hzl-core (for created-date patching)...');
    try {
      await initCore(HZL_DB_PATH);
    } catch (e) {
      console.warn(`[warn] Core init failed — created dates will not be patched: ${e.message}`);
    }
    console.log('');
  }

  // Migrate each project
  const summary = {};
  for (const projectName of projects) {
    console.log(`Project: ${projectName}`);
    try {
      const stats = await migrateProject(hzl, projectName);
      if (stats === null) {
        console.log('  (no tasks.json)');
      } else {
        summary[projectName] = stats;
      }
    } catch (e) {
      console.error(`  FATAL: ${e.message}`);
      summary[projectName] = { created: 0, skipped: 0, errors: [e.message], fatal: true };
    }
    console.log('');
  }

  // Summary
  console.log('=== Summary ===');
  let totalCreated = 0, totalSkipped = 0, totalErrors = 0;
  for (const [proj, s] of Object.entries(summary)) {
    const errStr = s.errors.length ? ` | ${s.errors.length} error(s)` : '';
    const fatalStr = s.fatal ? ' [FATAL]' : '';
    console.log(`  ${proj}: ${s.created} created, ${s.skipped} skipped${errStr}${fatalStr}`);
    totalCreated += s.created;
    totalSkipped += s.skipped;
    totalErrors  += s.errors.length;
  }
  console.log('');
  console.log(`  TOTAL: ${totalCreated} created, ${totalSkipped} skipped, ${totalErrors} errors`);

  if (totalErrors > 0) process.exit(1);
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
