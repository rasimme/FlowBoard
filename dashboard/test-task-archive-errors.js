'use strict';

/**
 * T-419: PUT /api/projects/:name/tasks/:id archive/validation errors must surface
 * as actionable client errors (400/409 with the real message), not a generic
 * 500 "Internal server error". The validation itself is intentional (a subtask
 * archives only via its parent; a parent archives only once its children are
 * done) — this pins the HTTP status + message, not the rule.
 */

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = __dirname;
const PORT = 18841;
const PROJECT = 'archive-errors';

let pass = 0, fail = 0;
const failures = [];
function ok(c, m) { if (c) { pass++; console.log(`  ok - ${m}`); } else { fail++; failures.push(m); console.log(`  not ok - ${m}`); } }

async function api(base, method, urlPath, body) {
  const res = await fetch(base + urlPath, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
}
async function waitForServer(base, child) {
  const t = Date.now();
  while (Date.now() - t < 10000) {
    if (child.exitCode !== null) throw new Error(`dashboard exited early with ${child.exitCode}`);
    try { if ((await fetch(base + '/api/health', { signal: AbortSignal.timeout(300) })).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('dashboard did not become ready');
}

async function run() {
  console.log('# task archive/validation error classification (T-419)');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-archerr-'));
  fs.mkdirSync(path.join(tmp, 'workspace/projects'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'projects'), { recursive: true });
  const base = `http://127.0.0.1:${PORT}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, FLOWBOARD_PORT: String(PORT), FLOWBOARD_HOST: '127.0.0.1',
      OPENCLAW_WORKSPACE: path.join(tmp, 'workspace'), FLOWBOARD_PROJECTS_DIR: path.join(tmp, 'projects'),
      HZL_DB_PATH: path.join(tmp, 'fb.db'), NODE_ENV: 'test', TELEGRAM_BOT_TOKEN: '', TELEGRAM_BOT_TOKENS: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await waitForServer(base, child);
    await api(base, 'POST', '/api/projects', { name: PROJECT });
    const P = `/api/projects/${PROJECT}`;
    const parent = (await api(base, 'POST', `${P}/tasks`, { title: 'parent', status: 'open' })).body.task;
    const childTask = (await api(base, 'POST', `${P}/tasks`, { title: 'child', parentId: parent.id, status: 'open' })).body.task;

    // Archiving a subtask individually → 400 with the actionable message (not 500).
    let r = await api(base, 'PUT', `${P}/tasks/${childTask.id}`, { status: 'archived' });
    ok(r.status === 400, `archive subtask → 400, not 500 (got ${r.status})`);
    ok(/subtask/i.test(r.body?.error || ''), `archive subtask → message names the cause (got: ${r.body?.error})`);

    // Archiving a parent whose child is not done → 409 with the actionable message (not 500).
    r = await api(base, 'PUT', `${P}/tasks/${parent.id}`, { status: 'archived' });
    ok(r.status === 409, `archive parent with not-done child → 409, not 500 (got ${r.status})`);
    ok(/not done/i.test(r.body?.error || ''), `archive parent → message explains children not done (got: ${r.body?.error})`);

    // Once the child is done, archiving the parent works (rule unchanged).
    await api(base, 'PUT', `${P}/tasks/${childTask.id}`, { status: 'done' });
    r = await api(base, 'PUT', `${P}/tasks/${parent.id}`, { status: 'archived' });
    ok(r.status === 200 && r.body?.task?.status === 'archived', `archive parent with done child → 200 archived (got ${r.status}/${r.body?.task?.status})`);
  } finally {
    child.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 300));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n# results: ${pass} passed, ${fail} failed`);
  if (fail > 0) { console.log('# failures:'); failures.forEach(f => console.log(`#   - ${f}`)); process.exitCode = 1; }
}
run().catch(e => { console.error('# fatal:', e.message); process.exitCode = 1; });
