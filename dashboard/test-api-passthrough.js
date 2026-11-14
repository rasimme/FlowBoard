'use strict';

/**
 * T-515-1 — the Gateway API passthrough for the native React dashboard.
 *
 * Raw Gateway methods are not schema-checked by the host, so the allow-list in
 * `openclaw/api-passthrough.js` is the only gate between an operator
 * connection and the dashboard's REST API. Pinned here:
 *
 *   1. Every documented endpoint is either forwarded or explicitly excluded —
 *      a new endpoint cannot become reachable (or silently unreachable) by
 *      accident.
 *   2. The read lane can only GET; path tricks never reach the dashboard.
 *   3. The adapter adds the principal and the service credential itself and
 *      returns status, body and the few headers the client reads.
 *   4. The browser transport turns a fetch call into one Gateway call and the
 *      answer back into a Response, so the client's own handling is unchanged.
 *
 * Run: node test-api-passthrough.js
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { withIsolatedDashboard } = require('./test-support/server-harness.js');

const REPO_ROOT = path.resolve(__dirname, '..');
const url = (...parts) => pathToFileURL(path.join(REPO_ROOT, ...parts)).href;
const SERVICE_TOKEN = crypto.randomBytes(32).toString('hex');

/** Documented endpoints the native page must not reach. Keep reasons current. */
const EXCLUDED = new Map([
  ['POST /api/update/run', 'self-update restarts the dashboard'],
  ['POST /api/auth', 'dashboard sign-in; the Gateway connection is the identity'],
  ['POST /api/hooks/task-complete', 'webhook for agents'],
  ['DELETE /api/agents/:id', 'not used by the dashboard client'],
  ['GET /api/health/integrity', 'operator diagnostics'],
  ['GET /api/tasks/notifiable-stuck', 'notifier endpoint'],
  ['GET /api/projects/:name/bootstrap', 'agent context'],
  ['GET /api/projects/:name/rules', 'agent context'],
  ['GET /api/projects/:name/rules/:section', 'agent context'],
  ['GET /api/projects/:name/tasks/:id/handoff', 'agent context'],
  ['POST /api/projects/:name/sessions', 'agent session log'],
  ['POST /api/projects/:name/heal', 'operator repair'],
  ['PUT /api/projects/:name/governance/mode', 'not used by the dashboard client'],
  ['DELETE /api/projects/:name/canvas/notes/batch', 'not used by the dashboard client'],
  ['POST /api/workflows/start', 'agent workflow'],
  ['POST /api/workflows/handoff', 'agent workflow'],
  ['POST /api/workflows/delegate', 'agent workflow'],
]);

let passed = 0;
let failed = 0;
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

function samplePath(template) {
  return template
    .replace('{*filePath}', 'context/NOTES.md')
    .replace(/:[A-Za-z]+/g, 'x1');
}

