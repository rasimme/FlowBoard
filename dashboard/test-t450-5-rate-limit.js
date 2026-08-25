'use strict';

// T-450-5: token-bucket capacity, refill, trusted key isolation, and the
// Retry-After contract. This test uses a deterministic clock so it does not
// depend on scheduler timing or an available TCP port.
const assert = require('node:assert/strict');
const {
  LaneTokenBucketLimiter,
  getRateLimitScope,
  getTrustedPrincipal,
} = require('./rate-limiter.js');

const originalNow = Date.now;
let now = 1_000_000;
Date.now = () => now;

function request({ id = 7, method = 'GET', originalUrl = '/api/projects', body } = {}) {
  return {
    method,
    originalUrl,
    user: { id },
    body,
    headers: {},
    socket: { remoteAddress: '198.51.100.10' },
  };
}

function response() {
  const headers = {};
  return {
    headers,
    statusCode: null,
    body: null,
    set(name, value) { headers[name] = String(value); return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function run(middleware, req) {
  const res = response();
  let continued = false;
  middleware(req, res, () => { continued = true; });
  return { res, continued };
}

try {
  const limiter = new LaneTokenBucketLimiter({
    budgets: { read: 2, checkpoint: 2, mutation: 2, auth: 2 },
    burst: 3,
    keyGenerator: req => getTrustedPrincipal(req),
    scopeFor: getRateLimitScope,
  });
  const middleware = limiter.middleware();

  // rate + burst is the initial capacity: five requests pass, the sixth is
  // rejected and advertises the time needed for one token at 2/minute.
  const read = request();
  for (let i = 0; i < 5; i++) assert.equal(run(middleware, read).continued, true);
  const limited = run(middleware, read);
  assert.equal(limited.continued, false, 'bucket rejects after rate + burst tokens');
  assert.equal(limited.res.statusCode, 429);
  assert.equal(limited.res.headers['Retry-After'], '30');
  assert.equal(limited.res.body.code, 'RATE_LIMIT_EXCEEDED');
  assert.equal(limited.res.body.scope, 'read');
  assert.equal(limited.res.body.lane, 'read');
  assert.equal(limited.res.body.retryAfter, 30);

  // One minute refills exactly the configured rate, but never beyond the
  // capacity. The two newly available tokens pass and the third is rejected.
  now += 60_000;
  assert.equal(run(middleware, read).continued, true, 'refill supplies the configured rate');
  assert.equal(run(middleware, read).continued, true, 'refill supplies the second configured token');
  assert.equal(run(middleware, read).res.statusCode, 429, 'refill does not exceed bucket capacity');

  // Lane and trusted principal are both part of the key. Body-supplied agent
  // ids are ignored by the principal resolver and cannot select a bucket.
  assert.equal(run(middleware, request({ id: 8 })).continued, true, 'another trusted principal has an independent bucket');
  assert.equal(run(middleware, request({ method: 'POST', originalUrl: '/api/projects/demo/tasks/T-1/checkpoint' })).continued, true, 'checkpoint lane is independent');
  assert.equal(
    getTrustedPrincipal(request({ body: { agent: 'attacker-controlled-id' } })),
    'user:7',
    'unchecked body identity never becomes the limiter principal',
  );

  limiter.close();
  console.log('T-450-5 token-bucket contract tests passed');
} finally {
  Date.now = originalNow;
}
