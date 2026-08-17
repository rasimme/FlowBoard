'use strict';

// T-441 Security Review findings:
// 1. Legacy cookie migration: ensure old cookies are validated before accepting
// 2. Verified EXPIRED fallback: strict cookie verification for aged init-data
// 3. Upstream auth rate limiting: guard /api/auth against brute force
// 4. Privacy scan extension: detect sensitive parameters leaking to logs

const { spawn } = require('child_process');
const { once } = require('events');
const crypto = require('crypto');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const os = require('os');
const path = require('path');

const ROOT = __dirname;
const PORT = 18855;
const SECRET = 'test-only-jwt-secret-at-least-thirty-two-characters';
const BOT_TOKEN = '100001:test-token';
const SECONDARY_BOT_TOKEN = '100002:test-secondary-token';
const AGENT_ID = 'test-agent';

let pass = 0;
let fail = 0;
const failures = [];

function ok(condition, message) {
  if (condition) {
    pass += 1;
    console.log(`  ok - ${message}`);
  } else {
    fail += 1;
    failures.push(message);
    console.log(`  not ok - ${message}`);
  }
}

function testEnv(tmp, overrides = {}) {
  return {
    ...process.env,
    FLOWBOARD_PORT: String(PORT),
    FLOWBOARD_HOST: '127.0.0.1',
    OPENCLAW_WORKSPACE: path.join(tmp, 'workspace'),
    FLOWBOARD_PROJECTS_DIR: path.join(tmp, 'projects'),
    HZL_DB_PATH: path.join(tmp, 'flowboard.db'),
    NODE_ENV: 'test',
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    TELEGRAM_BOT_TOKENS: '',
    FLOWBOARD_TELEGRAM_AGENT_IDS: AGENT_ID,
    FLOWBOARD_TRUSTED_PROXY_IPS: '127.0.0.1,::1',
    JWT_SECRET: SECRET,
    ALLOWED_USER_IDS: '42',
    ...overrides,
  };
}

