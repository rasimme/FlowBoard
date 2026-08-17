import assert from 'node:assert/strict';
import http from 'node:http';

import {
  authenticateTelegram,
  fetchActiveProjectForAgent,
  fetchAgentsList,
  fetchProjectsList,
  fetchTasksForProject,
} from './src/utils/dashboardApi.js';

globalThis.window = {
  location: { origin: 'http://127.0.0.1:18790' },
  Telegram: {},
};

const nativeFetch = globalThis.fetch;

const validProject = (overrides = {}) => ({
  name: 'demo',
  displayName: 'Demo',
  status: 'active',
  archived: false,
  group: null,
  github: null,
  order: null,
  assignedAgents: [],
  description: '',
  createdAt: '2026-08-17T10:00:00.000Z',
  taskCounts: {
    open: 0,
    'in-progress': 0,
    review: 0,
    done: 0,
    backlog: 0,
    archived: 0,
    blocked: 0,
  },
  ...overrides,
});

const validTask = (overrides = {}) => ({
  id: 'T-001',
  title: 'Test task',
  status: 'open',
  blocked: false,
  priority: 'medium',
  parentId: null,
  subtaskIds: [],
  specFile: null,
  created: '2026-08-17',
  enteredStatusAt: '2026-08-17T10:00:00.000Z',
  completed: null,
  agent: null,
  claimedAt: null,
  leaseUntil: null,
  lastCheckpointAt: null,
  staleAfterMinutes: null,
  checkpointCount: 0,
  order: null,
  tags: [],
  description: '',
  routedAgent: null,
  trashedAt: null,
  specExists: false,
  ...overrides,
});

const validAgent = (overrides = {}) => ({
  agent_id: 'main',
  active_project: null,
  activated_at: '2026-08-17T10:00:00.000Z',
  last_seen: '2026-08-17T10:00:00.000Z',
  ...overrides,
});

const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

async function expectProtocol(run, message) {
  await assert.rejects(run, (error) => error?.kind === 'protocol', message);
}

// Projects: the success marker and complete runtime shape are mandatory.
globalThis.fetch = async () => jsonResponse({ ok: true, projects: [validProject()] });
assert.deepEqual(await fetchProjectsList(), [validProject()]);
globalThis.fetch = async () => jsonResponse({ ok: true, projects: { malformed: true } });
await expectProtocol(() => fetchProjectsList(), 'projects requires an array');
for (const [label, payload] of [
  ['projects requires ok=true', { projects: [validProject()] }],
  ['projects rejects a false success marker', { ok: false, projects: [validProject()] }],
  ['projects rejects an unknown status enum', { ok: true, projects: [validProject({ status: 'mystery' })] }],
  ['projects validates assignedAgents as strings', { ok: true, projects: [validProject({ assignedAgents: ['main', 42] })] }],
  ['projects validates the complete taskCounts object', {
    ok: true,
    projects: [validProject({ taskCounts: { ...validProject().taskCounts, blocked: '0' } })],
  }],
]) {
  globalThis.fetch = async () => jsonResponse(payload);
  await expectProtocol(() => fetchProjectsList(), label);
}

// Agents: top-level success plus every DB-backed runtime field is checked.
globalThis.fetch = async () => jsonResponse({
  ok: true,
  agents: [validAgent()],
});
assert.deepEqual(await fetchAgentsList(), [validAgent()]);
globalThis.fetch = async () => jsonResponse({ ok: true, agents: { malformed: true } });
await expectProtocol(() => fetchAgentsList(), 'agents requires an array');
for (const [label, payload] of [
  ['agents requires ok=true', { agents: [validAgent()] }],
  ['agents validates active_project', { ok: true, agents: [validAgent({ active_project: 42 })] }],
  ['agents validates activated_at', { ok: true, agents: [validAgent({ activated_at: 42 })] }],
  ['agents validates last_seen', { ok: true, agents: [validAgent({ last_seen: [] })] }],
]) {
  globalThis.fetch = async () => jsonResponse(payload);
  await expectProtocol(() => fetchAgentsList(), label);
}

// Status: no identity intentionally skips the request; returned identity must match.
let fetchCount = 0;
globalThis.fetch = async () => { fetchCount += 1; return jsonResponse({}); };
assert.equal(await fetchActiveProjectForAgent(null), null);
assert.equal(fetchCount, 0, 'status is not fetched without an agent identity');
globalThis.fetch = async () => jsonResponse({ agentId: 'main', activeProject: 'flowboard' });
assert.equal(await fetchActiveProjectForAgent('main'), 'flowboard');
globalThis.fetch = async () => jsonResponse({ agentId: 'other', activeProject: 'flowboard' });
await expectProtocol(() => fetchActiveProjectForAgent('main'), 'status identity must match');
globalThis.fetch = async () => jsonResponse({ agentId: 'main', activeProject: 42 });
await expectProtocol(() => fetchActiveProjectForAgent('main'), 'status activeProject is string or null');

