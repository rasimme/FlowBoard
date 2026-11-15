// T-521 — checkpoint discipline hooks, unit-tested without the SDK.
import assert from 'node:assert/strict';
import { readCommit, taskIdsIn, agentIdFrom, checkpointMessage, createTaskDiscipline, registerTaskDiscipline, REMINDER_KEY } from '../openclaw/task-discipline.js';

let passed = 0; let failed = 0;
async function check(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok - ${name}`); } catch (e) { failed += 1; console.log(`  not ok - ${name}\n     ${e.message}`); }
}
const OUT = '[feat/x 1a2b3c4d5] fix(api): thing (T-12-3)\n 2 files changed';
function fakeAdapter(over = {}) {
  const calls = [];
  return {
    calls,
    getStatus: async (a, s) => { calls.push(['status', a, s]); return { activeProject: 'demo' }; },
    getTask: async (p, id) => { calls.push(['task', p, id]); return { agent: 'dev', claimedAt: 'x', status: 'in-progress' }; },
    addCheckpoint: async (p, id, body) => { calls.push(['checkpoint', p, id, body]); return {}; },
    listStuck: async () => ({ stale: [{ project: 'demo', taskId: 'T-1', agent: 'dev' }, { project: 'demo', taskId: 'T-2', agent: 'other' }], expired: [] }),
    ...over,
  };
}
const ctx = { agentId: 'dev', sessionKey: 'agent:dev:main', toolCallId: 'c1' };
const commitEvent = (extra = {}) => ({ toolName: 'exec', params: { command: 'cd repo && git commit -q -m "fix(api): thing (T-12-3)"' }, result: { output: OUT }, ...extra });

console.log('# task discipline hooks (T-521)');
await check('reads sha and subject from git output', () => assert.deepEqual(readCommit(commitEvent()), { sha: '1a2b3c4d5', subject: 'fix(api): thing (T-12-3)' }));
await check('quiet commit needs exit code 0', () => {
  assert.equal(readCommit(commitEvent({ result: { output: '' } })), null);
  assert.deepEqual(readCommit(commitEvent({ result: { exitCode: 0 } })), { sha: null, subject: 'fix(api): thing (T-12-3)' });
});
await check('failed, dry-run and non-commit calls are ignored', () => {
  assert.equal(readCommit(commitEvent({ error: 'boom' })), null);
  assert.equal(readCommit({ params: { command: 'git commit --dry-run -m "T-1"' }, result: { exitCode: 0 } }), null);
  assert.equal(readCommit({ params: { command: 'git status' }, result: { output: OUT } }), null);
  assert.equal(readCommit({ params: {}, result: OUT }), null);
});
await check('task ids are deduplicated and bounded', () => assert.deepEqual(taskIdsIn('T-1 T-1 T-2-3 T-4 T-5 XT-9'), ['T-1', 'T-2-3', 'T-4']));
await check('agent id falls back to the session key', () => {
  assert.equal(agentIdFrom({}, 'agent:main:telegram:1'), 'main');
  assert.equal(agentIdFrom({}, 'weird'), null);
});
await check('checkpoint message is bounded', () => assert.equal(checkpointMessage({ sha: 'abc', subject: 'x'.repeat(400) }).length, 256));
await check('a commit naming a held task records one checkpoint', async () => {
  const adapter = fakeAdapter();
  const hooks = createTaskDiscipline({ adapter });
  await hooks.onAfterToolCall(commitEvent(), ctx);
  await hooks.onAfterToolCall(commitEvent(), ctx); // same tool call id
  const cps = adapter.calls.filter((c) => c[0] === 'checkpoint');
  assert.equal(cps.length, 1);
  assert.deepEqual(cps[0].slice(1, 3), ['demo', 'T-12-3']);
  assert.equal(cps[0][3].agent, 'dev');
  assert.equal(cps[0][3].sessionKey, 'agent:dev:main');
  assert.match(cps[0][3].message, /^Commit 1a2b3c4d5: fix/);
});
await check('no checkpoint without a claim, a project or a task id', async () => {
  for (const over of [
    { getTask: async () => ({ agent: 'other', claimedAt: 'x', status: 'in-progress' }) },
    { getTask: async () => ({ agent: 'dev', claimedAt: null, status: 'in-progress' }) },
    { getTask: async () => ({ agent: 'dev', claimedAt: 'x', status: 'review' }) },
    { getStatus: async () => ({ activeProject: null }) },
  ]) {
    const adapter = fakeAdapter(over);
    await createTaskDiscipline({ adapter }).onAfterToolCall(commitEvent(), { ...ctx, toolCallId: undefined });
    assert.equal(adapter.calls.filter((c) => c[0] === 'checkpoint').length, 0);
  }
  const adapter = fakeAdapter();
  await createTaskDiscipline({ adapter }).onAfterToolCall({ params: { command: 'git commit -m "no id"' }, result: { exitCode: 0 } }, ctx);
  assert.equal(adapter.calls.length, 0);
});
await check('an adapter failure never throws out of the hook', async () => {
  const hooks = createTaskDiscipline({ adapter: fakeAdapter({ getStatus: async () => { throw new Error('down'); }, listStuck: async () => { throw new Error('down'); } }) });
  await hooks.onAfterToolCall(commitEvent(), ctx);
  assert.equal(await hooks.onBeforeAgentFinalize({ stopHookActive: false, sessionKey: 'agent:dev:main' }, {}), undefined);
});
await check('finalize asks once for a stale claim of this agent only', async () => {
  const hooks = createTaskDiscipline({ adapter: fakeAdapter() });
  const r = await hooks.onBeforeAgentFinalize({ stopHookActive: false, sessionKey: 'agent:dev:main' }, {});
  assert.equal(r.action, 'revise');
  assert.equal(r.retry.idempotencyKey, REMINDER_KEY);
  assert.equal(r.retry.maxAttempts, 1);
  assert.match(r.retry.instruction, /demo\/T-1/);
  assert.equal(/T-2/.test(r.retry.instruction), false);
  assert.equal(await hooks.onBeforeAgentFinalize({ stopHookActive: true, sessionKey: 'agent:dev:main' }, {}), undefined);
  assert.equal(await hooks.onBeforeAgentFinalize({ stopHookActive: false, sessionKey: 'agent:idle:main' }, {}), undefined);
});
await check('registration follows config and host support', () => {
  const on = []; const api = { on: (n, h, o) => on.push([n, o]) };
  assert.deepEqual(registerTaskDiscipline(api, { adapter: fakeAdapter() }), ['after_tool_call']);
  assert.deepEqual(on[0][1].matcher, ['exec']);
  assert.deepEqual(registerTaskDiscipline(api, { adapter: fakeAdapter(), config: { commitCheckpoints: false, finalizeReminder: true } }), ['before_agent_finalize']);
  assert.deepEqual(registerTaskDiscipline({}, { adapter: fakeAdapter() }), []);
  assert.deepEqual(registerTaskDiscipline({ on: () => { throw new Error('unknown hook'); } }, { adapter: fakeAdapter() }), []);
});
// --- against a real isolated dashboard: adapter methods + hook end to end ---
{
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { withIsolatedDashboard } = require('./test-support/server-harness.js');
  const { createFlowBoardAdapter } = await import('../openclaw/adapter.js');
  await withIsolatedDashboard(async ({ base, api }) => {
    const adapter = createFlowBoardAdapter({ dashboardBaseUrl: base });
    const AGENT = 'dev-worker'; const SESSION = 'agent:dev-worker:main';
    await api('POST', '/projects', { name: 'disc-fixture', displayName: 'Discipline', description: 'T-521 fixture.' });
    const held = (await api('POST', '/projects/disc-fixture/tasks', { title: 'Held by the agent', status: 'open', description: 'x' })).body?.task?.id;
    const free = (await api('POST', '/projects/disc-fixture/tasks', { title: 'Not claimed at all', status: 'open', description: 'x' })).body?.task?.id;
    await api('POST', `/projects/disc-fixture/tasks/${held}/claim`, { agent: AGENT, sessionKey: SESSION });
    const hooks = createTaskDiscipline({ adapter });
    const event = (id, callId) => ({ toolName: 'exec', toolCallId: callId, params: { command: `git commit -m "feat: work (${id})"` }, result: { output: `[dev 0123abc] feat: work (${id})` } });
    const count = async (id) => ((await api('GET', `/projects/disc-fixture/tasks/${id}/checkpoints`)).body?.checkpoints || []).length;

    await check('HTTP: the claim bound the session, so the hook finds the project', async () => {
      assert.equal((await adapter.getStatus(AGENT, SESSION)).activeProject, 'disc-fixture');
    });
    await check('HTTP: a commit naming the held task writes a checkpoint', async () => {
      await hooks.onAfterToolCall(event(held, 'h1'), { agentId: AGENT, sessionKey: SESSION });
      const cps = (await api('GET', `/projects/disc-fixture/tasks/${held}/checkpoints`)).body.checkpoints;
      assert.equal(cps.length, 1);
      assert.match(cps[0].message, /^Commit 0123abc: feat: work/);
      assert.equal(cps[0].agent, AGENT);
    });
    await check('HTTP: an unclaimed task and an unbound session get nothing', async () => {
      await hooks.onAfterToolCall(event(free, 'h2'), { agentId: AGENT, sessionKey: SESSION });
      assert.equal(await count(free), 0);
      await hooks.onAfterToolCall(event(held, 'h3'), { agentId: AGENT, sessionKey: 'agent:dev-worker:other' });
      assert.equal(await count(held), 1);
    });
    await check('HTTP: stuck list has the shape the finalize hook reads; a fresh claim asks nothing', async () => {
      const stuck = await adapter.listStuck();
      assert.ok(Array.isArray(stuck.stale) && Array.isArray(stuck.expired));
      assert.equal(await hooks.onBeforeAgentFinalize({ stopHookActive: false, sessionKey: SESSION }, {}), undefined);
    });
  }, { prefix: 'flowboard-task-discipline-' });
}

console.log(`\n# results: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
