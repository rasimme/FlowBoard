'use strict';

// T-458: a spec can be written in the create call, and the create reminder
// only speaks when the server actually flagged something.
//
// T-464: `missing_spec_link` is retired as a flaggable reason — 16 of 16
// measured structureReview flags carried it and the other form-based
// reasons never fired once, so a missing spec is no longer marked. The
// spec is still recommended (see the `api-access` discipline note in
// rules-api.js) and still writable in the same create call or via
// POST /specs/:id — that mechanism is untouched, it just no longer clears
// anything, because nothing is ever flagged for lacking a spec any more.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const port = 18809;
const workspace = path.join(__dirname, 'test-workspace');
const project = 'test-t458-spec-on-create';
const db = path.join(workspace, '.hzl', 'flowboard-t458.db');
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

    // ── 1. A spec passed to the create call ─────────────────────────────
    const withSpec = await request('POST', `/api/projects/${project}/tasks`, {
      title: 'Rebuild the snapshot cache layer',
      description: 'Short summary line.',
      spec: '# Goal\n\nRebuild it.\n\n## Done When\n- [ ] it is rebuilt\n',
    });
    ok(withSpec.status === 200, 'create with an inline spec succeeds');
    ok(withSpec.body.task.specFile, 'the created task carries a specFile');
    ok(fs.existsSync(path.join(projectsDir, project, withSpec.body.task.specFile)),
      'the spec file exists on disk');
    ok(!withSpec.body.task.structureReview,
      'a task created with a spec is not flagged at all');
    ok(!withSpec.body.reminder,
      'nothing flagged means the create response says nothing');

    // ── 2. No spec at all, otherwise well-formed: not flagged (T-464) ───
    // The behavior T-464 changes: whether a spec exists is no longer part
    // of what gets a task marked. A well-formed task with no spec sails
    // through exactly like one with a spec (case 1 above).
    const noSpecWellFormed = await request('POST', `/api/projects/${project}/tasks`, {
      title: 'Retire the legacy webhook shim',
      description: 'Short summary line.',
    });
    ok(noSpecWellFormed.status === 200, 'create without a spec still succeeds — nothing blocks');
    ok(!noSpecWellFormed.body.task.structureReview,
      'a well-formed task with no spec at all is not flagged — missing_spec_link is gone (T-464)');
    ok(!noSpecWellFormed.body.reminder, 'and the create response says nothing');

    // ── 3. A real form problem still flags, and the reminder names it ───
    const noDescription = await request('POST', `/api/projects/${project}/tasks`, {
      title: 'Rebuild the snapshot cache layer once more',
    });
    ok(noDescription.status === 200, 'create without a description still succeeds — nothing blocks');
    const flagged = noDescription.body.task;
    ok(flagged.structureReview?.reasons.includes('missing_description'),
      'a development task without a description is still flagged missing_description');
    ok(typeof noDescription.body.reminder === 'string' && noDescription.body.reminder.includes('missing_description'),
      'the reminder names the reason it was flagged for');

    // ── 4. The spec route still works, and stays scoped to what it fixed ─
    // writeSpecFileForTask() used to call resolveStructureReason() with
    // 'missing_spec_link' after every spec write. That call was removed —
    // missing_spec_link can never be assigned any more, so it was dead code.
    // Writing a spec through this route was never the fix for
    // missing_description, and still is not: this checks the mechanism does
    // not overreach and clear an unrelated reason just because a spec
    // arrived.
    const specLater = await request('POST', `/api/projects/${project}/specs/${flagged.id}`, {
      content: '# Goal\n\nWritten after the fact.\n',
    });
    ok(specLater.status === 200, 'a spec can still be written the old way');
    ok(specLater.body.task.structureReview?.reasons.includes('missing_description'),
      'writing a spec does not retire an unrelated reason — missing_description is not what a spec fixes');

    // ── 5. An accepted review is history and stays put ──────────────────
    // Same contract as before T-464, exercised with a different reason pair
    // (title_pattern + missing_description instead of missing_spec_link):
    // a spec written after acceptance never rewrites a 'reviewed' record,
    // whatever reasons it was accepted for.
    const accepted = await request('POST', `/api/projects/${project}/tasks`, { title: 'Fix router' });
    const acceptedReasons = accepted.body.task.structureReview?.reasons || [];
    ok(acceptedReasons.includes('title_pattern') && acceptedReasons.includes('missing_description'),
      'a bare stub-titled task collects both form reasons at once');
    await request('POST', `/api/projects/${project}/tasks/${accepted.body.task.id}/structure-review`, {});
    await request('POST', `/api/projects/${project}/specs/${accepted.body.task.id}`, {
      content: '# Goal\n\nAdded after a human already accepted the deviation.\n',
    });
    const stillReviewed = await request('GET', `/api/projects/${project}/tasks/${accepted.body.task.id}`);
    ok(stillReviewed.body.task.structureReview?.status === 'reviewed',
      'a review a human accepted is never rewritten by a later spec');
    ok(stillReviewed.body.task.structureReview.reasons.includes('title_pattern')
      && stillReviewed.body.task.structureReview.reasons.includes('missing_description'),
      'and it keeps the reasons it was accepted for — that record is history');

    // ── 6. The rules a project serves depend on its discipline ──────────
    const devRules = await request('GET', `/api/projects/${project}/rules/api-access`);
    ok(devRules.status === 200 && String(devRules.body).includes('This project is `development`'),
      'a development project serves the development note with api-access');
    ok(String(devRules.body).includes('Detail belongs in the spec'),
      'and the note says where detail goes before a task is created wrongly');
    const devOther = await request('GET', `/api/projects/${project}/rules/hzl`);
    ok(!String(devOther.body).includes('This project is'),
      'sections whose meaning does not change stay identical');

    // ── 7. A list project says nothing at all ───────────────────────────
    assert.equal((await request('PUT', `/api/projects/${project}/task-discipline`, { discipline: 'list' })).status, 200);
    const listTask = await request('POST', `/api/projects/${project}/tasks`, { title: 'Water the plant' });
    ok(!listTask.body.task.structureReview, 'a list project flags nothing');
    ok(!listTask.body.reminder, 'and therefore says nothing — no advice nobody asked for');
    const listRules = await request('GET', `/api/projects/${project}/rules/api-access`);
    ok(!String(listRules.body).includes('This project is'),
      'and its rules carry no discipline note either');

    for (const c of checks) console.log(`  ok - ${c.label}`);
    console.log(`\n✅ Spec on create, quiet reminders, no spec-based flagging (T-458/T-464): all ${checks.length} checks passed`);
  } finally {
    child.kill();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
