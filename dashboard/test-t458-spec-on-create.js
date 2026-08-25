'use strict';

// T-458: a spec can be written in the create call, a spec written later
// retires the flag it was flagged for, and the create reminder only speaks
// when the server actually flagged something.

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

    // ── 2. No spec: flagged, and the reminder names the fix ─────────────
    const noSpec = await request('POST', `/api/projects/${project}/tasks`, {
      title: 'Rebuild the snapshot cache layer again',
      description: 'Short summary line.',
    });
    ok(noSpec.status === 200, 'create without a spec still succeeds — nothing blocks');
    const flagged = noSpec.body.task;
    ok(flagged.structureReview?.reasons.includes('missing_spec_link'),
      'a development task without a spec is flagged missing_spec_link');
    ok(typeof noSpec.body.reminder === 'string' && noSpec.body.reminder.includes('missing_spec_link'),
      'the reminder names the reason it was flagged for');
    ok(noSpec.body.reminder.includes(`/specs/${flagged.id}`),
      'the reminder carries the exact call that fixes it');

    // ── 3. Writing the spec later retires that reason ───────────────────
    const later = await request('POST', `/api/projects/${project}/specs/${flagged.id}`, {
      content: '# Goal\n\nWritten after the fact.\n',
    });
    ok(later.status === 200, 'a spec can still be written the old way');
    ok(!later.body.task.structureReview,
      'the flag is gone once its only reason is spent — no human acknowledgement needed');

    // ── 4. Other reasons survive; only the spent one goes ───────────────
    const multi = await request('POST', `/api/projects/${project}/tasks`, { title: 'Fix API' });
    const multiReasons = multi.body.task.structureReview?.reasons || [];
    ok(multiReasons.includes('missing_description') && multiReasons.includes('missing_spec_link'),
      'a bare task collects several reasons');
    const multiSpec = await request('POST', `/api/projects/${project}/specs/${multi.body.task.id}`, {
      content: '# Goal\n\nStill has no description.\n',
    });
    const after = multiSpec.body.task.structureReview;
    ok(after && after.status === 'pending', 'the review stays pending while other reasons remain');
    ok(!after.reasons.includes('missing_spec_link'), 'the spent reason is dropped');
    ok(after.reasons.includes('missing_description'), 'the unrelated reason survives untouched');

    // ── 5. An accepted review is history and stays put ──────────────────
    const accepted = await request('POST', `/api/projects/${project}/tasks`, { title: 'Fix router' });
    await request('POST', `/api/projects/${project}/tasks/${accepted.body.task.id}/structure-review`, {});
    await request('POST', `/api/projects/${project}/specs/${accepted.body.task.id}`, {
      content: '# Goal\n\nAdded after a human already accepted the deviation.\n',
    });
    const stillReviewed = await request('GET', `/api/projects/${project}/tasks/${accepted.body.task.id}`);
    ok(stillReviewed.body.task.structureReview?.status === 'reviewed',
      'a review a human accepted is never rewritten by a later spec');
    ok(stillReviewed.body.task.structureReview.reasons.includes('missing_spec_link'),
      'and it keeps the reasons it was accepted for — that record is history');

    // ── 6. A list project says nothing at all ───────────────────────────
    assert.equal((await request('PUT', `/api/projects/${project}/task-discipline`, { discipline: 'list' })).status, 200);
    const listTask = await request('POST', `/api/projects/${project}/tasks`, { title: 'Water the plant' });
    ok(!listTask.body.task.structureReview, 'a list project flags nothing');
    ok(!listTask.body.reminder, 'and therefore says nothing — no advice nobody asked for');

    for (const c of checks) console.log(`  ok - ${c.label}`);
    console.log(`\n✅ Spec on create, spent flags, quiet reminders (T-458): all ${checks.length} checks passed`);
  } finally {
    child.kill();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
