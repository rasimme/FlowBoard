'use strict';

// T-441: ordered three-bot identity mapping, fresh-initData session rebinding,
// cross-bot cookie rejection, secret-safe diagnostics, and strict config boot.

const { spawn } = require('child_process');
const { once } = require('events');
const crypto = require('crypto');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const os = require('os');
const path = require('path');

const ROOT = __dirname;
const PORT = 18854;
const SECRET = 'test-only-jwt-secret-at-least-thirty-two-characters';
const BOT_TOKENS = [
  '100001:test-only-primary-token',
  '100002:test-only-secondary-token',
  '100003:test-only-tertiary-token',
];
const AGENT_IDS = ['botti', 'dev-botti', 'design-botti'];

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
    TELEGRAM_BOT_TOKEN: '',
    TELEGRAM_BOT_TOKENS: '',
    FLOWBOARD_TELEGRAM_AGENT_IDS: '',
    JWT_SECRET: '',
    ALLOWED_USER_IDS: '',
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
    user: JSON.stringify({ id: userId, username: 'multi_bot_test' }),
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

async function auth(base, initData, cookie = null) {
  const headers = {
    'cf-ray': crypto.randomBytes(8).toString('hex'),
    'cf-connecting-ip': '203.0.113.44',
    'X-Telegram-Init-Data': initData,
  };
  if (cookie) headers.Cookie = cookie;
  const response = await fetch(`${base}/api/auth`, { method: 'POST', headers });
  const body = await response.json().catch(() => ({}));
  return { response, body, setCookie: response.headers.get('set-cookie') || '' };
}

function sessionCookie(setCookie) {
  return setCookie.split(';', 1)[0];
}

function sessionPayload(setCookie) {
  const cookie = sessionCookie(setCookie);
  const token = cookie.slice(cookie.indexOf('=') + 1);
  return jwt.verify(token, SECRET, { algorithms: ['HS256'] });
}

