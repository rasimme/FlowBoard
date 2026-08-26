'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const port = 18803;
const workspace = path.join(__dirname, 'test-workspace');
const project = 'test-t449-3-structure-review';
const db = path.join(workspace, '.hzl', 'flowboard-t449-3.db');
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

function structureShape(task) {
  assert.ok(task.structureReview, 'task has a structure review');
  assert.deepEqual(Object.keys(task.structureReview).sort(), ['reasons', 'reviewedAt', 'reviewer', 'status']);
  return task.structureReview;
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
    const development = await request('POST', `/api/projects/${project}/tasks`, { title: 'Fix API' });
    assert.equal(development.status, 200);
    const devReview = structureShape(development.body.task);
    assert.equal(devReview.status, 'pending');
    assert.equal(devReview.reviewer, null);
    assert.equal(devReview.reviewedAt, null);
    // T-464: missing_spec_link is no longer a reason — 16 of 16 measured
    // flags carried it and none of the form-based reasons ever fired, so it
    // was cut. Only the two observable-form reasons remain for "Fix API".
    assert.deepEqual(devReview.reasons, ['missing_description', 'title_pattern']);
    const pending = await request('GET', `/api/projects/${project}/tasks?structureReview=pending`);
    assert.deepEqual(pending.body.tasks.map(task => task.id), [development.body.task.id]);

    const acknowledged = await request('POST', `/api/projects/${project}/tasks/${development.body.task.id}/structure-review`, {});
    assert.equal(acknowledged.status, 200);
    const reviewed = structureShape(acknowledged.body.task);
    assert.equal(reviewed.status, 'reviewed');
    assert.equal(reviewed.reviewer, 'local:operator');
    assert.doesNotThrow(() => new Date(reviewed.reviewedAt).toISOString());
    assert.deepEqual(reviewed.reasons, devReview.reasons);
    const secondAcknowledgement = await request('POST', `/api/projects/${project}/tasks/${development.body.task.id}/structure-review`, {});
    assert.equal(secondAcknowledgement.status, 409, JSON.stringify(secondAcknowledgement.body));

    assert.equal((await request('PUT', `/api/projects/${project}/task-discipline`, { discipline: 'standard' })).status, 200);
    const standard = await request('POST', `/api/projects/${project}/tasks`, { title: 'Update notes' });
    assert.equal(standard.status, 200);
    assert.deepEqual(structureShape(standard.body.task).reasons, ['missing_description', 'title_pattern']);

    assert.equal((await request('PUT', `/api/projects/${project}/task-discipline`, { discipline: 'list' })).status, 200);
    const list = await request('POST', `/api/projects/${project}/tasks`, { title: 'Update notes' });
    assert.equal(list.status, 200);
    assert.equal(list.body.task.structureReview, null);
    assert.equal((await request('GET', `/api/projects/${project}/tasks?structureReview=pending`)).body.tasks.length, 1);
    console.log('T-449-3 structure review contract tests passed');
  } finally {
    child.kill();
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
