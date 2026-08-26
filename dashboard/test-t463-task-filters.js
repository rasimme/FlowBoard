'use strict';

// T-463: `status` and `tag` were documented on GET /tasks and never
// implemented — every value, including nonsense, returned the full list.
// The load-bearing assertion here is that a filter returns FEWER tasks than
// no filter. A test that only checks "the returned tasks match the filter"
// passes happily against a filter that does nothing, which is how this
// survived for as long as it did.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const port = 18811;
const workspace = path.join(__dirname, 'test-workspace');
const project = 'test-t463-task-filters';
const db = path.join(workspace, '.hzl', 'flowboard-t463.db');
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
function ok(cond, label) { checks.push(label); assert.ok(cond, label); }

async function main() {
  const child = spawn('node', ['server.js'], { cwd: __dirname, stdio: ['ignore', 'ignore', 'inherit'], env: {
    ...process.env, NODE_ENV: 'test', FLOWBOARD_PORT: String(port), HZL_DB_PATH: db,
    OPENCLAW_WORKSPACE: workspace, FLOWBOARD_PROJECTS_DIR: projectsDir,
    AUTH_ALWAYS: 'false', SPECIFY_WORKER_DISABLED: 'true',
  } });
  try {
    await waitReady(child);
    assert.equal((await request('POST', '/api/projects', { name: project })).status, 201);

    const base = `/api/projects/${project}/tasks`;
    await request('POST', base, { title: 'Backlog one', description: 'x', tags: ['alpha'] });
    await request('POST', base, { title: 'Backlog two', description: 'x', tags: ['beta'] });
    const third = await request('POST', base, { title: 'Moves to review', description: 'x', tags: ['alpha'] });
    await request('PUT', `${base}/${third.body.task.id}`, { status: 'review' });

    const all = await request('GET', base);
    ok(all.body.tasks.length === 3, 'three tasks exist without a filter');

    // The assertion that matters: filtering must actually reduce the set.
    const backlog = await request('GET', `${base}?status=backlog`);
    ok(backlog.body.tasks.length < all.body.tasks.length,
      'a status filter returns fewer tasks than no filter');
    ok(backlog.body.tasks.every(t => t.status === 'backlog'),
      'and everything it returns carries that status');
    ok(backlog.body.tasks.length === 2, 'exactly the two backlog tasks');

    const review = await request('GET', `${base}?status=review`);
    ok(review.body.tasks.length === 1 && review.body.tasks[0].id === third.body.task.id,
      'a different status selects a different task');

    // An unknown value must say so rather than quietly returning everything.
    const bogus = await request('GET', `${base}?status=nonsense`);
    ok(bogus.status === 400, 'an unknown status is rejected, not ignored');
    ok(bogus.body.code === 'INVALID_STATUS_FILTER', 'and carries a machine-readable code');
    ok(String(bogus.body.error).includes('backlog'),
      'the error names the values that would work');

    const alpha = await request('GET', `${base}?tag=alpha`);
    ok(alpha.body.tasks.length === 2, 'tag selects the two tasks carrying it');
    ok(alpha.body.tasks.every(t => t.tags.includes('alpha')), 'and only those');
    const missing = await request('GET', `${base}?tag=does-not-exist`);
    ok(missing.body.tasks.length === 0, 'an unmatched tag returns nothing, not everything');

    const combined = await request('GET', `${base}?status=backlog&tag=alpha`);
    ok(combined.body.tasks.length === 1, 'filters combine rather than override each other');

    for (const label of checks) console.log(`  ok - ${label}`);
    console.log(`\n✅ Task list filters (T-463): all ${checks.length} checks passed`);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await new Promise(resolve => child.once('exit', resolve));
    }
    fs.rmSync(path.join(projectsDir, project), { recursive: true, force: true });
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
