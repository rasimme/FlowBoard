'use strict';

// flowboard-metadata.js — FlowBoard-owned project metadata tables in HZL SQLite DB
// T-131-1: replaces _index.md as live source of truth for project metadata
// T-131-3: adds flowboard_agents for DB-backed per-agent active project state

const fs = require('fs');

let _db = null;

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS flowboard_projects (
    name            TEXT PRIMARY KEY,
    display_name    TEXT,
    status          TEXT DEFAULT 'active',
    assigned_agents TEXT DEFAULT '[]',
    config          TEXT DEFAULT '{}',
    created_at      TEXT,
    updated_at      TEXT
  )
`;

const CREATE_AGENTS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS flowboard_agents (
    agent_id        TEXT PRIMARY KEY,
    active_project  TEXT,
    activated_at    TEXT,
    last_seen       TEXT
  )
`;

// T-231: default idle threshold before an agent's active_project is auto-cleared
// (generous on purpose — a live session heartbeats via GET /api/status on every
// bootstrap, and a held task claim protects regardless of idle time).
const AGENT_IDLE_TTL_HOURS = Number(process.env.FLOWBOARD_AGENT_IDLE_TTL_HOURS) || 48;

const CREATE_MIGRATIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS flowboard_migrations (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    applied_at  TEXT NOT NULL
  )
`;

// T-136: tombstones for hard-deleted projects. HZL's projections table retains
// project rows (no native delete), so we filter by name here to make delete
// effectively permanent from a UI perspective while keeping event history.
const CREATE_DELETED_PROJECTS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS flowboard_deleted_projects (
    name        TEXT PRIMARY KEY,
    deleted_at  TEXT NOT NULL
  )
`;

/**
 * Initialize with a better-sqlite3 db handle (from hzl-service cacheDb).
 * Creates the flowboard_projects table if it does not exist.
 */
function init(db) {
  _db = db;
  _db.prepare(CREATE_TABLE_SQL).run();
  _db.prepare(CREATE_AGENTS_TABLE_SQL).run();
  _db.prepare(CREATE_MIGRATIONS_TABLE_SQL).run();
  _db.prepare(CREATE_DELETED_PROJECTS_TABLE_SQL).run();
  console.log('[flowboard-meta] Tables ready: flowboard_projects, flowboard_agents, flowboard_migrations, flowboard_deleted_projects');
}

function countProjects() {
  if (!_db) return 0;
  const row = _db.prepare('SELECT COUNT(*) AS count FROM flowboard_projects').get();
  return row?.count || 0;
}

function shouldRunIndexMigration() {
  return countProjects() === 0;
}

function getProject(name) {
  if (!_db) return null;
  return _db.prepare('SELECT * FROM flowboard_projects WHERE name = ?').get(name) || null;
}

function listMetaProjects() {
  if (!_db) return [];
  return _db.prepare('SELECT * FROM flowboard_projects').all();
}

/**
 * Upsert a project metadata row.
 * Does NOT overwrite if already present — pass force=true to overwrite.
 */
function upsertProject(name, { displayName, status, assignedAgents, config, createdAt } = {}, force = false) {
  if (!_db) throw new Error('[flowboard-meta] Not initialized — call init() first');
  const now = new Date().toISOString();
  const existing = getProject(name);
  if (existing && !force) return; // already migrated, skip
  _db.prepare(`
    INSERT INTO flowboard_projects (name, display_name, status, assigned_agents, config, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      display_name    = excluded.display_name,
      status          = excluded.status,
      assigned_agents = excluded.assigned_agents,
      config          = excluded.config,
      updated_at      = excluded.updated_at
  `).run(
    name,
    displayName || name,
    status || 'active',
    JSON.stringify(assignedAgents || []),
    JSON.stringify(config || {}),
    createdAt || (existing ? existing.created_at : now),
    now
  );
}

/**
 * Migrate metadata from _index.md into flowboard_projects.
 * Skips rows already in DB (idempotent). Skips malformed rows.
 * getDisplayNameFn(name) → string (optional, used to pull display name from PROJECT.md)
 * Returns { migrated, skipped, errors } summary.
 */
