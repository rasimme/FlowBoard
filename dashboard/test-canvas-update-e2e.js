'use strict';

// T-344-6 — E2E test for the complete canvas.json → DB update path.
//
// Simulates a real installation that updates to the DB-canvas server version:
//   1. Fixture workspace with 3 LEGACY projects (filesystem dirs, no registry
//      rows): normal canvas.json (notes + connections + one orphaned
//      connection), empty canvas.json, corrupt canvas.json.
//   2. Server boot on a fresh DB → m008 applied, legacy dirs healed into the
//      registry, GET /api/migrations/canvas/status reports 3 pending with
//      CLEANED counts.
//   3. Browser (Edge headless, same pattern as test-canvas-browser-smoke.js):
//      dashboard loads → migration banner visible → Review opens the modal →
//      confirm runs the migration through the real UI.
//   4. Verify: 2 projects migrated (counts correct, canvas.json renamed to
//      .pre-db.bak), corrupt project listed as failed, banner stays for the
//      remaining pending project.
//   5. Canvas function probe AFTER migration via API (create/update/connect
//      in the migrated project → served from the DB, no canvas.json
//      reappears) and one promote happy path (Specify NODE_ENV=test
//      fallback, pattern test-canvas-create-task-smoke.js) including the
//      ADR-0016 PERSIST cleanup deleting the source note from the DB store.
//
// If Microsoft Edge is not installed, the UI part is skipped and the
// migration is run through the API instead, so the server-side path is still
// covered on headless CI machines.

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = __dirname;
const DASHBOARD_PORT = 18818;
const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';

