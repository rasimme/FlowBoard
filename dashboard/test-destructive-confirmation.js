'use strict';

/**
 * T-417-23: typed-confirmation on high-blast-radius destructive endpoints
 * (ClawHub #7b — "batch-delete lacks explicit confirmation"; also the accident
 * class that hard-deleted a live project by mistake). Each of the four
 * highest-blast-radius DELETEs requires a specific {confirmation:<token>} in the
 * body; without it the server returns 400 CONFIRMATION_REQUIRED and does nothing.
 * Single-item deletes and reversible ops stay ungated.
 */

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = __dirname;
const PORT = 18839;
const PROJECT = 'destructive-confirm';

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
  console.log('# destructive-action typed confirmation (T-417-23)');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-confirm-'));
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

    // 1. Task hard-delete cascade (?mode=all)
    const parent = (await api(base, 'POST', `${P}/tasks`, { title: 'parent', status: 'open' })).body.task;
    await api(base, 'POST', `${P}/tasks`, { title: 'child', parentId: parent.id, status: 'open' });
    let r = await api(base, 'DELETE', `${P}/tasks/${parent.id}?mode=all`);
    ok(r.status === 400 && r.body?.code === 'CONFIRMATION_REQUIRED', 'tasks mode=all without confirmation → 400');
    r = await api(base, 'DELETE', `${P}/tasks/${parent.id}?mode=all`, { confirmation: 'delete-task-cascade' });
    ok(r.status === 200, 'tasks mode=all with confirmation → 200');

    // single-item delete stays UNGATED
    const solo = (await api(base, 'POST', `${P}/tasks`, { title: 'solo', status: 'open' })).body.task;
    ok((await api(base, 'DELETE', `${P}/tasks/${solo.id}`)).status === 200, 'single task delete stays ungated (no confirmation needed)');

    // 2. Empty trash
    const t2 = (await api(base, 'POST', `${P}/tasks`, { title: 'trashme', status: 'open' })).body.task;
    await api(base, 'PUT', `${P}/tasks/${t2.id}`, { trashedAt: new Date().toISOString() });
    r = await api(base, 'DELETE', `${P}/tasks/trash`);
    ok(r.status === 400 && r.body?.code === 'CONFIRMATION_REQUIRED', 'empty-trash without confirmation → 400');
    r = await api(base, 'DELETE', `${P}/tasks/trash`, { confirmation: 'empty-trash' });
    ok(r.status === 200, 'empty-trash with confirmation → 200');

    // 3. Canvas notes batch delete
    const n1 = (await api(base, 'POST', `${P}/canvas/notes`, { text: 'a' })).body.note;
    const n2 = (await api(base, 'POST', `${P}/canvas/notes`, { text: 'b' })).body.note;
    r = await api(base, 'DELETE', `${P}/canvas/notes/batch`, { noteIds: [n1.id, n2.id] });
    ok(r.status === 400 && r.body?.code === 'CONFIRMATION_REQUIRED', 'notes/batch without confirmation → 400');
    r = await api(base, 'DELETE', `${P}/canvas/notes/batch`, { noteIds: [n1.id, n2.id], confirmation: 'delete-notes' });
    ok(r.status === 204, 'notes/batch with confirmation → 204');

    // 4. Canvas connections delete
    const a = (await api(base, 'POST', `${P}/canvas/notes`, { text: 'A' })).body.note;
    const b = (await api(base, 'POST', `${P}/canvas/notes`, { text: 'B' })).body.note;
    await api(base, 'POST', `${P}/canvas/connections`, { from: a.id, to: b.id });
    r = await api(base, 'DELETE', `${P}/canvas/connections`, { from: a.id, to: b.id });
    ok(r.status === 400 && r.body?.code === 'CONFIRMATION_REQUIRED', 'connections delete without confirmation → 400');
    r = await api(base, 'DELETE', `${P}/canvas/connections`, { from: a.id, to: b.id, confirmation: 'delete-connections' });
    ok(r.status === 200, 'connections delete with confirmation → 200');
  } finally {
    child.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 300));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n# results: ${pass} passed, ${fail} failed`);
  if (fail > 0) { console.log('# failures:'); failures.forEach(f => console.log(`#   - ${f}`)); process.exitCode = 1; }
}
run().catch(e => { console.error('# fatal:', e.message); process.exitCode = 1; });
