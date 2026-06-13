'use strict';

/**
 * Unit tests for the canvas DB store in hzl-service.js (T-344-1).
 *
 * Covers: m008 schema migration (target DB = events DB file, see decision
 * comment in migrations.js), note CRUD + N-xxx ID sequence, undirected
 * connection dedupe (duplicate/updated/reverse port mapping), batch delete,
 * import idempotence, self-loop reject — response shapes 1:1 with the
 * legacy file implementation in server.js (readCanvasFile/writeCanvasFile
 * + canvas endpoint handlers).
 *
 * Run: node test-canvas-db-store.js
 */

const fs = require('fs');
const hzl = require('./hzl-service.js');
const migrations = require('./migrations.js');
const fbMeta = require('./flowboard-metadata.js');

const DB_PATH = '/tmp/flowboard-canvas-db-store-test.db';
const CACHE_PATH = DB_PATH.replace(/\.db$/, '-cache.db');
const P = 'canvas-db-test';
const P2 = 'canvas-db-test-2';

let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, msg) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${msg}`);
  } else {
    fail++;
    failures.push(msg);
    console.log(`  ❌ ${msg}`);
  }
}

function section(title) {
  console.log(`\n## ${title}\n`);
}

/** Expect fn to throw an http-ish error with .status and exact .message. */
function expectError(fn, status, message, msg) {
  try {
    fn();
    ok(false, `${msg} (did not throw)`);
  } catch (err) {
    ok(err.status === status && err.message === message,
      `${msg} (got status=${err.status}, message=${JSON.stringify(err.message)})`);
  }
}