// Tasks: all fields consumed by the board are validated before publication.
globalThis.fetch = async () => jsonResponse({ ok: true, tasks: [validTask()] });
assert.deepEqual(await fetchTasksForProject('demo'), [validTask()]);
const canonicalTask = validTask({
  workState: 'waiting',
  workStateDetails: {
    reason: 'Need approval',
    waitingFor: 'reviewer',
    responsible: 'human',
    checkAgainAt: '2026-08-18T09:00:00.000Z',
    setAt: '2026-08-17T17:00:00.000Z',
  },
  stuckIndicator: { id: 'si-1', message: 'Needs attention', actions: ['retry'] },
});
globalThis.fetch = async () => jsonResponse({ ok: true, tasks: [canonicalTask] });
assert.deepEqual(await fetchTasksForProject('demo'), [canonicalTask],
  'tasks accept canonical workState, details, and transient indicator');
globalThis.fetch = async () => jsonResponse({ ok: true, tasks: [validTask({ staleAfterMinutes: 1 })] });
assert.deepEqual(
  await fetchTasksForProject('demo'),
  [validTask({ staleAfterMinutes: 1 })],
  'tasks accept a positive staleAfterMinutes override',
);
globalThis.fetch = async () => jsonResponse({ ok: true, tasks: { malformed: true } });
await expectProtocol(() => fetchTasksForProject('demo'), 'tasks requires an array');
for (const [label, payload] of [
  ['tasks requires ok=true', { tasks: [validTask()] }],
  ['tasks rejects an unknown status enum', { ok: true, tasks: [validTask({ status: 'ready' })] }],
  ['tasks rejects an unknown priority enum', { ok: true, tasks: [validTask({ priority: 'critical' })] }],
  ['tasks validates subtaskIds as strings', { ok: true, tasks: [validTask({ subtaskIds: ['T-001-1', null] })] }],
  ['tasks validates tags as strings', { ok: true, tasks: [validTask({ tags: ['frontend', 42] })] }],
  ['tasks rejects contradictory blocked projection', {
    ok: true,
    tasks: [validTask({ workState: 'waiting', blocked: true })],
  }],
  ['tasks rejects unknown canonical workState', {
    ok: true,
    tasks: [validTask({ workState: 'stalled' })],
  }],
  ['tasks rejects malformed workStateDetails', {
    ok: true,
    tasks: [validTask({ workState: 'paused', workStateDetails: { responsible: 42 } })],
  }],
  ['tasks rejects staleAfterMinutes zero', {
    ok: true,
    tasks: [validTask({ staleAfterMinutes: 0 })],
  }],
  ['tasks rejects negative staleAfterMinutes', {
    ok: true,
    tasks: [validTask({ staleAfterMinutes: -1 })],
  }],
  ['tasks validates optional progress shape', {
    ok: true,
    tasks: [validTask({ progress: { done: 0, inProgress: '0', total: 1 } })],
  }],
]) {
  globalThis.fetch = async () => jsonResponse(payload);
  await expectProtocol(() => fetchTasksForProject('demo'), label);
}

// Auth: method/header and the success payload are validated centrally.
let authRequest;
globalThis.fetch = async (url, options) => {
  authRequest = { url, options };
  return jsonResponse({ ok: true, user: { username: 'tester' }, agentId: 'main' });
};
assert.equal((await authenticateTelegram('signed-init-data')).agentId, 'main');
assert.equal(authRequest.url, '/api/auth');
assert.equal(authRequest.options.method, 'POST');
assert.equal(authRequest.options.headers['X-Telegram-Init-Data'], 'signed-init-data');
globalThis.fetch = async () => jsonResponse({ ok: false, user: {} });
await expectProtocol(() => authenticateTelegram('signed-init-data'), 'auth requires ok=true');
globalThis.fetch = async () => jsonResponse({ ok: true, user: {}, agentId: '' });
await expectProtocol(() => authenticateTelegram('signed-init-data'), 'auth rejects an empty agentId');
globalThis.fetch = async () => jsonResponse({ error: 'Telegram init data was not signed by a configured bot.', code: 'TELEGRAM_BOT_NOT_SUPPORTED' }, 403);
await assert.rejects(
  () => authenticateTelegram('signed-init-data'),
  (error) => error?.status === 403 && error?.code === 'TELEGRAM_BOT_NOT_SUPPORTED',
  'auth preserves the server-issued typed failure code',
);