async function allowListTests() {
  const p = await import(url('openclaw', 'api-passthrough.js'));
  const verdict = (request, allowWrite) => p.checkApiRequest(request, { allowWrite });
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'docs', 'reference', 'api-manifest.json'), 'utf8'));

  section('allow-list covers the documented API');
  await check('every documented endpoint is forwarded or explicitly excluded', () => {
    const wrong = [];
    for (const { method, path: template } of manifest.endpoints) {
      const key = `${method} ${template}`;
      const request = method === 'GET' ? { path: samplePath(template) } : { method, path: samplePath(template) };
      const allowed = verdict(request, method !== 'GET').ok;
      if (allowed === EXCLUDED.has(key)) wrong.push(`${key} (${allowed ? 'forwarded but excluded' : 'neither forwarded nor excluded'})`);
    }
    assert.deepEqual(wrong, []);
  });
  await check('the exclusion list names only documented endpoints', () => {
    const known = new Set(manifest.endpoints.map((e) => `${e.method} ${e.path}`));
    assert.deepEqual([...EXCLUDED.keys()].filter((key) => !known.has(key)), []);
  });

  section('lanes and path hygiene');
  await check('the read lane ignores a caller-supplied method', () => {
    const result = verdict({ method: 'DELETE', path: '/api/projects/demo/tasks' }, false);
    assert.equal(result.ok, true);
    assert.equal(result.method, 'GET');
  });
  await check('the read lane refuses a body', () => {
    assert.equal(verdict({ path: '/api/projects', body: '{}' }, false).code, 'GATEWAY_BODY_INVALID');
  });
  await check('the write lane refuses GET and unknown methods', () => {
    for (const method of ['GET', 'PATCH', 'HEAD', 'OPTIONS', '', undefined]) {
      assert.equal(verdict({ method, path: '/api/projects' }, true).code, 'GATEWAY_METHOD_NOT_ALLOWED', String(method));
    }
  });
  await check('non-canonical and foreign paths are refused before matching', () => {
    const bad = [
      '/api/projects/demo/../../update/run', '/api/projects/demo/./tasks', '//evil.example/api/projects',
      'http://evil.example/api/projects', '/api/projects/demo%2f..%2fx', '/api/projects/demo%2e%2e/tasks',
      '/api/projects\\demo', '/api/projects#x', '/api/projects\n', '/projects', '', null, 42,
      `/api/projects?${'a'.repeat(p.MAX_PATH_LENGTH)}`,
    ];
    for (const candidate of bad) {
      assert.equal(verdict({ path: candidate }, false).code, 'GATEWAY_PATH_INVALID', JSON.stringify(candidate));
    }
  });
  await check('the query string is kept and never matched against', () => {
    const result = verdict({ path: '/api/projects/demo/tasks?includeArchived=true&x=/api/update/run' }, false);
    assert.equal(result.path, '/api/projects/demo/tasks?includeArchived=true&x=/api/update/run');
    assert.equal(verdict({ method: 'POST', path: '/api/search?x=/api/projects' }, true).code, 'GATEWAY_PATH_NOT_ALLOWED');
  });
  await check('body and content type are bounded', () => {
    const base = { method: 'POST', path: '/api/projects/demo/tasks' };
    assert.equal(verdict({ ...base, body: { title: 'x' } }, true).code, 'GATEWAY_BODY_INVALID');
    assert.equal(verdict({ ...base, body: 'x'.repeat(p.MAX_REQUEST_BODY + 1) }, true).code, 'GATEWAY_BODY_TOO_LARGE');
    assert.equal(verdict({ ...base, body: '{}', contentType: 'text/html' }, true).code, 'GATEWAY_CONTENT_TYPE_NOT_ALLOWED');
    assert.equal(verdict({ ...base, body: '{}', contentType: 'application/vnd.flowboard.project-bundle+json' }, true).ok, true);
  });
}

function stubFetch(answer = {}) {
  const calls = [];
  return {
    calls,
    fetch: async (target, init = {}) => {
      calls.push({ url: String(target), ...init });
      const headers = new Headers(answer.headers || { 'content-type': 'application/json', etag: '"abc"', 'set-cookie': 'sid=1', 'x-internal': 'no' });
      return { status: answer.status ?? 200, headers, text: async () => answer.body ?? '{"ok":true}' };
    },
  };
}

