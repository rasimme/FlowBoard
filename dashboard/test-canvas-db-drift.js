'use strict';

// T-344-5 — Canvas drift/conflict detection integration test (ADR-0018).
// Spawns a real dashboard server (pattern: test-canvas-db-import.js) and
// exercises the restore-conflict scenario: a project whose canvas data was
// migrated into the DB gets a canvas.json back on disk (workspace restore
// from a pre-migration backup, or a failed post-import rename).
//
// Contract under test:
//   - GET  /api/migrations/canvas/status grows an ADDITIVE `conflicts` array:
//     [{ project, displayName, bytes, migratedAt }]. Existing fields
//     (pending/migrated/total) keep their exact shape and semantics.
//   - A conflict project is NOT listed as pending and is NEVER auto-migrated.
//   - POST /api/migrations/canvas/run with an explicit conflict project
//     returns ok:false with a clear error — no silent skip, no re-import
//     over the DB data (operator decides, see T-344-8 docs).
//   - run-all never touches conflict projects and other pending projects
//     still migrate normally while a conflict exists (no crash).
//   - `.pre-db.bak` and `.pre-db.bak.<epoch>` leftovers are legitimate
//     migration artifacts and never count as conflicts.
//   - heal on a conflict project neither removes the file, nor unsets the
//     migration flag, nor imports anything.
//   - The server log carries a conflict warning from the scan.
//   - Deleting the file resolves the conflict (status clean, run skips again).

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = __dirname;
const DASHBOARD_PORT = 18817;
const P_CONFLICT = 'drift-conflict';
const P_BAK = 'drift-bakonly';
const P_PENDING = 'drift-pending';
const P_DBNATIVE = 'drift-dbnative';

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

