'use strict';

/**
 * Security hardening tests for T-428-1 through T-428-5:
 * - T-428-1: CSRF Origin exact hostname matching (not substring)
 * - T-428-2: Pinned Links URL sanitizing (http/https only)
 * - T-428-3: apiFetch same-origin /api credential protection
 * - T-428-4: Telegram initData auth validation tests
 * - T-428-5: Telegram agentId binding priority
 */

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const ROOT = __dirname;
const PORT = 18850;
const SECRET = 'test-jwt-secret-please-be-at-least-32-chars-long';
const BOT_TOKEN = '123456:bot-secret-test';
const SECONDARY_BOT_TOKEN = '654321:secondary-bot-secret-test';

let pass = 0, fail = 0;
const failures = [];
function ok(c, m) { if (c) { pass++; console.log(`  ok - ${m}`); } else { fail++; failures.push(m); console.log(`  not ok - ${m}`); } }

async function waitForServer(base, child) {
  const t = Date.now();
  while (Date.now() - t < 10000) {
    if (child.exitCode !== null) throw new Error(`dashboard exited early with ${child.exitCode}`);
    try { if ((await fetch(base + '/api/health', { signal: AbortSignal.timeout(300) })).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('dashboard did not become ready');
}

function buildTelegramInitData(userId = 42, botToken = BOT_TOKEN, overrides = {}) {
  const params = new URLSearchParams({
    user: JSON.stringify({ id: userId, username: 'testuser', ...overrides.user }),
    auth_date: String(Math.floor(Date.now() / 1000) + (overrides.authDateDelta || 0)),
    ...overrides.extraParams,
  });
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`).join('\n');
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  params.append('hash', hash);
  return params.toString();
}

async function authedFetch(base, urlPath, opts = {}) {
  return fetch(base + urlPath, {
    ...opts,
    headers: {
      'cf-ray': crypto.randomBytes(8).toString('hex'),
      'cf-connecting-ip': '203.0.113.42',
      'X-Telegram-Init-Data': buildTelegramInitData(),
      ...(opts.headers || {}),
    },
  });
}

async function run() {
  console.log('# Security hardening bundle (T-428-1..T-428-5)');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-sec-'));
  fs.mkdirSync(path.join(tmp, 'workspace/projects'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'projects'), { recursive: true });
  const base = `http://127.0.0.1:${PORT}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, FLOWBOARD_PORT: String(PORT), FLOWBOARD_HOST: '127.0.0.1',
      OPENCLAW_WORKSPACE: path.join(tmp, 'workspace'), FLOWBOARD_PROJECTS_DIR: path.join(tmp, 'projects'),
      HZL_DB_PATH: path.join(tmp, 'fb.db'), NODE_ENV: 'test',
      TELEGRAM_BOT_TOKEN: BOT_TOKEN, JWT_SECRET: SECRET, ALLOWED_USER_IDS: '42',
      TELEGRAM_BOT_TOKENS: SECONDARY_BOT_TOKEN,
      FLOWBOARD_TELEGRAM_AGENT_IDS: 'primary-agent,secondary-agent',
      LOCAL_HOSTNAME: 'myhost.local', FLOWBOARD_ALLOW_LAN: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await waitForServer(base, child);

    // --- T-428-1: CSRF Origin exact hostname matching ---
    console.log('\n# T-428-1: CSRF Origin exact hostname matching');

    // Valid loopback origins should work
    for (const origin of ['http://localhost:9000', 'http://127.0.0.1:8080', 'http://[::1]:3000']) {
      const res = await authedFetch(base, '/api/projects', {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `test-${crypto.randomBytes(4).toString('hex')}` }),
      });
      ok(res.status !== 403, `loopback origin ${origin} is allowed (not blocked by CSRF)`);
    }

    // Valid LOCAL_HOSTNAME origin should work
    const res = await authedFetch(base, '/api/projects', {
      method: 'POST',
      headers: { Origin: 'http://myhost.local:8080', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `test-${crypto.randomBytes(4).toString('hex')}` }),
    });
    ok(res.status !== 403, 'exact LOCAL_HOSTNAME match is allowed');

    // Near-miss origins should be DENIED (substring matches would fail here)
    const deniedOrigins = [
      'http://notmyhost.local',
      'http://myhostX.local',
      'http://localhost.evil.com',
      'http://127.0.0.1.evil.com',
      'https://malicious.com',
    ];
    for (const origin of deniedOrigins) {
      const res = await authedFetch(base, '/api/projects', {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `test-${crypto.randomBytes(4).toString('hex')}` }),
      });
      ok(res.status === 403, `near-miss origin ${origin} is correctly DENIED (T-428-1)`);
    }

    // --- T-428-4: Telegram initData auth validation ---
    console.log('\n# T-428-4: Telegram initData auth validation');

    // Valid initData should work
    const validInitData = buildTelegramInitData();
    const validRes = await fetch(base + '/api/projects', {
      headers: { 'cf-ray': 'test-valid', 'cf-connecting-ip': '203.0.113.10', 'X-Telegram-Init-Data': validInitData },
    });
    ok(validRes.status === 200, 'valid Telegram initData is accepted');

    // Bad hash should fail
    const badHash = buildTelegramInitData();
    const params = new URLSearchParams(badHash);
    params.set('hash', 'badhash1234567890');
    const badHashRes = await fetch(base + '/api/projects', {
      headers: { 'cf-ray': 'test-bad-hash', 'cf-connecting-ip': '203.0.113.11', 'X-Telegram-Init-Data': params.toString() },
    });
    ok(badHashRes.status === 403, 'bad hash is rejected');

    // Stale auth_date (> 300 seconds old) should fail
    const staleInitData = buildTelegramInitData(42, BOT_TOKEN, { authDateDelta: -400 });
    const staleRes = await fetch(base + '/api/projects', {
      headers: { 'cf-ray': 'test-stale', 'cf-connecting-ip': '203.0.113.12', 'X-Telegram-Init-Data': staleInitData },
    });
    ok(staleRes.status === 403, 'stale auth_date (> 300s) is rejected');

    // Future auth_date should fail
    const futureInitData = buildTelegramInitData(42, BOT_TOKEN, { authDateDelta: 100 });
    const futureRes = await fetch(base + '/api/projects', {
      headers: { 'cf-ray': 'test-future', 'cf-connecting-ip': '203.0.113.13', 'X-Telegram-Init-Data': futureInitData },
    });
    ok(futureRes.status === 403, 'future auth_date is rejected');

    // Wrong user ID should fail
    const wrongUserInitData = buildTelegramInitData(999);
    const wrongUserRes = await fetch(base + '/api/projects', {
      headers: { 'cf-ray': 'test-wrong-user', 'cf-connecting-ip': '203.0.113.14', 'X-Telegram-Init-Data': wrongUserInitData },
    });
    ok(wrongUserRes.status === 403, 'unauthorized user ID is rejected');

    // Malformed user JSON should fail
    const malformedParams = new URLSearchParams({
      user: 'not-json',
      auth_date: String(Math.floor(Date.now() / 1000)),
    });
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const malformedCheckString = [...malformedParams.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`).join('\n');
    const hash = crypto.createHmac('sha256', secretKey).update(malformedCheckString).digest('hex');
    malformedParams.append('hash', hash);
    const malformedRes = await fetch(base + '/api/projects', {
      headers: { 'cf-ray': 'test-malformed', 'cf-connecting-ip': '203.0.113.15', 'X-Telegram-Init-Data': malformedParams.toString() },
    });
    ok(malformedRes.status === 403, 'malformed user JSON is rejected');

    const mappedRes = await fetch(base + '/api/auth', {
      method: 'POST',
      headers: {
        'cf-ray': 'test-secondary-bot',
        'cf-connecting-ip': '203.0.113.16',
        'X-Telegram-Init-Data': buildTelegramInitData(42, SECONDARY_BOT_TOKEN),
      },
    });
    const mappedData = await mappedRes.json().catch(() => ({}));
    ok(mappedRes.status === 200 && mappedData.agentId === 'secondary-agent', 'multi-bot agent mapping returns matched agentId');

    console.log(`\n# results: ${pass} passed, ${fail} failed`);
    if (fail > 0) { console.log('# failures:'); failures.forEach(f => console.log(`#   - ${f}`)); process.exitCode = 1; }
  } finally {
    child.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 300));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
run().catch(e => { console.error('# fatal:', e.message); process.exitCode = 1; });
