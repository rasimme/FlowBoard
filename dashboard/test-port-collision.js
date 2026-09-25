'use strict';

/**
 * T-495: default dashboard port and the OpenClaw MCP Apps sandbox collision.
 *
 * Unit checks for dashboard/port-collision.js plus one real boot: a port held
 * by another listener that equals the configured Gateway port + 1 must fail
 * with a message naming the MCP Apps sandbox and both fixes.
 */

const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const { DEFAULT_DASHBOARD_PORT } = require('./flowboard-url.cjs');
const {
  describeListenError,
  describeSandboxOverlap,
  isMcpAppsSandboxPort,
  mcpAppsSandboxPort,
  resolveGatewayPort,
} = require('./port-collision.js');

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log(`  ok - ${m}`); } else { fail++; console.log(`  not ok - ${m}`); } }

const inUse = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });

console.log('# default port');
// OpenClaw 2026.9.x derives Gateway .. Gateway+110 (MCP Apps sandbox +1,
// browser control +2, reserved +3..+10, CDP range +11..+110).
ok(DEFAULT_DASHBOARD_PORT === 18700, 'default is 18700');
ok(DEFAULT_DASHBOARD_PORT < 18789, 'default sits below the default Gateway port');
for (const base of [18789, 19001, 19100, 19789]) {
  ok(DEFAULT_DASHBOARD_PORT < base || DEFAULT_DASHBOARD_PORT > base + 110, `default is outside the derived block of Gateway base ${base}`);
}
ok(!isMcpAppsSandboxPort(DEFAULT_DASHBOARD_PORT, {}), 'default is not the MCP Apps sandbox port of the default Gateway');

console.log('# gateway resolution');
ok(resolveGatewayPort({}) === 18789, 'default Gateway port is 18789');
ok(mcpAppsSandboxPort({}) === 18790, 'default sandbox port is Gateway + 1');
ok(resolveGatewayPort({ GATEWAY_PORT: '19001' }) === 19001, 'GATEWAY_PORT is read');
ok(resolveGatewayPort({ OPENCLAW_GATEWAY_PORT: '19789', GATEWAY_PORT: '19001' }) === 19789, 'OPENCLAW_GATEWAY_PORT beats GATEWAY_PORT');
ok(resolveGatewayPort({ OPENCLAW_GATEWAY_URL: 'http://127.0.0.1:19100', OPENCLAW_GATEWAY_PORT: '19789' }) === 19100, 'URL form beats port-only form');
ok(resolveGatewayPort({ OPENCLAW_GATEWAY_PORT: 'bad' }) === 18789, 'invalid port falls back to the default Gateway');

console.log('# messages');
{
  const msg = describeListenError(inUse, { port: 18790, host: '127.0.0.1', env: {} });
  ok(msg.includes('Failed to listen on http://127.0.0.1:18790'), 'names the address');
  ok(msg.includes('MCP Apps sandbox'), 'names the MCP Apps sandbox collision');
  ok(msg.includes('FLOWBOARD_PORT'), 'offers the FLOWBOARD_PORT fix');
  ok(msg.includes('mcp.apps.sandboxPort'), 'offers the mcp.apps.sandboxPort fix');
  ok(msg.includes('plugins.entries.flowboard.config.dashboardPort'), 'tells how to repoint the hook');
}
{
  const msg = describeListenError(inUse, { port: 19002, host: '127.0.0.1', env: { OPENCLAW_GATEWAY_PORT: '19001' } });
  ok(msg.includes('MCP Apps sandbox'), 'follows a custom Gateway port');
}
{
  const msg = describeListenError(inUse, { port: 18700, host: '127.0.0.1', env: {} });
  ok(!msg.includes('MCP Apps'), 'a non-sandbox port does not blame MCP Apps');
  ok(msg.includes('already in use') && msg.includes('FLOWBOARD_PORT'), 'a non-sandbox port gets the generic fix');
}
{
  const msg = describeListenError(Object.assign(new Error('permission denied'), { code: 'EACCES' }), { port: 80, host: '0.0.0.0', env: {} });
  ok(msg.includes('permission denied') && !msg.includes('MCP Apps'), 'other listen errors keep their own message');
}
ok(describeSandboxOverlap(18700, {}) === null, 'no startup warning on the default port');
ok(/Warning: .*MCP Apps sandbox/.test(describeSandboxOverlap(18790, {}) || ''), 'startup warning when the port equals Gateway + 1');

async function bootCollision() {
  console.log('# real boot on an occupied Gateway + 1 port');
  const blocker = net.createServer();
  await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
  const port = blocker.address().port;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-portcollision-'));
  fs.mkdirSync(path.join(tmp, 'workspace/projects'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'projects'), { recursive: true });
  const env = {
    ...process.env,
    FLOWBOARD_PORT: String(port),
    FLOWBOARD_HOST: '127.0.0.1',
    OPENCLAW_GATEWAY_PORT: String(port - 1),
    OPENCLAW_GATEWAY_URL: '', GATEWAY_URL: '', GATEWAY_PORT: '',
    OPENCLAW_WORKSPACE: path.join(tmp, 'workspace'),
    FLOWBOARD_PROJECTS_DIR: path.join(tmp, 'projects'),
    HZL_DB_PATH: path.join(tmp, 'fb.db'),
    NODE_ENV: 'test',
    TELEGRAM_BOT_TOKEN: '', TELEGRAM_BOT_TOKENS: '', DASHBOARD_ORIGIN: '', LOCAL_HOSTNAME: '',
  };
  const child = spawn(process.execPath, ['server.js'], { cwd: __dirname, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  const started = Date.now();
  while (Date.now() - started < 15000 && !out.includes('mcp.apps.sandboxPort') && child.exitCode === null) {
    await new Promise(r => setTimeout(r, 100));
  }
  // Give the listen error a moment after the startup warning.
  const t2 = Date.now();
  while (Date.now() - t2 < 5000 && !out.includes('already in use') && child.exitCode === null) {
    await new Promise(r => setTimeout(r, 100));
  }
  child.kill('SIGTERM');
  blocker.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  ok(out.includes('[startup] Warning:') && out.includes('MCP Apps sandbox'), 'server warns before binding Gateway + 1');
  ok(out.includes(`port ${port} is already in use`), 'server reports the occupied port');
  ok(out.includes('mcp.apps.sandboxPort') && out.includes('FLOWBOARD_PORT'), 'server prints both fixes');
  if (fail) console.log(out.slice(-2000));
}

bootCollision().then(() => {
  if (fail === 0) console.log(`\n✅ All ${pass} checks passed`);
  else { console.log(`\n❌ ${fail} failed, ${pass} passed`); process.exit(1); }
}).catch(err => { console.error(err); process.exit(1); });
