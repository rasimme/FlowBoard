'use strict';

// T-344-3 — Canvas migration workflow integration test.
// Spawns a real dashboard server (pattern: test-canvas-create-task-smoke.js /
// test-canvas-db-endpoints.js) against a fixture workspace with three
// canvas.json files (normal with reverse-duplicate + orphan connections,
// empty, corrupt) plus one DB-native project, and exercises:
//   - GET  /api/migrations/canvas/status  (pending/migrated/total contract)
//   - POST /api/migrations/canvas/run     (selective + all-pending, partial
//     failure isolation, count verification against CLEANED file counts,
//     .pre-db.bak rename, idempotent re-run, no data-loss path)
//   - the headless operator script scripts/migrate-canvas-to-db.mjs
//     (status mode, --run mode, exit codes)
//   - cross-check: after migration the canvas endpoints serve DB data.

const { spawn, execFile } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = __dirname;
const DASHBOARD_PORT = 18816;
const P_NORMAL = 'mig-normal';
const P_EMPTY = 'mig-empty';
const P_CORRUPT = 'mig-corrupt';
const P_SKIP = 'mig-skip'; // legacy/foreign canvas.json with a non-string-id note
const P_DBNATIVE = 'mig-dbnative';

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
    body: body !== undefined ? JSON.stringify(body) : undefined,
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

function runScript(args, base) {
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(ROOT, 'scripts', 'migrate-canvas-to-db.mjs'), '--base', base, ...args],
      { cwd: ROOT, timeout: 20000 },
      (err, stdout, stderr) => {
        resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) });
      });
  });
}

