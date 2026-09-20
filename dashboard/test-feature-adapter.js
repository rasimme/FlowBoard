'use strict';

/**
 * T-487-8 — the Gateway adapter's stage-1 operations.
 *
 * `openclaw/adapter.js` is the only code that turns a feature operation into a
 * FlowBoard HTTP call, so two things are worth asserting there and nowhere
 * else:
 *
 *   1. **`tasks.needing-me` is FlowBoard's own answer, merged.** The review
 *      lane comes from the task API, the blocked/stalled lane from FlowBoard's
 *      stall detection (`GET /api/tasks/stuck`), and the merge is bounded: the
 *      per-project review fetch happens only where the project list already
 *      reports work in review, and never for more than MAX_REVIEW_PROJECTS.
 *      A rail that quietly turned into an N+1 scan of every project would be
 *      invisible until a big board made it slow.
 *   2. **`sessionKey` reaches `/api/status`.** T-487-2 made a binding
 *      session-scoped; if the adapter drops the key, a session-scoped switch
 *      silently rewrites the agent-level binding instead — the exact bug
 *      ADR-0039 exists to prevent.
 *
 * The request-shape tests use a fetch stub (what leaves the adapter), the HTTP
 * tests a real isolated dashboard (what FlowBoard answers).
 *
 * Run: node test-feature-adapter.js
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { withIsolatedDashboard } = require('./test-support/server-harness.js');

const ADAPTER_URL = pathToFileURL(path.resolve(__dirname, '..', 'openclaw', 'adapter.js')).href;
const SERVICE_TOKEN = crypto.randomBytes(32).toString('hex');
const PROJECT = 'rail-fixture';
const OTHER_PROJECT = 'rail-quiet';

let passed = 0;
let failed = 0;

/** Awaits async assertions: an unawaited one would outlive the fixture server. */
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ❌ ${name}\n     ${error.message}`);
  }
}

function section(title) {
  console.log(`\n## ${title}`);
}

/** Record every request and answer from a canned routing table. */
function recordingFetch(routes) {
  const calls = [];
  return {
    calls,
    fetch: async (url, init = {}) => {
      const parsed = new URL(url);
      const key = `${init.method || 'GET'} ${parsed.pathname}`;
      calls.push({
        method: init.method || 'GET',
        pathname: parsed.pathname,
        search: parsed.searchParams,
        body: init.body ? JSON.parse(init.body) : null,
        headers: init.headers || {},
      });
      const handler = routes[key] ?? routes[`${init.method || 'GET'} *`];
      const payload = typeof handler === 'function' ? handler(parsed) : handler;
      return {
        ok: true,
        status: 200,
        json: async () => payload ?? {},
      };
    },
  };
}

function projectRow(name, review = 0, blocked = 0) {
  return { name, status: 'active', taskCounts: { review, blocked, open: 0, 'in-progress': 0, done: 0, backlog: 0, archived: 0 } };
}

