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

  console.log('\n# results: all proxy-trust assertions passed');
}

try {
  run();
} catch (error) {
  console.error('# failed:', error.stack || error.message);
  process.exitCode = 1;
}