function migrateFromIndexMd(indexFilePath, getDisplayNameFn) {
  const result = { migrated: 0, skipped: 0, errors: [] };

  let text;
  try {
    text = fs.readFileSync(indexFilePath, 'utf8');
  } catch {
    console.log('[flowboard-meta] No _index.md found — skipping migration');
    return result;
  }

  const lines = text.split('\n');
  for (const line of lines) {
    // Matches: | project-name | status | description |
    const match = line.match(/^\|\s*(\w[\w-]*)\s*\|\s*(\w+)\s*\|\s*(.+?)\s*\|$/);
    if (!match || match[1] === 'Project') continue;

    const name = match[1].trim();
    const rawStatus = match[2].trim().toLowerCase();
    const status = ['active', 'closed', 'archived'].includes(rawStatus) ? rawStatus : 'active';

    // Skip if already in DB
    if (getProject(name)) {
      result.skipped++;
      continue;
    }

    try {
      const displayName = getDisplayNameFn ? getDisplayNameFn(name) : name;
      upsertProject(name, { displayName, status }, true);
      result.migrated++;
    } catch (e) {
      result.errors.push({ name, error: e.message });
      console.warn(`[flowboard-meta] Migration error for ${name}:`, e.message);
    }
  }

  console.log(`[flowboard-meta] Migration: ${result.migrated} migrated, ${result.skipped} skipped, ${result.errors.length} errors`);
  return result;
}

/**
 * Merge HZL native project list with flowboard_projects metadata.
 * hzlProjects: [{ name, description, created_at, is_protected }]
 * Returns: [{ name, displayName, status, archived, group, order, assignedAgents, description, createdAt }]
 * Hard-deleted projects (flowboard_deleted_projects) are filtered out.
 */
function listProjects(hzlProjects) {
  const deleted = _db
    ? new Set(_db.prepare('SELECT name FROM flowboard_deleted_projects').all().map(r => r.name))
    : new Set();
  return hzlProjects
    .filter(p => !deleted.has(p.name))
    .map(p => {
      const meta = _db ? getProject(p.name) : null;
      const config = meta ? _parseJson(meta.config, {}) : {};
      const status = meta ? (meta.status || 'active') : 'active';
      return {
        name: p.name,
        displayName: meta ? (meta.display_name || p.name) : p.name,
        status,
        archived: status === 'archived',
        group: typeof config.group === 'string' ? config.group : null,
        order: typeof config.order === 'number' ? config.order : null,
        assignedAgents: meta ? _parseJson(meta.assigned_agents, []) : [],
        description: p.description || '',
        createdAt: meta ? meta.created_at : (p.created_at || null),
      };
    });
}

/**
 * T-136: Patch metadata fields on a project row.
 * Accepts any subset of { displayName, status, group, order, archived }.
 * `archived` is a convenience boolean that maps to status ∈ {'active','archived'}.
 * group/order are merged into the config JSON; explicit null clears them.
 * Returns the patched row (raw DB shape), or null if project is not in metadata.
 */
function updateProjectMeta(name, patch) {
  if (!_db) throw new Error('[flowboard-meta] Not initialized — call init() first');
  const existing = getProject(name);
  if (!existing) return null;

  const now = new Date().toISOString();
  const nextDisplayName = patch.displayName !== undefined
    ? String(patch.displayName || name)
    : existing.display_name;

  let nextStatus = existing.status || 'active';
  if (patch.status !== undefined) nextStatus = patch.status;
  else if (patch.archived !== undefined) nextStatus = patch.archived ? 'archived' : 'active';

  const config = _parseJson(existing.config, {});
  if (patch.group !== undefined) {
    if (patch.group === null || patch.group === '') delete config.group;
    else config.group = String(patch.group);
  }
  if (patch.order !== undefined) {
    if (patch.order === null) delete config.order;
    else {
      const n = Number(patch.order);
      if (Number.isFinite(n)) config.order = n;
    }
  }

  _db.prepare(`
    UPDATE flowboard_projects
       SET display_name = ?, status = ?, config = ?, updated_at = ?
     WHERE name = ?
  `).run(nextDisplayName, nextStatus, JSON.stringify(config), now, name);

  return getProject(name);
}

