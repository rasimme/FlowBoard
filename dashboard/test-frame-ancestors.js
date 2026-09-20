'use strict';

// T-487-10: FLOWBOARD_FRAME_ANCESTORS lets an operator embed the dashboard in
// a Control UI iframe from configured origins. Default behaviour (no env var)
// must stay byte-identical to the pre-existing security headers:
//   X-Frame-Options: SAMEORIGIN
//   Content-Security-Policy: ... frame-ancestors 'self' https://web.telegram.org
// When the var is set with >=1 valid origin, X-Frame-Options is omitted
// (it cannot express more than one allowed ancestor) and CSP frame-ancestors
// grows to include the configured origins. Invalid entries are dropped with a
// named startup warning instead of crashing the server.

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { reservePort } = require('./test-support/server-harness.js');

const ROOT = __dirname;
const DEFAULT_CSP_FRAME_ANCESTORS = "frame-ancestors 'self' https://web.telegram.org";
const DEFAULT_CSP_REST = [
  "default-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data: https://t.me",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
];

async function waitForServer(base, child) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`dashboard exited early (${child.exitCode})`);
    try {
      if ((await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(300) })).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('dashboard did not become ready');
}

async function withServer(extraEnv, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-frame-ancestors-'));
  fs.mkdirSync(path.join(tmp, 'workspace', 'projects'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'projects'), { recursive: true });
  const port = await reservePort();
  const base = `http://127.0.0.1:${port}`;
  let logs = '';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      FLOWBOARD_PORT: String(port),
      FLOWBOARD_HOST: '127.0.0.1',
      OPENCLAW_WORKSPACE: path.join(tmp, 'workspace'),
      FLOWBOARD_PROJECTS_DIR: path.join(tmp, 'projects'),
      HZL_DB_PATH: path.join(tmp, 'flowboard.db'),
      SPECIFY_WORKER_DISABLED: 'true',
      FLOWBOARD_ENABLE_SELF_UPDATE: 'false',
      TELEGRAM_BOT_TOKEN: '',
      TELEGRAM_BOT_TOKENS: '',
      ALLOWED_USER_IDS: '',
      DASHBOARD_ORIGIN: '',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { logs += d.toString(); });
  child.stderr.on('data', (d) => { logs += d.toString(); });
  try {
    await waitForServer(base, child);
    return await fn({ base, getLogs: () => logs });
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 300));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function fetchHeaders(base) {
  const res = await fetch(`${base}/api/health`);
  return res.headers;
}

async function main() {
  console.log('# FLOWBOARD_FRAME_ANCESTORS (T-487-10)');

  // (a) default — unset env var — behaviour is byte-identical to today.
  await withServer({}, async ({ base }) => {
    const headers = await fetchHeaders(base);
    assert.equal(headers.get('x-frame-options'), 'SAMEORIGIN', 'default: X-Frame-Options present');
    const csp = headers.get('content-security-policy');
    assert.ok(csp, 'default: CSP header present');
    assert.ok(csp.includes(DEFAULT_CSP_FRAME_ANCESTORS), 'default: frame-ancestors unchanged');
    for (const directive of DEFAULT_CSP_REST) {
      assert.ok(csp.includes(directive), `default: CSP retains "${directive}"`);
    }
  });
  console.log('  ok - default headers unchanged when FLOWBOARD_FRAME_ANCESTORS is unset');

  // (b) two valid origins — XFO omitted, both origins appended to frame-ancestors,
  // rest of the CSP untouched.
  const origin1 = 'http://127.0.0.1:18860';
  const origin2 = 'https://gateway.example.ts.net';
  await withServer({ FLOWBOARD_FRAME_ANCESTORS: `${origin1},${origin2}` }, async ({ base }) => {
    const headers = await fetchHeaders(base);
    assert.equal(headers.get('x-frame-options'), null, 'configured: X-Frame-Options is omitted');
    const csp = headers.get('content-security-policy');
    assert.ok(csp, 'configured: CSP header present');
    const frameAncestorsDirective = csp.split(';').map((s) => s.trim()).find((d) => d.startsWith('frame-ancestors'));
    assert.ok(frameAncestorsDirective, 'configured: frame-ancestors directive present');
    assert.equal(
      frameAncestorsDirective,
      `frame-ancestors 'self' https://web.telegram.org ${origin1} ${origin2}`,
      'configured: frame-ancestors grows with both configured origins'
    );
    for (const directive of DEFAULT_CSP_REST) {
      assert.ok(csp.includes(directive), `configured: CSP retains "${directive}"`);
    }
  });
  console.log('  ok - two valid origins appended, X-Frame-Options omitted');

  // (c) invalid entries dropped with a named warning; valid entries survive
  // alongside them.
  const invalidEntries = ['not-a-url', 'javascript:alert(1)', 'http://also.valid:8080/path', ''];
  const validEntry = 'https://valid.example';
  const mixedValue = [invalidEntries[0], validEntry, invalidEntries[1], invalidEntries[2], invalidEntries[3]].join(',');
  await withServer({ FLOWBOARD_FRAME_ANCESTORS: mixedValue }, async ({ base, getLogs }) => {
    const headers = await fetchHeaders(base);
    assert.equal(headers.get('x-frame-options'), null, 'mixed: X-Frame-Options omitted (one valid origin survives)');
    const csp = headers.get('content-security-policy');
    const frameAncestorsDirective = csp.split(';').map((s) => s.trim()).find((d) => d.startsWith('frame-ancestors'));
    assert.equal(
      frameAncestorsDirective,
      `frame-ancestors 'self' https://web.telegram.org ${validEntry}`,
      'mixed: only the valid origin is appended'
    );
    const logs = getLogs();
    assert.match(logs, /FLOWBOARD_FRAME_ANCESTORS/, 'mixed: startup warning mentions the env var');
    for (const invalid of ['not-a-url', 'javascript:alert(1)', 'http://also.valid:8080/path']) {
      assert.ok(logs.includes(invalid), `mixed: warning names invalid entry "${invalid}"`);
    }
  });
  console.log('  ok - invalid entries dropped with a named startup warning, valid entry kept');

  // (d) all-invalid — none remain — default headers apply, still warns.
  await withServer({ FLOWBOARD_FRAME_ANCESTORS: 'not-a-url,javascript:alert(1)' }, async ({ base, getLogs }) => {
    const headers = await fetchHeaders(base);
    assert.equal(headers.get('x-frame-options'), 'SAMEORIGIN', 'all-invalid: X-Frame-Options present (default applies)');
    const csp = headers.get('content-security-policy');
    assert.ok(csp.includes(DEFAULT_CSP_FRAME_ANCESTORS), 'all-invalid: frame-ancestors falls back to default');
    const logs = getLogs();
    assert.match(logs, /FLOWBOARD_FRAME_ANCESTORS/, 'all-invalid: startup warning still fires');
  });
  console.log('  ok - all-invalid entries fall back to default headers with a warning');

  console.log('\nT-487-10 frame-ancestors tests passed');
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
