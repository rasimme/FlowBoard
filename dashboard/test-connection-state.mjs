import assert from 'node:assert/strict';

import { ApiError, apiJson } from './src/utils/apiFetch.js';
import {
  INITIAL_CONNECTION_STATE,
  classifyConnectionError,
  connectionFailure,
  connectionLoading,
  connectionRecovery,
  connectionSuccess,
} from './src/state/connectionState.mjs';

console.log('# dashboard connection state (T-440)');

const auth = classifyConnectionError(new ApiError('Forbidden', { status: 403 }));
assert.equal(auth.status, 'auth-error');
assert.equal(auth.httpStatus, 403);

const unauthorized = classifyConnectionError(new ApiError('Unauthorized', { status: 401 }));
assert.equal(unauthorized.status, 'auth-error');

const offline = classifyConnectionError(new ApiError('Network request failed', { kind: 'network' }));
assert.equal(offline.status, 'offline');

const server = classifyConnectionError(new ApiError('Unavailable', { status: 503 }));
assert.equal(server.status, 'server-error');

const timeout = classifyConnectionError(new ApiError('Deadline reached', { kind: 'timeout' }));
assert.equal(timeout.status, 'timeout');

assert.deepEqual(connectionSuccess([]), {
  status: 'empty', hasData: true, retrying: false, error: null, httpStatus: null, errorScope: null,
});
assert.equal(connectionSuccess([{ name: 'project' }]).status, 'ready');

const withData = connectionFailure(connectionSuccess([{ name: 'project' }]), server);
assert.equal(withData.status, 'server-error');
assert.equal(withData.hasData, true, 'poll failure preserves the valid-data marker');
assert.equal(connectionLoading(withData).status, 'server-error', 'background retry keeps data visible');
assert.equal(connectionLoading(withData).retrying, true);
assert.deepEqual(connectionLoading(INITIAL_CONNECTION_STATE), {
  ...INITIAL_CONNECTION_STATE, status: 'loading', retrying: true,
});

const coreFailure = connectionFailure(connectionSuccess([{ name: 'project' }]), server, 'core');
assert.equal(coreFailure.errorScope, 'core');
assert.equal(
  connectionRecovery(coreFailure, [{ name: 'project' }], 'tasks'),
  coreFailure,
  'a task-only recovery cannot clear a global core API failure',
);
assert.equal(
  connectionFailure(coreFailure, new ApiError('Task refresh failed', { status: 500 }), 'tasks'),
  coreFailure,
  'a task-only failure cannot replace a global core API failure',
);
const taskFailure = connectionFailure(connectionSuccess([{ name: 'project' }]), server, 'tasks');
assert.equal(connectionRecovery(taskFailure, [{ name: 'project' }], 'tasks').status, 'ready');

global.window = { location: { origin: 'http://127.0.0.1:18790' }, Telegram: {} };

global.fetch = async () => new Response(JSON.stringify({ error: 'Tunnel auth required' }), {
  status: 403,
  headers: { 'Content-Type': 'application/json' },
});
await assert.rejects(
  () => apiJson('/projects'),
  (error) => error instanceof ApiError && error.status === 403 && error.message === 'Tunnel auth required',
  'apiJson preserves HTTP status for auth classification',
);

global.fetch = async () => { throw new TypeError('fetch failed'); };
await assert.rejects(
  () => apiJson('/projects'),
  (error) => error instanceof ApiError && error.kind === 'network',
  'apiJson types connection failures as network errors',
);

global.fetch = async () => new Response('<html>not json</html>', {
  status: 200,
  headers: { 'Content-Type': 'text/html' },
});
await assert.rejects(
  () => apiJson('/projects'),
  (error) => error instanceof ApiError && error.kind === 'protocol',
  'apiJson rejects a malformed/non-JSON 2xx response as a protocol failure',
);

let timeoutAbortedFetch = false;
global.fetch = async (_url, { signal }) => new Promise((resolve, reject) => {
  signal.addEventListener('abort', () => {
    timeoutAbortedFetch = true;
    reject(signal.reason || new DOMException('Aborted', 'AbortError'));
  }, { once: true });
});
await assert.rejects(
  () => apiJson('/projects', { timeoutMs: 20 }),
  (error) => error instanceof ApiError && error.kind === 'timeout' && /20 ms/.test(error.message),
  'apiJson enforces a real fetch deadline and reports a typed timeout',
);
assert.equal(timeoutAbortedFetch, true, 'the deadline aborts the underlying fetch');

console.log('dashboard connection state tests passed');
