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

// System docs m005 validates on startup. Post-lazy-load the canonical rule
// sections live at the top level and the monolithic PROJECT-RULES.md is
// archived under legacy/ (nothing at runtime reads it — the reference lives
// only in the rules manifest as an info pointer).
const SYSTEM_DOCS = [
  'tasks-api.md', 'canvas-and-notes.md',
  'specify-workflow.md', 'project-files.md', 'agent-bridge.md',
  'commands.md', 'hzl.md', 'error-handling.md', 'key-principles.md',
];
const LEGACY_SYSTEM_DOCS = [
  'legacy/PROJECT-RULES.md',
];

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
    run: (_db, { fbMeta, hzlService, agentId, activeProjectFile }) => {
      // T-177-3: agentId is now optional — comes from OPENCLAW_AGENT_ID env
      // (legacy operator hint). When unset (the new normal post-T-177), there
      // is no implied "current runtime agent" the dashboard should backfill
      // for. The migration is idempotent and already applied on existing
      // installs that had the env set; new installs simply skip.
      if (!agentId) {
        console.log('[m003] No OPENCLAW_AGENT_ID set; skipping ACTIVE-PROJECT.md backfill (expected on services without operator-hint env).');
        return;
      }
      // Inner idempotency guard: backfillAgentFromFile skips if row already exists.
      // Pass hzlProjects so legacy display_names in ACTIVE-PROJECT.md get canonicalized.
      const hzlProjects = hzlService ? hzlService.listHzlProjects() : [];
      fbMeta.backfillAgentFromFile(agentId, activeProjectFile, hzlProjects);
    },
  },


  {
    id:         'm004-project-path',
    name:       'Move project files to shared root ~/.openclaw/projects/',
    filesystem: true,
    run: (_db, { openclawHome, projectsDir }) => {
      const newRoot = path.join(openclawHome, 'projects');

      // Idempotency: if target already exists and has content, nothing to do.
      // (Server already uses newRoot via PROJECTS_DIR fallback logic.)
      if (fs.existsSync(newRoot)) {
        const entries = fs.readdirSync(newRoot);
        if (entries.length > 0) {
          console.log('[m004] Target already populated — skipping copy.');
          return;
        }
      }

      // Old workspace-relative projects path (source of truth before this migration)
      const oldRoot = projectsDir; // still points to workspace/projects at this point

      if (!fs.existsSync(oldRoot)) {
        console.log('[m004] No existing projects directory found — nothing to migrate.');
        return;
      }

      // If the old root is already a symlink, a previous run of this
      // migration (possibly under a different openclawHome, e.g. a
      // test-spawned server) has replaced it with the compat link. Copying
      // a symlink root would crash cpSync (EEXIST on the just-created
      // newRoot) — and there is nothing left to migrate anyway.
      if (fs.lstatSync(oldRoot).isSymbolicLink()) {
        console.log('[m004] Old root is already a compat symlink — migration done; skipping.');
        return;
      }

      // Same physical directory (e.g. oldRoot resolves into newRoot):
      // nothing to move, and copying onto itself would corrupt the tree.
      if (path.resolve(fs.realpathSync(oldRoot)) === path.resolve(newRoot)) {
        console.log('[m004] Old root and new root are the same directory — skipping.');
        return;
      }

      console.log(`[m004] Copying ${oldRoot} → ${newRoot} ...`);
      fs.mkdirSync(newRoot, { recursive: true });
      try {
        fs.cpSync(oldRoot, newRoot, { recursive: true, preserveTimestamps: true });
      } catch (err) {
        console.warn('[m004] Copy failed — removing partial newRoot before retry.');
        fs.rmSync(newRoot, { recursive: true, force: true });
        throw err;
      }

      // Verify: every top-level entry in old root should exist in new root
      const oldEntries = fs.readdirSync(oldRoot);
      const newEntries = new Set(fs.readdirSync(newRoot));
      const missing = oldEntries.filter(e => !newEntries.has(e));
      if (missing.length > 0) {
        throw new Error(`[m004] Verification failed — missing in new root: ${missing.join(', ')}`);
      }

      // Backup old root (rename, not delete — safe rollback)
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const backupPath = `${oldRoot}.bak-${ts}`;
      console.log(`[m004] Renaming old root to ${backupPath} ...`);
      fs.renameSync(oldRoot, backupPath);

      // Compatibility symlink so any tool still using the old path keeps working
      console.log(`[m004] Creating symlink ${oldRoot} → ${newRoot} ...`);
      fs.symlinkSync(newRoot, oldRoot);

      console.log(`[m004] Migration complete. ${oldEntries.length} entries moved.`);
      console.log(`[m004] Backup preserved at: ${backupPath}`);
    },
  },
  {
    id:         'm005-project-doc-structure',
    name:       'System docs → docs/project-mode/, session log extraction, bootstrap alignment',
    filesystem: true,
    run: (_db, { projectsDir, openclawHome }) => {
      // --- Part A: Verify system docs exist in repo docs/project-mode/ ---
      // The canonical docs are shipped in the repo. This migration validates
      // they're present (they were placed there by the commit that added this migration).
      const repoRoot = path.resolve(__dirname, '..');
      const systemDocsDir = path.join(repoRoot, 'docs', 'project-mode');
      for (const doc of [...SYSTEM_DOCS, ...LEGACY_SYSTEM_DOCS]) {
        const p = path.join(systemDocsDir, doc);
        if (!fs.existsSync(p)) {
          console.warn(`[m005] System doc missing (expected in repo): ${p}`);
        }
      }

      // --- Part B: Symlink legacy PROJECT-RULES.md path in shared projects dir
      // to the archived copy. Pre-lazy-load installs that still reference
      // `projects/PROJECT-RULES.md` directly get a working redirect; new
      // installs don't depend on this at runtime.
      const sharedRulesPath = path.join(projectsDir, 'PROJECT-RULES.md');
      const canonicalRulesPath = path.join(systemDocsDir, 'legacy', 'PROJECT-RULES.md');
      try {
        const stat = fs.lstatSync(sharedRulesPath);
        if (stat.isSymbolicLink()) {
          // Re-point symlink to new canonical location
          fs.unlinkSync(sharedRulesPath);
          fs.symlinkSync(canonicalRulesPath, sharedRulesPath);
          console.log(`[m005] Re-pointed symlink: ${sharedRulesPath} → ${canonicalRulesPath}`);
        } else {
          // Regular file — back up and replace with symlink
          const bak = sharedRulesPath + '.bak-m005';
          fs.renameSync(sharedRulesPath, bak);
          fs.symlinkSync(canonicalRulesPath, sharedRulesPath);
          console.log(`[m005] Replaced file with symlink: ${sharedRulesPath} (backup: ${bak})`);
        }
      } catch (e) {
        if (e.code === 'ENOENT') {
          // No existing file — just create symlink
          fs.symlinkSync(canonicalRulesPath, sharedRulesPath);
          console.log(`[m005] Created symlink: ${sharedRulesPath} → ${canonicalRulesPath}`);
        } else {
          throw e;
        }
      }

      // --- Part C: Extract session logs from PROJECT.md → SESSIONS.md ---
      if (!fs.existsSync(projectsDir)) return;
      const projects = fs.readdirSync(projectsDir, { withFileTypes: true })
        .filter(e => e.isDirectory());

      for (const entry of projects) {
        const projectDir = path.join(projectsDir, entry.name);
        const projectMd = path.join(projectDir, 'PROJECT.md');
        const sessionsMd = path.join(projectDir, 'SESSIONS.md');

        if (!fs.existsSync(projectMd)) continue;

        let content;
        try { content = fs.readFileSync(projectMd, 'utf8'); } catch { continue; }

        const logMatch = content.match(/^(## Session Log)\s*$/m);
        if (!logMatch) continue; // No session log — skip

        const splitIndex = logMatch.index;
        const beforeLog = content.slice(0, splitIndex).trimEnd();
        const logSection = content.slice(splitIndex);

        // Safety: don't overwrite existing SESSIONS.md
        if (fs.existsSync(sessionsMd)) {
          console.log(`[m005] ${entry.name}: SESSIONS.md already exists — skipping extraction, removing log from PROJECT.md`);
        } else {
          // Write SESSIONS.md first (safe ordering: write new file before modifying old one)
          const sessionsContent = `# Session Log — ${entry.name}\n\n${logSection.trim()}\n`;
          const tmpPath = sessionsMd + '.tmp-m005';
          fs.writeFileSync(tmpPath, sessionsContent, 'utf8');
          fs.renameSync(tmpPath, sessionsMd);
          console.log(`[m005] ${entry.name}: Extracted session log → SESSIONS.md`);
        }

        // Remove session log from PROJECT.md
        const slimContent = beforeLog + '\n';
        const tmpProjectMd = projectMd + '.tmp-m005';
        fs.writeFileSync(tmpProjectMd, slimContent, 'utf8');
        fs.renameSync(tmpProjectMd, projectMd);
        console.log(`[m005] ${entry.name}: Trimmed SESSION LOG from PROJECT.md`);
      }

      console.log('[m005] Migration complete.');
    },
  },
  {
    id:         'm006-snippets-advisory',
    name:       'Detect legacy AGENTS.md / BOOT.md snippets and recommend update',
    filesystem: true,
    run: (_db, { openclawHome }) => {
      // Read-only check: scans workspace/ and workspace-*/ under OPENCLAW_HOME for
      // AGENTS.md and BOOT.md files that still reference the pre-lazy-load paths
      // (ACTIVE-PROJECT.md, projects/PROJECT-RULES.md). Emits a warning pointing
      // at the doctor CLI; does NOT edit anything. Registry row is written by
      // the caller so the advisory only fires once per install.
      let doctor;
      try { doctor = require('./snippets-doctor.js'); } catch (err) {
        console.warn('[m006] snippets-doctor module unavailable:', err.message);
        return;
      }

      const targets = ['AGENTS.md', 'BOOT.md'];
      const findings = [];
      for (const name of targets) {
        const candidates = doctor.findCandidateFiles(openclawHome, name);
        for (const file of candidates) {
          let content = '';
          try { content = fs.readFileSync(file, 'utf8'); } catch { continue; }
          if (doctor.detectLegacyMarkers(content)) findings.push(file);
        }
      }

      if (findings.length === 0) {
        console.log('[m006] No legacy snippet markers detected.');
        return;
      }

      console.warn(`[m006] Found ${findings.length} file(s) with legacy snippet markers:`);
      for (const f of findings) console.warn(`  - ${f}`);
      console.warn('[m006] These reference ACTIVE-PROJECT.md / projects/PROJECT-RULES.md directly.');
      console.warn('[m006] The lazy-load model uses BOOTSTRAP.md + GET /api/projects/:name/rules/:section instead.');
      console.warn('[m006] Run `node dashboard/snippets-doctor.js` to preview a safe, byte-match-only replacement.');
      console.warn('[m006] Manual merge remains the intended path — AGENTS.md is user-owned.');
    },
  },

  {
    id:   'm007-agent-last-seen',
    name: 'flowboard_agents: add last_seen column for idle auto-deactivation (T-231)',
    run: (db) => {
      // Idempotent: fresh installs already have the column from
      // CREATE_AGENTS_TABLE_SQL; existing installs need the ALTER. Use the
      // pragma_table_info table-valued function via a plain prepared statement
      // so this does not depend on a driver-specific .pragma() helper.
      const hasColumn = db.prepare(
        "SELECT COUNT(*) AS c FROM pragma_table_info('flowboard_agents') WHERE name = 'last_seen'"
      ).get().c > 0;
      if (!hasColumn) {
        db.exec('ALTER TABLE flowboard_agents ADD COLUMN last_seen TEXT');
      }
      // Backfill: treat existing rows as last seen at activation time, so stale
      // pre-T-231 activations become eligible for expiry immediately.
      db.prepare('UPDATE flowboard_agents SET last_seen = activated_at WHERE last_seen IS NULL').run();
    },
  },
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
