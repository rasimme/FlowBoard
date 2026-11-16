'use strict';

/**
 * T-526: checkpoint and complete need the caller's own claim.
 *
 * Agents used to checkpoint tasks they had never claimed: the service only
 * checked the owner when the task already had one, so the write succeeded
 * silently. The agent-facing routes now refuse with 409 NOT_CLAIMED and a body
 * that teaches the next call. Internal workflows (handoff, delegate) still
 * write through the service and are not gated; the commit-checkpoint hook only
 * ever writes to a live claim and is unaffected.
 */

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const claimGate = require('./claim-gate.js');

const ROOT = __dirname;
const PORT = 18871;
const PROJECT = 'claim-gate';
const P = `/api/projects/${PROJECT}`;

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

function unitTests() {
  console.log('# claim gate (unit)');
  const opts = { project: 'p', taskId: 'T-1', agent: 'a', action: 'checkpoint', message: 'm', progress: 5 };
  ok(claimGate.notClaimedRefusal(null, opts) === null, 'unknown task is left to the service (404)');
  ok(claimGate.notClaimedRefusal({ agent: 'a', claimedAt: 'x', status: 'in-progress', leaseUntil: '2000-01-01T00:00:00.000Z' }, opts) === null,
    'own claim with an expired lease passes (checkpoint renews it)');
  ok(claimGate.notClaimedRefusal({ agent: 'b', claimedAt: 'x', status: 'in-progress' }, opts) === null,
    'live claim of another agent passes on to the service (NOT_OWNER)');
  ok(claimGate.notClaimedRefusal({ agent: 'a', claimedAt: null, status: 'review' }, opts) === null,
    'own finished task passes (closing checkpoint after complete)');
  const unclaimed = claimGate.notClaimedRefusal({ agent: null, claimedAt: null, status: 'backlog' }, opts);
  ok(unclaimed?.code === 'NOT_CLAIMED', 'never claimed -> NOT_CLAIMED');
  ok(claimGate.notClaimedRefusal({ agent: 'a', claimedAt: null, status: 'open' }, opts)?.code === 'NOT_CLAIMED',
    'own released claim (agent kept as history) -> NOT_CLAIMED');
  ok(claimGate.notClaimedRefusal({ agent: 'b', claimedAt: null, status: 'review' }, opts)?.code === 'NOT_CLAIMED',
    'another agent\'s finished task -> NOT_CLAIMED');
  const complete = claimGate.notClaimedRefusal({ agent: null }, { ...opts, action: 'complete' });
  ok(complete?.code === 'NOT_CLAIMED' && !('rejected' in complete), 'complete refusal has no checkpoint echo');
  let threw = false;
  try { claimGate.notClaimedRefusal({}, { ...opts, action: 'update' }); } catch { threw = true; }
  ok(threw, 'unknown action is a programming error');
}