/**
 * T-136: Tombstone-delete a project from flowboard metadata.
 * Removes the flowboard_projects row and inserts a tombstone row so listProjects()
 * filters this name out even though HZL retains the projection.
 */
function deleteProjectMeta(name) {
  if (!_db) throw new Error('[flowboard-meta] Not initialized — call init() first');
  const now = new Date().toISOString();
  const tx = _db.transaction((n) => {
    _db.prepare('DELETE FROM flowboard_projects WHERE name = ?').run(n);
    _db.prepare(
      'INSERT OR REPLACE INTO flowboard_deleted_projects (name, deleted_at) VALUES (?, ?)'
    ).run(n, now);
  });
  tx(name);
}

/**
 * T-136: True/false whether a project is in the tombstone table.
 * Used by createProject to reject resurrection of a just-deleted name.
 */
function isProjectDeleted(name) {
  if (!_db) return false;
  const row = _db.prepare('SELECT 1 FROM flowboard_deleted_projects WHERE name = ?').get(name);
  return !!row;
}

function _parseJson(str, defaultVal) {
  try { return JSON.parse(str); } catch { return defaultVal; }
}

// --- Agent state (T-131-3) ---

/**
 * Return the active project name for the given agent, or null if none set.
 */
function getAgentRow(agentId) {
  if (!_db) return null;
  return _db.prepare('SELECT agent_id, active_project, activated_at, last_seen FROM flowboard_agents WHERE agent_id = ?').get(agentId) || null;
}

/**
 * T-231: pure idle-expiry decision. Returns true iff this agent's
 * `active_project` should be auto-cleared. An agent is NOT expired when it has
 * no active project, has no recorded heartbeat (defensive), holds an active
 * task claim (lease protection), or was seen within the TTL window.
 */
function isAgentIdleExpired(row, { nowMs, ttlHours, claimCount } = {}) {
  if (!row || !row.active_project) return false;
  if (!row.last_seen) return false;
  if (claimCount > 0) return false;
  const seenMs = Date.parse(row.last_seen);
  if (Number.isNaN(seenMs)) return false;
  return (nowMs - seenMs) > ttlHours * 3600 * 1000;
}

/**
 * T-231: refresh an agent's heartbeat. Upsert-safe — creates the row with
 * last_seen set if absent, without touching active_project.
 */
function touchAgentLastSeen(agentId) {
  if (!_db || !agentId) return;
  const now = new Date().toISOString();
  _db.prepare(`
    INSERT INTO flowboard_agents (agent_id, active_project, activated_at, last_seen)
    VALUES (?, NULL, ?, ?)
    ON CONFLICT(agent_id) DO UPDATE SET last_seen = excluded.last_seen
  `).run(agentId, now, now);
}

/**
 * T-231: clear an agent's active_project (auto-deactivation). Keeps the row and
 * last_seen so the agent stays visible and re-establishes liveness on its next
 * heartbeat. Returns true if a row was actually changed.
 */
function clearAgentActiveProject(agentId) {
  if (!_db || !agentId) return false;
  const res = _db.prepare('UPDATE flowboard_agents SET active_project = NULL WHERE agent_id = ? AND active_project IS NOT NULL').run(agentId);
  return res.changes > 0;
}

function getAgentActiveProject(agentId) {
  const row = getAgentRow(agentId);
  return row ? (row.active_project || null) : null;
}

/**
 * Upsert the active project for an agent. Pass null/undefined to clear.
 * activated_at is always set to current UTC ISO-8601 timestamp.
 */
function setAgentActiveProject(agentId, projectName) {
  if (!_db) throw new Error('[flowboard-meta] Not initialized — call init() first');
  const now = new Date().toISOString();
  _db.prepare(`
    INSERT INTO flowboard_agents (agent_id, active_project, activated_at, last_seen)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(agent_id) DO UPDATE SET
      active_project = excluded.active_project,
      activated_at   = excluded.activated_at,
      last_seen      = excluded.last_seen
  `).run(agentId, projectName || null, now, now);
}

