'use strict';

/**
 * The Gateway adapter and the change poll (T-487-8, T-498; cut down with the
 * contract in T-515-7).
 *
 * `openclaw/adapter.js` turns the remaining feature query and the change
 * poll's reads into FlowBoard HTTP calls. What is worth asserting here:
 *
 *   1. **`tasks.needing-me` is FlowBoard's own answer, merged.** The review
 *      lane comes from the task API, the blocked/stalled lane from FlowBoard's
 *      stall detection (`GET /api/tasks/stuck`), and the merge is bounded: the
 *      per-project review fetch happens only where the project list already
 *      reports work in review, and never for more than MAX_REVIEW_PROJECTS.
 *   2. **The board projection is FlowBoard's answer, narrowed.** The task
 *      list feeds the change poll's digest, so its bounds and ordering are
 *      what decides which cards an event names.
 *   3. **Refusals keep FlowBoard's message and code.**
 *   4. **The poll costs nothing when nobody is looking.** The board lane only
 *      runs for focused projects and only while a client is registered; a
 *      regression there is a quiet one, because it looks exactly like a
 *      working poll.
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
const POLL_URL = pathToFileURL(path.resolve(__dirname, '..', 'openclaw', 'change-poll.js')).href;
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
      // A route may answer `{ __status, error }` to exercise the 4xx path.
      const status = Number.isInteger(payload?.__status) ? payload.__status : 200;
      return {
        ok: status < 400,
        status,
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

  section('serviceToken — resolved string vs unresolved SecretRef (T-508)');
  {
    const { readServiceToken } = await import(ADAPTER_URL);
    const ref = { source: 'file', provider: 'flowboard-secrets', id: '/flowboard/serviceToken' };

    await check('a host-resolved (or inline) string is used as the token', () => {
      assert.deepEqual(readServiceToken({ serviceToken: `  ${SERVICE_TOKEN}  ` }), { token: SERVICE_TOKEN, unresolved: false });
    });
    await check('no serviceToken is simply absent, not unresolved', () => {
      assert.deepEqual(readServiceToken({}), { token: '', unresolved: false });
      assert.deepEqual(readServiceToken(undefined), { token: '', unresolved: false });
    });
    await check('a SecretRef object the host did not resolve is flagged, never used', () => {
      assert.deepEqual(readServiceToken({ serviceToken: ref }), { token: '', unresolved: true });
    });
    await check('an unresolved SecretRef sends no Authorization header at all', async () => {
      const recorder = recordingFetch({ 'GET /api/projects': { ok: true, projects: [] } });
      const adapter = createFlowBoardAdapter({ dashboardBaseUrl: 'http://127.0.0.1:1', serviceToken: ref }, { fetch: recorder.fetch });
      await adapter.listProjects(null);
      assert.equal(adapter.hasServiceToken(), false);
      assert.equal(adapter.serviceTokenUnresolved(), true);
      assert.equal(Object.prototype.hasOwnProperty.call(recorder.calls[0].headers, 'Authorization'), false);
      assert.equal(JSON.stringify(recorder.calls[0]).includes(ref.id), false);
    });
    await check('the resolved string reaches the Authorization header', async () => {
      const recorder = recordingFetch({ 'GET /api/projects': { ok: true, projects: [] } });
      const adapter = createFlowBoardAdapter({ dashboardBaseUrl: 'http://127.0.0.1:1', serviceToken: SERVICE_TOKEN }, { fetch: recorder.fetch });
      await adapter.listProjects(null);
      assert.equal(adapter.serviceTokenUnresolved(), false);
      assert.equal(recorder.calls[0].headers.Authorization, `Bearer ${SERVICE_TOKEN}`);
    });
  }

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


/** A FlowBoard task row with everything the board projection must survive. */
function taskRow(overrides = {}) {
  return {
    id: 'T-001',
    title: 'Card',
    status: 'open',
    priority: 'high',
    workState: 'blocked',
    workStateDetails: {
      reason: 'waiting for the API key',
      waitingFor: 'ops',
      responsible: 'ops-oncall',
      checkAgainAt: '2026-09-21T10:00:00Z',
      // Server-owned bookkeeping the contract deliberately does not carry.
      setAt: '2026-09-20T10:00:00Z',
    },
    stuckIndicator: null,
    agent: 'codex',
    parentId: null,
    subtaskIds: ['T-001-1', 'T-001-2'],
    tags: ['backend', 'openclaw'],
    order: 2,
    enteredStatusAt: '2026-09-20T09:00:00Z',
    created: '2026-09-01',
    leaseUntil: '2026-09-20T12:00:00Z',
    specExists: true,
    specFile: 'specs/T-001.md',
    // Fields FlowBoard returns and a board has no business seeing.
    claimedAt: '2026-09-20T11:00:00Z',
    lastCheckpointAt: '2026-09-20T11:30:00Z',
    checkpointCount: 3,
    routedAgent: null,
    trashedAt: null,
    dependsOn: [],
    exceptionReview: null,
    structureReview: null,
    creationAudit: { principal: { actor: 'gateway:secret' } },
    ...overrides,
  };
}

