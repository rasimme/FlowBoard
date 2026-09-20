'use strict';

/**
 * T-487-7 / ADR-0040 — service-credential principal for the OpenClaw Gateway.
 *
 * The invariant under test is narrow and load-bearing: the
 * X-FlowBoard-Gateway-* headers are attribution input **only** for a request
 * that already proved the shared service token from an accepted peer. Every
 * other request must be treated exactly as it was before this feature existed.
 *
 *   1. valid token + profile headers  → verified human principal, profile in
 *                                       the created task's creationAudit
 *   2. valid token, no profile header → trusted local operator (agent), never
 *                                       a fabricated human
 *   3. wrong / missing token          → headers ignored completely
 *   4. non-loopback peer without the  → rejected (headers ignored)
 *      explicit allow flag
 *   5. token shorter than 32 chars    → ignored with a named startup warning
 *   6. CSRF (S-06)                    → a bearer, Origin-less client is not
 *                                       blocked on mutating requests
 *   7. AUTH_ALWAYS=true + valid token → admitted
 *
 * Run: node test-service-token-principal.js
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const net = require('node:net');

const { withIsolatedDashboard } = require('./test-support/server-harness.js');
const { createCredentialFixtures } = require('./test-support/credential-fixtures.js');
const servicePrincipal = require('./service-principal.js');
const governance = require('./governance.js');

const CREDENTIALS = createCredentialFixtures('service-token-principal');
const SERVICE_TOKEN = crypto.randomBytes(32).toString('hex');
const SHORT_TOKEN = 'too-short-token';
const PROJECT = 'gateway-principal';
const PROFILE_ID = 'profile-7f3a2b';
const PROFILE_NAME = 'Gateway Operator';

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
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

function gatewayHeaders(extra = {}) {
  return {
    'X-FlowBoard-Gateway-Profile-Id': PROFILE_ID,
    'X-FlowBoard-Gateway-Profile-Name': PROFILE_NAME,
    'X-FlowBoard-Gateway-Scopes': 'operator.read,operator.write',
    'X-FlowBoard-Gateway-Agent-Id': 'claude-code',
    ...extra,
  };
}

async function call(base, method, path, { token, headers = {}, body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  return { status: response.status, body: parsed, text };
}

/** Reach the server over a non-loopback local address to test the peer rule. */
function firstNonLoopbackIPv4() {
  const interfaces = require('node:os').networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Unit level — the rules, without a server
// ---------------------------------------------------------------------------

function unitTests() {
  section('service token parsing');
  check('a 64-char token is accepted', () => {
    const parsed = servicePrincipal.parseServiceToken(SERVICE_TOKEN);
    assert.equal(parsed.token, SERVICE_TOKEN);
    assert.equal(parsed.warning, null);
  });
  check('a short token is ignored with a named warning', () => {
    const parsed = servicePrincipal.parseServiceToken(SHORT_TOKEN);
    assert.equal(parsed.token, null);
    assert.match(parsed.warning, /FLOWBOARD_SERVICE_TOKEN/);
    assert.match(parsed.warning, /IGNORED/);
  });
  check('an unset token disables the facade without a warning', () => {
    assert.deepEqual(servicePrincipal.parseServiceToken(undefined), { token: null, warning: null });
    assert.deepEqual(servicePrincipal.parseServiceToken('   '), { token: null, warning: null });
  });

  section('service caller resolution');
  const loopbackRequest = (headers) => ({ ip: '127.0.0.1', headers });
  check('matching token on loopback yields the caller', () => {
    const resolution = servicePrincipal.resolveServiceCaller(
      loopbackRequest({
        authorization: `Bearer ${SERVICE_TOKEN}`,
        'x-flowboard-gateway-profile-id': PROFILE_ID,
        'x-flowboard-gateway-profile-name': PROFILE_NAME,
        'x-flowboard-gateway-scopes': 'operator.read, operator.write',
      }),
      { token: SERVICE_TOKEN },
    );
    assert.equal(resolution.ok, true);
    assert.equal(resolution.caller.profileId, PROFILE_ID);
    assert.equal(resolution.caller.displayName, PROFILE_NAME);
    assert.deepEqual(resolution.caller.scopes, ['operator.read', 'operator.write']);
  });
  check('a wrong token resolves nothing', () => {
    const resolution = servicePrincipal.resolveServiceCaller(
      loopbackRequest({ authorization: 'Bearer nope', 'x-flowboard-gateway-profile-id': PROFILE_ID }),
      { token: SERVICE_TOKEN },
    );
    assert.equal(resolution.ok, false);
    assert.equal(resolution.reason, 'token_mismatch');
  });
  check('a remote peer is rejected unless explicitly allowed', () => {
    const request = { ip: '10.0.0.7', headers: { authorization: `Bearer ${SERVICE_TOKEN}` } };
    assert.equal(servicePrincipal.resolveServiceCaller(request, { token: SERVICE_TOKEN }).reason, 'remote_not_allowed');
    assert.equal(servicePrincipal.resolveServiceCaller(request, { token: SERVICE_TOKEN, allowRemote: true }).ok, true);
  });
  check('a cf-ray tunnel marker is rejected like a remote peer', () => {
    const request = { ip: '127.0.0.1', headers: { authorization: `Bearer ${SERVICE_TOKEN}`, 'cf-ray': 'abc' } };
    assert.equal(servicePrincipal.resolveServiceCaller(request, { token: SERVICE_TOKEN }).reason, 'remote_not_allowed');
  });
  check('header values are bounded and control characters rejected', () => {
    const resolution = servicePrincipal.resolveServiceCaller(
      loopbackRequest({
        authorization: `Bearer ${SERVICE_TOKEN}`,
        'x-flowboard-gateway-profile-id': 'x'.repeat(200),
        'x-flowboard-gateway-agent-id': 'agent\nInjected: yes',
        'x-flowboard-gateway-scopes': `${'a'.repeat(200)},operator.read,not a scope`,
      }),
      { token: SERVICE_TOKEN },
    );
    assert.equal(resolution.caller.profileId, null, 'over-long profile id is dropped');
    assert.equal(resolution.caller.agentId, null, 'newline in a header value is dropped');
    assert.deepEqual(resolution.caller.scopes, ['operator.read']);
  });
  check('comparison is constant-time and length-aware', () => {
    assert.equal(servicePrincipal.timingSafeEqualString(SERVICE_TOKEN, SERVICE_TOKEN), true);
    assert.equal(servicePrincipal.timingSafeEqualString(SERVICE_TOKEN, `${SERVICE_TOKEN}x`), false);
    assert.equal(servicePrincipal.timingSafeEqualString('', SERVICE_TOKEN), false);
  });

  section('principal resolution (ADR-0033 ordering)');
  check('profile present → verified human with gateway source', () => {
    const principal = governance.resolvePrincipal({
      ip: '127.0.0.1',
      serviceCaller: {
        source: 'openclaw-gateway',
        profileId: PROFILE_ID,
        displayName: PROFILE_NAME,
        scopes: ['operator.write'],
        agentId: 'claude-code',
        sessionKey: 'agent:main:main',
      },
    });
    assert.equal(principal.kind, 'human');
    assert.equal(principal.verified, true);
    assert.equal(principal.source, 'openclaw-gateway');
    assert.equal(principal.actor, `gateway:${PROFILE_ID}`);
    assert.equal(principal.humanId, PROFILE_ID);
    assert.equal(principal.displayName, PROFILE_NAME);
    assert.equal(governance.isVerifiedHuman(principal), true);
  });
  check('no profile → trusted local operator, never a fabricated human', () => {
    const principal = governance.resolvePrincipal({
      ip: '127.0.0.1',
      serviceCaller: { source: 'openclaw-gateway', profileId: null, displayName: null, scopes: [] },
    });
    assert.equal(principal.kind, 'agent');
    assert.equal(principal.verified, false);
    assert.equal(principal.actor, 'local:operator');
    assert.equal(governance.isVerifiedHuman(principal), false);
  });
  check('a FlowBoard Telegram session still wins over the Gateway credential', () => {
    const principal = governance.resolvePrincipal({
      ip: '127.0.0.1',
      user: { id: 4711 },
      serviceCaller: { source: 'openclaw-gateway', profileId: PROFILE_ID },
    });
    assert.equal(principal.actor, 'session:4711');
  });
  check('a forged serviceCaller source is not honoured', () => {
    const principal = governance.resolvePrincipal({
      ip: '127.0.0.1',
      serviceCaller: { source: 'somewhere-else', profileId: PROFILE_ID },
    });
    assert.equal(principal.actor, 'local:operator', 'falls through to the loopback rule');
    assert.equal(principal.kind, 'agent');
  });
}

// ---------------------------------------------------------------------------
// HTTP level — against a real isolated server
// ---------------------------------------------------------------------------

async function httpTests() {
  await withIsolatedDashboard(async ({ base, readLogs }) => {
    section('HTTP — valid credential');

    const created = await call(base, 'POST', '/api/projects', {
      token: SERVICE_TOKEN,
      headers: gatewayHeaders(),
      body: { name: PROJECT, displayName: 'Gateway Principal', description: 'ADR-0040 fixture project.' },
    });
    check('project creation over the service credential succeeds', () => {
      assert.equal(created.status, 201, created.text.slice(0, 200));
    });

    const task = await call(base, 'POST', `/api/projects/${PROJECT}/tasks`, {
      token: SERVICE_TOKEN,
      headers: gatewayHeaders(),
      body: { title: 'Attribution proof', priority: 'medium' },
    });
    check('task creation records the Gateway profile in creationAudit', () => {
      assert.equal(task.status, 200, task.text.slice(0, 200));
      const audit = task.body?.task?.creationAudit;
      assert.ok(audit, 'creationAudit present');
      assert.equal(audit.origin, 'tasks-api');
      assert.equal(audit.principal.kind, 'human');
      assert.equal(audit.principal.verified, true);
      assert.equal(audit.principal.actor, `gateway:${PROFILE_ID}`);
      assert.equal(audit.principal.source, 'openclaw-gateway');
      assert.equal(audit.principal.displayName, PROFILE_NAME);
    });
    check('S-06 does not block a bearer client that sends no Origin', () => {
      assert.notEqual(task.status, 403, 'mutating bearer request must not be CSRF-rejected');
    });

    section('HTTP — no profile header');
    const operatorTask = await call(base, 'POST', `/api/projects/${PROJECT}/tasks`, {
      token: SERVICE_TOKEN,
      headers: { 'X-FlowBoard-Gateway-Scopes': 'operator.write' },
      body: { title: 'Operator fallback', priority: 'low' },
    });
    check('a Gateway call without a profile is the local operator', () => {
      assert.equal(operatorTask.status, 200, operatorTask.text.slice(0, 200));
      const principal = operatorTask.body?.task?.creationAudit?.principal;
      assert.equal(principal.kind, 'agent');
      assert.equal(principal.verified, false);
      assert.equal(principal.actor, 'local:operator');
      assert.equal(principal.displayName, undefined);
    });

    section('HTTP — invalid or absent credential');
    const forged = await call(base, 'POST', `/api/projects/${PROJECT}/tasks`, {
      token: `${SERVICE_TOKEN.slice(0, -1)}0`,
      headers: gatewayHeaders(),
      body: { title: 'Forged attribution', priority: 'low' },
    });
    check('a wrong token leaves the profile headers completely ignored', () => {
      assert.equal(forged.status, 200, 'loopback admission still applies');
      const principal = forged.body?.task?.creationAudit?.principal;
      assert.equal(principal.kind, 'agent');
      assert.equal(principal.actor, 'local:operator');
      assert.equal(principal.source, undefined);
    });

    const unauthenticated = await call(base, 'POST', `/api/projects/${PROJECT}/tasks`, {
      headers: gatewayHeaders(),
      body: { title: 'No credential at all', priority: 'low' },
    });
    check('headers without any token are ignored too', () => {
      assert.equal(unauthenticated.status, 200);
      const principal = unauthenticated.body?.task?.creationAudit?.principal;
      assert.equal(principal.kind, 'agent');
      assert.equal(principal.actor, 'local:operator');
    });

    check('a rejected service call is logged without the credential', () => {
      const logs = readLogs();
      assert.match(logs, /\[service-auth\] rejected Gateway service call \(token_mismatch\)/);
      assert.equal(logs.includes(SERVICE_TOKEN), false, 'the configured token never reaches the log');
    });
  }, { prefix: 'flowboard-service-token-', env: { FLOWBOARD_SERVICE_TOKEN: SERVICE_TOKEN } });
}

async function shortTokenTest() {
  section('HTTP — token shorter than the minimum');
  await withIsolatedDashboard(async ({ base, readLogs }) => {
    const rejected = await call(base, 'POST', '/api/projects', {
      token: SHORT_TOKEN,
      headers: gatewayHeaders(),
      body: { name: 'short-token', displayName: 'Short', description: 'x' },
    });
    check('a short token never authenticates a Gateway principal', () => {
      assert.match(readLogs(), /FLOWBOARD_SERVICE_TOKEN is shorter than 32 characters and is IGNORED/);
      // Loopback admission still lets the request through, but as the operator.
      assert.equal(rejected.status, 201);
    });
    const task = await call(base, 'POST', '/api/projects/short-token/tasks', {
      token: SHORT_TOKEN,
      headers: gatewayHeaders(),
      body: { title: 'Short token attribution', priority: 'low' },
    });
    check('and its headers are not used for attribution', () => {
      assert.equal(task.body?.task?.creationAudit?.principal?.actor, 'local:operator');
    });
  }, { prefix: 'flowboard-service-token-short-', env: { FLOWBOARD_SERVICE_TOKEN: SHORT_TOKEN } });
}

async function remotePeerTest() {
  const address = firstNonLoopbackIPv4();
  section('HTTP — non-loopback peer');
  if (!address) {
    console.log('  ⏭️  no non-loopback IPv4 interface available; peer rule covered by the unit test');
    return;
  }
  await withIsolatedDashboard(async ({ port }) => {
    const reachable = await new Promise((resolve) => {
      const probe = net.connect({ host: address, port, localAddress: address }, () => {
        probe.destroy();
        resolve(true);
      });
      probe.on('error', () => resolve(false));
      probe.setTimeout(1000, () => { probe.destroy(); resolve(false); });
    });
    if (!reachable) {
      console.log('  ⏭️  server is bound to loopback only; the peer rule cannot be exercised over the wire');
      return;
    }
    const task = await call(`http://${address}:${port}`, 'POST', `/api/projects/${PROJECT}/tasks`, {
      token: SERVICE_TOKEN,
      headers: gatewayHeaders(),
      body: { title: 'Remote attribution', priority: 'low' },
    });
    check('a remote service call is refused, not attributed', () => {
      assert.equal(task.status, 403);
    });
  }, { prefix: 'flowboard-service-token-remote-', env: { FLOWBOARD_SERVICE_TOKEN: SERVICE_TOKEN } });
}

async function authAlwaysTest() {
  section('HTTP — AUTH_ALWAYS=true');
  await withIsolatedDashboard(async ({ base }) => {
    const anonymous = await call(base, 'GET', '/api/projects');
    check('an anonymous loopback request is challenged', () => {
      assert.equal(anonymous.status === 401 || anonymous.status === 403, true, `got ${anonymous.status}`);
    });
    const authorized = await call(base, 'GET', '/api/projects', {
      token: SERVICE_TOKEN,
      headers: gatewayHeaders(),
    });
    check('the service credential is admitted under AUTH_ALWAYS', () => {
      assert.equal(authorized.status, 200, authorized.text.slice(0, 200));
    });
  }, {
    prefix: 'flowboard-service-token-authalways-',
    env: {
      FLOWBOARD_SERVICE_TOKEN: SERVICE_TOKEN,
      AUTH_ALWAYS: 'true',
      TELEGRAM_BOT_TOKEN: CREDENTIALS.botToken,
      FLOWBOARD_TELEGRAM_AGENT_IDS: 'main',
      ALLOWED_USER_IDS: '4711',
      JWT_SECRET: CREDENTIALS.jwtSecret,
    },
  });
}

async function main() {
  unitTests();
  await httpTests();
  await shortTokenTest();
  await remotePeerTest();
  await authAlwaysTest();

  console.log(`\n${failed ? '❌' : '✅'} service-token principal: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
