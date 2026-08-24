import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

import { ApiError, apiFetch, apiJson } from './src/utils/apiFetch.js';
import { authenticateTelegram, fetchDashboardSnapshot } from './src/utils/dashboardApi.js';
import { isAuthHalted, markAuthSucceeded } from './src/state/authState.mjs';

const require = createRequire(import.meta.url);
const { buildDashboardSnapshot } = require('./dashboard-snapshot.js');
const { getRateLimitKey, getRateLimitScope, getTrustedPrincipal } = require('./rate-limiter.js');

console.log('# T-445 snapshot, lane isolation, and client cooldown contracts');

let projectCalls = 0;
let agentCalls = 0;
let statusCalls = 0;
let taskCalls = 0;
const snapshot = buildDashboardSnapshot({
  agentId: 'codex',
  requestedProject: 'demo',
  now: () => 0,
  listProjects: () => { projectCalls++; return [{ name: 'demo' }]; },
  listAgents: () => { agentCalls++; return []; },
  getStatus: () => { statusCalls++; return { agentId: 'codex', activeProject: 'demo', contextReady: true }; },
  listTasks: (project) => { taskCalls++; assert.equal(project, 'demo'); return []; },
});
assert.equal(snapshot.version, 1);
assert.equal(snapshot.generatedAt, '1970-01-01T00:00:00.000Z');
assert.deepEqual(Object.keys(snapshot.sections).sort(), ['agents', 'projects', 'status', 'tasks']);
assert.deepEqual({ projectCalls, agentCalls, statusCalls, taskCalls }, {
  projectCalls: 1, agentCalls: 1, statusCalls: 1, taskCalls: 1,
});

const partial = buildDashboardSnapshot({
  listProjects: () => { throw new Error('projects unavailable'); },
  listAgents: () => [],
  getStatus: () => ({ agentId: null, activeProject: null, contextReady: false }),
  listTasks: () => [],
});
assert.equal(partial.ok, true);
assert.equal(partial.sections.projects.ok, false);
assert.equal(partial.sections.projects.error.code, 'SECTION_UNAVAILABLE');
assert.deepEqual(partial.projects, [], 'failed section is not a fabricated success payload');
assert.equal(partial.sections.tasks.ok, false, 'dependent tasks fail closed when projects are unavailable');
assert.equal(Object.hasOwn(partial, 'snapshot'), false, 'snapshot response does not duplicate its envelope');

const malformed = buildDashboardSnapshot({
  listProjects: () => ({ name: 'not-an-array' }),
  listAgents: () => [],
  getStatus: () => ({ agentId: null, activeProject: null, contextReady: false }),
  listTasks: () => [],
});
assert.equal(malformed.sections.projects.ok, false, 'malformed section data fails closed');
markAuthSucceeded();

const request = {
  method: 'GET',
  originalUrl: '/api/dashboard/snapshot/v1?agentId=codex',
  socket: { remoteAddress: '127.0.0.1' },
  user: { id: 42 },
  headers: {},
};
assert.equal(getRateLimitScope(request), 'read');
assert.notEqual(
  getRateLimitKey(request),
  getRateLimitKey({ ...request, method: 'POST', originalUrl: '/api/projects/demo/tasks/T-1/checkpoint' }),
  'read and checkpoint lanes are independent for one verified principal',
);
assert.equal(getTrustedPrincipal({ ...request, user: undefined }, []), 'ip:127.0.0.1');
assert.equal(
  getTrustedPrincipal({ ...request, user: undefined, body: { agent: 'unchecked-attacker-id' } }, []),
  'ip:127.0.0.1',
  'unchecked body agent ids never become limiter principals',
);
assert.doesNotMatch(getRateLimitKey(request), /token|cookie/i);

const source = fs.readFileSync(new URL('./src/context/AppStateContext.jsx', import.meta.url), 'utf8');
const filesSource = fs.readFileSync(new URL('./src/pages/FilesView.jsx', import.meta.url), 'utf8');
assert.doesNotMatch(source, /fetchAgentsList|app-state-initial-agents/, 'AppStateProvider does not duplicate agent reads');
assert.match(filesSource, /const FILE_POLL_INTERVAL_MS = 15000;/, 'Files lane is visible-only at 15 seconds');
assert.match(filesSource, /fileTreeTargetKey/, 'Files tree target includes project and includeHidden');
assert.match(filesSource, /treeTargetRef/, 'Files tree uses generation invalidation for target switches');
assert.match(filesSource, /isAuthHalted|authHalted/, 'Files polling honors the shared auth halt');

global.window = { location: { origin: 'http://127.0.0.1:18790' }, Telegram: {} };
global.fetch = async () => new Response(JSON.stringify({
  ok: true,
  version: 1,
  generatedAt: '2026-08-24T08:00:00.000Z',
  projects: [],
  agents: [],
  status: { agentId: 'codex', activeProject: null, contextReady: false },
  activeProject: null,
  viewedProject: null,
  tasks: [],
  sections: {
    projects: { ok: true, data: [] },
    agents: { ok: true, data: [] },
    status: { ok: true, data: { agentId: 'codex', activeProject: null, contextReady: false } },
    tasks: { ok: true, data: [] },
  },
}), { status: 200, headers: { 'Content-Type': 'application/json' } });
const loaded = await fetchDashboardSnapshot(null, 'codex');
assert.equal(loaded.version, 1);
assert.equal(Object.hasOwn(loaded, 'snapshot'), false);

global.fetch = async () => new Response(JSON.stringify({ error: 'Forbidden' }), {
  status: 403,
  headers: { 'Content-Type': 'application/json' },
});
await apiFetch('/api/projects/demo/files');
assert.equal(isAuthHalted(), true, 'any API 403 opens the shared auth halt');

global.fetch = async () => new Response(JSON.stringify({
  ok: true,
  user: { username: 'tester' },
  agentId: 'codex',
}), { status: 200, headers: { 'Content-Type': 'application/json' } });
await authenticateTelegram('signed-init-data');
assert.equal(isAuthHalted(), false, 'only a validated auth exchange clears the halt');

global.window.__FLOWBOARD_ENABLE_DASHBOARD_SNAPSHOT__ = false;
global.fetch = async (url) => {
  const path = new URL(url, global.window.location.origin).pathname;
  const data = path.endsWith('/projects')
    ? { ok: true, projects: [] }
    : path.endsWith('/agents')
      ? { ok: true, agents: [] }
      : { agentId: 'codex', activeProject: null };
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
const legacy = await fetchDashboardSnapshot(null, 'codex');
assert.deepEqual(legacy.projects, [], 'manual rollback uses the legacy project lane');
assert.equal(legacy.sections.tasks.ok, true, 'manual rollback preserves the typed envelope');
global.window.__FLOWBOARD_ENABLE_DASHBOARD_SNAPSHOT__ = true;

global.fetch = async () => new Response(JSON.stringify({
  error: 'Rate limit exceeded', code: 'RATE_LIMIT_EXCEEDED', scope: 'read', retryAfter: 7,
}), { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '7' } });
await assert.rejects(
  () => apiJson('/dashboard/snapshot/v1'),
  (error) => error instanceof ApiError
    && error.status === 429
    && error.retryAfterSeconds === 7
    && error.rateLimitScope === 'read',
  '429 exposes structured scope and Retry-After metadata to the client',
);

console.log('T-445 focused tests passed');