async function invalidConfigCase(tmp, name, envOverrides, expectedCode) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: testEnv(tmp, {
      JWT_SECRET: SECRET,
      ALLOWED_USER_IDS: '42',
      ...envOverrides,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
  const [code] = await once(child, 'exit');
  clearTimeout(timeout);

  ok(code !== 0, `${name}: invalid config prevents startup`);
  ok(output.includes(`[${expectedCode}]`), `${name}: diagnostic uses ${expectedCode}`);
  const configuredTokens = [envOverrides.TELEGRAM_BOT_TOKEN, envOverrides.TELEGRAM_BOT_TOKENS]
    .filter(Boolean)
    .flatMap(value => value.split(','));
  ok(configuredTokens.every(token => !output.includes(token)), `${name}: diagnostics do not disclose token values`);
}

async function run() {
  console.log('# Multi-bot Telegram auth (T-441)');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-multi-bot-auth-'));
  fs.mkdirSync(path.join(tmp, 'workspace', 'projects'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'projects'), { recursive: true });
  const base = `http://127.0.0.1:${PORT}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: testEnv(tmp, {
      TELEGRAM_BOT_TOKEN: BOT_TOKENS[0],
      TELEGRAM_BOT_TOKENS: BOT_TOKENS.slice(1).join(','),
      FLOWBOARD_TELEGRAM_AGENT_IDS: AGENT_IDS.join(','),
      JWT_SECRET: SECRET,
      ALLOWED_USER_IDS: '42',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForServer(base, child);

    const sessions = [];
    for (let index = 0; index < BOT_TOKENS.length; index += 1) {
      const result = await auth(base, buildTelegramInitData(BOT_TOKENS[index]));
      const payload = result.response.status === 200 ? sessionPayload(result.setCookie) : {};
      ok(result.response.status === 200, `bot ${index + 1} creates a fresh session without another bot cookie`);
      ok(result.body.agentId === AGENT_IDS[index], `bot ${index + 1} returns server-confirmed agent ${AGENT_IDS[index]}`);
      ok(payload.agentId === AGENT_IDS[index], `bot ${index + 1} session is bound to ${AGENT_IDS[index]}`);
      sessions.push(sessionCookie(result.setCookie));
    }

    const rebound = await auth(base, buildTelegramInitData(BOT_TOKENS[1]), sessions[0]);
    ok(rebound.response.status === 200 && rebound.body.agentId === AGENT_IDS[1],
      'fresh bot-2 initData overrides a bot-1 cookie');
    ok(sessionPayload(rebound.setCookie).agentId === AGENT_IDS[1],
      'cross-bot authentication reissues the session for bot 2');

    const unsupportedToken = '100004:test-only-unconfigured-token';
    const unsupported = await auth(base, buildTelegramInitData(unsupportedToken), sessions[0]);
    ok(unsupported.response.status === 403 && unsupported.body.code === 'TELEGRAM_BOT_NOT_SUPPORTED',
      'a cookie cannot mask fresh initData signed by an unsupported bot');
    ok(unsupported.setCookie.includes('flowboard_session=') && /Expires=Thu, 01 Jan 1970/i.test(unsupported.setCookie),
      'rejected cross-bot initData clears the existing session cookie');
    ok(!JSON.stringify(unsupported.body).includes(unsupportedToken),
      'unsupported-bot API diagnostics do not disclose the presented token');

    const stale = await auth(base, buildTelegramInitData(BOT_TOKENS[2], { authDateDelta: -301 }), sessions[0]);
    ok(stale.response.status === 403 && stale.body.code === 'TELEGRAM_INIT_DATA_EXPIRED',
      '/api/auth rejects expired initData even when another bot cookie exists');

    const steadyState = await fetch(`${base}/api/projects`, {
      headers: {
        'cf-ray': 'steady-state-stale-init-data',
        'cf-connecting-ip': '203.0.113.45',
        Cookie: sessions[2],
        'X-Telegram-Init-Data': buildTelegramInitData(BOT_TOKENS[2], { authDateDelta: -301 }),
      },
    });
    ok(steadyState.status === 200,
      'an established same-bot session remains usable after WebApp initData ages out');
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit').catch(() => {});
  }

  const invalidRoot = path.join(tmp, 'invalid-config');
  fs.mkdirSync(path.join(invalidRoot, 'workspace', 'projects'), { recursive: true });
  fs.mkdirSync(path.join(invalidRoot, 'projects'), { recursive: true });

  await invalidConfigCase(invalidRoot, 'missing mapping', {
    TELEGRAM_BOT_TOKEN: BOT_TOKENS[0],
  }, 'TELEGRAM_AGENT_MAPPING_COUNT');

  await invalidConfigCase(invalidRoot, 'mapping count mismatch', {
    TELEGRAM_BOT_TOKEN: BOT_TOKENS[0],
    TELEGRAM_BOT_TOKENS: BOT_TOKENS.slice(1).join(','),
    FLOWBOARD_TELEGRAM_AGENT_IDS: AGENT_IDS.slice(0, 2).join(','),
  }, 'TELEGRAM_AGENT_MAPPING_COUNT');

  await invalidConfigCase(invalidRoot, 'mapping gap', {
    TELEGRAM_BOT_TOKEN: BOT_TOKENS[0],
    TELEGRAM_BOT_TOKENS: BOT_TOKENS.slice(1).join(','),
    FLOWBOARD_TELEGRAM_AGENT_IDS: 'botti,,design-botti',
  }, 'TELEGRAM_AGENT_MAPPING_EMPTY_ENTRY');

  await invalidConfigCase(invalidRoot, 'duplicate mapping', {
    TELEGRAM_BOT_TOKEN: BOT_TOKENS[0],
    TELEGRAM_BOT_TOKENS: BOT_TOKENS.slice(1).join(','),
    FLOWBOARD_TELEGRAM_AGENT_IDS: 'botti,botti,design-botti',
  }, 'TELEGRAM_AGENT_MAPPING_DUPLICATE');

  await invalidConfigCase(invalidRoot, 'invalid agent id', {
    TELEGRAM_BOT_TOKEN: BOT_TOKENS[0],
    FLOWBOARD_TELEGRAM_AGENT_IDS: 'Not A Stable Agent',
  }, 'TELEGRAM_AGENT_ID_INVALID');

  await invalidConfigCase(invalidRoot, 'duplicate token', {
    TELEGRAM_BOT_TOKEN: BOT_TOKENS[0],
    TELEGRAM_BOT_TOKENS: BOT_TOKENS[0],
    FLOWBOARD_TELEGRAM_AGENT_IDS: 'botti,dev-botti',
  }, 'TELEGRAM_TOKEN_DUPLICATE');

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
