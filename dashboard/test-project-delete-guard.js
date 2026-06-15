'use strict';

// Guardrail for accidental project hard-delete (T-357). After dev-botti
// hard-deleted a live project meaning to deactivate it, the destructive
// DELETE now requires an explicit hardDelete acknowledgement on top of
// ?confirm=<name>, and a bare confirm is rejected with guidance toward the
// reversible PUT { archived:true } deactivate path.

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = __dirname;
const PORT = 18837;

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
async function listNames(base) {
  const r = await api(base, 'GET', '/api/projects');
  const ps = Array.isArray(r.body) ? r.body : (r.body?.projects || []);
  return ps.map(p => (typeof p === 'string' ? p : p.name));
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
  console.log('# project hard-delete guardrail (T-357)');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-delguard-'));
  fs.mkdirSync(path.join(tmp, 'workspace/projects'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'projects'), { recursive: true });
  const base = `http://127.0.0.1:${PORT}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, FLOWBOARD_PORT: String(PORT), FLOWBOARD_HOST: '127.0.0.1', OPENCLAW_WORKSPACE: path.join(tmp, 'workspace'), FLOWBOARD_PROJECTS_DIR: path.join(tmp, 'projects'), HZL_DB_PATH: path.join(tmp, 'fb.db'), NODE_ENV: 'test', TELEGRAM_BOT_TOKEN: '', TELEGRAM_BOT_TOKENS: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await waitForServer(base, child);
    const P = 'guard-test';
    await api(base, 'POST', '/api/projects', { name: P });
    ok((await listNames(base)).includes(P), 'project created and listed');

    // Bare DELETE (no confirm) → 400 mismatch (unchanged).
    ok((await api(base, 'DELETE', `/api/projects/${P}`)).status === 400, 'DELETE without confirm → 400');

    // confirm only (dev-botti's exact mistake) → 400, NOT deleted, guidance given.
    const guarded = await api(base, 'DELETE', `/api/projects/${P}?confirm=${P}`);
    ok(guarded.status === 400 && guarded.body?.code === 'HARD_DELETE_NOT_ACKNOWLEDGED',
      'DELETE confirm-only → 400 HARD_DELETE_NOT_ACKNOWLEDGED');
    ok(/archived/i.test(guarded.body?.error || '') && /PUT \/api\/projects/i.test(guarded.body?.error || ''),
      'guidance points to the PUT { archived:true } deactivate path');
    ok((await listNames(base)).includes(P), 'project still exists after the blocked delete');

    // T-358 two-step: even WITH the ack, a non-archived (live) project is refused.
    const live = await api(base, 'DELETE', `/api/projects/${P}?confirm=${P}&hardDelete=true`);
    ok(live.status === 409 && live.body?.code === 'NOT_ARCHIVED',
      'DELETE of a non-archived project → 409 NOT_ARCHIVED (must deactivate first)');
    ok((await listNames(base)).includes(P), 'live project still present after the refused delete');

    // Step 1 — deactivate (reversible, keeps data).
    const deact = await api(base, 'PUT', `/api/projects/${P}`, { archived: true });
    ok(deact.status === 200, 'PUT { archived:true } deactivates (200, data kept)');
    ok((await listNames(base)).includes(P), 'deactivated project is still present (not deleted)');

    // Step 2 — now the deliberate hard-delete (archived + confirm + ack) succeeds.
    const del = await api(base, 'DELETE', `/api/projects/${P}?confirm=${P}&hardDelete=true`);
    ok(del.status === 200 && del.body?.ok === true, 'archived + confirm + hardDelete → 200 (deliberate two-step)');
    ok(!(await listNames(base)).includes(P), 'project gone after the acknowledged two-step delete');

    // T-358 restore round-trip: the deleted project is listed under /deleted, and
    // restore brings it back (untombstone + dir move from .trash).
    const deletedList = await api(base, 'GET', '/api/projects/deleted');
    ok((deletedList.body?.projects || []).some(d => d.name === P), 'deleted project appears in GET /api/projects/deleted');
    const restored = await api(base, 'POST', `/api/projects/${P}/restore`);
    ok(restored.status === 200 && restored.body?.ok === true, 'POST /api/projects/<name>/restore → 200');
    ok((await listNames(base)).includes(P), 'restored project is listed again');
    ok(!((await api(base, 'GET', '/api/projects/deleted')).body?.projects || []).some(d => d.name === P),
      'restored project no longer appears under /deleted');

    // Body-form ack also works (still subject to the archived precondition).
    const P2 = 'guard-test-2';
    await api(base, 'POST', '/api/projects', { name: P2 });
    await api(base, 'PUT', `/api/projects/${P2}`, { archived: true });
    const delBody = await api(base, 'DELETE', `/api/projects/${P2}?confirm=${P2}`, { hardDelete: true });
    ok(delBody.status === 200, 'hardDelete:true in the body is also accepted (archived project)');
  } finally {
    child.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 300));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n# results: ${pass} passed, ${fail} failed`);
  if (fail > 0) { console.log('# failures:'); failures.forEach(f => console.log(`#   - ${f}`)); process.exitCode = 1; }
}
run().catch(e => { console.error('# fatal:', e.message); process.exitCode = 1; });
