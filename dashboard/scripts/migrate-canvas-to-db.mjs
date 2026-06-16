#!/usr/bin/env node
// migrate-canvas-to-db.mjs — headless canvas.json -> DB migration (T-344-3).
//
// Talks to a running FlowBoard dashboard server; the actual migration logic
// lives behind POST /api/migrations/canvas/run (transactional import, count
// verification, canvas.json -> canvas.json.pre-db.bak rename).
//
// Usage:
//   node scripts/migrate-canvas-to-db.mjs                 # show migration status
//   node scripts/migrate-canvas-to-db.mjs --run           # migrate all pending projects
//   node scripts/migrate-canvas-to-db.mjs --run --project foo --project bar
//   node scripts/migrate-canvas-to-db.mjs --base http://127.0.0.1:18790
//
// Base URL resolution: --base > FLOWBOARD_BASE_URL > http://127.0.0.1:$FLOWBOARD_PORT (default 18790).
// Exit codes: 0 = ok, 1 = at least one project failed to migrate, 2 = usage or connection error.

const args = process.argv.slice(2);

function usage() {
  console.log('Usage: node scripts/migrate-canvas-to-db.mjs [--run] [--project <name>]... [--base <url>]');
  console.log('  (no flags)        show canvas migration status');
  console.log('  --run             migrate pending projects (all, or only the given --project names)');
  console.log('  --project <name>  restrict --run to specific projects (repeatable)');
  console.log('  --base <url>      dashboard base URL (default http://127.0.0.1:18790)');
}

let doRun = false;
let base = process.env.FLOWBOARD_BASE_URL || `http://127.0.0.1:${process.env.FLOWBOARD_PORT || 18790}`;
const projects = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--run') doRun = true;
  else if (a === '--base') base = args[++i];
  else if (a === '--project') projects.push(args[++i]);
  else if (a === '--help' || a === '-h') { usage(); process.exit(0); }
  else { console.error(`Unknown argument: ${a}`); usage(); process.exit(2); }
}
if (!base || (projects.length && projects.some(p => !p))) { usage(); process.exit(2); }
base = base.replace(/\/+$/, '');

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    console.error(`Cannot reach FlowBoard at ${base}: ${e.message}`);
    console.error('Is the dashboard server running? Use --base to point at it.');
    process.exit(2);
  }
  let json = null;
  try { json = await res.json(); } catch {}
  if (!res.ok) {
    console.error(`${method} ${path} failed: HTTP ${res.status}${json && json.error ? ` — ${json.error}` : ''}`);
    process.exit(2);
  }
  return json;
}

function printStatus(status) {
  console.log(`Canvas migration status (${base})`);
  console.log('');
  if (status.pending.length === 0) {
    console.log('Pending: none — all canvas data lives in the DB.');
  } else {
    console.log(`Pending (${status.pending.length}):`);
    for (const p of status.pending) {
      const label = p.displayName && p.displayName !== p.project ? ` (${p.displayName})` : '';
      console.log(`  - ${p.project}${label}: ${p.notes} notes, ${p.connections} connections, ${p.bytes} bytes`);
    }
  }
  console.log('');
  console.log(`Migrated (${status.migrated.length}):`);
  for (const m of status.migrated) {
    console.log(`  - ${m.project} (migrated at ${m.migratedAt})`);
  }
  console.log('');
  console.log(`Total projects tracked: ${status.total}`);
}

const status = await api('GET', '/api/migrations/canvas/status');
printStatus(status);

if (!doRun) {
  if (status.pending.length > 0) {
    console.log('');
    console.log('Run with --run to migrate the pending projects.');
  }
  process.exit(0);
}

if (status.pending.length === 0 && projects.length === 0) {
  console.log('');
  console.log('Nothing to migrate.');
  process.exit(0);
}

console.log('');
console.log(projects.length
  ? `Running migration for: ${projects.join(', ')} ...`
  : 'Running migration for all pending projects ...');

const run = await api('POST', '/api/migrations/canvas/run', projects.length ? { projects } : {});

console.log('');
for (const r of run.results) {
  if (r.ok && r.skipped) {
    console.log(`  SKIPPED ${r.project}: already migrated (${r.notes} notes, ${r.connections} connections in DB)`);
  } else if (r.ok) {
    console.log(`  OK      ${r.project}: ${r.notes} notes, ${r.connections} connections imported; canvas.json -> canvas.json.pre-db.bak`);
    if (r.warning) console.log(`          WARNING: ${r.warning}`);
  } else {
    console.log(`  FAILED  ${r.project}: ${r.error}`);
  }
}
console.log('');
if (run.failed > 0) {
  console.log(`${run.failed} project(s) failed to migrate — fix the listed errors and re-run. Successful projects stay migrated.`);
  process.exit(1);
}
console.log('All requested projects migrated successfully.');
process.exit(0);
