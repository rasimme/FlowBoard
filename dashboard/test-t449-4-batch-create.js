'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const port = 18804;
const workspace = path.join(__dirname, 'test-workspace');
const project = 'test-t449-4-batch-create';
const db = path.join(workspace, '.hzl', 'flowboard-t449-4.db');
const projectsDir = path.join(workspace, 'projects');
for (const file of [db, `${db}-wal`, `${db}-shm`, db.replace(/\.db$/, '-cache.db'), db.replace(/\.db$/, '-cache.db-wal'), db.replace(/\.db$/, '-cache.db-shm')]) {
  try { fs.unlinkSync(file); } catch {}
}
fs.rmSync(path.join(projectsDir, project), { recursive: true, force: true });
fs.mkdirSync(projectsDir, { recursive: true });

function request(method, requestPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: requestPath, method,
      headers: { 'content-type': 'application/json' } }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data || '{}') }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
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

async function main() {
  const child = spawn('node', ['server.js'], { cwd: __dirname, stdio: ['ignore', 'ignore', 'inherit'], env: {
    ...process.env, NODE_ENV: 'test', FLOWBOARD_PORT: String(port), HZL_DB_PATH: db,
    OPENCLAW_WORKSPACE: workspace, FLOWBOARD_PROJECTS_DIR: projectsDir, AUTH_ALWAYS: 'false', SPECIFY_WORKER_DISABLED: 'true',
  } });
  try {
    await waitReady(child);
    assert.equal((await request('POST', '/api/projects', { name: project })).status, 201);
    await request('PUT', `/api/projects/${project}/task-discipline`, { discipline: 'development' });

    const created = await request('POST', `/api/projects/${project}/tasks`, {
      parent: { title: 'Release API', description: 'Parent description', priority: 'high' },
      subtasks: [
        { title: 'Implement endpoint', description: 'Child one', priority: 'low' },
        { title: 'Add coverage' },
      ],
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.batch, true);
    assert.equal(created.body.subtasks.length, 2);
    assert.equal(created.body.subtasks[0].parentId, created.body.parent.id);
    assert.equal(created.body.parent.description, 'Parent description');
    assert.equal(created.body.subtasks[0].description, 'Child one');
    assert.equal(created.body.parent.priority, 'high');
    assert.equal(created.body.subtasks[0].priority, 'low');
    assert.equal(created.body.subtasks[1].priority, 'high');
    // `flat_batch` is retired: a well-formed batch create (a parent and
    // subtasks with descriptions, non-stub titles) is the correct mechanism
    // for keeping related tasks together, so nothing about doing it in one
    // call gets flagged on its own.
    assert.equal(created.body.parent.structureReview, null);
    assert.equal(created.body.subtasks[0].structureReview, null);
    // A genuine form problem is still flagged inside a batch create — the
    // flag tracks the item's own title/description, not the batch shape.
    // subtasks[1] ("Add coverage") has no description.
    assert.equal(created.body.subtasks[1].structureReview.status, 'pending');
    assert.deepEqual(created.body.subtasks[1].structureReview.reasons, ['missing_description']);

    const before = await request('GET', `/api/projects/${project}/tasks?includeArchived=true`);
    const rejected = await request('POST', `/api/projects/${project}/tasks`, {
      parent: { title: 'Should not exist', description: 'valid' },
      subtasks: [{ title: 'Bad priority', priority: 'urgent' }],
    });
    assert.equal(rejected.status, 400);
    const after = await request('GET', `/api/projects/${project}/tasks?includeArchived=true`);
    assert.deepEqual(after.body.tasks.map(task => task.id), before.body.tasks.map(task => task.id));
    console.log('T-449-4 batch create contract tests passed');
  } finally {
    child.kill();
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
