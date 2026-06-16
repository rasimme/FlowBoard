'use strict';

// T-344-2 — Canvas endpoints dual-read integration test.
// Spawns a real dashboard server (pattern: test-canvas-create-task-smoke.js)
// and exercises all canvas endpoints against BOTH backends:
//   A) a DB-native project created via POST /api/projects (must never grow a
//      canvas.json; data lives in the canvas_* tables of the events DB), and
//   B) an unmigrated fixture project with a hand-written canvas.json (must
//      keep today's file behavior byte-for-byte: every mutation lands in the
//      file, never in the DB tables).
// Both halves also run the Specify PERSIST cleanup (promote -> next ->
// confirm) to prove ADR-0016 note deletion goes through the same switch, and
// hit POST /heal to prove healing neither scaffolds canvas.json nor flips the
// per-project migration flag.

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = __dirname;
const DASHBOARD_PORT = 18815;
const DB_PROJECT = 'canvas-db-endpoints-mig';
const FILE_PROJECT = 'canvas-db-endpoints-file';

let pass = 0;
let fail = 0;
const failures = [];

function ok(condition, message) {
  if (condition) {
    pass++;
    console.log(`  ok - ${message}`);
  } else {
    fail++;
    failures.push(message);
    console.log(`  not ok - ${message}`);
  }
}