/**
 * One-time migration: read active project from ACTIVE-PROJECT.md and insert into
 * flowboard_agents if no row exists yet for this agent.
 *
 * Canonicalizes the file's value via resolveProjectName() — historical files may
 * contain display_names ("FlowBoard") instead of canonical names ("flowboard").
 * If the value can't be resolved, store null and warn rather than blocking the
 * migration; one-shot pre-existing data shouldn't fail startup.
 *
 * Returns the imported (canonical) project name, or null if skipped/not found.
 */
function backfillAgentFromFile(agentId, activeProjectFilePath, hzlProjects) {
  if (!_db) return null;
  const existing = _db.prepare('SELECT active_project FROM flowboard_agents WHERE agent_id = ?').get(agentId);
  if (existing) return null; // already in DB — skip

  let rawName = null;
  try {
    const text = fs.readFileSync(activeProjectFilePath, 'utf8');
    const match = text.match(/^project:\s*(.+)$/m);
    const name = match ? match[1].trim() : null;
    rawName = (name && name !== 'none') ? name : null;
  } catch {
    return null; // file not found — nothing to migrate
  }

  let canonical = null;
  if (rawName) {
    canonical = resolveProjectName(rawName, hzlProjects);
    if (!canonical) {
      console.warn(`[flowboard-meta] Backfill: cannot resolve "${rawName}" for agent "${agentId}" — storing null`);
    }
  }

  setAgentActiveProject(agentId, canonical);
  console.log(`[flowboard-meta] Backfilled agent "${agentId}": active_project=${canonical || 'null'}`);
  return canonical;
}

/**
 * Resolve an arbitrary project identifier to its canonical `name`.
 * Order: exact name → case-insensitive name → display_name (exact then ci).
 *
 * Returns the canonical `name` if found, `null` otherwise.
 *   - input == null/'' → null
 *   - hzlProjects empty/missing → null
 * Caller decides whether `null` means "clear" (legitimate) or "unknown" (reject).
 *
 * hzlProjects is passed in (rather than imported) to keep this module decoupled
 * from hzl-service. Pass the result of hzlService.listHzlProjects().
 */
function resolveProjectName(input, hzlProjects) {
  if (!input) return null;
  if (!Array.isArray(hzlProjects) || hzlProjects.length === 0) return null;

  const exact = hzlProjects.find(p => p.name === input);
  if (exact) return exact.name;

  const lower = String(input).toLowerCase();
  const ci = hzlProjects.find(p => p.name.toLowerCase() === lower);
  if (ci) return ci.name;

  const byDisplay = hzlProjects.find(p => {
    const dn = getProject(p.name)?.display_name;
    return dn === input || (dn && dn.toLowerCase() === lower);
  });
  if (byDisplay) return byDisplay.name;

  return null;
}

/**
 * List all agent rows ordered by agent_id.
 */
function listAgents() {
  if (!_db) return [];
  return _db.prepare('SELECT agent_id, active_project, activated_at, last_seen FROM flowboard_agents ORDER BY agent_id').all();
}

/**
 * Delete an agent row from flowboard_agents. Idempotent — returns the
 * number of rows actually deleted (0 or 1). Historical task attribution
 * (`agent="<id>"` on tasks/comments/checkpoints) is unaffected: agentId
 * is a string field, not a foreign key. T-180.
 */
function deleteAgentRow(agentId) {
  if (!_db) throw new Error('[flowboard-meta] Not initialized — call init() first');
  const result = _db.prepare('DELETE FROM flowboard_agents WHERE agent_id = ?').run(agentId);
  return result.changes;
}

module.exports = {
  init,
  countProjects,
  shouldRunIndexMigration,
  getProject,
  listMetaProjects,
  upsertProject,
  updateProjectMeta,
  deleteProjectMeta,
  isProjectDeleted,
  migrateFromIndexMd,
  listProjects,
  getAgentRow,
  getAgentActiveProject,
  setAgentActiveProject,
  backfillAgentFromFile,
  deleteAgentRow,
  listAgents,
  resolveProjectName,
  isAgentIdleExpired,
  touchAgentLastSeen,
  clearAgentActiveProject,
  AGENT_IDLE_TTL_HOURS,
};