async function requestShapeTests() {
  const { createFlowBoardAdapter, MAX_REVIEW_PROJECTS, stuckEntryToItem, sortNeedsMe } = await import(ADAPTER_URL);

  section('status — sessionKey forwarding');
  {
    const recorder = recordingFetch({
      'GET /api/status': { activeProject: 'alpha', agentId: 'main', binding: 'session', contextReady: true, sessionKey: 's-1' },
      'PUT /api/status': { ok: true, activeProject: 'alpha', agentId: 'main', binding: 'session', contextReady: true },
    });
    const adapter = createFlowBoardAdapter({ dashboardBaseUrl: 'http://127.0.0.1:1', serviceToken: SERVICE_TOKEN }, { fetch: recorder.fetch });

    const read = await adapter.getStatus(null, { agentId: 'main', sessionKey: 's-1' });
    await check('status.get sends ?sessionKey and reports the layer that answered', () => {
      assert.equal(recorder.calls[0].search.get('agentId'), 'main');
      assert.equal(recorder.calls[0].search.get('sessionKey'), 's-1');
      assert.equal(read.binding.scope, 'session');
      assert.equal(read.binding.sessionKey, 's-1');
      assert.equal(read.binding.contextReady, true);
      assert.equal(read.activeProject, 'alpha');
    });

    await adapter.getStatus(null, { agentId: 'main' });
    await check('status.get omits the parameter entirely when there is no session', () => {
      assert.equal(recorder.calls[1].search.has('sessionKey'), false);
    });

    const write = await adapter.setStatus(null, { agentId: 'main', project: 'alpha', sessionKey: 's-1' });
    await check('status.set puts sessionKey in the body and returns the binding', () => {
      assert.deepEqual(recorder.calls[2].body, { agentId: 'main', project: 'alpha', sessionKey: 's-1' });
      assert.equal(write.binding.scope, 'session');
      assert.equal(write.activeProject, 'alpha');
    });

    await adapter.setStatus(null, { agentId: 'main', project: null, sessionKey: 's-1' });
    await check('clearing a session binding sends the documented "none" project', () => {
      assert.deepEqual(recorder.calls[3].body, { agentId: 'main', project: 'none', sessionKey: 's-1' });
    });

    await adapter.setStatus(null, { agentId: 'main', project: 'alpha' });
    await check('an agent-level switch carries no sessionKey key at all', () => {
      assert.equal(Object.prototype.hasOwnProperty.call(recorder.calls[4].body, 'sessionKey'), false);
    });
  }

  await check('an unexpected binding value is reported as "unknown", not passed through', async () => {
    const recorder = recordingFetch({ 'GET /api/status': { activeProject: null, agentId: 'main', binding: 'tenant' } });
    const adapter = createFlowBoardAdapter({ dashboardBaseUrl: 'http://127.0.0.1:1' }, { fetch: recorder.fetch });
    const read = await adapter.getStatus(null, { agentId: 'main' });
    assert.equal(read.binding.scope, null);
  });

  section('tasks.needing-me — bounded merge');
  {
    const projects = [projectRow('alpha', 2, 1), projectRow('beta', 0, 0), projectRow('gamma', 1, 0)];
    const recorder = recordingFetch({
      'GET /api/projects': { ok: true, projects },
      'GET /api/tasks/stuck': {
        ok: true,
        stuck: {
          combined: [
            { project: 'alpha', taskId: 'T-050', title: 'Blocked work', status: 'open', workState: 'blocked', reason: 'blocked', agent: null, workStateDetails: { reason: 'waiting on review bundle' } },
            { project: 'beta', taskId: 'T-060', title: 'Stalled work', status: 'in-progress', workState: 'working', reason: 'stale', agent: 'codex', staleMinutes: 42 },
            { project: 'deleted', taskId: 'T-070', title: 'Gone', status: 'open', workState: 'blocked', reason: 'blocked' },
          ],
        },
      },
      'GET *': (url) => ({
        ok: true,
        tasks: [{ id: `R-${url.pathname.split('/')[3]}`, title: 'Approve me', status: 'review', agent: 'main', workState: 'working' }],
      }),
    });
    const adapter = createFlowBoardAdapter({ dashboardBaseUrl: 'http://127.0.0.1:1' }, { fetch: recorder.fetch });
    const result = await adapter.listNeedingMe(null, {});

    await check('only projects that already report a review are fetched', () => {
      const taskCalls = recorder.calls.filter((call) => call.pathname.endsWith('/tasks'));
      assert.deepEqual(taskCalls.map((call) => call.pathname), ['/api/projects/alpha/tasks', '/api/projects/gamma/tasks']);
      assert.equal(taskCalls.every((call) => call.search.get('status') === 'review'), true);
    });

    await check('the answer merges both lanes', () => {
      assert.deepEqual(result.items.map((item) => `${item.reason}:${item.project}/${item.id}`), [
        'review:alpha/R-alpha',
        'review:gamma/R-gamma',
        'blocked:alpha/T-050',
        'stuck:beta/T-060',
      ]);
      assert.equal(result.scannedProjects, 2);
      assert.equal(result.truncated, false);
    });

    await check('stall evidence becomes one readable note', () => {
      const byId = Object.fromEntries(result.items.map((item) => [item.id, item]));
      assert.equal(byId['T-050'].note, 'waiting on review bundle');
      assert.equal(byId['T-060'].note, 'no checkpoint for 42 min');
      assert.equal(byId['T-060'].agent, 'codex');
    });

    await check('a stuck entry for a project outside the scope is dropped', () => {
      assert.equal(result.items.some((item) => item.project === 'deleted'), false);
    });
  }

  await check('a project filter narrows both lanes to that project', async () => {
    const recorder = recordingFetch({
      'GET /api/projects': { ok: true, projects: [projectRow('alpha', 1, 0), projectRow('beta', 1, 0)] },
      'GET /api/tasks/stuck': { ok: true, stuck: { combined: [{ project: 'beta', taskId: 'T-9', title: 'x', status: 'open', workState: 'blocked', reason: 'blocked' }] } },
      'GET *': { ok: true, tasks: [{ id: 'T-1', title: 'Approve me', status: 'review' }] },
    });
    const adapter = createFlowBoardAdapter({ dashboardBaseUrl: 'http://127.0.0.1:1' }, { fetch: recorder.fetch });
    const result = await adapter.listNeedingMe(null, { project: 'alpha' });
    assert.deepEqual(result.items.map((item) => item.project), ['alpha']);
    assert.equal(recorder.calls.filter((call) => call.pathname.endsWith('/tasks')).length, 1);
  });

  await check('an unknown project is an error, not a silently empty rail', async () => {
    const recorder = recordingFetch({ 'GET /api/projects': { ok: true, projects: [projectRow('alpha')] } });
    const adapter = createFlowBoardAdapter({ dashboardBaseUrl: 'http://127.0.0.1:1' }, { fetch: recorder.fetch });
    await assert.rejects(() => adapter.listNeedingMe(null, { project: 'ghost' }), /Unknown project: ghost/);
  });

  await check('the review scan is capped and says so', async () => {
    const many = Array.from({ length: MAX_REVIEW_PROJECTS + 3 }, (_, index) => projectRow(`p${index}`, 1, 0));
    const recorder = recordingFetch({
      'GET /api/projects': { ok: true, projects: many },
      'GET /api/tasks/stuck': { ok: true, stuck: { combined: [] } },
      'GET *': (url) => ({ ok: true, tasks: [{ id: `T-${url.pathname.split('/')[3]}`, title: 'x', status: 'review' }] }),
    });
    const adapter = createFlowBoardAdapter({ dashboardBaseUrl: 'http://127.0.0.1:1' }, { fetch: recorder.fetch });
    const result = await adapter.listNeedingMe(null, {});
    assert.equal(result.scannedProjects, MAX_REVIEW_PROJECTS);
    assert.equal(result.items.length, MAX_REVIEW_PROJECTS);
    assert.equal(result.truncated, true);
  });

  await check('the limit bounds the answer and is itself bounded', async () => {
    const recorder = recordingFetch({
      'GET /api/projects': { ok: true, projects: [projectRow('alpha', 3, 0)] },
      'GET /api/tasks/stuck': { ok: true, stuck: { combined: [] } },
      'GET *': { ok: true, tasks: [{ id: 'T-1', title: 'a', status: 'review' }, { id: 'T-2', title: 'b', status: 'review' }, { id: 'T-3', title: 'c', status: 'review' }] },
    });
    const adapter = createFlowBoardAdapter({ dashboardBaseUrl: 'http://127.0.0.1:1' }, { fetch: recorder.fetch });
    const limited = await adapter.listNeedingMe(null, { limit: 2 });
    assert.equal(limited.items.length, 2);
    assert.equal(limited.truncated, true);
    const unbounded = await adapter.listNeedingMe(null, { limit: 10_000 });
    assert.equal(unbounded.items.length, 3);
  });

  await check('stall detection being down still renders the approve gate', async () => {
    const recorder = recordingFetch({
      'GET /api/projects': { ok: true, projects: [projectRow('alpha', 1, 0)] },
      'GET *': { ok: true, tasks: [{ id: 'T-1', title: 'a', status: 'review' }] },
    });
    // The stuck route answers with an empty object rather than the expected
    // shape; the merge must treat that as "no stall data", not as a failure.
    const adapter = createFlowBoardAdapter({ dashboardBaseUrl: 'http://127.0.0.1:1' }, { fetch: recorder.fetch });
    const result = await adapter.listNeedingMe(null, {});
    assert.deepEqual(result.items.map((item) => item.reason), ['review']);
  });

  await check('a stuck entry without a project or id is not rendered', () => {
    assert.equal(stuckEntryToItem({ taskId: 'T-1' }), null);
    assert.equal(stuckEntryToItem({ project: 'alpha' }), null);
    assert.equal(stuckEntryToItem(null), null);
  });

  await check('lane order is approvals, then blocked, then stalled', () => {
    const sorted = sortNeedsMe([
      { reason: 'stuck', project: 'b', id: 'T-3' },
      { reason: 'blocked', project: 'a', id: 'T-2' },
      { reason: 'review', project: 'c', id: 'T-1' },
    ]);
    assert.deepEqual(sorted.map((item) => item.reason), ['review', 'blocked', 'stuck']);
  });

  await check('every note is bounded and single-line', () => {
    const item = stuckEntryToItem({
      project: 'alpha',
      taskId: 'T-1',
      title: 'x',
      status: 'open',
      workState: 'blocked',
      reason: 'blocked',
      workStateDetails: { reason: `line one\nline two ${'y'.repeat(400)}` },
    });
    assert.equal(item.note.includes('\n'), false);
    assert.equal(item.note.length <= 120, true);
  });
}