const CARD_FIELDS = [
  'agent', 'created', 'enteredStatusAt', 'id', 'leaseUntil', 'order', 'parentId', 'priority',
  'specExists', 'status', 'stuckIndicator', 'subtaskCount', 'tags', 'title', 'workState',
  'workStateDetails',
];

async function boardShapeTests() {
  const {
    createFlowBoardAdapter, compareTasks, projectStuckIndicator, projectTask,
    toFeatureError, FlowBoardAdapterError, FlowBoardFeatureRefusal,
    MAX_REFUSAL_MESSAGE, refusalEnvelope, wrapSessionActionHandler, withRefusalEnvelopes,
  } = await import(ADAPTER_URL);

  const adapterFor = (routes) => {
    const recorder = recordingFetch(routes);
    return {
      recorder,
      adapter: createFlowBoardAdapter(
        { dashboardBaseUrl: 'http://127.0.0.1:1', serviceToken: SERVICE_TOKEN },
        { fetch: recorder.fetch },
      ),
    };
  };

  section('tasks.list — the card projection');

  await check('a card carries exactly the contract fields, and nothing else FlowBoard returned', async () => {
    const { adapter } = adapterFor({ 'GET /api/projects/alpha/tasks': { ok: true, tasks: [taskRow()] } });
    const { tasks } = await adapter.listTasks(null, { project: 'alpha' });
    assert.deepEqual(Object.keys(tasks[0]).sort(), CARD_FIELDS);
    assert.equal(tasks[0].subtaskCount, 2, 'subtaskIds become a count, not a list');
    assert.equal(tasks[0].specExists, true);
    assert.equal(tasks[0].agent, 'codex');
    assert.equal(tasks[0].order, 2);
    assert.deepEqual(tasks[0].tags, ['backend', 'openclaw']);
  });

  await check('work-state details survive verbatim, minus the server-owned setAt', async () => {
    const { adapter } = adapterFor({ 'GET /api/projects/alpha/tasks': { ok: true, tasks: [taskRow()] } });
    const { tasks } = await adapter.listTasks(null, { project: 'alpha' });
    assert.deepEqual(tasks[0].workStateDetails, {
      reason: 'waiting for the API key',
      waitingFor: 'ops',
      responsible: 'ops-oncall',
      checkAgainAt: '2026-09-21T10:00:00Z',
    });
  });

  await check('the stuck indicator is reduced to the five fields a chip draws', () => {
    const projected = projectStuckIndicator({
      active: true,
      reason: 'stale',
      message: `no checkpoint for 42 min ${'x'.repeat(400)}`,
      since: '2026-09-20T08:00:00Z',
      detectedAt: '2026-09-20T09:00:00Z',
      updatedAt: '2026-09-20T09:05:00Z',
      owner: 'codex',
      ownerKind: 'agent',
      delivery: 'wake',
      wakeAgent: 'main',
      actions: [{ id: 'retry' }],
    });
    assert.deepEqual(Object.keys(projected).sort(), ['active', 'detectedAt', 'message', 'reason', 'since']);
    assert.equal(projected.message.length, 200);
  });

  await check('a cleared indicator is null, not an inactive object', () => {
    assert.equal(projectStuckIndicator({ active: false, reason: 'stale' }), null);
    assert.equal(projectStuckIndicator(null), null);
    assert.equal(projectTask({ id: 'T-1' }).stuckIndicator, null);
  });

  await check('tags are bounded in both directions', () => {
    const projected = projectTask({
      id: 'T-1',
      tags: [...Array.from({ length: 30 }, (_, index) => `tag-${index}`), 't'.repeat(80)],
    });
    assert.equal(projected.tags.length, 20);
    assert.ok(projected.tags.every((tag) => tag.length <= 40));
  });

  await check('an unknown work state or priority falls back instead of reaching the browser', () => {
    const projected = projectTask({ id: 'T-1', workState: 'vibing', priority: 'critical' });
    assert.equal(projected.workState, 'working');
    assert.equal(projected.priority, 'medium');
  });

  section('tasks.list — order, bounds and the archived rule');

  await check('cards sort by the manual rank first, unranked last, ids numeric-aware', () => {
    const sorted = [
      { id: 'T-10', order: null },
      { id: 'T-9', order: null },
      { id: 'T-3', order: 5 },
      { id: 'T-4', order: 1 },
    ].sort(compareTasks);
    assert.deepEqual(sorted.map((task) => task.id), ['T-4', 'T-3', 'T-9', 'T-10']);
  });

  await check('the limit cuts the board and says so', async () => {
    const rows = Array.from({ length: 5 }, (_, index) => taskRow({ id: `T-00${index}`, order: index }));
    const { adapter } = adapterFor({ 'GET /api/projects/alpha/tasks': { ok: true, tasks: rows } });
    const limited = await adapter.listTasks(null, { project: 'alpha', limit: 2 });
    assert.equal(limited.tasks.length, 2);
    assert.equal(limited.truncated, true);
    assert.deepEqual(limited.tasks.map((task) => task.id), ['T-000', 'T-001']);
    const whole = await adapter.listTasks(null, { project: 'alpha' });
    assert.equal(whole.truncated, false);
    assert.equal(whole.tasks.length, 5);
  });

  await check('a limit outside the contract is clamped, never trusted', async () => {
    const rows = Array.from({ length: 3 }, (_, index) => taskRow({ id: `T-00${index}`, order: index }));
    const { adapter } = adapterFor({ 'GET /api/projects/alpha/tasks': { ok: true, tasks: rows } });
    assert.equal((await adapter.listTasks(null, { project: 'alpha', limit: 0 })).tasks.length, 1);
    assert.equal((await adapter.listTasks(null, { project: 'alpha', limit: 10_000 })).tasks.length, 3);
  });

  await check('archived tasks are excluded by default and on request', async () => {
    const { adapter, recorder } = adapterFor({ 'GET /api/projects/alpha/tasks': { ok: true, tasks: [] } });
    await adapter.listTasks(null, { project: 'alpha' });
    assert.equal(recorder.calls[0].search.has('includeArchived'), false);
    assert.equal(recorder.calls[0].search.has('status'), false);

    await adapter.listTasks(null, { project: 'alpha', includeArchived: true });
    assert.equal(recorder.calls[1].search.get('includeArchived'), 'true');

    await adapter.listTasks(null, { project: 'alpha', status: 'review' });
    assert.equal(recorder.calls[2].search.get('status'), 'review');
    assert.equal(recorder.calls[2].search.has('includeArchived'), false);
  });

  await check('asking for the archived column includes archived tasks, or it would be empty by definition', async () => {
    const { adapter, recorder } = adapterFor({ 'GET /api/projects/alpha/tasks': { ok: true, tasks: [] } });
    await adapter.listTasks(null, { project: 'alpha', status: 'archived' });
    assert.equal(recorder.calls[0].search.get('status'), 'archived');
    assert.equal(recorder.calls[0].search.get('includeArchived'), 'true');
  });

  section('tasks.list — trash (T-499)');

  await check('a trashed task is not a card', async () => {
    const { adapter } = adapterFor({
      'GET /api/projects/alpha/tasks': {
        ok: true,
        tasks: [taskRow({ id: 'T-001' }), taskRow({ id: 'T-002', trashedAt: '2026-09-24T10:00:00Z' })],
      },
    });
    const { tasks } = await adapter.listTasks(null, { project: 'alpha' });
    assert.deepEqual(tasks.map((task) => task.id), ['T-001']);
  });

  await check('a trashed task in review is not on the operator\'s plate', async () => {
    const { adapter } = adapterFor({
      'GET /api/projects': { ok: true, projects: [projectRow('alpha', 2)] },
      'GET /api/tasks/stuck': { ok: true, stuck: { combined: [] } },
      'GET /api/projects/alpha/tasks': {
        ok: true,
        tasks: [
          taskRow({ id: 'T-001', status: 'review' }),
          taskRow({ id: 'T-002', status: 'review', trashedAt: '2026-09-24T10:00:00Z' }),
        ],
      },
    });
    const { items } = await adapter.listNeedingMe(null, {});
    assert.deepEqual(items.map((item) => item.id), ['T-001']);
  });

  section('the guarded error path (T-499)');

  await check("FlowBoard's error code survives the feature error mapping unchanged", () => {
    for (const code of ['SPECIFY_REQUIRED', 'NOT_OWNER', 'NOT_IN_REVIEW']) {
      const mapped = toFeatureError(new FlowBoardAdapterError(`refused ${code}`, code));
      assert.equal(mapped.code, code);
      assert.equal(mapped.message, `refused ${code}`);
      assert.equal(mapped instanceof FlowBoardAdapterError, false, 'no adapter internals leak through');
      assert.equal(mapped instanceof FlowBoardFeatureRefusal, true, 'the refusal is the one class the wrapper answers');
    }
    const foreign = new TypeError('boom');
    assert.equal(toFeatureError(foreign), foreign, 'a non-FlowBoard error is not rewritten');
  });

  section('refusals reach the native page as an envelope (T-504)');

  await check('a refusal becomes { ok: false, error, code } with the code passed through', () => {
    for (const [message, code] of [
      ['Task T-001 is not in review (status: open); cannot approve', 'NOT_IN_REVIEW'],
      ['Task not found', 'flowboard_not_found'],
      ['Only the owning agent "worker-one" can change the status of a task it actively holds.', 'NOT_OWNER'],
    ]) {
      const envelope = refusalEnvelope(toFeatureError(new FlowBoardAdapterError(message, code)));
      assert.deepEqual(envelope, { ok: false, error: message, code });
    }
  });

  await check('the envelope carries a bounded message and nothing else', () => {
    const long = new FlowBoardFeatureRefusal('x'.repeat(5000), 'NOT_OWNER');
    long.body = { secret: 'never' };
    const envelope = refusalEnvelope(long);
    assert.equal(envelope.error.length, MAX_REFUSAL_MESSAGE);
    assert.deepEqual(Object.keys(envelope).sort(), ['code', 'error', 'ok']);
    assert.deepEqual(refusalEnvelope(new FlowBoardFeatureRefusal('no code')), { ok: false, error: 'no code' });
  });

  await check('anything that is not a FlowBoard refusal gets no envelope', () => {
    assert.equal(refusalEnvelope(new Error('internal')), null);
    assert.equal(refusalEnvelope(Object.assign(new Error('looks alike'), { code: 'NOT_OWNER' })), null);
    assert.equal(refusalEnvelope(new FlowBoardAdapterError('raw adapter error', 'NOT_OWNER')), null);
    assert.equal(refusalEnvelope(undefined), null);
  });

  await check('a wrapped handler answers a refusal and rethrows everything else', async () => {
    const refused = wrapSessionActionHandler(async () => {
      throw new FlowBoardFeatureRefusal('Task T-001 is not in review', 'NOT_IN_REVIEW');
    });
    assert.deepEqual(await refused({}), { ok: false, error: 'Task T-001 is not in review', code: 'NOT_IN_REVIEW' });
    const boom = new TypeError('internal detail');
    const broken = wrapSessionActionHandler(async () => {
      throw boom;
    });
    await assert.rejects(() => broken({}), (error) => error === boom);
    const fine = wrapSessionActionHandler(async (action) => ({ ok: true, result: action.payload }));
    assert.deepEqual(await fine({ payload: 7 }), { ok: true, result: 7 });
    assert.equal(wrapSessionActionHandler(undefined), undefined, 'a missing handler is left for the host to refuse');
  });

  await check('withRefusalEnvelopes wraps only registerSessionAction and passes the real api through', async () => {
    const registered = [];
    const services = [];
    const api = {
      id: 'flowboard',
      pluginConfig: { dashboardPort: 1 },
      logger: { warn() {} },
      registerSessionAction(action) {
        assert.equal(this, api, 'the real registrar runs on the real api');
        registered.push(action);
      },
      registerService(service) {
        assert.equal(this, api, 'other methods are bound to the real api');
        services.push(service);
      },
    };
    const view = withRefusalEnvelopes(api);
    assert.notEqual(view, api);
    assert.equal(view.id, 'flowboard');
    assert.equal(view.pluginConfig, api.pluginConfig);
    assert.equal(view.logger, api.logger);
    const { registerService } = view;
    registerService({ id: 'svc' });
    assert.equal(services.length, 1, 'a detached method still reaches the real api');

    // What defineFeaturePlugin's session-action handler does with our refusal:
    // it rethrows every error that is not its own validation error.
    const sdkHandler = async () => {
      throw toFeatureError(new FlowBoardAdapterError('Task T-9 not found', 'flowboard_not_found'));
    };
    view.registerSessionAction({ id: 'task.get', description: 'Read', requiredScopes: ['operator.read'], handler: sdkHandler });
    assert.equal(registered.length, 1);
    assert.equal(registered[0].id, 'task.get');
    assert.deepEqual(registered[0].requiredScopes, ['operator.read']);
    assert.notEqual(registered[0].handler, sdkHandler);
    assert.deepEqual(await registered[0].handler({ payload: {} }), {
      ok: false,
      error: 'Task T-9 not found',
      code: 'flowboard_not_found',
    });
  });

  await check('an api that cannot be shadowed is returned unchanged', () => {
    assert.equal(withRefusalEnvelopes(null), null);
    const noActions = { id: 'flowboard' };
    assert.equal(withRefusalEnvelopes(noActions), noActions, 'a host without session actions is left alone');
    const frozen = Object.freeze({ id: 'flowboard', registerSessionAction() {} });
    assert.equal(withRefusalEnvelopes(frozen), frozen);
  });

  await check('a 404 without a code of its own is flowboard_not_found', async () => {
    const { adapter } = adapterFor({
      'GET /api/projects/alpha/tasks': { __status: 404, error: 'Project not found' },
      'GET /api/projects/beta/tasks': { __status: 404, error: 'Project beta not found', code: 'NOT_FOUND' },
      'GET /api/projects/gamma/tasks': { __status: 400, error: 'Invalid status' },
    });
    await assert.rejects(
      () => adapter.listTasks(null, { project: 'alpha' }),
      (error) => error.code === 'flowboard_not_found' && error.message === 'Project not found',
    );
    await assert.rejects(
      () => adapter.listTasks(null, { project: 'beta' }),
      (error) => error.code === 'NOT_FOUND',
      "FlowBoard's own code still wins",
    );
    await assert.rejects(
      () => adapter.listTasks(null, { project: 'gamma' }),
      (error) => error.code === 'flowboard_rejected',
    );
  });
}