const P_NORMAL = 'cdm-e2e-normal';
const P_EMPTY = 'cdm-e2e-empty';
const P_CORRUPT = 'cdm-e2e-corrupt';

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
  while (Date.now() - started < 15000) {
    if (child.exitCode !== null) throw new Error(`dashboard exited early with ${child.exitCode}`);
    try {
      const res = await fetch(base + '/api/health', { signal: AbortSignal.timeout(300) });
      if (res.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('dashboard did not become ready');
}

async function waitFor(fn, label, timeout = 10000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch {}
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error(`timeout waiting for ${label}`);
}

// --- Fixture workspace -------------------------------------------------------

function writeFixtureProjects(projectsDir) {
  // Normal: 3 notes, 2 valid connections + 1 orphaned connection that the
  // migration must drop (cleaned counts: 3 notes / 2 connections).
  const normalDir = path.join(projectsDir, P_NORMAL);
  fs.mkdirSync(normalDir, { recursive: true });
  fs.writeFileSync(path.join(normalDir, 'PROJECT.md'), `# ${P_NORMAL}\n\nLegacy fixture project.\n`);
  fs.writeFileSync(path.join(normalDir, 'canvas.json'), JSON.stringify({
    notes: [
      { id: 'N-001', text: 'Legacy idea one', x: 120, y: 140, color: 'yellow', size: 'small', created: '2026-01-10' },
      { id: 'N-002', text: 'Legacy idea two', x: 420, y: 180, color: 'blue', size: 'medium', created: '2026-01-11' },
      { id: 'N-003', text: 'Legacy idea three', x: 260, y: 420, color: 'green', size: 'small', created: '2026-01-12' },
    ],
    connections: [
      { from: 'N-001', to: 'N-002', fromPort: 'right', toPort: 'left' },
      { from: 'N-002', to: 'N-003' },
      { from: 'N-001', to: 'N-999' }, // orphan — must be dropped by the import
    ],
  }, null, 2));

  // Empty: valid scaffold file — counts as pending with 0/0, migrates cleanly.
  const emptyDir = path.join(projectsDir, P_EMPTY);
  fs.mkdirSync(emptyDir, { recursive: true });
  fs.writeFileSync(path.join(emptyDir, 'PROJECT.md'), `# ${P_EMPTY}\n`);
  fs.writeFileSync(path.join(emptyDir, 'canvas.json'), JSON.stringify({ notes: [], connections: [] }, null, 2));

  // Corrupt: unparseable JSON — must fail in the run step and stay pending.
  const corruptDir = path.join(projectsDir, P_CORRUPT);
  fs.mkdirSync(corruptDir, { recursive: true });
  fs.writeFileSync(path.join(corruptDir, 'PROJECT.md'), `# ${P_CORRUPT}\n`);
  fs.writeFileSync(path.join(corruptDir, 'canvas.json'), '{ "notes": [ {"id": "N-001", broken');
}

// --- Browser helpers ---------------------------------------------------------

/** Text content of the migration banner alert, or null when absent. */
async function bannerText(page) {
  return page.evaluate(() => {
    const el = [...document.querySelectorAll('div[role="alert"]')]
      .find(e => e.textContent.includes('Update available'));
    return el ? el.textContent : null;
  });
}

/** Text content of the open migration modal dialog, or null when absent. */
async function dialogText(page) {
  return page.evaluate(() => {
    const el = [...document.querySelectorAll('[role="dialog"]')]
      .find(e => e.textContent.includes('Canvas Data Migration'));
    return el ? el.textContent : null;
  });
}

/** Click the first button whose trimmed text matches; returns false when absent. */
async function clickButton(page, matcher) {
  return page.evaluate((source, flags) => {
    const re = new RegExp(source, flags);
    const btn = [...document.querySelectorAll('button')].find(b => re.test(b.textContent.trim()));
    if (!btn) return false;
    btn.click();
    return true;
  }, matcher.source, matcher.flags);
}

// --- Test --------------------------------------------------------------------

async function run() {
  console.log('# Canvas update-path E2E (T-344-6)');

  const browserAvailable = fs.existsSync(EDGE);
  if (browserAvailable && !fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    throw new Error('dist/index.html missing — run `npx vite build` first');
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-canvas-update-e2e-'));
  const workspace = path.join(tempRoot, 'workspace');
  const projectsDir = path.join(tempRoot, 'projects');
  fs.mkdirSync(path.join(workspace, 'projects'), { recursive: true });
  fs.mkdirSync(projectsDir, { recursive: true });

  // Legacy fixture projects exist on disk BEFORE the server ever boots —
  // exactly the state of an installation that updates to the DB-canvas build.
  writeFixtureProjects(projectsDir);

  const base = `http://127.0.0.1:${DASHBOARD_PORT}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      FLOWBOARD_PORT: String(DASHBOARD_PORT),
      FLOWBOARD_HOST: '127.0.0.1',
      OPENCLAW_WORKSPACE: workspace,
      FLOWBOARD_PROJECTS_DIR: projectsDir,
      HZL_DB_PATH: path.join(tempRoot, 'flowboard.db'),
      NODE_ENV: 'test', // Specify worker fallback for the promote happy path
      TELEGRAM_BOT_TOKEN: '',
      TELEGRAM_BOT_TOKENS: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', d => { logs += d.toString(); });
  child.stderr.on('data', d => { logs += d.toString(); });

  let browser = null;
  try {
    // ── 1. Boot: fresh DB, migrations run, legacy dirs healed ───────────────
    await waitForServer(base, child);
    ok(logs.includes('Applying m008-canvas-schema'), 'boot applies migration m008 (canvas schema)');

    for (const name of [P_NORMAL, P_EMPTY, P_CORRUPT]) {
      const res = await fetchJson(base, 'POST', `/api/projects/${name}/heal`, {});
      ok(res.status === 200, `heals legacy project dir into the registry (${name})`);
    }

    // ── 2. Detection: status reports 3 pending with cleaned counts ──────────
    let res = await fetchJson(base, 'GET', '/api/migrations/canvas/status');
    ok(res.status === 200 && Array.isArray(res.body?.pending), 'migration status endpoint responds');
    const pending = res.body.pending;
    ok(pending.length === 3, `status reports 3 pending projects (got ${pending.length})`);
    const pNormal = pending.find(p => p.project === P_NORMAL);
    ok(pNormal?.notes === 3 && pNormal?.connections === 2,
      `pending counts for ${P_NORMAL} are cleaned (3 notes / 2 connections, orphan dropped) — got ${pNormal?.notes}/${pNormal?.connections}`);
    const pEmpty = pending.find(p => p.project === P_EMPTY);
    ok(pEmpty?.notes === 0 && pEmpty?.connections === 0, `pending counts for ${P_EMPTY} are 0/0`);
    ok(pending.some(p => p.project === P_CORRUPT), `corrupt project ${P_CORRUPT} is listed as pending (tolerant read)`);
    ok(!(res.body.migrated || []).some(p => [P_NORMAL, P_EMPTY, P_CORRUPT].includes(p.project)),
      'no fixture project is marked migrated before the run');

    // ── 3. UI: banner → modal → confirm → result (Edge headless) ────────────
    if (browserAvailable) {
      const puppeteer = require('puppeteer-core');
      browser = await puppeteer.launch({
        executablePath: EDGE,
        headless: 'new',
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1280,900'],
      });
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(base + '/', { waitUntil: 'networkidle2' });

      const banner = await waitFor(() => bannerText(page), 'migration banner');
      ok(/Update available/.test(banner), 'migration banner appears after dashboard load');
      ok(/pending for 3 projects/.test(banner), `banner announces 3 pending projects (got "${banner}")`);

      ok(await clickButton(page, /^Review$/), 'banner has a Review button');
      const modal = await waitFor(() => dialogText(page), 'migration modal');
      ok(/Canvas Data Migration/.test(modal), 'Review opens the Canvas Data Migration modal');
      ok(modal.includes(P_NORMAL) && modal.includes(P_EMPTY) && modal.includes(P_CORRUPT),
        'modal lists all 3 pending projects');
      ok(modal.includes('3 notes · 2 connections'), 'modal shows cleaned counts for the normal project');
      ok(modal.includes('canvas.json.pre-db.bak'), 'modal points out the automatic backup');

      ok(await clickButton(page, /^Migrate 3 projects$/), 'modal has the Migrate confirm button');
      const resultModal = await waitFor(async () => {
        const t = await dialogText(page);
        return t && t.includes('Migration finished with errors') ? t : null;
      }, 'migration result phase');
      ok(/1 of 3 projects failed/.test(resultModal), 'result reports 1 of 3 projects failed');
      ok(resultModal.includes(`${P_NORMAL} — 3 notes, 2 connections migrated`),
        'result lists the normal project with correct migrated counts');
      ok(resultModal.includes(`${P_EMPTY} — 0 notes, 0 connections migrated`),
        'result lists the empty project as migrated (0/0)');
      ok(resultModal.includes(P_CORRUPT) && resultModal.includes('invalid canvas.json'),
        'result lists the corrupt project as failed with a parse error');

      ok(await clickButton(page, /^Close$/), 'result modal has a Close button');
      const bannerAfter = await waitFor(async () => {
        const t = await bannerText(page);
        return t && /pending for 1 project\b/.test(t) ? t : null;
      }, 'banner shrinks to remaining pending project');
      ok(/pending for 1 project\b/.test(bannerAfter),
        'banner stays visible for the remaining (corrupt) project');
    } else {
      console.log('  skip - Microsoft Edge not found; running migration via API instead of the UI');
      res = await fetchJson(base, 'POST', '/api/migrations/canvas/run', {});
      ok(res.status === 200 && res.body?.failed === 1, 'API migration run reports 1 failure');
    }

    // ── 4. Server-side verification of the migration outcome ────────────────
    ok(fs.existsSync(path.join(projectsDir, P_NORMAL, 'canvas.json.pre-db.bak')),
      'normal project: canvas.json renamed to canvas.json.pre-db.bak');
    ok(!fs.existsSync(path.join(projectsDir, P_NORMAL, 'canvas.json')),
      'normal project: no canvas.json left after migration');
    const bak = JSON.parse(fs.readFileSync(path.join(projectsDir, P_NORMAL, 'canvas.json.pre-db.bak'), 'utf8'));
    ok(bak.notes.length === 3 && bak.connections.length === 3,
      'backup file preserves the ORIGINAL content (3 notes, 3 connections incl. orphan)');
    ok(fs.existsSync(path.join(projectsDir, P_EMPTY, 'canvas.json.pre-db.bak'))
      && !fs.existsSync(path.join(projectsDir, P_EMPTY, 'canvas.json')),
      'empty project: backed up and switched over');
    ok(fs.existsSync(path.join(projectsDir, P_CORRUPT, 'canvas.json'))
      && !fs.existsSync(path.join(projectsDir, P_CORRUPT, 'canvas.json.pre-db.bak')),
      'corrupt project: canvas.json untouched, no backup created');

    res = await fetchJson(base, 'GET', '/api/migrations/canvas/status');
    ok(res.body?.pending?.length === 1 && res.body.pending[0].project === P_CORRUPT,
      'status now reports only the corrupt project as pending');
    const migratedNames = (res.body?.migrated || []).map(m => m.project);
    ok(migratedNames.includes(P_NORMAL) && migratedNames.includes(P_EMPTY),
      'status lists both migrated projects with migratedAt');

    res = await fetchJson(base, 'GET', `/api/projects/${P_NORMAL}/canvas`);
    ok(res.body?.notes?.length === 3 && res.body?.connections?.length === 2,
      'migrated canvas serves 3 notes / 2 connections from the DB');
    ok(res.body.notes.some(n => n.id === 'N-001' && n.text === 'Legacy idea one'),
      'migrated note content matches the legacy file');

    // ── 5. Canvas function probe in the migrated project (DB backend) ───────
    res = await fetchJson(base, 'POST', `/api/projects/${P_NORMAL}/canvas/notes`, {
      text: 'Post-migration note', x: 600, y: 500, color: 'purple',
    });
    ok(res.status === 200 && res.body?.note?.id, 'create note works after migration');
    const newNote = res.body.note;
    ok(!['N-001', 'N-002', 'N-003'].includes(newNote.id), `new note gets a fresh id (got ${newNote.id})`);

    res = await fetchJson(base, 'PUT', `/api/projects/${P_NORMAL}/canvas/notes/${newNote.id}`, {
      text: 'Post-migration note (edited)', color: 'red',
    });
    ok(res.status === 200 && res.body?.note?.text === 'Post-migration note (edited)',
      'update note works after migration');

    res = await fetchJson(base, 'POST', `/api/projects/${P_NORMAL}/canvas/connections`, {
      from: newNote.id, to: 'N-001', fromPort: 'left', toPort: 'right',
    });
    ok(res.status === 200 && res.body?.connection, 'create connection works after migration');

    res = await fetchJson(base, 'GET', `/api/projects/${P_NORMAL}/canvas`);
    ok(res.body?.notes?.length === 4 && res.body?.connections?.length === 3,
      `canvas reflects the probe (4 notes / 3 connections, got ${res.body?.notes?.length}/${res.body?.connections?.length})`);
    const edited = res.body.notes.find(n => n.id === newNote.id);
    ok(edited?.text === 'Post-migration note (edited)' && edited?.color === 'red',
      'note update persisted in the DB store');
    ok(!fs.existsSync(path.join(projectsDir, P_NORMAL, 'canvas.json')),
      'no canvas.json reappears — writes go to the DB only');

    // ── 6. Promote happy path against the migrated project (ADR-0016) ───────
    res = await fetchJson(base, 'POST', `/api/projects/${P_NORMAL}/canvas/notes`, {
      text: 'E2E: promote this migrated note', x: 200, y: 600, color: 'yellow',
    });
    ok(res.status === 200 && res.body?.note?.id, 'creates the promote source note');
    const promoteNote = res.body.note;

    res = await fetchJson(base, 'POST', `/api/projects/${P_NORMAL}/canvas/promote`, {
      notes: [promoteNote], connections: [], mode: 'single',
    });
    ok(res.status === 200 && res.body?.sessionId, 'promote starts a dashboard Specify session');
    const sessionId = res.body.sessionId;

    res = await fetchJson(base, 'POST', `/api/specify/sessions/${sessionId}/next`);
    ok(res.status === 200 && res.body?.session?.status === 'proposal-ready',
      'Specify test-fallback worker reaches proposal-ready');

    res = await fetchJson(base, 'POST', `/api/specify/sessions/${sessionId}/confirm`, { approved: true });
    ok(res.status === 200 && res.body?.session?.status === 'done', 'confirm completes the session');
    const taskIds = res.body?.createdArtifacts?.taskIds || [];
    ok(taskIds.length === 1, `promote creates exactly one task (got ${taskIds.length})`);

    res = await fetchJson(base, 'GET', `/api/projects/${P_NORMAL}/tasks`);
    const created = (res.body?.tasks || []).find(t => t.id === taskIds[0]);
    ok(Boolean(created), `created task ${taskIds[0]} is retrievable`);
    ok(Boolean(created) && created.title.includes('promote'),
      `task title reflects the note text (got "${created?.title}")`);

    // ADR-0016 PERSIST cleanup: the source note must be deleted from the DB
    // store (5 notes existed before confirm: 3 migrated + probe + promote).
    res = await fetchJson(base, 'GET', `/api/projects/${P_NORMAL}/canvas`);
    ok(!(res.body?.notes || []).some(n => n.id === promoteNote.id),
      'PERSIST cleanup deleted the promoted note from the DB store');
    ok(res.body?.notes?.length === 4, `remaining notes intact after cleanup (got ${res.body?.notes?.length})`);
    ok(!fs.existsSync(path.join(projectsDir, P_NORMAL, 'canvas.json')),
      'promote cleanup ran in the DB backend — still no canvas.json');
  } catch (err) {
    fail++;
    failures.push(err.message);
    console.log(`  not ok - ${err.message}`);
    if (logs) console.log(logs.split('\n').slice(-25).join('\n'));
  } finally {
    if (browser) await browser.close().catch(() => {});
    child.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 300));
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log(`\n# results: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log('# failures:');
    for (const f of failures) console.log(`#   - ${f}`);
    process.exitCode = 1;
  }
}

run().catch(err => {
  console.error('# fatal:', err.message);
  process.exitCode = 1;
});