async function httpTests() {
  console.log('# claim gate (HTTP)');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-claimgate-'));
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
    for (const id of ['worker-one', 'worker-two']) await api(base, 'PUT', '/api/status', { agentId: id, project: PROJECT });
    const newTask = async (title, status = 'open') => (await api(base, 'POST', `${P}/tasks`, { title, status })).body.task;
    const checkpoints = async (id) => (await api(base, 'GET', `${P}/tasks/${id}/checkpoints`)).body.checkpoints || [];

    // 1. Unclaimed checkpoint -> 409 NOT_CLAIMED, teaches the next call, echoes the text, writes nothing.
    const t1 = await newTask('t1', 'backlog');
    const sessionKey = 'agent:worker-one:main';
    let r = await api(base, 'POST', `${P}/tasks/${t1.id}/checkpoint`, { agent: 'worker-one', message: 'did a thing', progress: 40, sessionKey });
    ok(r.status === 409 && r.body?.code === 'NOT_CLAIMED', 'unclaimed checkpoint -> 409 NOT_CLAIMED');
    ok(typeof r.body?.error === 'string' && r.body.error.includes(t1.id), 'refusal has a one-sentence error naming the task');
    ok(r.body?.hint?.method === 'POST' && r.body.hint.path === `${P}/tasks/${t1.id}/claim`, 'hint names the exact claim call');
    ok(r.body?.hint?.body?.agent === 'worker-one' && r.body.hint.body.sessionKey === sessionKey, 'hint body carries agent and the sent sessionKey');
    ok(r.body?.hint?.alternative?.path === '/api/workflows/start' && r.body.hint.alternative.body?.project === PROJECT, 'hint offers workflows/start');
    ok(r.body?.rules === `${P}/rules/agent-bridge`, 'refusal points at rules/agent-bridge');
    ok(r.body?.rejected?.message === 'did a thing' && r.body.rejected.progress === 40, 'rejected checkpoint is echoed unchanged');
    ok((await checkpoints(t1.id)).length === 0, 'refused checkpoint wrote nothing');
    r = await api(base, 'POST', `${P}/tasks/${t1.id}/checkpoint`, { agent: 'worker-one', message: 'x' });
    ok(r.status === 409 && !('sessionKey' in (r.body?.hint?.body || {})) && r.body?.rejected?.progress === null,
      'without sessionKey the hint omits it; missing progress echoes as null');
    r = await api(base, 'POST', `${P}/tasks/${t1.id}/checkpoint`, { agent: 'worker-one' });
    ok(r.status === 400, 'missing message is still a 400, before the gate');

    // 2. Unclaimed complete -> 409 NOT_CLAIMED, task untouched.
    r = await api(base, 'POST', `${P}/tasks/${t1.id}/complete`, { agent: 'worker-one' });
    ok(r.status === 409 && r.body?.code === 'NOT_CLAIMED' && !('rejected' in r.body), 'unclaimed complete -> 409 NOT_CLAIMED');
    ok((await api(base, 'GET', `${P}/tasks/${t1.id}`)).body?.task?.status === 'backlog', 'refused complete left the status alone');

    // 3. Own claim -> checkpoint 200 -> complete 200 -> closing checkpoint 200.
    ok((await api(base, 'POST', `${P}/tasks/${t1.id}/claim`, { agent: 'worker-one' })).status === 200, 'claim succeeds');
    r = await api(base, 'POST', `${P}/tasks/${t1.id}/checkpoint`, { agent: 'worker-one', message: 'did a thing', progress: 40 });
    ok(r.status === 200 && r.body?.checkpoint?.message === 'did a thing', 'resent checkpoint after claim -> 200');
    r = await api(base, 'POST', `${P}/tasks/${t1.id}/complete`, { agent: 'worker-one' });
    ok(r.status === 200 && r.body?.task?.status === 'review', 'own complete -> 200 review');
    r = await api(base, 'POST', `${P}/tasks/${t1.id}/checkpoint`, { agent: 'worker-one', message: 'closing note' });
    ok(r.status === 200, 'closing checkpoint by the finishing agent after complete -> 200');
    r = await api(base, 'POST', `${P}/tasks/${t1.id}/checkpoint`, { agent: 'worker-two', message: 'drive-by' });
    ok(r.status === 409 && r.body?.code === 'NOT_CLAIMED', 'another agent on a finished task -> NOT_CLAIMED');

    // 4. Foreign live claim stays NOT_OWNER (403) for both actions.
    const t2 = await newTask('t2');
    await api(base, 'POST', `${P}/tasks/${t2.id}/claim`, { agent: 'worker-one' });
    r = await api(base, 'POST', `${P}/tasks/${t2.id}/checkpoint`, { agent: 'worker-two', message: 'hijack' });
    ok(r.status === 403 && r.body?.code === 'NOT_OWNER', 'foreign live claim: checkpoint -> 403 NOT_OWNER');
    r = await api(base, 'POST', `${P}/tasks/${t2.id}/complete`, { agent: 'worker-two' });
    ok(r.status === 403 && r.body?.code === 'NOT_OWNER', 'foreign live claim: complete -> 403 NOT_OWNER');

    // 5. Released claim: the agent field stays as history, but there is no claim to work under.
    ok((await api(base, 'POST', `${P}/tasks/${t2.id}/release`, { agent: 'worker-one' })).status === 200, 'setup: release');
    r = await api(base, 'POST', `${P}/tasks/${t2.id}/checkpoint`, { agent: 'worker-one', message: 'after release' });
    ok(r.status === 409 && r.body?.code === 'NOT_CLAIMED', 'checkpoint after own release -> NOT_CLAIMED');
    r = await api(base, 'POST', `${P}/tasks/${t2.id}/checkpoint`, { agent: 'worker-two', message: 'after release' });
    ok(r.status === 409 && r.body?.code === 'NOT_CLAIMED', 'other agent on a released task -> NOT_CLAIMED (claim would succeed)');

    // 6. workflows/start claims, after which checkpoint works.
    await newTask('t3'); // something for workflows/start to pick
    r = await api(base, 'POST', '/api/workflows/start', { agent: 'worker-two', project: PROJECT });
    const startedId = r.body?.claimed?.id || r.body?.task?.id;
    ok(r.status === 200 && !!startedId, 'workflows/start claims a task');
    r = await api(base, 'POST', `${P}/tasks/${startedId}/checkpoint`, { agent: 'worker-two', message: 'started via workflow' });
    ok(r.status === 200, 'checkpoint after workflows/start -> 200');

    // 7. Handoff still writes its checkpoint on the unclaimed follow-on.
    const src = await newTask('handoff source');
    await api(base, 'POST', `${P}/tasks/${src.id}/claim`, { agent: 'worker-one' });
    await api(base, 'POST', `${P}/tasks/${src.id}/checkpoint`, { agent: 'worker-one', message: 'source work' });
    r = await api(base, 'POST', '/api/workflows/handoff', { project: PROJECT, fromTaskId: src.id, title: 'follow-on', agent: 'worker-two' });
    ok(r.status === 200 && r.body?.completedTask?.status === 'review', 'handoff completes the claimed source');
    const followOn = r.body?.followOnTask;
    ok(!!followOn && !followOn.claimedAt, 'follow-on is created unclaimed');
    ok((await checkpoints(followOn.id)).some(cp => /Handoff context/.test(cp.message)), 'handoff checkpoint was written on the unclaimed follow-on');
    r = await api(base, 'POST', `${P}/tasks/${followOn.id}/checkpoint`, { agent: 'worker-two', message: 'routed, not claimed' });
    ok(r.status === 409 && r.body?.code === 'NOT_CLAIMED', 'routed is not claimed: the follow-on agent must claim first');

    // 8. Delegate still writes its checkpoint on the source, claimed or not.
    const parent = await newTask('delegate parent');
    r = await api(base, 'POST', '/api/workflows/delegate', { project: PROJECT, fromTaskId: parent.id, title: 'delegated child', checkpoint: 'delegated' });
    ok(r.status === 200 && r.body?.checkpointAdded === true, 'delegate on an unclaimed source still records its checkpoint');
    ok((await checkpoints(parent.id)).some(cp => cp.message === 'delegated'), 'delegate checkpoint is stored');

    // 9. Commit-checkpoint hook (openclaw/task-discipline.js) still records on a live claim and skips otherwise.
    const { createTaskDiscipline } = await import('../openclaw/task-discipline.js');
    const { createFlowBoardAdapter } = await import('../openclaw/adapter.js');
    const hooks = createTaskDiscipline({ adapter: createFlowBoardAdapter({ dashboardBaseUrl: base }) });
    const held = await newTask('commit held');
    const notHeld = await newTask('commit not held');
    await api(base, 'POST', `${P}/tasks/${held.id}/claim`, { agent: 'worker-one' });
    const commit = (id, callId) => hooks.onAfterToolCall(
      { toolName: 'exec', toolCallId: callId, params: { command: `git commit -m "feat: x (${id})"` }, result: { output: `[feat/x abc1234] feat: x (${id})\n 1 file changed` } },
      { agentId: 'worker-one', sessionKey: 'agent:worker-one:main' },
    );
    await commit(held.id, 'c1');
    await commit(notHeld.id, 'c2');
    ok((await checkpoints(held.id)).some(cp => /^Commit abc1234/.test(cp.message)), 'commit hook records a checkpoint on the held task');
    ok((await checkpoints(notHeld.id)).length === 0, 'commit hook writes nothing to a task it does not hold');
  } finally {
    child.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 300));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function run() {
  unitTests();
  await httpTests();
  console.log(`\n# results: ${pass} passed, ${fail} failed`);
  if (fail > 0) { console.log('# failures:'); failures.forEach(f => console.log(`#   - ${f}`)); process.exitCode = 1; }
}
run().catch(e => { console.error('# fatal:', e.message); process.exitCode = 1; });