// Every loader uses apiJson's deadline and forwards a caller abort. A caller
// cancellation must remain "aborted" even if fetch settles after timeoutMs.
let deadlineReachedFetch = false;
globalThis.fetch = async (_url, { signal }) => new Promise((_resolve, reject) => {
  signal.addEventListener('abort', () => {
    deadlineReachedFetch = true;
    reject(signal.reason || new DOMException('Aborted', 'AbortError'));
  }, { once: true });
});
await assert.rejects(
  () => fetchProjectsList(undefined, { timeoutMs: 5 }),
  (error) => error?.kind === 'timeout',
  'dashboard loader applies a request deadline',
);
assert.equal(deadlineReachedFetch, true, 'deadline aborts the underlying fetch');

let callerAbortReachedFetch = false;
globalThis.fetch = async (_url, { signal }) => new Promise((_resolve, reject) => {
  signal.addEventListener('abort', () => {
    callerAbortReachedFetch = true;
    setTimeout(() => reject(signal.reason || new DOMException('Aborted', 'AbortError')), 20);
  }, { once: true });
});
const controller = new AbortController();
const abortedTasks = fetchTasksForProject('demo', controller.signal, { timeoutMs: 5 });
controller.abort(new DOMException('Project changed', 'AbortError'));
await assert.rejects(
  abortedTasks,
  (error) => error?.kind === 'aborted',
  'dashboard loader forwards caller abort without reclassifying it as timeout',
);
assert.equal(callerAbortReachedFetch, true, 'caller abort reaches the underlying fetch');

// The deadline spans headers AND a stalled/chunked response body. This catches
// the old implementation, which cleared its timer as soon as fetch() returned
// a Response and could then hang forever in response.json().
let stalledBodyClosedResolve;
let siblingBodyClosedResolve;
let siblingBodyStartedResolve;
const stalledBodyClosed = new Promise((resolve) => { stalledBodyClosedResolve = resolve; });
const siblingBodyClosed = new Promise((resolve) => { siblingBodyClosedResolve = resolve; });
const siblingBodyStarted = new Promise((resolve) => { siblingBodyStartedResolve = resolve; });
let serverMode = 'deadline';
const server = http.createServer((req, res) => {
  if (req.url === '/api/projects') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' });
    res.write('{"ok":true,"projects":[');
    res.on('close', () => {
      if (serverMode === 'deadline') stalledBodyClosedResolve();
      else siblingBodyClosedResolve();
    });
    if (serverMode === 'sibling') siblingBodyStartedResolve();
    return;
  }
  if (req.url === '/api/agents') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, agents: [validAgent({ active_project: 42 })] }));
    return;
  }
  res.writeHead(404).end();
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const base = `http://127.0.0.1:${server.address().port}`;
globalThis.fetch = (url, options) => nativeFetch(new URL(url, base), options);

await assert.rejects(
  () => fetchProjectsList(undefined, { timeoutMs: 25 }),
  (error) => error?.kind === 'timeout',
  'deadline aborts a stalled chunked JSON body',
);
await Promise.race([
  stalledBodyClosed,
  new Promise((_, reject) => setTimeout(() => reject(new Error('timed-out body socket stayed open')), 500)),
]);

// A schema failure in one request aborts a sibling that already received
// headers and is stalled while streaming/parsing its JSON body.
serverMode = 'sibling';
const { abortableAll } = await import('./src/utils/apiFetch.js');
await assert.rejects(
  () => abortableAll([
    (signal) => fetchProjectsList(signal, { timeoutMs: 1000 }),
    async (signal) => {
      await siblingBodyStarted;
      return fetchAgentsList(signal, { timeoutMs: 1000 });
    },
  ]),
  (error) => error?.kind === 'protocol' && error?.path === '/api/agents',
  'malformed sibling schema remains the group failure',
);
await Promise.race([
  siblingBodyClosed,
  new Promise((_, reject) => setTimeout(() => reject(new Error('sibling body was not aborted')), 500)),
]);

// Caller abort forwarding is temporary: successful completion removes the
// listener instead of retaining each poll's signal forever.
let addedAbortListeners = 0;
let removedAbortListeners = 0;
const listenerController = new AbortController();
const originalAdd = listenerController.signal.addEventListener.bind(listenerController.signal);
const originalRemove = listenerController.signal.removeEventListener.bind(listenerController.signal);
listenerController.signal.addEventListener = (...args) => {
  if (args[0] === 'abort') addedAbortListeners += 1;
  return originalAdd(...args);
};
listenerController.signal.removeEventListener = (...args) => {
  if (args[0] === 'abort') removedAbortListeners += 1;
  return originalRemove(...args);
};
globalThis.fetch = async () => jsonResponse({ ok: true, projects: [validProject()] });
await fetchProjectsList(listenerController.signal, { timeoutMs: 50 });
assert.equal(addedAbortListeners, removedAbortListeners, 'caller abort listener is removed after JSON parsing');

await new Promise((resolve) => server.close(resolve));

console.log('dashboard API loader tests passed');
