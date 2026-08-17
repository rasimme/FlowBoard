import assert from 'node:assert/strict';

import { ApiError, apiJson } from './src/utils/apiFetch.js';
import {
  INITIAL_CONNECTION_STATE,
  classifyConnectionError,
  connectionFailure,
  connectionLoading,
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

assert.deepEqual(connectionSuccess([]), {
  status: 'empty', hasData: true, retrying: false, error: null, httpStatus: null,
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

console.log('dashboard connection state tests passed');
