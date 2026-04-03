'use strict';

// flowboard-metadata.js — FlowBoard-owned project metadata table in HZL SQLite DB
// T-131-1: replaces _index.md as live source of truth for project metadata

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

/**
 * Initialize with a better-sqlite3 db handle (from hzl-service cacheDb).
 * Creates the flowboard_projects table if it does not exist.
 */
function init(db) {
  _db = db;
  _db.prepare(CREATE_TABLE_SQL).run();
  console.log('[flowboard-meta] Table ready: flowboard_projects');
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
 * Returns: [{ name, displayName, status, assignedAgents, description }]
 * Missing metadata rows fall back to safe defaults — never hides a project.
 */
function listProjects(hzlProjects) {
  return hzlProjects.map(p => {
    const meta = _db ? getProject(p.name) : null;
    return {
      name: p.name,
      displayName: meta ? (meta.display_name || p.name) : p.name,
      status: meta ? (meta.status || 'active') : 'active',
      assignedAgents: meta ? _parseJson(meta.assigned_agents, []) : [],
      description: p.description || '',
    };
  });
}

function _parseJson(str, defaultVal) {
  try { return JSON.parse(str); } catch { return defaultVal; }
}

module.exports = { init, countProjects, shouldRunIndexMigration, getProject, upsertProject, migrateFromIndexMd, listProjects };