function cleanDb() {
  for (const f of [DB_PATH, CACHE_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`, `${CACHE_PATH}-wal`, `${CACHE_PATH}-shm`]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

async function run() {
  cleanDb();
  await hzl.init(DB_PATH);

  // ===========================================================================
  section('m008 migration — registry + target DB (events DB file)');

  {
    fbMeta.init(hzl.getCacheDb());
    const cacheDb = hzl.getCacheDb();

    // Mark every migration except m008 as applied so runPending only runs m008
    // (the earlier migrations need a full workspace context this unit test
    // does not provide; the real boot path is covered by test-migrations-boot.js).
    const now = new Date().toISOString();
    const ins = cacheDb.prepare('INSERT INTO flowboard_migrations (id, name, applied_at) VALUES (?, ?, ?)');
    ok(Array.isArray(migrations.migrations) && migrations.migrations.length > 0,
      'migrations.js exports the migrations list');
    for (const m of migrations.migrations || []) {
      if (m.id !== 'm008-canvas-schema') ins.run(m.id, m.name, now);
    }
    ok((migrations.migrations || []).some(m => m.id === 'm008-canvas-schema'),
      'm008-canvas-schema is registered');

    migrations.runPending(cacheDb, { hzlService: hzl });
    const row = cacheDb.prepare("SELECT id FROM flowboard_migrations WHERE id = 'm008-canvas-schema'").get();
    ok(!!row, 'm008 writes its registry row');

    // Idempotent: second run is a no-op
    migrations.runPending(cacheDb, { hzlService: hzl });
    const count = cacheDb.prepare("SELECT COUNT(*) AS c FROM flowboard_migrations WHERE id = 'm008-canvas-schema'").get().c;
    ok(count === 1, 'second runPending does not re-apply m008');

    const evTables = hzl.getEventsDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'canvas_%' ORDER BY name")
      .all().map(r => r.name);
    ok(evTables.includes('canvas_notes') && evTables.includes('canvas_connections') && evTables.includes('canvas_meta'),
      `canvas tables live in the events DB file (got: ${evTables.join(', ')})`);

    const cacheTables = cacheDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'canvas_%'")
      .all().map(r => r.name);
    ok(cacheTables.length === 0,
      `no canvas tables in the disposable cache DB (got: ${cacheTables.join(', ') || 'none'})`);
  }

  // ===========================================================================
  section('canvasGet — empty project');

  {
    const data = hzl.canvasGet(P);
    ok(Array.isArray(data.notes) && data.notes.length === 0, 'empty project has notes: []');
    ok(Array.isArray(data.connections) && data.connections.length === 0, 'empty project has connections: []');
  }

  // ===========================================================================
  section('note create — defaults, shape, N-xxx sequence');

  {
    const today = new Date().toISOString().slice(0, 10);
    const r1 = hzl.canvasCreateNote(P, {});
    ok(r1.ok === true && r1.note && r1.note.id === 'N-001', 'first note gets id N-001');
    ok(r1.note.text === '' && r1.note.x === 0 && r1.note.y === 0, 'defaults: text "", x 0, y 0');
    ok(r1.note.color === 'yellow' && r1.note.size === 'small', 'defaults: color yellow, size small');
    ok(r1.note.created === today, 'created is today (YYYY-MM-DD)');
    ok(JSON.stringify(Object.keys(r1.note).sort()) === JSON.stringify(['color', 'created', 'id', 'size', 'text', 'x', 'y']),
      'note shape matches file implementation exactly (id,text,x,y,color,size,created)');

    const r2 = hzl.canvasCreateNote(P, { text: 'Hello Canvas', x: 120, y: 80, color: 'blue', size: 'medium' });
    ok(r2.note.id === 'N-002', 'second note gets id N-002');
    ok(r2.note.text === 'Hello Canvas' && r2.note.x === 120 && r2.note.y === 80, 'explicit values stored');
    ok(r2.note.color === 'blue' && r2.note.size === 'medium', 'explicit color/size stored');

    // Sequence is monotonic (canvas_meta.note_seq) — no ID reuse after delete
    hzl.canvasDeleteNote(P, 'N-002');
    const r3 = hzl.canvasCreateNote(P, { text: 'third' });
    ok(r3.note.id === 'N-003', 'sequence does not reuse deleted IDs (N-003 after deleting N-002)');

    const big = 'x'.repeat(50 * 1024 + 1);
    expectError(() => hzl.canvasCreateNote(P, { text: big }), 413, 'Note text too large (max 50KB)',
      'create with >50KB text rejects with 413 semantics');

    const data = hzl.canvasGet(P);
    ok(data.notes.length === 2, 'two notes remain');
    ok(data.notes[0].id === 'N-001' && data.notes[1].id === 'N-003', 'notes keep insertion order');
  }

  // ===========================================================================
  section('note update');

  {
    const r = hzl.canvasUpdateNote(P, 'N-001', { text: 'updated', x: 7 });
    ok(r.ok === true && r.note.text === 'updated' && r.note.x === 7, 'update changes provided fields');
    ok(r.note.color === 'yellow' && r.note.y === 0, 'update leaves other fields untouched');

    const r2 = hzl.canvasUpdateNote(P, 'N-001', { color: 'green', size: 'large', y: -12 });
    ok(r2.note.color === 'green' && r2.note.size === 'large' && r2.note.y === -12, 'color/size/y updatable');

    expectError(() => hzl.canvasUpdateNote(P, 'N-999', { text: 'nope' }), 404, 'Note not found',
      'updating unknown note rejects with 404 semantics');

    const big = 'x'.repeat(50 * 1024 + 1);
    expectError(() => hzl.canvasUpdateNote(P, 'N-001', { text: big }), 413, 'Note text too large (max 50KB)',
      'update with >50KB text rejects with 413 semantics');

    const persisted = hzl.canvasGet(P).notes.find(n => n.id === 'N-001');
    ok(persisted.text === 'updated' && persisted.color === 'green', 'updates persisted');
  }

  // ===========================================================================
  section('connections — create, undirected dedupe, port updates');

  {
    // Fresh notes for clean connection state
    const a = hzl.canvasCreateNote(P, { text: 'A' }).note.id; // N-004
    const b = hzl.canvasCreateNote(P, { text: 'B' }).note.id; // N-005
    const c = hzl.canvasCreateNote(P, { text: 'C' }).note.id; // N-006

    expectError(() => hzl.canvasSaveConnection(P, { from: a }), 400, 'from and to required',
      'missing "to" rejects with 400 semantics');
    expectError(() => hzl.canvasSaveConnection(P, { from: a, to: a }), 400, 'Cannot connect note to itself',
      'self-loop rejects with 400 semantics');
    expectError(() => hzl.canvasSaveConnection(P, { from: a, to: 'N-999' }), 404, 'Note not found',
      'connection to unknown note rejects with 404 semantics');

    const r1 = hzl.canvasSaveConnection(P, { from: a, to: b, fromPort: 'right', toPort: 'left' });
    ok(r1.ok === true && !r1.duplicate && !r1.updated, 'new connection has no duplicate/updated flag');
    ok(r1.connection && r1.connection.from === a && r1.connection.to === b, 'connection stores direction');
    ok(r1.connection.fromPort === 'right' && r1.connection.toPort === 'left', 'connection stores ports');

    const r2 = hzl.canvasSaveConnection(P, { from: a, to: b });
    ok(r2.ok === true && r2.duplicate === true && !r2.connection, 'same direction without ports → { duplicate: true }');

    const r3 = hzl.canvasSaveConnection(P, { from: b, to: a });
    ok(r3.ok === true && r3.duplicate === true, 'reverse direction without ports → { duplicate: true }');

    // Same-direction port update
    const r4 = hzl.canvasSaveConnection(P, { from: a, to: b, fromPort: 'bottom' });
    ok(r4.ok === true && r4.updated === true, 'same direction with port → { updated: true }');
    ok(r4.connection.fromPort === 'bottom' && r4.connection.toPort === 'left',
      'partial port update overwrites only provided port');
    ok(r4.connection.from === a && r4.connection.to === b, 'stored direction unchanged on update');

    // Reverse-direction port update maps ports onto the stored direction
    const r5 = hzl.canvasSaveConnection(P, { from: b, to: a, fromPort: 'top', toPort: 'right' });
    ok(r5.ok === true && r5.updated === true, 'reverse direction with ports → { updated: true }');
    ok(r5.connection.from === a && r5.connection.to === b, 'reverse update keeps original stored direction');
    ok(r5.connection.fromPort === 'right' && r5.connection.toPort === 'top',
      'reverse update maps toPort→fromPort and fromPort→toPort (file parity)');

    // Connection without ports omits the port keys (file parity)
    const r6 = hzl.canvasSaveConnection(P, { from: b, to: c });
    ok(r6.connection && !('fromPort' in r6.connection) && !('toPort' in r6.connection),
      'portless connection omits fromPort/toPort keys');

    const data = hzl.canvasGet(P);
    ok(data.connections.length === 2, 'two connections exist');
    const ab = data.connections.find(x => x.from === a);
    ok(ab && ab.fromPort === 'right' && ab.toPort === 'top', 'canvasGet returns updated ports');

    // Delete works in both directions
    expectError(() => hzl.canvasDeleteConnection(P, { from: a }), 400, 'from and to required',
      'connection delete without to rejects with 400 semantics');
    const d1 = hzl.canvasDeleteConnection(P, { from: b, to: a });
    ok(d1.ok === true, 'reverse-direction delete returns ok');
    ok(hzl.canvasGet(P).connections.length === 1, 'reverse-direction delete removes the connection');
    const d2 = hzl.canvasDeleteConnection(P, { from: b, to: a });
    ok(d2.ok === true, 'deleting a non-existent connection is still ok (file parity)');
  }

  // ===========================================================================
  section('note delete — cascades connected connections');

  {
    const x = hzl.canvasCreateNote(P, { text: 'X' }).note.id;
    const y = hzl.canvasCreateNote(P, { text: 'Y' }).note.id;
    hzl.canvasSaveConnection(P, { from: x, to: y });

    expectError(() => hzl.canvasDeleteNote(P, 'N-999'), 404, 'Note not found',
      'deleting unknown note rejects with 404 semantics');

    const before = hzl.canvasGet(P).connections.length;
    const r = hzl.canvasDeleteNote(P, x);
    ok(r.ok === true, 'delete returns { ok: true }');
    const after = hzl.canvasGet(P);
    ok(!after.notes.some(n => n.id === x), 'note removed');
    ok(after.connections.length === before - 1, 'connections touching the note removed');
    ok(!after.connections.some(cn => cn.from === x || cn.to === x), 'no dangling connection endpoints');
  }

  // ===========================================================================
  section('batch delete');

  {
    const ids = [
      hzl.canvasCreateNote(P, { text: 'b1' }).note.id,
      hzl.canvasCreateNote(P, { text: 'b2' }).note.id,
      hzl.canvasCreateNote(P, { text: 'b3' }).note.id,
    ];
    hzl.canvasSaveConnection(P, { from: ids[0], to: ids[1] });
    hzl.canvasSaveConnection(P, { from: ids[1], to: ids[2] });

    expectError(() => hzl.canvasDeleteNotesBatch(P, null), 400, 'noteIds array required',
      'batch delete without array rejects with 400 semantics');
    expectError(() => hzl.canvasDeleteNotesBatch(P, []), 400, 'noteIds array required',
      'batch delete with empty array rejects with 400 semantics');

    const r = hzl.canvasDeleteNotesBatch(P, [ids[0], ids[2], 'N-999']);
    ok(r.ok === true, 'batch delete with unknown ids succeeds silently (file parity)');
    const data = hzl.canvasGet(P);
    ok(!data.notes.some(n => n.id === ids[0] || n.id === ids[2]), 'batch-deleted notes gone');
    ok(data.notes.some(n => n.id === ids[1]), 'untouched note remains');
    ok(!data.connections.some(cn => [ids[0], ids[2]].includes(cn.from) || [ids[0], ids[2]].includes(cn.to)),
      'connections to batch-deleted notes removed');
  }

  // ===========================================================================
  section('migration flag — canvasIsMigrated / canvasMarkMigrated');

  {
    ok(hzl.canvasIsMigrated(P2) === false, 'unmigrated project reports false');
    hzl.canvasMarkMigrated(P2);
    ok(hzl.canvasIsMigrated(P2) === true, 'marked project reports true');
    hzl.canvasMarkMigrated(P2); // idempotent
    ok(hzl.canvasIsMigrated(P2) === true, 'marking twice stays true');
    ok(hzl.canvasIsMigrated(P) === false, 'flag is per-project');
  }

  // ===========================================================================
  section('canvasImportFromJson — transactional, idempotent, GC parity');

  {
    const json = {
      notes: [
        { id: 'N-001', text: 'one', x: 1, y: 2, color: 'yellow', size: 'small', created: '2026-01-01' },
        { id: 'N-005', text: 'five', x: 10, y: 20, color: 'pink', size: 'large', created: '2026-01-02' },
      ],
      connections: [
        { from: 'N-001', to: 'N-005', fromPort: 'right', toPort: 'left' },
        { from: 'N-005', to: 'N-001' },              // reverse duplicate → skipped (undirected invariant)
        { from: 'N-001', to: 'N-404' },              // orphan → GC'd like readCanvasFile does
      ],
    };

    const r = hzl.canvasImportFromJson(P2, json);
    ok(r.ok === true && r.notes === 2 && r.connections === 1,
      `import returns counts after GC/dedupe (got notes=${r.notes}, connections=${r.connections})`);

    const data = hzl.canvasGet(P2);
    ok(data.notes.length === 2 && data.notes[0].id === 'N-001' && data.notes[1].id === 'N-005',
      'imported notes present in file order');
    ok(data.notes[1].text === 'five' && data.notes[1].created === '2026-01-02', 'imported note fields preserved');
    ok(data.connections.length === 1 && data.connections[0].from === 'N-001' && data.connections[0].fromPort === 'right',
      'imported connection preserved, orphan + reverse dup dropped');

    // Idempotent: re-import yields identical state
    const r2 = hzl.canvasImportFromJson(P2, json);
    ok(r2.notes === 2 && r2.connections === 1, 're-import returns same counts');
    const data2 = hzl.canvasGet(P2);
    ok(JSON.stringify(data2) === JSON.stringify(data), 're-import leaves identical state (idempotent)');

    // Sequence continues after the highest imported numeric suffix
    const created = hzl.canvasCreateNote(P2, { text: 'after import' });
    ok(created.note.id === 'N-006', `note_seq continues after imported max (got ${created.note.id})`);

    // Import replaces existing rows (no merge leftovers)
    const r3 = hzl.canvasImportFromJson(P2, { notes: [{ id: 'N-002', text: 'solo' }], connections: [] });
    ok(r3.notes === 1 && r3.connections === 0, 'import of smaller dataset returns its counts');
    const data3 = hzl.canvasGet(P2);
    ok(data3.notes.length === 1 && data3.notes[0].id === 'N-002', 'import replaces previous canvas state');
    ok(data3.notes[0].text === 'solo' && data3.notes[0].x === 0,
      'imported note without x/y/color falls back to file-read defaults');

    // Seq never goes backwards (no ID reuse after shrinking import)
    const afterShrink = hzl.canvasCreateNote(P2, { text: 'post-shrink' });
    ok(afterShrink.note.id === 'N-007', `note_seq stays monotonic across imports (got ${afterShrink.note.id})`);

    expectError(() => hzl.canvasImportFromJson(P2, null), 400, 'notes and connections arrays required',
      'import with invalid payload rejects with 400 semantics');
  }

  // ===========================================================================
  section('project isolation');

  {
    const pNotes = hzl.canvasGet(P).notes.map(n => n.id);
    const p2Notes = hzl.canvasGet(P2).notes.map(n => n.id);
    // P2 state after the import section: N-002 (last import) + N-007 (post-shrink)
    ok(p2Notes.length === 2 && p2Notes.includes('N-002') && p2Notes.includes('N-007'),
      `project 2 sees only its own notes (got: ${p2Notes.join(', ')})`);
    ok(!pNotes.includes('N-007'), 'project 1 unaffected by project 2 imports');
    const r = hzl.canvasCreateNote(P, { text: 'iso' });
    ok(hzl.canvasGet(P2).notes.length === 2, 'creating in project 1 does not leak into project 2');
    hzl.canvasDeleteNote(P, r.note.id);
  }

  // ===========================================================================
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Canvas DB store tests: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  cleanDb();
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