async function httpTests() {
  const { createFlowBoardAdapter } = await import(ADAPTER_URL);

  await withIsolatedDashboard(async ({ base, api }) => {
    const adapter = createFlowBoardAdapter({ dashboardBaseUrl: base, serviceToken: SERVICE_TOKEN });

    await api('POST', '/projects', { name: PROJECT, displayName: 'Rail fixture', description: 'T-487-8 fixture.' });
    await api('POST', '/projects', { name: OTHER_PROJECT, displayName: 'Quiet', description: 'No attention needed.' });
    const review = await api('POST', `/projects/${PROJECT}/tasks`, { title: 'Approve this result', priority: 'high' });
    const blocked = await api('POST', `/projects/${PROJECT}/tasks`, { title: 'Cannot continue', priority: 'medium' });
    const calm = await api('POST', `/projects/${OTHER_PROJECT}/tasks`, { title: 'Ordinary work', priority: 'low' });
    const reviewId = review.body?.task?.id;
    const blockedId = blocked.body?.task?.id;
    await api('PUT', `/projects/${PROJECT}/tasks/${reviewId}`, { status: 'review' });
    await api('PUT', `/projects/${PROJECT}/tasks/${blockedId}`, {
      workState: 'blocked',
      workStateDetails: { reason: 'waiting for the API key' },
    });

    section('HTTP — projects.list');
    const projects = await adapter.listProjects(null);
    await check('every project carries the counts the rail badges', () => {
      const fixture = projects.find((project) => project.name === PROJECT);
      assert.ok(fixture, 'fixture project listed');
      assert.equal(fixture.counts.review, 1);
      assert.equal(fixture.counts.blocked, 1);
      assert.equal(projects.find((project) => project.name === OTHER_PROJECT).counts.review, 0);
    });

    section('HTTP — tasks.needing-me');
    const needing = await adapter.listNeedingMe(null, {});
    await check('the review lane and the blocked lane both come back', () => {
      const byId = Object.fromEntries(needing.items.map((item) => [item.id, item]));
      assert.equal(byId[reviewId]?.reason, 'review', JSON.stringify(needing.items));
      assert.equal(byId[blockedId]?.reason, 'blocked');
      assert.equal(byId[blockedId]?.note, 'waiting for the API key');
      assert.equal(byId[blockedId]?.workState, 'blocked');
    });
    await check('ordinary work is not on the operator\'s plate', () => {
      const calmId = calm.body?.task?.id;
      assert.ok(calmId, 'fixture task created');
      assert.equal(
        needing.items.some((item) => item.project === OTHER_PROJECT && item.id === calmId),
        false,
      );
      assert.equal(needing.scannedProjects, 1, 'the quiet project was never fetched');
      assert.equal(needing.truncated, false);
    });
    await check('a project filter answers only for that project', async () => {
      const scoped = await adapter.listNeedingMe(null, { project: OTHER_PROJECT });
      assert.deepEqual(scoped.items, []);
    });

    section('HTTP — session-scoped binding');
    const agentLevel = await adapter.setStatus(null, { agentId: 'main', project: PROJECT });
    await check('an agent-level switch reports the agent binding', () => {
      assert.equal(agentLevel.activeProject, PROJECT);
      assert.equal(agentLevel.binding.scope, 'agent');
      assert.equal(agentLevel.binding.sessionKey, null);
    });

    const sessionLevel = await adapter.setStatus(null, {
      agentId: 'main',
      project: OTHER_PROJECT,
      sessionKey: 'agent:main:rail',
    });
    await check('a session-scoped switch does not rewrite the agent binding', async () => {
      assert.equal(sessionLevel.activeProject, OTHER_PROJECT);
      assert.equal(sessionLevel.binding.scope, 'session');
      const stillAgent = await adapter.getStatus(null, { agentId: 'main' });
      assert.equal(stillAgent.activeProject, PROJECT, 'the agent-level binding must survive');
      assert.equal(stillAgent.binding.scope, 'agent');
    });

    await check('reading with the session key resolves the session binding', async () => {
      const read = await adapter.getStatus(null, { agentId: 'main', sessionKey: 'agent:main:rail' });
      assert.equal(read.activeProject, OTHER_PROJECT);
      assert.equal(read.binding.scope, 'session');
      assert.equal(read.binding.sessionKey, 'agent:main:rail');
    });

    await check('releasing the session falls back to the agent binding', async () => {
      const released = await adapter.setStatus(null, { agentId: 'main', project: null, sessionKey: 'agent:main:rail' });
      assert.equal(released.activeProject, PROJECT);
      assert.equal(released.binding.scope, 'agent');
    });

    await check('FlowBoard\'s own rejection message survives the adapter', async () => {
      await assert.rejects(
        () => adapter.setStatus(null, { agentId: 'main', project: 'does-not-exist' }),
        /Unknown project/,
      );
    });
  }, { prefix: 'flowboard-feature-adapter-', env: { FLOWBOARD_SERVICE_TOKEN: SERVICE_TOKEN } });
}

async function main() {
  await requestShapeTests();
  await httpTests();
  console.log(`\n${failed ? '❌' : '✅'} feature adapter: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