async function waitForServer(base, child) {
  const started = Date.now();
  while (Date.now() - started < 10000) {
    if (child.exitCode !== null) throw new Error(`dashboard exited early with ${child.exitCode}`);
    try {
      if ((await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(300) })).ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('dashboard did not become ready');
}

function buildTelegramInitData(botToken, { userId = 42, authDateDelta = 0 } = {}) {
  const params = new URLSearchParams({
    user: JSON.stringify({ id: userId, username: 'test_user' }),
    auth_date: String(Math.floor(Date.now() / 1000) + authDateDelta),
  });
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  params.set('hash', crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex'));
  return params.toString();
}

function sessionCookie(setCookie) {
  return setCookie.split(';', 1)[0];
}

async function auth(base, initData, cookie = null, ip = '203.0.113.44') {
  const headers = {
    'cf-ray': crypto.randomBytes(8).toString('hex'),
    'cf-connecting-ip': ip,
  };
  if (initData !== null && initData !== undefined) headers['X-Telegram-Init-Data'] = initData;
  if (cookie) headers.Cookie = cookie;
  const response = await fetch(`${base}/api/auth`, { method: 'POST', headers });
  const body = await response.json().catch(() => ({}));
  return {
    response,
    body,
    setCookie: response.headers.get('set-cookie') || '',
    setCookies: typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [],
  };
}

async function run() {
  console.log('# T-441 Security Review Findings');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-t441-review-'));
  fs.mkdirSync(path.join(tmp, 'workspace', 'projects'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'projects'), { recursive: true });
  const base = `http://127.0.0.1:${PORT}`;

  let stdoutLog = '';
  let stderrLog = '';

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: testEnv(tmp, {
      TELEGRAM_BOT_TOKENS: SECONDARY_BOT_TOKEN,
      FLOWBOARD_TELEGRAM_AGENT_IDS: `${AGENT_ID},test-agent-secondary`,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', data => { stdoutLog += data.toString(); });
  child.stderr.on('data', data => { stderrLog += data.toString(); });

  try {
    await waitForServer(base, child);

    // Finding 1: Legacy Cookie Migration – only accept valid cookies with proper format
    console.log('\n## Finding 1: Legacy Cookie Migration');

    // Create a valid session
    const validResult = await auth(base, buildTelegramInitData(BOT_TOKEN), null, '203.0.113.10');
    ok(validResult.response.status === 200, 'valid fresh init-data creates session');

    const validCookie = sessionCookie(validResult.setCookie);

    // Test that legacy/malformed cookies are rejected
    const legacyCookie = 'flowboard_session=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.invalid.signature';
    const legacyResult = await auth(base, null, legacyCookie, '203.0.113.11');
    ok(legacyResult.response.status === 403, 'legacy malformed cookie is rejected');

    const agentlessToken = jwt.sign(
      { id: 42, username: 'test_user', agentId: null },
      SECRET,
      { expiresIn: '8h', algorithm: 'HS256' },
    );
    const agentlessResult = await auth(
      base,
      null,
      `flowboard_session=${agentlessToken}`,
      '203.0.113.13',
    );
    ok(agentlessResult.response.status === 403, 'legacy agentless cookie is rejected');
    ok(agentlessResult.body.code === 'INVALID_SESSION', 'agentless cookie gets a typed error');
    ok(agentlessResult.setCookies.some(cookie => /Path=\//i.test(cookie)),
      'agentless cookie is cleared on the root path');
    ok(agentlessResult.setCookies.some(cookie => /Path=\/api(?:;|$)/i.test(cookie)),
      'agentless legacy cookie is cleared on the /api path');

    // Finding 2: Verified EXPIRED Fallback
    console.log('\n## Finding 2: Verified EXPIRED Fallback');

    // Create an aged init-data (beyond 5 minutes)
    const agedInitData = buildTelegramInitData(BOT_TOKEN, { authDateDelta: -301 });

    // On /api/auth (strict exchange), aged init-data must be rejected even with valid cookie
    const staleAuthExchange = await auth(base, agedInitData, validCookie, '203.0.113.12');
    ok(staleAuthExchange.response.status === 403, '/api/auth rejects aged init-data (even with valid cookie)');
    ok(staleAuthExchange.body.code === 'TELEGRAM_INIT_DATA_EXPIRED', 'correct error code for aged init-data');
    ok(staleAuthExchange.setCookies.some(cookie => /Path=\//i.test(cookie)),
      '/api/auth clears the root cookie when aged init-data is rejected');
    ok(staleAuthExchange.setCookies.some(cookie => /Path=\/api(?:;|$)/i.test(cookie)),
      '/api/auth clears the legacy /api cookie when aged init-data is rejected');

    // On steady-state API (non-auth), aged init-data may use existing valid cookie
    const steadyState = await fetch(`${base}/api/projects`, {
      headers: {
        'cf-ray': 'steady-test',
        'cf-connecting-ip': '203.0.113.45',
        Cookie: validCookie,
        'X-Telegram-Init-Data': agedInitData,
      },
    });
    ok(steadyState.status === 200, 'steady-state API accepts aged init-data with valid cookie');

    const crossBotStaleResponse = await fetch(`${base}/api/projects`, {
      headers: {
        'cf-ray': 'steady-cross-bot-stale',
        'cf-connecting-ip': '203.0.113.46',
        Cookie: validCookie,
        'X-Telegram-Init-Data': buildTelegramInitData(SECONDARY_BOT_TOKEN, { authDateDelta: -301 }),
      },
    });
    const crossBotStaleBody = await crossBotStaleResponse.json().catch(() => ({}));
    ok(crossBotStaleResponse.status === 403,
      'steady-state API rejects expired init-data from a different bot');
    ok(crossBotStaleBody.code === 'TELEGRAM_INIT_DATA_EXPIRED',
      'cross-bot expired init-data remains explicitly typed as EXPIRED after verification');
    const crossBotStaleCookies = typeof crossBotStaleResponse.headers.getSetCookie === 'function'
      ? crossBotStaleResponse.headers.getSetCookie()
      : [];
    ok(crossBotStaleCookies.some(cookie => /Path=\//i.test(cookie))
      && crossBotStaleCookies.some(cookie => /Path=\/api(?:;|$)/i.test(cookie)),
    'cross-bot expired init-data clears both cookie scopes');

    const forgedExpiredInitData = buildTelegramInitData(BOT_TOKEN)
      .replace(/auth_date=\d+/, `auth_date=${Math.floor(Date.now() / 1000) - 301}`);
    const forgedExpiredResponse = await fetch(`${base}/api/projects`, {
      headers: {
        'cf-ray': 'steady-forged-expired',
        'cf-connecting-ip': '203.0.113.47',
        Cookie: validCookie,
        'X-Telegram-Init-Data': forgedExpiredInitData,
      },
    });
    const forgedExpiredBody = await forgedExpiredResponse.json().catch(() => ({}));
    ok(forgedExpiredResponse.status === 403,
      'forged expired init-data is rejected instead of reaching cookie fallback');
    ok(forgedExpiredBody.code !== 'TELEGRAM_INIT_DATA_EXPIRED',
      'forged expired init-data is not misclassified as EXPIRED');
    const forgedExpiredCookies = typeof forgedExpiredResponse.headers.getSetCookie === 'function'
      ? forgedExpiredResponse.headers.getSetCookie()
      : [];
    ok(forgedExpiredCookies.some(cookie => /Path=\//i.test(cookie))
      && forgedExpiredCookies.some(cookie => /Path=\/api(?:;|$)/i.test(cookie)),
    'forged expired init-data clears both cookie scopes');

    // Finding 3: Upstream Auth Rate Limiting
    console.log('\n## Finding 3: Upstream Auth Rate Limiting');

    // Invalid credentials must also consume the auth budget, before Telegram
    // verification can reject them.
    let rateLimitHit = false;
    const rateLimitTestIp = '203.0.113.88';
    for (let i = 0; i < 65; i++) {
      const result = await auth(base, 'malformed-init-data', null, rateLimitTestIp);
      if (result.response.status === 429) {
        rateLimitHit = true;
        ok(true, `rate limit (429) hit after ${i + 1} attempts`);
        break;
      }
    }
    ok(rateLimitHit, 'invalid auth attempts trigger rate limiting (429)');

    let rotatedHeaderRateLimitHit = false;
    for (let i = 0; i < 65; i++) {
      const response = await fetch(`${base}/api/auth`, {
        method: 'POST',
        headers: {
          // No cf-ray means this is a direct socket request. Rotating this
          // untrusted header must not rotate the limiter key.
          'cf-connecting-ip': `198.51.100.${(i % 200) + 1}`,
          'X-Telegram-Init-Data': 'malformed-init-data',
        },
      });
      if (response.status === 429) {
        rotatedHeaderRateLimitHit = true;
        ok(true, `rotating direct cf-connecting-ip headers still hit 429 after ${i + 1} attempts`);
        break;
      }
    }
    ok(rotatedHeaderRateLimitHit,
      'untrusted cf-connecting-ip rotation cannot evade the socket-keyed auth limiter');

    // Finding 4: Privacy Scan Extension – no token leaks in logs/responses
    console.log('\n## Finding 4: Privacy Scan Extension');

    const privacyResult = await auth(base, buildTelegramInitData(BOT_TOKEN), null, '203.0.113.77');
    ok(privacyResult.response.status === 200, 'valid init-data passes authentication');
    ok(!JSON.stringify(privacyResult.body).includes(BOT_TOKEN), 'bot token not leaked in response body');
    ok(!JSON.stringify(privacyResult.body).includes('WebAppData'), 'HMAC salt not in response');

    await new Promise(resolve => setTimeout(resolve, 100));
    const allLogs = stdoutLog + stderrLog;
    ok(!allLogs.includes(BOT_TOKEN), 'bot token sanitized in logs');
    ok(!allLogs.includes('WebAppData'), 'HMAC salt not in logs');

  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit').catch(() => {});
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n# results: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log('# failures:');
    failures.forEach(message => console.log(`#   - ${message}`));
    process.exitCode = 1;
  }
}

run().catch(error => {
  console.error('# fatal:', error.stack || error.message);
  process.exitCode = 1;
});
