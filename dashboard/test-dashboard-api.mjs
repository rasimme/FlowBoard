import assert from 'node:assert/strict';

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

const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

async function expectProtocol(run, message) {
  await assert.rejects(run, (error) => error?.kind === 'protocol', message);
}

// Projects: valid data passes; malformed containers and entries never become [].
globalThis.fetch = async () => jsonResponse({ projects: [{ name: 'demo' }] });
assert.deepEqual(await fetchProjectsList(), [{ name: 'demo' }]);
globalThis.fetch = async () => jsonResponse({ projects: { malformed: true } });
await expectProtocol(() => fetchProjectsList(), 'projects requires an array');
globalThis.fetch = async () => jsonResponse({ projects: [{ name: '' }] });
await expectProtocol(() => fetchProjectsList(), 'projects requires a non-empty name');

// Agents: both the array and the identity/project fields are schema-checked.
globalThis.fetch = async () => jsonResponse({
  ok: true,
  agents: [{ agent_id: 'main', active_project: null }],
});
assert.deepEqual(await fetchAgentsList(), [{ agent_id: 'main', active_project: null }]);
globalThis.fetch = async () => jsonResponse({ ok: true, agents: { malformed: true } });
await expectProtocol(() => fetchAgentsList(), 'agents requires an array');
globalThis.fetch = async () => jsonResponse({ ok: true, agents: [{ agent_id: 'main', active_project: 42 }] });
await expectProtocol(() => fetchAgentsList(), 'agents validates active_project');

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

// Tasks: valid snapshots pass; malformed 2xx cannot be normalized to empty.
globalThis.fetch = async () => jsonResponse({ tasks: [{ id: 'T-001' }] });
assert.deepEqual(await fetchTasksForProject('demo'), [{ id: 'T-001' }]);
globalThis.fetch = async () => jsonResponse({ tasks: { malformed: true } });
await expectProtocol(() => fetchTasksForProject('demo'), 'tasks requires an array');
globalThis.fetch = async () => jsonResponse({ tasks: [{ title: 'missing id' }] });
await expectProtocol(() => fetchTasksForProject('demo'), 'tasks requires a non-empty id');

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

console.log('dashboard API loader tests passed');
