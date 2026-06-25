'use strict';

/**
 * T-422-2 (5.0.5): DELETE /api/agents/:id?force=true is a privileged,
 * high-blast-radius action — it force-releases another agent's LIVE task
 * claims and then deletes the agent row. Before 5.0.5 it did this with no
 * confirmation and no audit trail. Now:
 *  - force-delete that would yank live claims requires {confirmation:"force-delete-agent"};
 *  - every successful agent deletion writes an audit-log line (force vs plain);
 *  - force-delete of an agent with NO live claims stays ungated (nothing to yank);
 *  - the existing non-force 409-on-active-claims behavior is unchanged.
 */

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = __dirname;
const PORT = 18844;
const PROJECT = 'agent-del-guard';

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
  console.log('# force-agent-delete confirmation + audit (T-422-2)');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-agentdel-'));
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

    // Setup: three tasks, three registered agents; worker-one + worker-three each hold a live claim.
    const t1 = (await api(base, 'POST', `${P}/tasks`, { title: 't1', status: 'open' })).body.task;
    const t3 = (await api(base, 'POST', `${P}/tasks`, { title: 't3', status: 'open' })).body.task;
    for (const id of ['worker-one', 'worker-two', 'worker-three']) {
      await api(base, 'PUT', '/api/status', { agentId: id, project: PROJECT });
    }
    ok((await api(base, 'POST', `${P}/tasks/${t1.id}/claim`, { agent: 'worker-one' })).status === 200, 'setup: worker-one claims t1');
    ok((await api(base, 'POST', `${P}/tasks/${t3.id}/claim`, { agent: 'worker-three' })).status === 200, 'setup: worker-three claims t3');

    // 1. force-delete that would yank a LIVE claim, no confirmation → 400 and NO deletion.
    let r = await api(base, 'DELETE', '/api/agents/worker-one?force=true');
    ok(r.status === 400 && r.body?.code === 'CONFIRMATION_REQUIRED', 'force-delete (live claim) without confirmation → 400');
    let stillThere = JSON.stringify((await api(base, 'GET', '/api/agents')).body).includes('worker-one');
    ok(stillThere, 'rejected force-delete did NOT remove the agent row');

    // 2. wrong token → 400
    r = await api(base, 'DELETE', '/api/agents/worker-one?force=true', { confirmation: 'empty-trash' });
    ok(r.status === 400 && r.body?.code === 'CONFIRMATION_REQUIRED', 'force-delete with WRONG token → 400');

    // 3. token in the query string (not body) → 400
    r = await api(base, 'DELETE', '/api/agents/worker-one?force=true&confirmation=force-delete-agent');
    ok(r.status === 400 && r.body?.code === 'CONFIRMATION_REQUIRED', 'force-delete with token in query string → 400');

    // 4. correct token → 200, deletes + releases the claim
    r = await api(base, 'DELETE', '/api/agents/worker-one?force=true', { confirmation: 'force-delete-agent' });
    ok(r.status === 200 && r.body?.deleted === true && r.body?.releasedClaims === 1, 'force-delete with correct confirmation → 200, releasedClaims:1');

    // 5. force-delete of an agent with NO live claims stays ungated.
    r = await api(base, 'DELETE', '/api/agents/worker-two?force=true');
    ok(r.status === 200 && r.body?.deleted === true, 'force-delete of claim-less agent stays ungated → 200');

    // 6. non-force delete with active claims is unchanged: 409.
    r = await api(base, 'DELETE', '/api/agents/worker-three');
    ok(r.status === 409, 'non-force delete with active claims → 409 (unchanged)');

    // 7. audit trail: force-delete and plain delete both recorded.
    const auditLog = path.join(tmp, 'projects', '.audit', 'destructive.log');
    const entries = fs.existsSync(auditLog)
      ? fs.readFileSync(auditLog, 'utf8').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return {}; } })
      : [];
    const actions = new Set(entries.map(e => e.action));
    ok(actions.has('agent.force-delete'), 'audit log recorded agent.force-delete');
    ok(actions.has('agent.delete'), 'audit log recorded agent.delete (claim-less)');
    const forceEntry = entries.find(e => e.action === 'agent.force-delete');
    ok(forceEntry && /worker-one/.test(forceEntry.target || ''), 'force-delete audit names the agent');
    ok(entries.length > 0 && entries.every(e => e.actor && e.ts), 'every audit entry has actor + ts');
  } finally {
    child.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 300));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n# results: ${pass} passed, ${fail} failed`);
  if (fail > 0) { console.log('# failures:'); failures.forEach(f => console.log(`#   - ${f}`)); process.exitCode = 1; }
}
run().catch(e => { console.error('# fatal:', e.message); process.exitCode = 1; });
