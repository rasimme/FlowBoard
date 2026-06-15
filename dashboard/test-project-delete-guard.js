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

    // The intended safe path: deactivate keeps the project + data.
    const deact = await api(base, 'PUT', `/api/projects/${P}`, { archived: true });
    ok(deact.status === 200, 'PUT { archived:true } deactivates (200, data kept)');
    ok((await listNames(base)).includes(P), 'deactivated project is still present (not deleted)');

    // Deliberate hard-delete with the explicit flag → succeeds.
    const del = await api(base, 'DELETE', `/api/projects/${P}?confirm=${P}&hardDelete=true`);
    ok(del.status === 200 && del.body?.ok === true, 'DELETE confirm + hardDelete=true → 200 (deliberate)');
    ok(!(await listNames(base)).includes(P), 'project gone after acknowledged hard-delete');

    // Body-form acknowledgement also works (not only the query flag).
    const P2 = 'guard-test-2';
    await api(base, 'POST', '/api/projects', { name: P2 });
    const delBody = await api(base, 'DELETE', `/api/projects/${P2}?confirm=${P2}`, { hardDelete: true });
    ok(delBody.status === 200, 'hardDelete:true in the body is also accepted');
  } finally {
    child.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 300));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n# results: ${pass} passed, ${fail} failed`);
  if (fail > 0) { console.log('# failures:'); failures.forEach(f => console.log(`#   - ${f}`)); process.exitCode = 1; }
}
run().catch(e => { console.error('# fatal:', e.message); process.exitCode = 1; });