async function fetchJson(base, method, urlPath, body) {
  const res = await fetch(base + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
}

async function waitForServer(base, child) {
  const started = Date.now();
  while (Date.now() - started < 10000) {
    if (child.exitCode !== null) throw new Error(`dashboard exited early with ${child.exitCode}`);
    try {
      const res = await fetch(base + '/api/health', { signal: AbortSignal.timeout(300) });
      if (res.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('dashboard did not become ready');
}

function readDbCanvasRows(dbPath, project) {
  // Read-only peek into the events DB (server keeps it open in WAL mode).
  // libsql ships the better-sqlite3-compatible driver hzl-core uses.
  const Database = require('libsql');
  const db = new Database(dbPath, { readonly: true });
  try {
    const notes = db.prepare('SELECT id, text FROM canvas_notes WHERE project = ? ORDER BY rowid').all(project);
    const connections = db.prepare('SELECT from_id, to_id FROM canvas_connections WHERE project = ? ORDER BY rowid').all(project);
    const meta = db.prepare('SELECT migrated_at FROM canvas_meta WHERE project = ?').get(project) || null;
    return { notes, connections, migrated: !!(meta && meta.migrated_at) };
  } finally {
    db.close();
  }
}

// Shared endpoint matrix — identical expectations against both backends.
// `project` selects the backend implicitly via the per-project switch.
async function exerciseEndpoints(base, project, label) {
  // GET baseline
  let res = await fetchJson(base, 'GET', `/api/projects/${project}/canvas`);
  ok(res.status === 200 && Array.isArray(res.body?.notes) && Array.isArray(res.body?.connections),
    `${label}: GET canvas returns notes+connections arrays`);
  const baseCount = res.body.notes.length;

  // POST note
  res = await fetchJson(base, 'POST', `/api/projects/${project}/canvas/notes`, {
    text: 'first note', x: 10, y: 20, color: 'blue', size: 'small',
  });
  ok(res.status === 200 && res.body?.ok === true && /^N-\d{3,}$/.test(res.body?.note?.id || ''),
    `${label}: POST note returns ok + note object (got ${JSON.stringify(res.body?.note?.id)})`);
  ok(res.body?.note?.text === 'first note' && res.body?.note?.x === 10 && res.body?.note?.color === 'blue',
    `${label}: created note echoes fields`);
  ok(typeof res.body?.note?.created === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(res.body.note.created),
    `${label}: created note has YYYY-MM-DD created stamp`);
  const n1 = res.body.note;

  // POST note WITHOUT x/y -> auto-placed collision-free (T-352), not stacked at
  // (0,0). color/size defaults still apply.
  res = await fetchJson(base, 'POST', `/api/projects/${project}/canvas/notes`, { text: 'second note' });
  ok(res.status === 200 && typeof res.body?.note?.x === 'number' && typeof res.body?.note?.y === 'number'
    && !(res.body.note.x === 0 && res.body.note.y === 0)
    && res.body?.note?.color === 'yellow' && res.body?.note?.size === 'small',
    `${label}: POST note without x/y auto-places (not 0,0) + keeps color/size defaults`);
  const n2 = res.body.note;
  ok(n2.id !== n1.id, `${label}: note ids are unique (${n1.id}, ${n2.id})`);

  // T-352: explicit coordinates — including an explicit 0 — are always honored,
  // never auto-placed. Create then delete so it does not skew note counts below.
  res = await fetchJson(base, 'POST', `/api/projects/${project}/canvas/notes`, { text: 'at origin', x: 0, y: 0 });
  ok(res.status === 200 && res.body?.note?.x === 0 && res.body?.note?.y === 0,
    `${label}: POST note with explicit x:0,y:0 is honored (not auto-placed)`);
  await fetchJson(base, 'DELETE', `/api/projects/${project}/canvas/notes/${res.body.note.id}`);

  // POST oversized note -> 413
  res = await fetchJson(base, 'POST', `/api/projects/${project}/canvas/notes`, { text: 'x'.repeat(50 * 1024 + 1) });
  ok(res.status === 413 && res.body?.error === 'Note text too large (max 50KB)',
    `${label}: POST oversized note -> 413 with legacy message`);

  // PUT note
  res = await fetchJson(base, 'PUT', `/api/projects/${project}/canvas/notes/${n1.id}`, { text: 'edited', x: 99 });
  ok(res.status === 200 && res.body?.ok === true && res.body?.note?.text === 'edited' && res.body?.note?.x === 99,
    `${label}: PUT note updates fields and returns note`);
  ok(res.body?.note?.color === 'blue', `${label}: PUT note keeps untouched fields`);

  // PUT unknown note -> 404
  res = await fetchJson(base, 'PUT', `/api/projects/${project}/canvas/notes/N-999`, { text: 'nope' });
  ok(res.status === 404 && res.body?.error === 'Note not found', `${label}: PUT unknown note -> 404`);

  // PUT oversized -> 413
  res = await fetchJson(base, 'PUT', `/api/projects/${project}/canvas/notes/${n1.id}`, { text: 'x'.repeat(50 * 1024 + 1) });
  ok(res.status === 413 && res.body?.error === 'Note text too large (max 50KB)', `${label}: PUT oversized note -> 413`);

  // POST connection
  res = await fetchJson(base, 'POST', `/api/projects/${project}/canvas/connections`, { from: n1.id, to: n2.id });
  ok(res.status === 200 && res.body?.ok === true && res.body?.connection?.from === n1.id && res.body?.connection?.to === n2.id,
    `${label}: POST connection returns connection`);
  ok(!('fromPort' in (res.body?.connection || {})), `${label}: port keys omitted when unset`);

  // duplicate (reverse direction, no ports) -> duplicate:true
  res = await fetchJson(base, 'POST', `/api/projects/${project}/canvas/connections`, { from: n2.id, to: n1.id });
  ok(res.status === 200 && res.body?.duplicate === true && !res.body?.connection,
    `${label}: duplicate connection (reversed) -> duplicate:true`);

  // re-route with ports -> updated:true
  res = await fetchJson(base, 'POST', `/api/projects/${project}/canvas/connections`, {
    from: n1.id, to: n2.id, fromPort: 'right', toPort: 'left',
  });
  ok(res.status === 200 && res.body?.updated === true
    && res.body?.connection?.fromPort === 'right' && res.body?.connection?.toPort === 'left',
    `${label}: existing connection with ports -> updated:true with ports`);

  // self-loop -> 400
  res = await fetchJson(base, 'POST', `/api/projects/${project}/canvas/connections`, { from: n1.id, to: n1.id });
  ok(res.status === 400 && res.body?.error === 'Cannot connect note to itself', `${label}: self-loop -> 400`);

  // missing from/to -> 400
  res = await fetchJson(base, 'POST', `/api/projects/${project}/canvas/connections`, { from: n1.id });
  ok(res.status === 400 && res.body?.error === 'from and to required', `${label}: missing "to" -> 400`);

  // unknown endpoint note -> 404
  res = await fetchJson(base, 'POST', `/api/projects/${project}/canvas/connections`, { from: n1.id, to: 'N-999' });
  ok(res.status === 404 && res.body?.error === 'Note not found', `${label}: connection to unknown note -> 404`);

  // GET shows 2 new notes + 1 connection
  res = await fetchJson(base, 'GET', `/api/projects/${project}/canvas`);
  ok(res.body?.notes?.length === baseCount + 2, `${label}: GET shows both new notes`);
  ok(res.body?.connections?.some(c =>
    (c.from === n1.id && c.to === n2.id) || (c.from === n2.id && c.to === n1.id)),
    `${label}: GET shows the connection`);

  // DELETE connection (reverse direction works)
  res = await fetchJson(base, 'DELETE', `/api/projects/${project}/canvas/connections`, { from: n2.id, to: n1.id });
  ok(res.status === 200 && res.body?.ok === true, `${label}: DELETE connection (reversed) -> ok`);
  res = await fetchJson(base, 'DELETE', `/api/projects/${project}/canvas/connections`, { to: n1.id });
  ok(res.status === 400 && res.body?.error === 'from and to required', `${label}: DELETE connection missing "from" -> 400`);

  // DELETE note :id — also cascades connections (recreate one first)
  await fetchJson(base, 'POST', `/api/projects/${project}/canvas/connections`, { from: n1.id, to: n2.id });
  res = await fetchJson(base, 'DELETE', `/api/projects/${project}/canvas/notes/${n1.id}`);
  ok(res.status === 200 && res.body?.ok === true, `${label}: DELETE note -> ok`);
  res = await fetchJson(base, 'DELETE', `/api/projects/${project}/canvas/notes/${n1.id}`);
  ok(res.status === 404 && res.body?.error === 'Note not found', `${label}: DELETE deleted note -> 404`);
  res = await fetchJson(base, 'GET', `/api/projects/${project}/canvas`);
  ok(res.body?.connections?.every(c => c.from !== n1.id && c.to !== n1.id),
    `${label}: deleting a note cascades its connections`);

  // batch delete: 400 without ids, 204 with ids (unknown ids ignored)
  res = await fetchJson(base, 'DELETE', `/api/projects/${project}/canvas/notes/batch`, {});
  ok(res.status === 400 && res.body?.error === 'noteIds array required', `${label}: batch delete without noteIds -> 400`);
  res = await fetchJson(base, 'DELETE', `/api/projects/${project}/canvas/notes/batch`, { noteIds: [n2.id, 'N-999'] });
  ok(res.status === 204 && res.body === null, `${label}: batch delete -> 204 without body`);
  res = await fetchJson(base, 'GET', `/api/projects/${project}/canvas`);
  ok(res.body?.notes?.length === baseCount && !res.body.notes.some(n => n.id === n2.id),
    `${label}: batch-deleted note is gone`);
}

// Promote -> next -> confirm (dashboard Specify path) and verify the PERSIST
// cleanup removed the source note via the project's backend.
async function exercisePromoteCleanup(base, project, label) {
  let res = await fetchJson(base, 'POST', `/api/projects/${project}/canvas/notes`, {
    text: `Promote cleanup ${label}`, x: 50, y: 50,
  });
  ok(res.status === 200 && res.body?.note?.id, `${label}: promote source note created`);
  const note = res.body.note;

  res = await fetchJson(base, 'POST', `/api/projects/${project}/canvas/promote`, {
    notes: [note], connections: [], mode: 'single',
  });
  ok(res.status === 200 && res.body?.sessionId, `${label}: promote starts dashboard Specify session`);
  const sessionId = res.body.sessionId;

  res = await fetchJson(base, 'POST', `/api/specify/sessions/${sessionId}/next`);
  ok(res.status === 200 && res.body?.session?.status === 'proposal-ready', `${label}: worker reaches proposal-ready`);

  res = await fetchJson(base, 'POST', `/api/specify/sessions/${sessionId}/confirm`, { approved: true });
  ok(res.status === 200 && res.body?.session?.status === 'done', `${label}: confirm completes session`);
  const taskIds = res.body?.createdArtifacts?.taskIds || [];
  ok(taskIds.length === 1, `${label}: confirm created exactly one task`);
  const cleaned = res.body?.createdArtifacts?.cleanedNoteIds || [];
  ok(cleaned.includes(note.id), `${label}: PERSIST cleanup reports the source note id`);

  res = await fetchJson(base, 'GET', `/api/projects/${project}/canvas`);
  ok(res.status === 200 && !res.body.notes.some(n => n.id === note.id),
    `${label}: source note deleted after task creation (ADR-0016)`);
}

async function run() {
  console.log('# Canvas endpoints dual-read (T-344-2)');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-canvas-db-endpoints-'));
  const workspace = path.join(tempRoot, 'workspace');
  const projectsDir = path.join(tempRoot, 'projects');
  fs.mkdirSync(path.join(workspace, 'projects'), { recursive: true });
  fs.mkdirSync(projectsDir, { recursive: true });
  const dbPath = path.join(tempRoot, 'flowboard.db');

  const base = `http://127.0.0.1:${DASHBOARD_PORT}`;

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      FLOWBOARD_PORT: String(DASHBOARD_PORT),
      FLOWBOARD_HOST: '127.0.0.1',
      OPENCLAW_WORKSPACE: workspace,
      FLOWBOARD_PROJECTS_DIR: projectsDir,
      HZL_DB_PATH: dbPath,
      NODE_ENV: 'test',
      TELEGRAM_BOT_TOKEN: '',
      TELEGRAM_BOT_TOKENS: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let logs = '';
  child.stdout.on('data', d => { logs += d.toString(); });
  child.stderr.on('data', d => { logs += d.toString(); });

  try {
    await waitForServer(base, child);

    // ---- A) DB-native project (created via API, immediately migrated) ----
    let res = await fetchJson(base, 'POST', '/api/projects', { name: DB_PROJECT });
    ok(res.status === 201 && res.body?.project?.name === DB_PROJECT, 'A: creates DB-native project');
    const dbProjectCanvasJson = path.join(projectsDir, DB_PROJECT, 'canvas.json');
    ok(!fs.existsSync(dbProjectCanvasJson), 'A: scaffolding creates no canvas.json');

    let rows = readDbCanvasRows(dbPath, DB_PROJECT);
    ok(rows.migrated === true, 'A: new project is marked canvas-migrated in canvas_meta');

    await exerciseEndpoints(base, DB_PROJECT, 'A(db)');

    ok(!fs.existsSync(dbProjectCanvasJson), 'A: still no canvas.json after using all endpoints');

    // Note data actually lives in the DB tables.
    res = await fetchJson(base, 'POST', `/api/projects/${DB_PROJECT}/canvas/notes`, { text: 'db persistence probe' });
    ok(res.status === 200, 'A: probe note created');
    rows = readDbCanvasRows(dbPath, DB_PROJECT);
    ok(rows.notes.some(n => n.text === 'db persistence probe'), 'A: note rows are stored in canvas_notes');
    ok(!fs.existsSync(dbProjectCanvasJson), 'A: probe note did not create canvas.json');

    // heal must not scaffold canvas.json or destroy the migration flag
    res = await fetchJson(base, 'POST', `/api/projects/${DB_PROJECT}/heal`, {});
    ok(res.status === 200 && res.body?.healed === false, 'A: heal on healthy DB-native project is a no-op');
    rows = readDbCanvasRows(dbPath, DB_PROJECT);
    ok(rows.migrated === true, 'A: heal keeps the migration flag');
    ok(!fs.existsSync(dbProjectCanvasJson), 'A: heal does not scaffold canvas.json');

    await exercisePromoteCleanup(base, DB_PROJECT, 'A(db)');
    ok(!fs.existsSync(dbProjectCanvasJson), 'A: promote cleanup did not create canvas.json');

    // ---- B) Unmigrated fixture project (legacy canvas.json on disk) ----
    const fileProjectDir = path.join(projectsDir, FILE_PROJECT);
    const fileCanvasJson = path.join(fileProjectDir, 'canvas.json');
    fs.mkdirSync(fileProjectDir, { recursive: true });
    fs.writeFileSync(path.join(fileProjectDir, 'PROJECT.md'), `# ${FILE_PROJECT}\n`);
    fs.writeFileSync(fileCanvasJson, JSON.stringify({
      notes: [{ id: 'N-001', text: 'legacy fixture note', x: 1, y: 2, color: 'green', size: 'small', created: '2026-01-01' }],
      connections: [],
    }, null, 2));

    // Register the fixture at the HZL/metadata layers without scaffolding.
    res = await fetchJson(base, 'POST', `/api/projects/${FILE_PROJECT}/heal`, {});
    ok(res.status === 200 && res.body?.healed === true, 'B: heal registers fixture project');
    rows = readDbCanvasRows(dbPath, FILE_PROJECT);
    ok(rows.migrated === false, 'B: heal does not mark the fixture as migrated');

    // The fixture note is served from the file.
    res = await fetchJson(base, 'GET', `/api/projects/${FILE_PROJECT}/canvas`);
    ok(res.status === 200 && res.body?.notes?.[0]?.id === 'N-001' && res.body.notes[0].text === 'legacy fixture note',
      'B: GET serves the legacy canvas.json content');

    await exerciseEndpoints(base, FILE_PROJECT, 'B(file)');

    // File behavior unchanged: mutations land in canvas.json, not in the DB.
    res = await fetchJson(base, 'POST', `/api/projects/${FILE_PROJECT}/canvas/notes`, { text: 'file persistence probe' });
    ok(res.status === 200, 'B: probe note created');
    const fileData = JSON.parse(fs.readFileSync(fileCanvasJson, 'utf8'));
    ok(fileData.notes.some(n => n.text === 'file persistence probe'), 'B: note is written to canvas.json');
    rows = readDbCanvasRows(dbPath, FILE_PROJECT);
    ok(rows.notes.length === 0 && rows.connections.length === 0, 'B: no canvas rows leak into the DB');
    ok(rows.migrated === false, 'B: fixture project stays unmigrated');

    await exercisePromoteCleanup(base, FILE_PROJECT, 'B(file)');
    const afterCleanup = JSON.parse(fs.readFileSync(fileCanvasJson, 'utf8'));
    ok(!afterCleanup.notes.some(n => n.text.startsWith('Promote cleanup')),
      'B: PERSIST cleanup removed the note from canvas.json');
  } catch (err) {
    fail++;
    failures.push(err.message);
    console.log(`  not ok - ${err.message}`);
    if (logs) console.log(logs.split('\n').slice(-25).join('\n'));
  } finally {
    child.kill();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  if (fail === 0) {
    console.log(`\n✅ All ${pass} checks passed`);
  } else {
    console.log(`\n❌ ${fail} failed, ${pass} passed`);
    failures.forEach(f => console.log(`  - ${f}`));
  }
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
