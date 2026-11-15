#!/usr/bin/env node
// Spread the seeded demo project's history over two weeks, so the Momentum
// strip, the timeline and the task stats have something to show in the demo
// media. The fixture creates everything within one second.
//
// DEV TOOL FOR A THROWAWAY DEMO DATABASE ONLY. It rewrites event timestamps,
// which the event store forbids on purpose (append-only trigger); the trigger
// is dropped for the rewrite and recreated afterwards. It refuses to run on
// anything that is not a pure demo database, and the dashboard must be
// stopped.
//
//   HZL_DB_PATH=/tmp/fb-demo/flowboard.db node dashboard/server.js   # isolated
//   FLOWBOARD_API=... node scripts/v5-demo-fixture.mjs seed
//   (stop the dashboard)
//   node scripts/v5-demo-backdate.mjs /tmp/fb-demo/flowboard.db
//
// Needs Node >= 22.5 (node:sqlite).
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const DEMO_PROJECT = /^flowboard-(?:v5-demo|demo-[a-z]+)$/;
const DAY = 86400000;
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;

const eventsPath = process.argv[2];
if (!eventsPath || !eventsPath.endsWith('.db')) {
  console.error('Usage: node scripts/v5-demo-backdate.mjs <path/to/flowboard.db>');
  process.exit(1);
}
const cachePath = eventsPath.replace(/\.db$/, '-cache.db');
if (!existsSync(eventsPath) || !existsSync(cachePath)) {
  console.error(`Missing ${eventsPath} or ${cachePath}`);
  process.exit(1);
}

const events = new DatabaseSync(eventsPath);
const cache = new DatabaseSync(cachePath);

const projects = cache.prepare('SELECT DISTINCT project FROM tasks_current').all().map((r) => r.project);
const foreign = projects.filter((name) => !DEMO_PROJECT.test(name));
if (projects.length === 0 || foreign.length > 0) {
  console.error(`Refusing: this is not a pure demo database (projects: ${projects.join(', ') || 'none'}).`);
  process.exit(1);
}

const shiftIso = (ts, ms) => new Date(Date.parse(ts) - ms).toISOString();

const status = new Map();
for (const row of cache.prepare('SELECT task_id, metadata FROM tasks_current').all()) {
  status.set(row.task_id, JSON.parse(row.metadata || '{}').flowboard?.status || null);
}

const byTask = new Map();
for (const row of events.prepare('SELECT id, task_id FROM events ORDER BY id').all()) {
  if (!byTask.has(row.task_id)) byTask.set(row.task_id, []);
  byTask.get(row.task_id).push(row.id);
}

// Each task gets a creation day (13..2 days ago, in creation order) and an end
// day that depends on where it stands now; its events are spread in between.
const tasks = [...byTask.keys()].filter((id) => status.has(id));
const shift = new Map(); // event id -> ms to subtract
const plan = new Map(); // task id -> [created shift, last shift]
tasks.forEach((taskId, index) => {
  const created = 13 - Math.floor((index * 11) / Math.max(tasks.length - 1, 1));
  const state = status.get(taskId);
  const end = state === 'in-progress' ? 0
    : state === 'review' ? Math.min(created, index % 2)
      : state === 'done' ? Math.min(created - 1, ((index * 3) % 6) + 1)
        : created;
  const jitter = ((index * 37) % 480) * 60000;
  const ids = byTask.get(taskId);
  ids.forEach((id, k) => {
    const day = ids.length > 1 ? Math.round(created - (created - end) * (k / (ids.length - 1))) : created;
    shift.set(id, day * DAY + (day > 0 ? jitter : 0));
  });
  plan.set(taskId, [shift.get(ids[0]), shift.get(ids[ids.length - 1])]);
});
for (const [taskId, ids] of byTask) {
  if (!status.has(taskId)) for (const id of ids) shift.set(id, 14 * DAY); // project events
}

events.exec('BEGIN');
events.exec('DROP TRIGGER IF EXISTS events_no_update');
const update = events.prepare('UPDATE events SET timestamp = ?, data = ? WHERE id = ?');
for (const row of events.prepare('SELECT id, timestamp, data FROM events').all()) {
  const ms = shift.get(row.id);
  update.run(shiftIso(row.timestamp, ms), row.data.replace(ISO, (ts) => shiftIso(ts, ms)), row.id);
}
events.exec(`CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN
  SELECT RAISE(ABORT, 'Events table is append-only: cannot UPDATE'); END`);
events.exec('COMMIT');

const last = new Map(); // task id -> { type -> last event id }
for (const row of events.prepare('SELECT id, task_id, type FROM events ORDER BY id').all()) {
  if (!last.has(row.task_id)) last.set(row.task_id, {});
  last.get(row.task_id)[row.type] = row.id;
}

cache.exec('BEGIN');
const updateTask = cache.prepare('UPDATE tasks_current SET metadata = ?, created_at = ?, updated_at = ?, terminal_at = ? WHERE task_id = ?');
for (const row of cache.prepare('SELECT task_id, metadata, created_at, updated_at, terminal_at FROM tasks_current').all()) {
  const [created, end] = plan.get(row.task_id);
  const metadata = JSON.parse(row.metadata);
  const fb = metadata.flowboard;
  const types = last.get(row.task_id) || {};
  fb.created = shiftIso(row.created_at, created).slice(0, 10);
  if (fb.completed) fb.completed = shiftIso(row.updated_at, end).slice(0, 10);
  if (fb.enteredStatusAt) fb.enteredStatusAt = shiftIso(fb.enteredStatusAt, types.status_changed ? shift.get(types.status_changed) : created);
  if (fb.lastCheckpointAt && types.checkpoint_recorded) fb.lastCheckpointAt = shiftIso(fb.lastCheckpointAt, shift.get(types.checkpoint_recorded));
  updateTask.run(
    JSON.stringify(metadata),
    shiftIso(row.created_at, created),
    shiftIso(row.updated_at, end),
    row.terminal_at ? shiftIso(row.terminal_at, end) : null,
    row.task_id,
  );
}
for (const table of ['task_checkpoints', 'task_comments']) {
  const set = cache.prepare(`UPDATE ${table} SET timestamp = ? WHERE event_rowid = ?`);
  for (const row of cache.prepare(`SELECT event_rowid, timestamp FROM ${table}`).all()) {
    set.run(shiftIso(row.timestamp, shift.get(row.event_rowid)), row.event_rowid);
  }
}
cache.exec('COMMIT');

events.close();
cache.close();
console.log(`backdated ${shift.size} events over ${tasks.length} tasks`);
