'use strict';

// T-441: Cloudflare forwarding headers are trusted only after the immediate
// socket peer matches explicit proxy configuration. This locks the boundary
// independently of an HTTP server's loopback transport.

const assert = require('assert');
const {
  RateLimiter,
  getClientIp,
  isTrustedCloudflareRequest,
  parseTrustedProxyConfig,
  DEFAULT_LANE_BUDGETS,
  LaneTokenBucketLimiter,
  getRateLimitScope,
  getTrustedPrincipal,
  readRateLimitConfig,
} = require('./rate-limiter.js');

function request(socketAddress, cloudflareIp, { ray = 'test-ray' } = {}) {
  return {
    socket: { remoteAddress: socketAddress },
    headers: {
      'cf-ray': ray,
      'cf-connecting-ip': cloudflareIp,
    },
  };
}

function run() {
  console.log('# rate-limiter proxy trust (T-441)');

  const config = parseTrustedProxyConfig('127.0.0.1,::1,10.0.0.0/8,not-an-ip');
  assert.strictEqual(config.entries.length, 3, 'valid proxy addresses and CIDRs are parsed');
  assert.deepStrictEqual(config.invalid, ['not-an-ip'], 'invalid proxy entries are reported');

  const forgedDirect = request('198.51.100.10', '203.0.113.1');
  assert.strictEqual(
    isTrustedCloudflareRequest(forgedDirect, config.entries),
    false,
    'forged cf-ray/cf-connecting-ip from a direct peer is untrusted',
  );
  assert.strictEqual(
    getClientIp(forgedDirect, config.entries),
    '198.51.100.10',
    'combined spoofing uses the direct socket key',
  );

  const directRotatingHeader = (index) => ({
    socket: { remoteAddress: '198.51.100.11' },
    headers: {
      'cf-connecting-ip': `203.0.113.${index}`,
    },
  });
  const directLimiter = new RateLimiter({
    windowMs: 60_000,
    maxRequests: 2,
    trustedProxyIps: config.entries,
  });
  assert.strictEqual(directLimiter.check(directRotatingHeader(1)).ok, true);
  assert.strictEqual(directLimiter.check(directRotatingHeader(2)).ok, true);
  assert.strictEqual(
    directLimiter.check(directRotatingHeader(3)).ok,
    false,
    'rotating an untrusted cf-connecting-ip cannot open new direct buckets',
  );
  directLimiter.close();

  const configuredCloudflare = request('127.0.0.1', '203.0.113.20');
  assert.strictEqual(
    isTrustedCloudflareRequest(configuredCloudflare, config.entries),
    true,
    'configured cloudflared loopback peer enables the Cloudflare path',
  );
  assert.strictEqual(
    getClientIp(configuredCloudflare, config.entries),
    '203.0.113.20',
    'configured Cloudflare path keeps the real client key',
  );

  const mappedLoopback = request('::ffff:127.0.0.1', '203.0.113.21');
  assert.strictEqual(
    getClientIp(mappedLoopback, config.entries),
    '203.0.113.21',
    'IPv4-mapped loopback socket matches configured proxy peer',
  );

  const unconfiguredCloudflare = request('127.0.0.1', '203.0.113.22');
  assert.strictEqual(
    isTrustedCloudflareRequest(unconfiguredCloudflare),
    false,
    'Cloudflare headers are not trusted without explicit proxy configuration',
  );
  assert.strictEqual(
    getClientIp(unconfiguredCloudflare),
    '127.0.0.1',
    'unconfigured tunnel falls back safely to its socket key',
  );

  const cloudflareLimiter = new RateLimiter({
    windowMs: 60_000,
    maxRequests: 2,
    trustedProxyIps: ['127.0.0.1'],
  });
  assert.strictEqual(cloudflareLimiter.check(request('127.0.0.1', '203.0.113.30')).ok, true);
  assert.strictEqual(cloudflareLimiter.check(request('127.0.0.1', '203.0.113.30')).ok, true);
  assert.strictEqual(
    cloudflareLimiter.check(request('127.0.0.1', '203.0.113.30')).ok,
    false,
    'configured Cloudflare client keeps its own rate-limit bucket',
  );
  assert.strictEqual(
    cloudflareLimiter.check(request('127.0.0.1', '203.0.113.31')).ok,
    true,
    'a second configured Cloudflare client is not degraded into the first bucket',
  );
  cloudflareLimiter.close();

  assert.deepStrictEqual(DEFAULT_LANE_BUDGETS, {
    read: 300,
    checkpoint: 120,
    mutation: 60,
    auth: 10,
  }, 'T-450-2 keeps the four independent default lane budgets');
  assert.deepStrictEqual(
    readRateLimitConfig({
      FLOWBOARD_RATE_LIMIT_READ: '301',
      FLOWBOARD_RATE_LIMIT_CHECKPOINT: '121',
      FLOWBOARD_RATE_LIMIT_MUTATION: '61',
      FLOWBOARD_RATE_LIMIT_AUTH: '11',
      FLOWBOARD_RATE_LIMIT_BURST: '7',
    }),
    { budgets: { read: 301, checkpoint: 121, mutation: 61, auth: 11 }, burst: 7 },
    'FLOWBOARD_RATE_LIMIT_* overrides are applied per lane',
  );

  const principalRequest = { method: 'GET', originalUrl: '/api/projects', user: { id: 42 }, headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  assert.strictEqual(getTrustedPrincipal(principalRequest), 'user:42', 'verified user identity is the limiter principal');
  assert.strictEqual(getRateLimitScope(principalRequest), 'read');

  const limiter = new LaneTokenBucketLimiter({
    budgets: DEFAULT_LANE_BUDGETS,
    burst: 0,
    keyGenerator: req => getTrustedPrincipal(req),
    scopeFor: getRateLimitScope,
  });
  const responses = [];
  const middleware = limiter.middleware();
  const fakeRes = {
    set() { return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { responses.push(body); },
  };
  middleware(principalRequest, fakeRes, () => responses.push('read-next'));
  middleware({ ...principalRequest, method: 'POST', originalUrl: '/api/projects/x/checkpoint' }, fakeRes, () => responses.push('checkpoint-next'));
  middleware({ ...principalRequest, method: 'POST', originalUrl: '/api/projects/x' }, fakeRes, () => responses.push('mutation-next'));
  middleware({ ...principalRequest, method: 'POST', originalUrl: '/api/auth' }, fakeRes, () => responses.push('auth-next'));
  assert.deepStrictEqual(responses, ['read-next', 'checkpoint-next', 'mutation-next', 'auth-next'], 'each lane has its own bucket for one trusted principal');
  limiter.close();

  console.log('\n# results: all proxy-trust assertions passed');
}

try {
  run();
} catch (error) {
  console.error('# failed:', error.stack || error.message);
  process.exitCode = 1;
}
