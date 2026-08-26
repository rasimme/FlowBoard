'use strict';

// T-451: canonical task reads, title/spec contracts, claim transitions, and
// the distinction between subtask progress and checkpoint progress.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const port = 18851;
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-t451-'));
const projectsDir = path.join(workspace, 'projects');
const db = path.join(workspace, 'flowboard.db');
const project = 't451';
fs.mkdirSync(projectsDir, { recursive: true });

function request(method, requestPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: requestPath, method,
      headers: { 'content-type': 'application/json' } }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
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

async function main() {
  const child = spawn(process.execPath, ['server.js'], { cwd: __dirname, stdio: ['ignore', 'ignore', 'inherit'], env: {
    ...process.env, NODE_ENV: 'test', FLOWBOARD_PORT: String(port), HZL_DB_PATH: db,
    OPENCLAW_WORKSPACE: workspace, FLOWBOARD_PROJECTS_DIR: projectsDir,
    AUTH_ALWAYS: 'false', SPECIFY_WORKER_DISABLED: 'true',
  } });
  try {
    await waitReady(child);
    assert.equal((await request('POST', '/api/projects', { name: project })).status, 201);

    const maxTitle = 'x'.repeat(128);
    const atLimit = await request('POST', `/api/projects/${project}/tasks`, { title: maxTitle });
    assert.equal(atLimit.status, 200, JSON.stringify(atLimit.body));
    const overLimit = await request('POST', `/api/projects/${project}/tasks`, { title: `${maxTitle}x` });
    assert.equal(overLimit.status, 400, JSON.stringify(overLimit.body));
    assert.match(overLimit.body.error, /max 128/);

    const parent = (await request('POST', `/api/projects/${project}/tasks`, { title: 'Parent' })).body.task;
    const childTask = (await request('POST', `/api/projects/${project}/tasks`, { title: 'Child', parentId: parent.id })).body.task;
    const canonical = await request('GET', `/api/projects/${project}/tasks/${parent.id}`);
    assert.equal(canonical.status, 200);
    assert.deepEqual(canonical.body.task.progress, { done: 0, inProgress: 0, total: 1 });
    assert.equal((await request('GET', `/api/projects/${project}/tasks/does-not-exist`)).status, 404);
    assert.equal((await request('GET', '/api/projects/no-such-project/tasks/T-001')).status, 404);

    const claim = await request('POST', `/api/projects/${project}/tasks/${childTask.id}/claim`, { agent: 't451-agent' });
    assert.equal(claim.status, 200);
    assert.equal(claim.body.task.status, 'in-progress');

    const checkpoint = await request('POST', `/api/projects/${project}/tasks/${childTask.id}/checkpoint`, {
      agent: 't451-agent', message: 'started', progress: 25,
    });
    assert.equal(checkpoint.status, 200);
    const checkpoints = await request('GET', `/api/projects/${project}/tasks/${childTask.id}/checkpoints`);
    assert.equal(checkpoints.body.checkpoints.at(-1).progress, 25);
    const childRead = await request('GET', `/api/projects/${project}/tasks/${childTask.id}`);
    assert.equal(typeof childRead.body.task.progress, 'undefined');

    const german = (await request('POST', `/api/projects/${project}/tasks`, { title: 'Ärger über Größe ß' })).body.task;
    const spec = await request('POST', `/api/projects/${project}/specs/${german.id}`, { content: '# test' });
    assert.match(spec.body.specFile, new RegExp(`${german.id}-aerger-ueber-groesse-ss\\.md`));
    assert.match(fs.readFileSync(path.join(projectsDir, project, spec.body.specFile), 'utf8'), /# test/);
    console.log('T-451 contract tests passed');
  } finally {
    child.kill();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
