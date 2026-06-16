'use strict';

/**
 * Regression for T-295 (B1): a PUT on a parent task must return the parent
 * with its subtaskIds populated, not an empty array. The empty array was
 * what wiped the client's subtask list (flicker) and silently broke the
 * priority cascade and parent-status recalc.
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

let pass = 0, fail = 0, failures = [];
const ok = (c, m) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; failures.push(m); console.log(`  ❌ ${m}`); } };

const PORT = 18802;
const WORKSPACE = path.join(__dirname, 'test-workspace');
const HZL_DB_PATH = path.join(WORKSPACE, '.hzl', 'flowboard-kanban-subtask-state.db');
const PROJECT = 'kanban-subtask-state-proj';

if (fs.existsSync(HZL_DB_PATH)) { try { fs.unlinkSync(HZL_DB_PATH); } catch {} }
// Remove any stale scaffold so POST /api/projects creates it cleanly.
fs.rmSync(path.join(WORKSPACE, 'projects', PROJECT), { recursive: true, force: true });
fs.mkdirSync(path.join(WORKSPACE, 'projects'), { recursive: true });

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ hostname: '127.0.0.1', port: PORT, path: p, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} },
      (res) => { let raw = ''; res.on('data', d => raw += d); res.on('end', () => {
        let parsed = null; try { parsed = JSON.parse(raw); } catch {}
        resolve({ statusCode: res.statusCode, body: parsed }); }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

async function waitForServer() {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try { const r = await req('GET', '/api/projects'); if (r.statusCode === 200) return; } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('server did not start');
}

async function run() {
  const server = spawn('node', ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, HZL_DB_PATH, FLOWBOARD_PORT: PORT, OPENCLAW_WORKSPACE: WORKSPACE,
      FLOWBOARD_PROJECTS_DIR: path.join(WORKSPACE, 'projects'), NODE_ENV: 'test' },
    stdio: 'pipe',
  });
  await waitForServer();

  try {
    console.log('\n## PUT on parent returns populated subtaskIds (T-295)\n');

    // Register the project in HZL (POST /tasks requires projectExists).
    await req('POST', '/api/projects', { name: PROJECT, displayName: 'Kanban Subtask State' });

    const parent = (await req('POST', `/api/projects/${PROJECT}/tasks`, { title: 'Parent task', priority: 'medium' })).body.task;
    const s1 = (await req('POST', `/api/projects/${PROJECT}/tasks`, { title: 'Sub one', parentId: parent.id })).body.task;
    const s2 = (await req('POST', `/api/projects/${PROJECT}/tasks`, { title: 'Sub two', parentId: parent.id })).body.task;
    ok(parent && s1 && s2, 'created parent + 2 subtasks');
    ok(s1.id.startsWith(parent.id + '-') && s2.id.startsWith(parent.id + '-'), 'subtask ids derive from parent');

    // The bug: PUT the parent (priority change) → response must still list both subtasks.
    const put = await req('PUT', `/api/projects/${PROJECT}/tasks/${parent.id}`, { priority: 'high' });
    ok(put.statusCode === 200, 'PUT parent priority returns 200');
    const ids = (put.body.task.subtaskIds || []).slice().sort();
    ok(ids.length === 2, `PUT response carries both subtaskIds (got ${ids.length}: ${ids.join(',')})`);
    ok(ids.includes(s1.id) && ids.includes(s2.id), 'subtaskIds contain both children');

    // subtaskIds stay numerically ordered
    const ordered = put.body.task.subtaskIds;
    ok(ordered[0] === `${parent.id}-1` && ordered[1] === `${parent.id}-2`, 'subtaskIds numerically ordered');

    // Priority cascade (was silently broken by the wipe): subtasks inherit the new priority.
    const after = (await req('GET', `/api/projects/${PROJECT}/tasks`)).body.tasks;
    const sub1 = after.find(t => t.id === s1.id);
    ok(sub1.priority === 'high', `priority cascade reached subtask (got ${sub1.priority})`);

    // A status PUT on the parent also keeps subtaskIds.
    const put2 = await req('PUT', `/api/projects/${PROJECT}/tasks/${parent.id}`, { status: 'open' });
    ok((put2.body.task.subtaskIds || []).length === 2, 'status PUT also returns populated subtaskIds');
  } catch (e) {
    fail++; console.error('Test error:', e.message);
  } finally {
    server.kill();
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail > 0) { console.log('Failures:', failures); process.exit(1); }
    process.exit(0);
  }
}
run().catch(e => { console.error(e); process.exit(1); });