async function changePollTests() {
  const { createChangePoller, createFocusRegistry, digestDiff, taskDigest, MAX_CHANGED_IDS, MAX_WATCHED_PROJECTS } =
    await import(POLL_URL);

  section('ui.focus — the per-connection registry');

  await check('focus is per connection, and null clears it', () => {
    const registry = createFocusRegistry();
    registry.remember('conn-a', 'alpha');
    registry.remember('conn-b', 'beta');
    assert.deepEqual(registry.projects(), ['beta', 'alpha']);
    registry.remember('conn-b', null);
    assert.deepEqual(registry.projects(), ['alpha']);
    registry.forget('conn-a');
    assert.deepEqual(registry.projects(), []);
  });

  await check('re-focusing moves a connection to the front — most recent wins', () => {
    const registry = createFocusRegistry();
    for (const [conn, project] of [['a', 'p1'], ['b', 'p2'], ['c', 'p3']]) registry.remember(conn, project);
    registry.remember('a', 'p4');
    assert.deepEqual(registry.projects(), ['p4', 'p3', 'p2']);
  });

  await check('two connections on one board are watched once', () => {
    const registry = createFocusRegistry();
    registry.remember('a', 'alpha');
    registry.remember('b', 'alpha');
    assert.deepEqual(registry.projects(), ['alpha']);
  });

  await check('the watch list is capped even when more boards are open', () => {
    const registry = createFocusRegistry();
    for (let index = 0; index < MAX_WATCHED_PROJECTS + 5; index += 1) registry.remember(`c${index}`, `p${index}`);
    assert.equal(registry.projects().length, MAX_WATCHED_PROJECTS);
    assert.equal(registry.projects()[0], `p${MAX_WATCHED_PROJECTS + 4}`, 'the most recently focused board is first');
  });

  await check('the registry itself is bounded, oldest connection first', () => {
    const registry = createFocusRegistry();
    for (let index = 0; index < 100; index += 1) registry.remember(`c${index}`, 'alpha');
    assert.equal(registry.size, 64);
  });

  await check('a call without a connection changes nothing', () => {
    const registry = createFocusRegistry();
    assert.equal(registry.remember(null, 'alpha'), false);
    assert.deepEqual(registry.projects(), []);
  });

  await check('focus notifies once per real change, so a wake is not a busy loop', () => {
    let wakes = 0;
    const registry = createFocusRegistry(() => { wakes += 1; });
    registry.remember('a', 'alpha');
    registry.remember('a', 'alpha');
    registry.remember('a', 'beta');
    assert.equal(wakes, 2);
  });

  section('the board digest');

  const card = (overrides) => ({
    id: 'T-1', status: 'open', workState: 'working', workStateDetails: { reason: null },
    agent: null, enteredStatusAt: '2026-09-20T09:00:00Z', title: 'Card', order: 1, priority: 'medium',
    tags: ['a'], ...overrides,
  });

  await check('the digest moves on the ten fields a card is drawn from', () => {
    const base = taskDigest([card({})]);
    const moved = [
      card({ status: 'review' }),
      card({ workState: 'blocked' }),
      card({ workStateDetails: { reason: 'waiting for ops' } }),
      card({ agent: 'codex' }),
      card({ enteredStatusAt: '2026-09-20T10:00:00Z' }),
      card({ title: 'Renamed' }),
      card({ order: 2 }),
      // T-499: the native panel edits these, so an edit elsewhere must show.
      card({ priority: 'high' }),
      card({ tags: ['x'] }),
      card({ tags: ['a', 'b'] }),
    ];
    for (const next of moved) {
      assert.equal(digestDiff(base, taskDigest([next])).changed, true, JSON.stringify(next));
    }
  });

  await check('and stays still for the fields it deliberately ignores', () => {
    const base = taskDigest([card({})]);
    // The stuck indicator is re-stamped on every evaluation and the lease
    // expires on a clock; digesting either would wake every page on a timer.
    const noise = taskDigest([
      card({ leaseUntil: '2026-09-20T12:00:00Z', stuckIndicator: { active: true, updatedAt: 'now' } }),
    ]);
    assert.equal(digestDiff(base, noise).changed, false);
  });

  await check('added, removed and changed tasks are one sorted list of ids', () => {
    const before = taskDigest([card({ id: 'T-1' }), card({ id: 'T-2' }), card({ id: 'T-10' })]);
    const after = taskDigest([card({ id: 'T-1', status: 'done' }), card({ id: 'T-10' }), card({ id: 'T-3' })]);
    assert.deepEqual(digestDiff(before, after), { changed: true, ids: ['T-1', 'T-2', 'T-3'] });
  });

  await check('an unchanged board produces no ids and no event', () => {
    const digest = taskDigest([card({})]);
    assert.deepEqual(digestDiff(digest, taskDigest([card({})])), { changed: false, ids: [] });
  });

  await check('a diff too large to name says "refetch" instead of a truncated list', () => {
    const many = (status) =>
      taskDigest(Array.from({ length: MAX_CHANGED_IDS + 1 }, (_, index) => card({ id: `T-${index}`, status })));
    assert.deepEqual(digestDiff(many('open'), many('review')), { changed: true, ids: null });
  });

  section('the change poll');

  /** Minimal adapter + event sink; the poller only ever uses these two. */
  function pollHarness({ tasksByProject = {}, projects = [] } = {}) {
    const emitted = [];
    const calls = [];
    const state = { tasksByProject, projects };
    const adapter = {
      listProjects: async () => {
        calls.push('projects');
        return state.projects;
      },
      listTasks: async (_principal, { project }) => {
        calls.push(`tasks:${project}`);
        const rows = state.tasksByProject[project];
        if (!rows) throw new Error(`Unknown project: ${project}`);
        return { tasks: rows, truncated: false };
      },
    };
    return { adapter, calls, emitted, state, events: { emit: (name, payload) => emitted.push({ name, payload }) } };
  }

  await check('nobody connected means no request at all', async () => {
    const harness = pollHarness({ tasksByProject: { alpha: [card({})] } });
    const poller = createChangePoller({
      adapter: harness.adapter,
      events: harness.events,
      hasClients: () => false,
      watchedProjects: () => ['alpha'],
    });
    poller.start();
    await poller.tick();
    await poller.tick();
    poller.stop();
    assert.deepEqual(harness.calls, []);
    assert.deepEqual(harness.emitted, []);
  });

  await check('a connected client with no focus reads the project list only', async () => {
    const harness = pollHarness({ projects: [{ name: 'alpha', status: 'active', counts: { review: 0, blocked: 0 } }] });
    const poller = createChangePoller({
      adapter: harness.adapter,
      events: harness.events,
      hasClients: () => true,
      watchedProjects: () => [],
    });
    poller.start();
    await poller.tick();
    poller.stop();
    assert.deepEqual(harness.calls, ['projects']);
  });

  await check('the first look at a board is a baseline, not an event', async () => {
    const harness = pollHarness({ tasksByProject: { alpha: [card({})] } });
    const poller = createChangePoller({
      adapter: harness.adapter,
      events: harness.events,
      hasClients: () => true,
      watchedProjects: () => ['alpha'],
      projectsIntervalMs: 10 ** 9,
    });
    poller.start();
    await poller.tick();
    assert.deepEqual(harness.emitted, []);
    await poller.tick();
    assert.deepEqual(harness.emitted, []);
    poller.stop();
  });

  await check('a moved card is announced with its id', async () => {
    const harness = pollHarness({ tasksByProject: { alpha: [card({ id: 'T-1' }), card({ id: 'T-2' })] } });
    const poller = createChangePoller({
      adapter: harness.adapter,
      events: harness.events,
      hasClients: () => true,
      watchedProjects: () => ['alpha'],
      projectsIntervalMs: 10 ** 9,
    });
    poller.start();
    await poller.tick();
    harness.state.tasksByProject.alpha = [card({ id: 'T-1', status: 'review' }), card({ id: 'T-2' })];
    await poller.tick();
    poller.stop();
    assert.deepEqual(harness.emitted, [{ name: 'tasks-changed', payload: { project: 'alpha', ids: ['T-1'] } }]);
  });

  await check('moving the focus drops the old baseline and starts a fresh one', async () => {
    const harness = pollHarness({
      tasksByProject: { alpha: [card({ id: 'T-1' })], beta: [card({ id: 'T-9' })] },
    });
    let watched = ['alpha'];
    const poller = createChangePoller({
      adapter: harness.adapter,
      events: harness.events,
      hasClients: () => true,
      watchedProjects: () => watched,
      projectsIntervalMs: 10 ** 9,
    });
    poller.start();
    await poller.tick();
    watched = ['beta'];
    await poller.tick();
    // Back to alpha, which changed while nobody was watching it: the poll must
    // not replay that as a change, it re-baselines instead.
    harness.state.tasksByProject.alpha = [card({ id: 'T-1', status: 'done' })];
    watched = ['alpha'];
    await poller.tick();
    poller.stop();
    assert.deepEqual(harness.emitted, []);
    // 'projects' is the very first tick's project-lane read; after that the
    // long projectsIntervalMs keeps the lane quiet, so only boards are read.
    assert.deepEqual(harness.calls, ['projects', 'tasks:alpha', 'tasks:beta', 'tasks:alpha']);
  });

  await check('one unreadable board does not stop the others', async () => {
    const harness = pollHarness({ tasksByProject: { beta: [card({ id: 'T-9' })] } });
    const poller = createChangePoller({
      adapter: harness.adapter,
      events: harness.events,
      hasClients: () => true,
      watchedProjects: () => ['gone', 'beta'],
      projectsIntervalMs: 10 ** 9,
      logger: { debug: () => {} },
    });
    poller.start();
    await poller.tick();
    harness.state.tasksByProject.beta = [card({ id: 'T-9', title: 'Renamed' })];
    await poller.tick();
    poller.stop();
    assert.deepEqual(harness.emitted, [{ name: 'tasks-changed', payload: { project: 'beta', ids: ['T-9'] } }]);
  });

  await check('a board that stays unreadable is reported once, not once per tick', async () => {
    const harness = pollHarness({ tasksByProject: { beta: [card({ id: 'T-9' })] } });
    const debug = [];
    const poller = createChangePoller({
      adapter: harness.adapter,
      events: harness.events,
      hasClients: () => true,
      // 'gone' always throws; 'beta' always works, so every tick has a
      // healthy half that must not reset the outage counter.
      watchedProjects: () => ['gone', 'beta'],
      projectsIntervalMs: 10 ** 9,
      logger: { debug: (line) => debug.push(line) },
    });
    poller.start();
    await poller.tick();
    await poller.tick();
    await poller.tick();
    poller.stop();
    assert.equal(debug.filter((line) => line.includes('change poll paused')).length, 1, debug.join('\n'));
  });

  await check('a client going away forgets every baseline', async () => {
    const harness = pollHarness({ tasksByProject: { alpha: [card({ id: 'T-1' })] } });
    let connected = true;
    const poller = createChangePoller({
      adapter: harness.adapter,
      events: harness.events,
      hasClients: () => connected,
      watchedProjects: () => ['alpha'],
      projectsIntervalMs: 10 ** 9,
    });
    poller.start();
    await poller.tick();
    connected = false;
    await poller.tick();
    harness.state.tasksByProject.alpha = [card({ id: 'T-1', status: 'done' })];
    connected = true;
    await poller.tick();
    poller.stop();
    assert.deepEqual(harness.emitted, [], 'a reconnecting page fetches for itself instead of replaying a diff');
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

    // ---------------------------------------------------------------------
    // T-498 — the board half, against the real server
    // ---------------------------------------------------------------------
    const BOARD_PROJECT = 'board-fixture';
    const OPERATOR = { profileId: 'p-17', displayName: 'Ada Lovelace', scopes: ['operator.write'] };

    await api('POST', '/projects', { name: BOARD_PROJECT, displayName: 'Board', description: 'T-498 fixture.' });
    const created = {};
    for (const [key, title] of [
      ['first', 'First card'],
      ['second', 'Second card'],
      ['approved', 'Ready for sign-off'],
      ['rejected', 'Needs changes'],
      ['gone', 'Old work'],
    ]) {
      const response = await api('POST', `/projects/${BOARD_PROJECT}/tasks`, { title, priority: 'medium' });
      created[key] = response.body?.task?.id;
    }
    // A manual rank on the second card only: unranked cards must sort after it.
    await api('PUT', `/projects/${BOARD_PROJECT}/tasks/${created.second}`, { order: 1, tags: ['backend'] });
    for (const id of [created.approved, created.rejected]) {
      await api('PUT', `/projects/${BOARD_PROJECT}/tasks/${id}`, { status: 'review' });
    }
    await api('PUT', `/projects/${BOARD_PROJECT}/tasks/${created.gone}`, { status: 'archived' });

    section('HTTP — tasks.list');

    await check('the board is the live project, archived work excluded, ranked first', async () => {
      const board = await adapter.listTasks(OPERATOR, { project: BOARD_PROJECT });
      assert.equal(board.truncated, false);
      assert.equal(board.tasks.some((task) => task.id === created.gone), false, 'archived work is off the board');
      assert.equal(board.tasks[0].id, created.second, 'the manually ranked card leads');
      assert.deepEqual(board.tasks[0].tags, ['backend']);
      assert.equal(board.tasks[0].order, 1);
      assert.equal(board.tasks.length, 4);
    });

    await check('every card comes back in the contract shape FlowBoard filled in', async () => {
      const board = await adapter.listTasks(OPERATOR, { project: BOARD_PROJECT });
      const card = board.tasks.find((task) => task.id === created.first);
      assert.deepEqual(Object.keys(card).sort(), CARD_FIELDS);
      assert.equal(card.workState, 'working');
      assert.deepEqual(card.workStateDetails, { reason: null, waitingFor: null, responsible: null, checkAgainAt: null });
      assert.equal(card.stuckIndicator, null);
      assert.equal(card.specExists, false);
      assert.equal(card.subtaskCount, 0);
      assert.ok(card.enteredStatusAt, 'FlowBoard stamps when a task entered its status');
    });

    await check('a status filter narrows the board, and archived is reachable on purpose', async () => {
      const review = await adapter.listTasks(OPERATOR, { project: BOARD_PROJECT, status: 'review' });
      assert.deepEqual(review.tasks.map((task) => task.id).sort(), [created.approved, created.rejected].sort());
      const archived = await adapter.listTasks(OPERATOR, { project: BOARD_PROJECT, status: 'archived' });
      assert.deepEqual(archived.tasks.map((task) => task.id), [created.gone]);
    });

    await check('the limit reports a cut board instead of pretending it is complete', async () => {
      const limited = await adapter.listTasks(OPERATOR, { project: BOARD_PROJECT, limit: 2 });
      assert.equal(limited.tasks.length, 2);
      assert.equal(limited.truncated, true);
    });

    section('HTTP — the change poll against the real dashboard');

    await check('the poll makes no request while nobody is connected, and names what moved when they are', async () => {
      const { createChangePoller } = await import(POLL_URL);
      const requests = [];
      const countingAdapter = createFlowBoardAdapter(
        { dashboardBaseUrl: base, serviceToken: SERVICE_TOKEN },
        {
          fetch: (url, init) => {
            requests.push(new URL(url).pathname);
            return fetch(url, init);
          },
        },
      );
      const emitted = [];
      let connected = false;
      const poller = createChangePoller({
        adapter: countingAdapter,
        events: { emit: (name, payload) => emitted.push({ name, payload }) },
        hasClients: () => connected,
        watchedProjects: () => [BOARD_PROJECT],
        projectsIntervalMs: 10 ** 9,
      });
      poller.start();
      await poller.tick();
      await poller.tick();
      assert.deepEqual(requests, [], 'an idle Gateway must not touch FlowBoard at all');

      connected = true;
      await poller.tick();
      const baselineRequests = requests.length;
      assert.ok(baselineRequests > 0, 'a connected client establishes a baseline');
      assert.deepEqual(emitted, [], 'the baseline is not a change');

      // The first connected tick also runs the project lane once; everything
      // after it is the board lane alone.
      assert.deepEqual(requests, ['/api/projects', `/api/projects/${BOARD_PROJECT}/tasks`]);

      await api('PUT', `/projects/${BOARD_PROJECT}/tasks/${created.second}`, { status: 'in-progress' });
      await poller.tick();
      poller.stop();
      assert.deepEqual(emitted, [{ name: 'tasks-changed', payload: { project: BOARD_PROJECT, ids: [created.second] } }]);
      assert.deepEqual(
        requests.slice(baselineRequests),
        [`/api/projects/${BOARD_PROJECT}/tasks`],
        'one board read per tick — the poll must not fan out per task',
      );
    });

    await check('the poll names a task that was trashed or re-prioritised elsewhere (T-499)', async () => {
      const { createChangePoller } = await import(POLL_URL);
      const emitted = [];
      const poller = createChangePoller({
        adapter,
        events: { emit: (name, payload) => emitted.push({ name, payload }) },
        hasClients: () => true,
        watchedProjects: () => [BOARD_PROJECT],
        projectsIntervalMs: 10 ** 9,
      });
      poller.start();
      await poller.tick();
      await api('PUT', `/projects/${BOARD_PROJECT}/tasks/${created.rejected}`, { trashedAt: new Date().toISOString() });
      await poller.tick();
      await api('PUT', `/projects/${BOARD_PROJECT}/tasks/${created.second}`, { priority: 'low' });
      await poller.tick();
      poller.stop();
      await api('PUT', `/projects/${BOARD_PROJECT}/tasks/${created.rejected}`, { trashedAt: null });
      assert.deepEqual(emitted, [
        { name: 'tasks-changed', payload: { project: BOARD_PROJECT, ids: [created.rejected] } },
        { name: 'tasks-changed', payload: { project: BOARD_PROJECT, ids: [created.second] } },
      ]);
    });
  }, { prefix: 'flowboard-feature-adapter-', env: { FLOWBOARD_SERVICE_TOKEN: SERVICE_TOKEN } });
}

async function main() {
  await requestShapeTests();
  await boardShapeTests();
  await changePollTests();
  await httpTests();
  console.log(`\n${failed ? '❌' : '✅'} feature adapter: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