async function run() {
  console.log('# Canvas migration workflow (T-344-3)');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-canvas-db-import-'));
  const workspace = path.join(tempRoot, 'workspace');
  const projectsDir = path.join(tempRoot, 'projects');
  fs.mkdirSync(path.join(workspace, 'projects'), { recursive: true });
  fs.mkdirSync(projectsDir, { recursive: true });
  const dbPath = path.join(tempRoot, 'flowboard.db');

  // ---- Fixtures ----
  // Normal: 3 notes; raw connections contain 1 valid, 1 reverse duplicate of
  // it, and 1 orphan. Cleaned counts (what import stores and verification
  // must compare against): 3 notes, 1 connection.
  const normalDir = path.join(projectsDir, P_NORMAL);
  fs.mkdirSync(normalDir, { recursive: true });
  fs.writeFileSync(path.join(normalDir, 'PROJECT.md'), `# ${P_NORMAL}\n`);
  const normalData = {
    notes: [
      { id: 'N-001', text: 'first fixture note', x: 10, y: 20, color: 'yellow', size: 'small', created: '2026-01-01' },
      { id: 'N-002', text: 'second fixture note', x: 30, y: 40, color: 'blue', size: 'medium', created: '2026-01-02' },
      { id: 'N-007', text: 'third fixture note', x: 50, y: 60, color: 'green', size: 'small', created: '2026-01-03' },
    ],
    connections: [
      { from: 'N-001', to: 'N-002', fromPort: 'right', toPort: 'left' },
      { from: 'N-002', to: 'N-001' }, // reverse duplicate — dropped on import
      { from: 'N-001', to: 'N-999' }, // orphan — dropped on import
    ],
  };
  fs.writeFileSync(path.join(normalDir, 'canvas.json'), JSON.stringify(normalData, null, 2));

  // Empty: the "fresh scaffold" shape — must count as pending with notes:0.
  const emptyDir = path.join(projectsDir, P_EMPTY);
  fs.mkdirSync(emptyDir, { recursive: true });
  fs.writeFileSync(path.join(emptyDir, 'PROJECT.md'), `# ${P_EMPTY}\n`);
  const emptyContent = JSON.stringify({ notes: [], connections: [] }, null, 2);
  fs.writeFileSync(path.join(emptyDir, 'canvas.json'), emptyContent);

  // Corrupt: invalid JSON — run must fail it cleanly without touching the file.
  const corruptDir = path.join(projectsDir, P_CORRUPT);
  fs.mkdirSync(corruptDir, { recursive: true });
  fs.writeFileSync(path.join(corruptDir, 'PROJECT.md'), `# ${P_CORRUPT}\n`);
  const corruptContent = '{ "notes": [ {"id": "N-001", "text": "broken';
  fs.writeFileSync(path.join(corruptDir, 'canvas.json'), corruptContent);

  // Skip: a foreign/legacy canvas.json with a numeric-id note. The importer
  // drops it (string-id only); counts still match (same filter), so it migrates
  // OK but the run result must carry a `warning` so the drop isn't silent.
  const skipDir = path.join(projectsDir, P_SKIP);
  fs.mkdirSync(skipDir, { recursive: true });
  fs.writeFileSync(path.join(skipDir, 'PROJECT.md'), `# ${P_SKIP}\n`);
  const skipData = {
    notes: [
      { id: 1, text: 'legacy numeric id', x: 10, y: 10, color: 'yellow', size: 'small' },
      { id: 'N-001', text: 'valid note', x: 20, y: 20, color: 'blue', size: 'small' },
    ],
    connections: [],
  };
  fs.writeFileSync(path.join(skipDir, 'canvas.json'), JSON.stringify(skipData, null, 2));

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

    // Register the fixtures at the HZL/metadata layers (no scaffolding) and
    // create one DB-native project that is born migrated.
    let res = await fetchJson(base, 'POST', '/api/projects', { name: P_DBNATIVE });
    ok(res.status === 201, 'setup: DB-native project created');
    for (const p of [P_NORMAL, P_EMPTY, P_CORRUPT]) {
      res = await fetchJson(base, 'POST', `/api/projects/${p}/heal`, {});
      ok(res.status === 200, `setup: heal registers ${p}`);
    }

    // ---- 1) Status before any migration ----
    res = await fetchJson(base, 'GET', '/api/migrations/canvas/status');
    ok(res.status === 200, 'status: returns 200');
    ok(Array.isArray(res.body?.pending) && Array.isArray(res.body?.migrated) && typeof res.body?.total === 'number',
      'status: has pending[], migrated[], total');
    const pendingNames = (res.body?.pending || []).map(p => p.project);
    ok(pendingNames.includes(P_NORMAL) && pendingNames.includes(P_EMPTY) && pendingNames.includes(P_CORRUPT),
      `status: all three fixtures pending (got ${pendingNames.join(',')})`);
    ok(!pendingNames.includes(P_DBNATIVE), 'status: DB-native project is not pending');

    const pNormal = res.body.pending.find(p => p.project === P_NORMAL);
    ok(pNormal && pNormal.notes === 3 && pNormal.connections === 1,
      `status: ${P_NORMAL} reports CLEANED counts 3 notes / 1 connection (got ${pNormal?.notes}/${pNormal?.connections})`);
    ok(pNormal && pNormal.displayName === P_NORMAL,
      `status: displayName falls back to project name (got ${JSON.stringify(pNormal?.displayName)})`);
    ok(pNormal && pNormal.bytes === fs.statSync(path.join(normalDir, 'canvas.json')).size,
      'status: bytes matches the file size on disk');

    const pEmpty = res.body.pending.find(p => p.project === P_EMPTY);
    ok(pEmpty && pEmpty.notes === 0 && pEmpty.connections === 0,
      'status: empty canvas.json is pending with notes:0');
    ok(pEmpty && pEmpty.bytes === Buffer.byteLength(emptyContent),
      'status: empty fixture bytes match');

    const pCorrupt = res.body.pending.find(p => p.project === P_CORRUPT);
    ok(pCorrupt && pCorrupt.notes === 0 && pCorrupt.connections === 0 && pCorrupt.bytes > 0,
      'status: corrupt canvas.json is pending (counts 0, real bytes)');

    const migratedNames = (res.body?.migrated || []).map(m => m.project);
    ok(migratedNames.includes(P_DBNATIVE), 'status: DB-native project listed as migrated');
    const mNative = res.body.migrated.find(m => m.project === P_DBNATIVE);
    ok(mNative && typeof mNative.migratedAt === 'string' && !Number.isNaN(Date.parse(mNative.migratedAt)),
      'status: migrated entries carry an ISO migratedAt');
    ok(res.body.total === res.body.pending.length + res.body.migrated.length,
      'status: total = pending + migrated');

    // ---- 2) Headless script, status mode ----
    let script = await runScript([], base);
    ok(script.code === 0, `script status: exit 0 (got ${script.code}; stderr: ${script.stderr.slice(0, 200)})`);
    ok(script.stdout.includes(P_NORMAL) && script.stdout.includes(P_EMPTY) && script.stdout.includes(P_CORRUPT),
      'script status: lists all pending projects');
    ok(/pending/i.test(script.stdout) && /migrated/i.test(script.stdout),
      'script status: mentions pending and migrated sections');

    // ---- 3) Selective run: migrate only the normal project ----
    res = await fetchJson(base, 'POST', '/api/migrations/canvas/run', { projects: [P_NORMAL] });
    ok(res.status === 200, 'run(normal): returns 200');
    ok(res.body?.failed === 0, `run(normal): failed === 0 (got ${res.body?.failed})`);
    ok(res.body?.results?.length === 1, 'run(normal): one result');
    const rNormal = res.body?.results?.[0] || {};
    ok(rNormal.project === P_NORMAL && rNormal.ok === true, 'run(normal): result ok');
    ok(rNormal.notes === 3 && rNormal.connections === 1,
      `run(normal): imported CLEANED counts 3/1 (got ${rNormal.notes}/${rNormal.connections})`);
    ok(!rNormal.error, 'run(normal): no error field');

    const normalJson = path.join(normalDir, 'canvas.json');
    const normalBak = path.join(normalDir, 'canvas.json.pre-db.bak');
    ok(!fs.existsSync(normalJson), 'run(normal): canvas.json renamed away');
    ok(fs.existsSync(normalBak), 'run(normal): canvas.json.pre-db.bak exists');
    const bakData = JSON.parse(fs.readFileSync(normalBak, 'utf8'));
    ok(bakData.notes.length === 3 && bakData.connections.length === 3,
      'run(normal): backup keeps the ORIGINAL raw content (3 raw connections)');

    let rows = readDbCanvasRows(dbPath, P_NORMAL);
    ok(rows.migrated === true, 'run(normal): canvas_meta.migrated_at set');
    ok(rows.notes.length === 3 && rows.connections.length === 1,
      `run(normal): DB rows match cleaned counts (got ${rows.notes.length}/${rows.connections.length})`);

    // Cross-check: canvas endpoints now serve DB data for the migrated project.
    res = await fetchJson(base, 'GET', `/api/projects/${P_NORMAL}/canvas`);
    ok(res.status === 200 && res.body?.notes?.length === 3, 'cross-check: GET /canvas serves 3 notes from DB');
    ok(res.body?.notes?.some(n => n.id === 'N-007' && n.text === 'third fixture note'),
      'cross-check: note content preserved');
    ok(res.body?.connections?.length === 1
      && res.body.connections[0].from === 'N-001' && res.body.connections[0].to === 'N-002'
      && res.body.connections[0].fromPort === 'right' && res.body.connections[0].toPort === 'left',
      'cross-check: deduped connection with ports preserved');
    // A mutation must hit the DB, not recreate canvas.json.
    res = await fetchJson(base, 'POST', `/api/projects/${P_NORMAL}/canvas/notes`, { text: 'post-migration probe' });
    ok(res.status === 200 && res.body?.note?.id === 'N-008',
      `cross-check: note_seq continued after imported max (got ${res.body?.note?.id})`);
    ok(!fs.existsSync(normalJson), 'cross-check: mutation did not recreate canvas.json');
    rows = readDbCanvasRows(dbPath, P_NORMAL);
    ok(rows.notes.length === 4, 'cross-check: probe note landed in the DB');

    // ---- 4) Run without body: all pending — empty succeeds, corrupt fails isolated ----
    res = await fetchJson(base, 'POST', '/api/migrations/canvas/run');
    ok(res.status === 200, 'run(all): returns 200');
    ok(res.body?.failed === 1, `run(all): exactly the corrupt project failed (failed=${res.body?.failed})`);
    const names = (res.body?.results || []).map(r => r.project);
    ok(!names.includes(P_NORMAL), 'run(all): already-migrated project not re-attempted');
    const rEmpty = (res.body?.results || []).find(r => r.project === P_EMPTY);
    ok(rEmpty && rEmpty.ok === true && rEmpty.notes === 0 && rEmpty.connections === 0,
      'run(all): empty project migrated with 0/0');
    const rCorrupt = (res.body?.results || []).find(r => r.project === P_CORRUPT);
    ok(rCorrupt && rCorrupt.ok === false && typeof rCorrupt.error === 'string' && rCorrupt.error.length > 0,
      `run(all): corrupt project failed with error (got ${JSON.stringify(rCorrupt?.error)})`);

    // T-345-11 (DB review M2): the numeric-id note is dropped but migration
    // still succeeds — the result must warn so the drop isn't silent.
    const rSkip = (res.body?.results || []).find(r => r.project === P_SKIP);
    ok(rSkip && rSkip.ok === true && rSkip.notes === 1,
      `run(all): skip project migrated the 1 valid note (got ${JSON.stringify(rSkip)})`);
    ok(rSkip && typeof rSkip.warning === 'string' && /skip/i.test(rSkip.warning),
      `run(all): dropped note is reported via warning (got ${JSON.stringify(rSkip?.warning)})`);

    ok(fs.existsSync(path.join(emptyDir, 'canvas.json.pre-db.bak'))
      && !fs.existsSync(path.join(emptyDir, 'canvas.json')),
      'run(all): empty project file renamed to .pre-db.bak');
    ok(readDbCanvasRows(dbPath, P_EMPTY).migrated === true, 'run(all): empty project flagged migrated');

    // Corrupt project: file untouched byte-for-byte, no .bak, not migrated.
    ok(fs.readFileSync(path.join(corruptDir, 'canvas.json'), 'utf8') === corruptContent,
      'run(all): corrupt canvas.json untouched');
    ok(!fs.existsSync(path.join(corruptDir, 'canvas.json.pre-db.bak')), 'run(all): corrupt project has no .bak');
    const corruptRows = readDbCanvasRows(dbPath, P_CORRUPT);
    ok(corruptRows.migrated === false && corruptRows.notes.length === 0,
      'run(all): corrupt project unmigrated, no rows leaked');

    // ---- 5) Re-run on migrated projects = no-op (idempotent) ----
    res = await fetchJson(base, 'POST', '/api/migrations/canvas/run', { projects: [P_NORMAL, P_EMPTY] });
    ok(res.status === 200 && res.body?.failed === 0, 'rerun: returns 200 with failed=0');
    ok((res.body?.results || []).every(r => r.ok === true && r.skipped === true),
      'rerun: migrated projects are skipped (ok:true, skipped:true)');
    rows = readDbCanvasRows(dbPath, P_NORMAL);
    ok(rows.notes.length === 4 && rows.connections.length === 1,
      'rerun: DB state unchanged (probe note survives, no re-import)');
    ok(fs.existsSync(normalBak) && !fs.existsSync(normalJson), 'rerun: file state unchanged');

    // Run with no pending targets besides corrupt: still isolated failure.
    res = await fetchJson(base, 'POST', '/api/migrations/canvas/run', {});
    ok(res.status === 200 && res.body?.failed === 1 && res.body?.results?.length === 1
      && res.body.results[0].project === P_CORRUPT,
      'rerun(all): only the corrupt project remains and fails again');

    // ---- 6) Validation and unknown projects ----
    res = await fetchJson(base, 'POST', '/api/migrations/canvas/run', { projects: 'nope' });
    ok(res.status === 400, 'run: non-array projects -> 400');
    res = await fetchJson(base, 'POST', '/api/migrations/canvas/run', { projects: ['no-such-project'] });
    ok(res.status === 200 && res.body?.failed === 1 && res.body?.results?.[0]?.ok === false,
      'run: unknown project -> failed result, not a crash');

    // ---- 7) Status after partial migration ----
    res = await fetchJson(base, 'GET', '/api/migrations/canvas/status');
    const pendingAfter = (res.body?.pending || []).map(p => p.project);
    ok(pendingAfter.length === 1 && pendingAfter[0] === P_CORRUPT,
      `status after: only corrupt pending (got ${pendingAfter.join(',')})`);
    const migratedAfter = (res.body?.migrated || []).map(m => m.project);
    ok(migratedAfter.includes(P_NORMAL) && migratedAfter.includes(P_EMPTY) && migratedAfter.includes(P_DBNATIVE),
      'status after: normal+empty+dbnative migrated');

    // ---- 8) Headless script --run: fails while corrupt is pending, succeeds after fix ----
    script = await runScript(['--run'], base);
    ok(script.code !== 0, `script --run with corrupt pending: exit != 0 (got ${script.code})`);
    ok(script.stdout.includes(P_CORRUPT), 'script --run: names the failed project');

    // Operator fixes the corrupt file, then the script migrates it.
    fs.writeFileSync(path.join(corruptDir, 'canvas.json'), JSON.stringify({
      notes: [{ id: 'N-001', text: 'repaired note', x: 0, y: 0, color: 'yellow', size: 'small', created: '2026-06-12' }],
      connections: [],
    }, null, 2));
    script = await runScript(['--run'], base);
    ok(script.code === 0, `script --run after repair: exit 0 (got ${script.code}; stderr: ${script.stderr.slice(0, 200)})`);
    ok(fs.existsSync(path.join(corruptDir, 'canvas.json.pre-db.bak')),
      'script --run after repair: .pre-db.bak created');
    rows = readDbCanvasRows(dbPath, P_CORRUPT);
    ok(rows.migrated === true && rows.notes.length === 1, 'script --run after repair: project migrated with 1 note');

    res = await fetchJson(base, 'GET', '/api/migrations/canvas/status');
    ok(res.body?.pending?.length === 0, 'final status: no pending projects left');

    // Script status mode on a fully migrated workspace stays exit 0.
    script = await runScript([], base);
    ok(script.code === 0, 'script status on fully migrated workspace: exit 0');
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