async function run() {
  console.log('# Canvas drift/conflict detection (T-344-5, ADR-0018)');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-canvas-db-drift-'));
  const workspace = path.join(tempRoot, 'workspace');
  const projectsDir = path.join(tempRoot, 'projects');
  fs.mkdirSync(path.join(workspace, 'projects'), { recursive: true });
  fs.mkdirSync(projectsDir, { recursive: true });
  const dbPath = path.join(tempRoot, 'flowboard.db');

  // ---- Fixtures (pre-boot file layout; registration happens via API) ----
  // Conflict candidate: starts as a normal file project, gets migrated via
  // the run endpoint, then a canvas.json is planted back (restore scenario).
  const conflictDir = path.join(projectsDir, P_CONFLICT);
  fs.mkdirSync(conflictDir, { recursive: true });
  fs.writeFileSync(path.join(conflictDir, 'PROJECT.md'), `# ${P_CONFLICT}\n`);
  fs.writeFileSync(path.join(conflictDir, 'canvas.json'), JSON.stringify({
    notes: [
      { id: 'N-001', text: 'db note one', x: 10, y: 20, color: 'yellow', size: 'small', created: '2026-01-01' },
      { id: 'N-002', text: 'db note two', x: 30, y: 40, color: 'blue', size: 'medium', created: '2026-01-02' },
    ],
    connections: [{ from: 'N-001', to: 'N-002' }],
  }, null, 2));

  // Bak-only project: migrated, then we add the epoch-suffixed backup
  // variant next to the regular one — neither may register as a conflict.
  const bakDir = path.join(projectsDir, P_BAK);
  fs.mkdirSync(bakDir, { recursive: true });
  fs.writeFileSync(path.join(bakDir, 'PROJECT.md'), `# ${P_BAK}\n`);
  fs.writeFileSync(path.join(bakDir, 'canvas.json'), JSON.stringify({
    notes: [{ id: 'N-001', text: 'bak project note', x: 0, y: 0, color: 'green', size: 'small', created: '2026-01-03' }],
    connections: [],
  }, null, 2));

  // Pending project: stays unmigrated at first — proves pending vs conflict
  // separation and that run-all still works while a conflict exists.
  const pendingDir = path.join(projectsDir, P_PENDING);
  fs.mkdirSync(pendingDir, { recursive: true });
  fs.writeFileSync(path.join(pendingDir, 'PROJECT.md'), `# ${P_PENDING}\n`);
  fs.writeFileSync(path.join(pendingDir, 'canvas.json'), JSON.stringify({
    notes: [{ id: 'N-001', text: 'pending note', x: 5, y: 5, color: 'yellow', size: 'small', created: '2026-01-04' }],
    connections: [],
  }, null, 2));

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

    // ---- Setup: register fixtures, migrate conflict + bak projects ----
    let res = await fetchJson(base, 'POST', '/api/projects', { name: P_DBNATIVE });
    ok(res.status === 201, 'setup: DB-native project created');
    for (const p of [P_CONFLICT, P_BAK, P_PENDING]) {
      res = await fetchJson(base, 'POST', `/api/projects/${p}/heal`, {});
      ok(res.status === 200, `setup: heal registers ${p}`);
    }
    res = await fetchJson(base, 'POST', '/api/migrations/canvas/run', { projects: [P_CONFLICT, P_BAK] });
    ok(res.status === 200 && res.body?.failed === 0, 'setup: conflict+bak fixtures migrated');
    ok(!fs.existsSync(path.join(conflictDir, 'canvas.json'))
      && fs.existsSync(path.join(conflictDir, 'canvas.json.pre-db.bak')),
      'setup: migration renamed canvas.json away');

    // Epoch-suffixed backup variant (created by a backup-name collision in
    // migrateCanvasProject) — legitimate, must never count as a conflict.
    fs.writeFileSync(path.join(bakDir, `canvas.json.pre-db.bak.${Date.now()}`), '{"notes":[],"connections":[]}');

    // ---- 1) No conflicts yet: additive field present and empty ----
    res = await fetchJson(base, 'GET', '/api/migrations/canvas/status');
    ok(res.status === 200, 'status: returns 200');
    ok(Array.isArray(res.body?.conflicts), 'status: has additive conflicts[]');
    ok(res.body?.conflicts?.length === 0, `status: no conflicts before the restore (got ${JSON.stringify(res.body?.conflicts)})`);
    ok(Array.isArray(res.body?.pending) && Array.isArray(res.body?.migrated) && typeof res.body?.total === 'number',
      'status: existing fields pending[]/migrated[]/total unchanged');
    ok(res.body.total === res.body.pending.length + res.body.migrated.length,
      'status: total semantics unchanged (pending + migrated)');

    // ---- 2) The restore: plant a fresh canvas.json next to the DB data ----
    const plantedContent = JSON.stringify({
      notes: [{ id: 'N-001', text: 'restored from old backup', x: 1, y: 1, color: 'red', size: 'small', created: '2025-12-01' }],
      connections: [],
    }, null, 2);
    fs.writeFileSync(path.join(conflictDir, 'canvas.json'), plantedContent);

    res = await fetchJson(base, 'GET', '/api/migrations/canvas/status');
    ok(res.status === 200, 'conflict status: returns 200 (no crash)');
    const conflicts = res.body?.conflicts || [];
    ok(conflicts.length === 1 && conflicts[0].project === P_CONFLICT,
      `conflict status: exactly the restored project conflicts (got ${conflicts.map(c => c.project).join(',')})`);
    const c = conflicts[0] || {};
    ok(c.displayName === P_CONFLICT, `conflict status: displayName falls back to project name (got ${JSON.stringify(c.displayName)})`);
    ok(c.bytes === Buffer.byteLength(plantedContent), `conflict status: bytes match the planted file (got ${c.bytes})`);
    ok(typeof c.migratedAt === 'string' && !Number.isNaN(Date.parse(c.migratedAt)),
      `conflict status: migratedAt is an ISO timestamp (got ${JSON.stringify(c.migratedAt)})`);
    ok(!(res.body?.pending || []).some(p => p.project === P_CONFLICT),
      'conflict status: conflict project is NOT pending');
    ok((res.body?.migrated || []).some(m => m.project === P_CONFLICT),
      'conflict status: conflict project still listed as migrated');
    ok(!conflicts.some(x => x.project === P_BAK),
      'conflict status: .pre-db.bak / .pre-db.bak.<epoch> files do not conflict');
    ok(!conflicts.some(x => x.project === P_DBNATIVE), 'conflict status: DB-native project does not conflict');
    ok(/conflict/i.test(logs) && logs.includes(P_CONFLICT),
      'conflict status: server log carries a conflict warning naming the project');

    // ---- 3) Explicit run on a conflict project must be rejected ----
    res = await fetchJson(base, 'POST', '/api/migrations/canvas/run', { projects: [P_CONFLICT] });
    ok(res.status === 200, 'run(conflict): endpoint itself returns 200 (per-project failure)');
    ok(res.body?.failed === 1, `run(conflict): failed === 1 (got ${res.body?.failed})`);
    const rConflict = res.body?.results?.[0] || {};
    ok(rConflict.project === P_CONFLICT && rConflict.ok === false,
      'run(conflict): result is ok:false — not a silent skip');
    ok(rConflict.skipped !== true, 'run(conflict): result is not marked skipped');
    ok(typeof rConflict.error === 'string' && /conflict/i.test(rConflict.error),
      `run(conflict): error names the conflict (got ${JSON.stringify(rConflict.error)})`);
    ok(fs.readFileSync(path.join(conflictDir, 'canvas.json'), 'utf8') === plantedContent,
      'run(conflict): restored canvas.json untouched byte-for-byte');

    // DB data must be exactly the pre-restore import — no re-import happened.
    res = await fetchJson(base, 'GET', `/api/projects/${P_CONFLICT}/canvas`);
    ok(res.status === 200 && res.body?.notes?.length === 2
      && res.body.notes.some(n => n.text === 'db note one')
      && !res.body.notes.some(n => n.text === 'restored from old backup'),
      'run(conflict): canvas endpoint still serves the DB data, not the file');

    // ---- 4) run-all skips the conflict but migrates other pending work ----
    res = await fetchJson(base, 'POST', '/api/migrations/canvas/run');
    ok(res.status === 200 && res.body?.failed === 0,
      `run-all: succeeds while a conflict exists (failed=${res.body?.failed})`);
    const runAllNames = (res.body?.results || []).map(r => r.project);
    ok(!runAllNames.includes(P_CONFLICT), 'run-all: conflict project not auto-touched');
    ok(runAllNames.includes(P_PENDING), 'run-all: pending project still migrates normally');
    ok(fs.readFileSync(path.join(conflictDir, 'canvas.json'), 'utf8') === plantedContent,
      'run-all: conflict file still untouched');

    // ---- 5) heal on a conflict project changes nothing canvas-related ----
    res = await fetchJson(base, 'POST', `/api/projects/${P_CONFLICT}/heal`, {});
    ok(res.status === 200 && res.body?.healed === false, 'heal(conflict): healthy project is a no-op');
    ok(fs.existsSync(path.join(conflictDir, 'canvas.json')), 'heal(conflict): canvas.json not removed');
    ok(fs.readFileSync(path.join(conflictDir, 'canvas.json'), 'utf8') === plantedContent,
      'heal(conflict): canvas.json content untouched');
    res = await fetchJson(base, 'GET', '/api/migrations/canvas/status');
    ok((res.body?.conflicts || []).some(x => x.project === P_CONFLICT),
      'heal(conflict): conflict still reported (migration flag survived heal)');
    res = await fetchJson(base, 'GET', `/api/projects/${P_CONFLICT}/canvas`);
    ok(res.status === 200 && res.body?.notes?.length === 2,
      'heal(conflict): canvas endpoint still serves DB data after heal');

    // ---- 6) Operator resolution: deleting the file clears the conflict ----
    fs.unlinkSync(path.join(conflictDir, 'canvas.json'));
    res = await fetchJson(base, 'GET', '/api/migrations/canvas/status');
    ok(res.status === 200 && (res.body?.conflicts || []).length === 0,
      'resolution: deleting the file clears the conflict');
    ok((res.body?.pending || []).length === 0, 'resolution: nothing pending afterwards');
    res = await fetchJson(base, 'POST', '/api/migrations/canvas/run', { projects: [P_CONFLICT] });
    ok(res.status === 200 && res.body?.results?.[0]?.ok === true && res.body?.results?.[0]?.skipped === true,
      'resolution: explicit run is back to the idempotent skip');
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