async function adapterTests() {
  const { createFlowBoardAdapter } = await import(url('openclaw', 'adapter.js'));
  const principal = { profileId: 'p-1', displayName: 'Op', scopes: ['operator.read', 'operator.write'], agentId: null, sessionKey: null };

  section('adapter passthrough');
  await check('adds the service credential and the principal; forwards only known response headers', async () => {
    const stub = stubFetch();
    const adapter = createFlowBoardAdapter({ dashboardBaseUrl: 'http://127.0.0.1:1', serviceToken: SERVICE_TOKEN }, { fetch: stub.fetch });
    const result = await adapter.passthrough(principal, { path: '/api/projects?x=1', ifNoneMatch: '"abc"' });
    assert.equal(stub.calls[0].url, 'http://127.0.0.1:1/api/projects?x=1');
    assert.equal(stub.calls[0].method, 'GET');
    assert.equal(stub.calls[0].headers.Authorization, `Bearer ${SERVICE_TOKEN}`);
    assert.equal(stub.calls[0].headers['X-FlowBoard-Gateway-Profile-Id'], 'p-1');
    assert.equal(stub.calls[0].headers['If-None-Match'], '"abc"');
    assert.deepEqual(result, { status: 200, headers: { 'content-type': 'application/json', etag: '"abc"' }, body: '{"ok":true}' });
  });
  await check('caller params cannot inject identity or arbitrary headers', async () => {
    const stub = stubFetch();
    const adapter = createFlowBoardAdapter({ dashboardBaseUrl: 'http://127.0.0.1:1', serviceToken: SERVICE_TOKEN }, { fetch: stub.fetch });
    await adapter.passthrough(principal, {
      method: 'POST', path: '/api/projects/demo/tasks', body: '{"title":"x"}',
      headers: { Authorization: 'Bearer evil', 'X-FlowBoard-Gateway-Profile-Id': 'evil' }, profileId: 'evil',
      sensitiveConfirmation: 'yes\r\nX-Evil: 1',
    }, { allowWrite: true });
    const sent = stub.calls[0].headers;
    assert.equal(sent.Authorization, `Bearer ${SERVICE_TOKEN}`);
    assert.equal(sent['X-FlowBoard-Gateway-Profile-Id'], 'p-1');
    assert.equal(sent['Content-Type'], 'application/json');
    assert.equal(/[\r\n]/.test(sent['X-FlowBoard-Sensitive-Confirmation']), false);
    assert.equal(stub.calls[0].body, '{"title":"x"}');
  });
  await check('a refused request never reaches the dashboard', async () => {
    const stub = stubFetch();
    const adapter = createFlowBoardAdapter({ dashboardBaseUrl: 'http://127.0.0.1:1' }, { fetch: stub.fetch });
    const denied = await adapter.passthrough(principal, { method: 'POST', path: '/api/update/run' }, { allowWrite: true });
    const readLane = await adapter.passthrough(principal, { method: 'POST', path: '/api/projects/demo/tasks', body: '{}' });
    assert.equal(denied.status, 403);
    assert.equal(JSON.parse(denied.body).code, 'GATEWAY_PATH_NOT_ALLOWED');
    assert.equal(readLane.status, 400);
    assert.equal(stub.calls.length, 0);
  });
  await check('upstream status and body are returned verbatim', async () => {
    const stub = stubFetch({ status: 409, body: '{"error":"Not owner","code":"NOT_OWNER"}' });
    const adapter = createFlowBoardAdapter({ dashboardBaseUrl: 'http://127.0.0.1:1' }, { fetch: stub.fetch });
    const result = await adapter.passthrough(principal, { method: 'PUT', path: '/api/projects/demo/tasks/T-1', body: '{}' }, { allowWrite: true });
    assert.equal(result.status, 409);
    assert.equal(JSON.parse(result.body).code, 'NOT_OWNER');
  });
  await check('an unreachable dashboard is a 502 without the cause', async () => {
    const adapter = createFlowBoardAdapter({ dashboardBaseUrl: 'http://127.0.0.1:1', serviceToken: SERVICE_TOKEN }, {
      fetch: async () => { throw new Error(`boom ${SERVICE_TOKEN}`); },
    });
    const result = await adapter.passthrough(principal, { path: '/api/projects' });
    assert.equal(result.status, 502);
    assert.equal(result.body.includes(SERVICE_TOKEN), false);
    assert.equal(JSON.parse(result.body).code, 'GATEWAY_UPSTREAM_UNAVAILABLE');
  });
}

async function transportTests() {
  const { createGatewayTransport } = await import(url('openclaw', 'native-ui', 'gateway-transport.js'));

  section('browser transport');
  await check('GET becomes the read method and the answer a Response', async () => {
    const calls = [];
    const transport = createGatewayTransport(async (method, params) => {
      calls.push({ method, params });
      return { status: 200, headers: { 'content-type': 'application/json', etag: '"v1"' }, body: '{"ok":true}' };
    });
    const response = await transport('/api/projects', { headers: { 'If-None-Match': '"v0"', 'X-FlowBoard-Client': 'dashboard' } });
    assert.deepEqual(calls, [{ method: 'flowboard.api.read', params: { path: '/api/projects', ifNoneMatch: '"v0"' } }]);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('etag'), '"v1"');
    assert.deepEqual(await response.json(), { ok: true });
  });
  await check('a write carries method, string body, bundle content type and confirmation', async () => {
    const calls = [];
    const transport = createGatewayTransport(async (method, params) => { calls.push({ method, params }); return { status: 201, body: '{}' }; });
    await transport('/api/projects/import', {
      method: 'post', body: '{"a":1}',
      headers: { 'Content-Type': 'application/vnd.flowboard.project-bundle+json', 'X-FlowBoard-Sensitive-Confirmation': 'allow' },
    });
    await transport('/api/projects/demo/tasks/trash', { method: 'DELETE', body: '{"confirmation":"empty-trash"}', headers: { 'Content-Type': 'application/json' } });
    assert.deepEqual(calls[0], { method: 'flowboard.api.write', params: {
      path: '/api/projects/import', method: 'POST', body: '{"a":1}',
      contentType: 'application/vnd.flowboard.project-bundle+json', sensitiveConfirmation: 'allow',
    } });
    assert.deepEqual(calls[1].params, { path: '/api/projects/demo/tasks/trash', method: 'DELETE', body: '{"confirmation":"empty-trash"}' });
  });
  await check('304 and 204 answers are bodyless; a malformed answer is a 502', async () => {
    const answers = [{ status: 304, body: '' }, { status: 204, body: 'ignored' }, null];
    const transport = createGatewayTransport(async () => answers.shift());
    assert.equal((await transport('/api/dashboard/snapshot/v1')).status, 304);
    assert.equal((await transport('/api/projects/demo/files/a.md', { method: 'DELETE' })).status, 204);
    assert.equal((await transport('/api/projects')).status, 502);
  });
  await check('an aborted signal rejects with the abort reason', async () => {
    const transport = createGatewayTransport(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = transport('/api/projects', { signal: controller.signal });
    controller.abort(new DOMException('timed out', 'TimeoutError'));
    await assert.rejects(pending, (error) => error.name === 'TimeoutError');
    await assert.rejects(transport('/api/projects', { signal: controller.signal }), (error) => error.name === 'TimeoutError');
  });
}

