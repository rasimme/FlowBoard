'use strict';

/**
 * T-422-1 (5.0.5): lease ownership on the generic PUT /tasks/:id path.
 *
 * The workflow endpoints (complete/checkpoint/release) reject a caller asserting
 * an agent that isn't the lease holder (NOT_OWNER, HTTP 403). The generic PUT
 * update path did NOT: a caller asserting actor=Y could flip a task that agent X
 * actively leases to review/done, which auto-releases X's claim. This closes that
 * gap — a status change on an ACTIVELY-LEASED task by a DIFFERENT asserted actor
 * is rejected (403 NOT_OWNER), mirroring complete.
 *
 * Review-remediation (T-422-5): the guard keys on a LIVE lease (claimedAt /
 * leaseUntil), NOT on task.agent. task.agent is preserved as a historical
 * "soft chip" after a claim is released (T-161), so a review/done task still
 * reports its old agent with no live lease — reopening such a task by a
 * different actor must NOT be blocked (there is no claim to protect). Status is
 * 403 to match NOT_OWNER everywhere else; adminOverride is a plain force flag
 * (no reason required on this path).
 *
 * Preserved by design: an actor-LESS caller is the trusted local operator /
 * dashboard UI — the Status-Picker auto-release flow stays intact. (A
 * co-resident process that forges/omits an identity is out-of-scope under the
 * local-first single-operator trust model — accidental-clobber prevention +
 * invariant completeness, not access control.)
 */

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = __dirname;
const PORT = 18845;
const PROJECT = 'lease-own';

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
async function getTask(base, P, id) {
  const body = (await api(base, 'GET', `${P}/tasks`)).body;
  const list = Array.isArray(body) ? body : (body.tasks || []);
  return list.find(t => t.id === id) || null;
}

async function run() {
  console.log('# update lease-ownership (T-422-1 / T-422-5)');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-leaseown-'));
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
    for (const id of ['worker-one', 'worker-two']) await api(base, 'PUT', '/api/status', { agentId: id, project: PROJECT });

    // Helper: create a task and have worker-one claim it (-> in-progress, LIVE lease).
    async function claimedTask(title) {
      const t = (await api(base, 'POST', `${P}/tasks`, { title, status: 'open' })).body.task;
      ok((await api(base, 'POST', `${P}/tasks/${t.id}/claim`, { agent: 'worker-one' })).status === 200, `setup: worker-one claims ${title}`);
      return t;
    }

    // 1. A DIFFERENT asserted actor cannot flip an ACTIVELY-LEASED task -> 403 NOT_OWNER, live lease intact.
    const t1 = await claimedTask('t1');
    let r = await api(base, 'PUT', `${P}/tasks/${t1.id}`, { status: 'review', actor: 'worker-two' });
    ok(r.status === 403 && r.body?.code === 'NOT_OWNER', 'non-owner status change on live lease -> 403 NOT_OWNER');
    const after1 = await getTask(base, P, t1.id);
    ok(after1 && after1.status === 'in-progress' && after1.agent === 'worker-one' && !!after1.claimedAt,
      'rejected change left the LIVE lease intact (claimedAt still set, status in-progress)');

    // 2. The owning actor may change its own claimed task's status.
    const t2 = await claimedTask('t2');
    r = await api(base, 'PUT', `${P}/tasks/${t2.id}`, { status: 'review', actor: 'worker-one' });
    ok(r.status === 200, 'owning actor status change -> 200');

    // 3. An actor-LESS caller (trusted operator / UI) is unaffected — the
    //    Status-Picker auto-release flow still works and the lease IS released.
    const t3 = await claimedTask('t3');
    r = await api(base, 'PUT', `${P}/tasks/${t3.id}`, { status: 'review' });
    ok(r.status === 200, 'actor-less operator status change -> 200 (auto-release preserved)');
    const after3 = await getTask(base, P, t3.id);
    ok(after3 && after3.status === 'review' && !after3.claimedAt && !after3.leaseUntil,
      'operator move took effect AND released the live lease (claimedAt/leaseUntil cleared)');

    // 4. adminOverride is a plain force flag — bypasses the owner check WITHOUT requiring a reason.
    const t4 = await claimedTask('t4');
    r = await api(base, 'PUT', `${P}/tasks/${t4.id}`, { status: 'review', actor: 'worker-two', adminOverride: true });
    ok(r.status === 200, 'adminOverride (no reason) bypasses the owner check -> 200');

    // 5. Non-status edits by a non-owner are NOT gated (only status mutation disrupts the lease).
    const t5 = await claimedTask('t5');
    r = await api(base, 'PUT', `${P}/tasks/${t5.id}`, { priority: 'high', actor: 'worker-two' });
    ok(r.status === 200, 'non-owner non-status edit (priority) stays ungated -> 200');

    // 6. SOFT-CHIP REOPEN (the bug T-422-5 fixes): a task in review carries its old
    //    agent as a history chip but has NO live lease. A different actor reopening it
    //    must NOT be blocked — there is no claim to protect.
    const t6 = await claimedTask('t6');
    ok((await api(base, 'POST', `${P}/tasks/${t6.id}/complete`, { agent: 'worker-one' })).status === 200, 'setup: worker-one completes t6 -> review');
    const review6 = await getTask(base, P, t6.id);
    ok(review6 && review6.status === 'review' && review6.agent === 'worker-one' && !review6.claimedAt,
      'precondition: review task keeps soft-chip agent but has no live lease');
    r = await api(base, 'PUT', `${P}/tasks/${t6.id}`, { status: 'in-progress', actor: 'worker-two' });
    ok(r.status === 200, 'reopen-from-review by a DIFFERENT actor is allowed (no live lease) -> 200');

    // 7. Pin behavior: a non-owner moving an actively-leased task to a non-release status
    //    (backlog) is also blocked — any status change on a live lease is owner-gated.
    const t7 = await claimedTask('t7');
    r = await api(base, 'PUT', `${P}/tasks/${t7.id}`, { status: 'backlog', actor: 'worker-two' });
    ok(r.status === 403 && r.body?.code === 'NOT_OWNER', 'non-owner moving a live-leased task to backlog -> 403 NOT_OWNER');
  } finally {
    child.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 300));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n# results: ${pass} passed, ${fail} failed`);
  if (fail > 0) { console.log('# failures:'); failures.forEach(f => console.log(`#   - ${f}`)); process.exitCode = 1; }
}
run().catch(e => { console.error('# fatal:', e.message); process.exitCode = 1; });
