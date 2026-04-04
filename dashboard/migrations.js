'use strict';

// migrations.js — FlowBoard migration registry
//
// Each migration has:
//   id:   stable string ID, zero-padded prefix ensures array order = execution order (m001-, m002-, ...)
//   name: human-readable description
//   run:  function(db, context) — must be idempotent
//
// DB migrations run inside a SQLite transaction that also writes the registry row.
// Filesystem migrations (path moves etc.) must be tagged `filesystem: true`; they run
// the FS op first, then write the registry row — cannot be wrapped in a SQLite transaction.
// If a migration throws, startServer() aborts — fix the problem and restart.

const fs   = require('fs');
const path = require('path');

const migrations = [
  {
    id:   'm001-hzl-tasks',
    name: 'tasks.json → HZL cache (initial data migration)',
    run: (_db, { hzlService, projectsDir }) => {
      // Inner idempotency guard: if HZL already has tasks, this is a no-op.
      // NOTE: the inline migration logic here is simplified (no forceId, title truncation,
      // or icebox→backlog mapping). Full logic lives in migrate-tasks.js. This is intentional:
      // on existing installs getCacheSize() > 0 short-circuits immediately; fresh installs
      // with legacy tasks.json files should run migrate-tasks.js manually first.
      if (hzlService.getCacheSize() > 0) return;
      if (!fs.existsSync(projectsDir)) return;
      const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const tasksFile = path.join(projectsDir, entry.name, 'tasks.json');
        if (fs.existsSync(tasksFile)) {
          hzlService.migrateProject(entry.name, hzlService);
        }
      }
    },
  },

  {
    id:   'm002-index-to-projects',
    name: '_index.md → flowboard_projects metadata table',
    run: (_db, { fbMeta, indexFile, getDisplayName }) => {
      // Inner idempotency guard: if metadata already present, no-op.
      if (fbMeta.countProjects() > 0) return;
      fbMeta.migrateFromIndexMd(indexFile, getDisplayName);
    },
  },

  {
    id:   'm003-active-project-to-db',
    name: 'ACTIVE-PROJECT.md → flowboard_agents table (current runtime agent)',
    run: (_db, { fbMeta, agentId, activeProjectFile }) => {
      // Inner idempotency guard: backfillAgentFromFile skips if row already exists.
      fbMeta.backfillAgentFromFile(agentId, activeProjectFile);
    },
  },

  // m004-project-path (T-131-2): filesystem migration — will be added here with filesystem: true
];

/**
 * Run all pending migrations in order.
 * DB migrations are wrapped in a transaction that also records the registry row.
 * Filesystem migrations (filesystem: true) write the FS change first, then record the row.
 *
 * @param {object} db        better-sqlite3 database handle
 * @param {object} context   runtime dependencies passed to each migration
 */
function runPending(db, context) {
  const applied = new Set(
    db.prepare('SELECT id FROM flowboard_migrations').all().map(r => r.id)
  );
  const pending = migrations.filter(m => !applied.has(m.id));

  if (pending.length === 0) {
    console.log('[migrations] All migrations already applied.');
    return;
  }

  const insertRow = db.prepare(
    'INSERT INTO flowboard_migrations (id, name, applied_at) VALUES (?, ?, ?)'
  );

  for (const migration of pending) {
    const start = Date.now();
    console.log(`[migrations] Applying ${migration.id}: ${migration.name} ...`);
    try {
      if (migration.filesystem) {
        // Filesystem migration: FS op first, then registry row (cannot be transactional).
        // If the server crashes between FS op and DB insert, the migration re-runs on next
        // start — its run() must handle that case as a no-op.
        migration.run(db, context);
        insertRow.run(migration.id, migration.name, new Date().toISOString());
      } else {
        // DB migration: atomic transaction wraps both the migration and the registry row.
        db.transaction(() => {
          migration.run(db, context);
          insertRow.run(migration.id, migration.name, new Date().toISOString());
        })();
      }
      console.log(`[migrations] ${migration.id}: done (${Date.now() - start}ms)`);
    } catch (err) {
      console.error(`[migrations] FAILED: ${migration.id} — ${err.message}`);
      throw err;
    }
  }
}

module.exports = { runPending };