async function httpTests() {
  const { createFlowBoardAdapter } = await import(url('openclaw', 'adapter.js'));
  const { createGatewayTransport } = await import(url('openclaw', 'native-ui', 'gateway-transport.js'));

  section('against a real dashboard');
  await withIsolatedDashboard(async ({ base, api }) => {
    const adapter = createFlowBoardAdapter({ dashboardBaseUrl: base, serviceToken: SERVICE_TOKEN });
    const principal = { profileId: 'profile-42', displayName: 'Gateway Operator', scopes: ['operator.read', 'operator.write'], agentId: null, sessionKey: null };
    // What the plugin backend does with a Gateway call, minus the Gateway.
    const transport = createGatewayTransport((method, params) =>
      adapter.passthrough(principal, params, { allowWrite: method === 'flowboard.api.write' }));

    await api('POST', '/projects', { name: 'native-fixture', displayName: 'Native fixture', description: 'T-515-1 fixture.' });

    await check('a write through the transport is attributed to the Gateway profile', async () => {
      const response = await transport('/api/projects/native-fixture/tasks', {
        method: 'POST', body: JSON.stringify({ title: 'Created through the Gateway' }), headers: { 'Content-Type': 'application/json' },
      });
      assert.equal(response.status, 200);
      const { task } = await response.json();
      assert.equal(task.creationAudit?.principal?.source, 'openclaw-gateway');
      assert.equal(task.creationAudit?.principal?.verified, true);
      assert.equal(task.creationAudit?.principal?.displayName, 'Gateway Operator');
    });
    await check('a large task list crosses in one piece', async () => {
      const filler = 'x'.repeat(4000);
      for (let i = 0; i < 80; i += 1) {
        await api('POST', '/projects/native-fixture/tasks', { title: `Bulk ${i}`, description: filler });
      }
      const response = await transport('/api/projects/native-fixture/tasks?includeArchived=true');
      const text = await response.text();
      assert.equal(response.status, 200);
      assert.ok(text.length > 300000, `expected more than 300000 characters, got ${text.length}`);
      assert.equal(JSON.parse(text).tasks.length, 81);
    });
    await check('FlowBoard errors keep their status and message', async () => {
      const response = await transport('/api/projects/native-fixture/tasks/T-999');
      assert.equal(response.status, 404);
      assert.equal(typeof (await response.json()).error, 'string');
    });
    await check('an excluded endpoint is refused without touching the dashboard', async () => {
      const response = await transport('/api/update/run', { method: 'POST', body: '{}' });
      assert.equal(response.status, 403);
      assert.equal((await response.json()).code, 'GATEWAY_PATH_NOT_ALLOWED');
    });
  }, { env: { FLOWBOARD_SERVICE_TOKEN: SERVICE_TOKEN } });
}

async function main() {
  await allowListTests();
  await adapterTests();
  await transportTests();
  await httpTests();
  console.log(`\n${failed ? '❌' : '✅'} api passthrough: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
