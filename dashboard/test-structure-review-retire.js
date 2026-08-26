'use strict';

// Structure-review flags must retire when their cause is fixed, on the task
// update path (PUT /api/projects/:name/tasks/:id) — the same failure mode
// T-459 fixed for `missing_spec_link`: an agent that fixed the problem still
// left a pending flag behind, so the queue filled with resolved items and
// the signal became something you learn to click away (see the docstring on
// hzlService.resolveStructureReason()).
//
// Covers `missing_description` and `title_pattern` — the two reasons that
// remain after `flat_batch` and `missing_spec_link` were both retired as
// false positives (`flat_batch` fired on the batch endpoint's own correct
// mechanism; `missing_spec_link` was a judgment the server cannot make).
//
// The rule under test is retiring only, never marking: an update must never
// add a reason or create a structureReview that was not there before —
// marking happens only at creation.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const port = 18863;
const workspace = path.join(__dirname, 'test-workspace');
const project = 'test-structure-review-retire';
const db = path.join(workspace, '.hzl', 'flowboard-structure-review-retire.db');
const projectsDir = path.join(workspace, 'projects');
for (const file of [db, `${db}-wal`, `${db}-shm`, db.replace(/\.db$/, '-cache.db'),
  db.replace(/\.db$/, '-cache.db-wal'), db.replace(/\.db$/, '-cache.db-shm')]) {
  try { fs.unlinkSync(file); } catch {}
}
fs.rmSync(path.join(projectsDir, project), { recursive: true, force: true });
fs.mkdirSync(projectsDir, { recursive: true });

function request(method, requestPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: requestPath, method,
      headers: { 'content-type': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch { parsed = data; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.end(JSON.stringify(body)); else req.end();
  });
}

async function waitReady(child) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('server exited before readiness');
    try { if ((await request('GET', '/api/health')).status === 200) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('server readiness timeout');
}

const checks = [];
function ok(cond, label) {
  checks.push({ cond: !!cond, label });
  assert.ok(cond, label);
}

async function main() {
  const child = spawn('node', ['server.js'], { cwd: __dirname, stdio: ['ignore', 'ignore', 'inherit'], env: {
    ...process.env, NODE_ENV: 'test', FLOWBOARD_PORT: String(port), HZL_DB_PATH: db,
    OPENCLAW_WORKSPACE: workspace, FLOWBOARD_PROJECTS_DIR: projectsDir,
    AUTH_ALWAYS: 'false', SPECIFY_WORKER_DISABLED: 'true',
  } });
  try {
    await waitReady(child);
    assert.equal((await request('POST', '/api/projects', { name: project })).status, 201);
    assert.equal((await request('PUT', `/api/projects/${project}/task-discipline`, { discipline: 'development' })).status, 200);

    // ── 1. Fixing one cause retires only that reason ─────────────────────
    const created = await request('POST', `/api/projects/${project}/tasks`, { title: 'Fix router' });
    ok(created.status === 200, 'stub-titled, description-less task is created');
    const bothReasons = created.body.task.structureReview?.reasons || [];
    ok(bothReasons.includes('missing_description') && bothReasons.includes('title_pattern'),
      'a bare stub title with no description collects both form reasons at creation');
    const id = created.body.task.id;

    const addedDescription = await request('PUT', `/api/projects/${project}/tasks/${id}`, {
      description: 'Routes /v2 traffic through the new proxy.',
    });
    ok(addedDescription.status === 200, 'adding a description succeeds');
    ok(addedDescription.body.task.structureReview?.status === 'pending',
      'the review is still pending — title_pattern is still true');
    assert.deepEqual(addedDescription.body.task.structureReview?.reasons, ['title_pattern'],
      'missing_description retired, title_pattern remains — only the fixed cause is dropped');

    // ── 2. Fixing the remaining cause clears the marker entirely ─────────
    const renamed = await request('PUT', `/api/projects/${project}/tasks/${id}`, {
      title: 'Reroute /v2 traffic through the new proxy',
    });
    ok(renamed.status === 200, 'renaming the title succeeds');
    ok(!renamed.body.task.structureReview, 'nothing left to flag — the marker clears completely');

    // ── 3. Retiring only, never marking ───────────────────────────────────
    const wellFormed = await request('POST', `/api/projects/${project}/tasks`, {
      title: 'Rebuild the caching layer',
      description: 'Cuts p95 latency for read-heavy list views.',
    });
    ok(!wellFormed.body.task.structureReview, 'a well-formed task is not flagged at creation');
    const wellFormedId = wellFormed.body.task.id;
    const madeBad = await request('PUT', `/api/projects/${project}/tasks/${wellFormedId}`, {
      title: 'Fix it',
      description: '',
    });
    ok(madeBad.status === 200, 'the update to a now-bad shape still succeeds');
    ok(!madeBad.body.task.structureReview,
      'an update never CREATES a structureReview — marking only ever happens at creation, even ' +
      'when the new title/description would have been flagged if it had been the original create');

    // ── 4. A human-accepted review is history, and stays put ─────────────
    const forAccept = await request('POST', `/api/projects/${project}/tasks`, { title: 'Fix db' });
    const acceptId = forAccept.body.task.id;
    const acceptedReasons = forAccept.body.task.structureReview?.reasons || [];
    ok(acceptedReasons.includes('missing_description') && acceptedReasons.includes('title_pattern'),
      'setup: another stub task with both reasons pending');
    const accepted = await request('POST', `/api/projects/${project}/tasks/${acceptId}/structure-review`, {});
    ok(accepted.body.task.structureReview?.status === 'reviewed', 'a human accepts the deviation');
    const fixedAfterAccept = await request('PUT', `/api/projects/${project}/tasks/${acceptId}`, {
      title: 'Repair the primary database connection pool',
      description: 'Retries with backoff instead of failing the request.',
    });
    ok(fixedAfterAccept.status === 200, 'fixing both causes after acceptance still succeeds');
    ok(fixedAfterAccept.body.task.structureReview?.status === 'reviewed',
      'an accepted review is never retired — it stays "reviewed", not touched by later fixes');
    assert.deepEqual(fixedAfterAccept.body.task.structureReview?.reasons, acceptedReasons,
      'and it keeps exactly the reasons it was accepted for — that record is history');

    // ── 5. A `list` project does nothing at all, even with a fix in hand ──
    const forList = await request('POST', `/api/projects/${project}/tasks`, { title: 'Fix cache' });
    const listId = forList.body.task.id;
    const listReasons = forList.body.task.structureReview?.reasons || [];
    ok(listReasons.includes('missing_description') && listReasons.includes('title_pattern'),
      'setup: a third stub task, still under `development`, flagged at creation');
    assert.equal((await request('PUT', `/api/projects/${project}/task-discipline`, { discipline: 'list' })).status, 200);
    const fixedUnderList = await request('PUT', `/api/projects/${project}/tasks/${listId}`, {
      title: 'Rebuild the shared cache warmup path',
      description: 'Fixes cold-start latency after a deploy.',
    });
    ok(fixedUnderList.status === 200, 'the update itself still succeeds under `list`');
    ok(fixedUnderList.body.task.structureReview?.status === 'pending',
      'a `list` project does not re-evaluate a leftover pending review at all');
    assert.deepEqual(fixedUnderList.body.task.structureReview?.reasons, listReasons,
      'reasons are exactly what they were before — nothing is silently cleared just because the ' +
      'project no longer checks form');

    for (const c of checks) console.log(`  ok - ${c.label}`);
    console.log(`\n✅ Structure-review retirement on update: all ${checks.length} checks passed`);
  } finally {
    child.kill();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
