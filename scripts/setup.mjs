#!/usr/bin/env node
// T-114 — FlowBoard one-shot setup.
//
// After `openclaw plugins install flowboard` wires the project-context hook,
// this brings up the dashboard service: install deps + build the UI, write a
// dashboard/.env with safe defaults (and a fresh JWT secret), register a
// per-user service (launchd on macOS, systemd --user on Linux) and verify
// the health endpoint.
//
// Idempotent: if a healthy dashboard already answers on the port, it skips
// service registration instead of clobbering an existing install.
//
//   node scripts/setup.mjs            # do it
//   node scripts/setup.mjs --dry-run  # print the plan, change nothing
//   node scripts/setup.mjs --force    # re-register the service even if up
//
// No external dependencies — Node builtins only.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir, platform } from 'node:os';
import { randomBytes } from 'node:crypto';
import { get } from 'node:http';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DASH = join(ROOT, 'dashboard');
const PORT = Number(process.env.FLOWBOARD_PORT) || 18790;
const DRY = process.argv.includes('--dry-run');
// --update: rebuild + restart an existing install (e.g. after
// `openclaw plugins update`). Like --force but semantically "refresh". The
// in-dashboard upgrade panel can shell out to `setup.mjs --update`.
const UPDATE = process.argv.includes('--update');
const FORCE = process.argv.includes('--force') || UPDATE;
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('Usage: node scripts/setup.mjs [--dry-run] [--force] [--update]');
  console.log('  (no flag)  first-time bring-up: deps, build, .env, service, health check');
  console.log('  --update   rebuild + restart an existing install (deps, build, restart)');
  console.log('  --force    re-register the service even if the dashboard is already up');
  console.log('  --dry-run  print the plan, change nothing');
  process.exit(0);
}

const c = { ok: '\x1b[32m✓\x1b[0m', warn: '\x1b[33m!\x1b[0m', err: '\x1b[31m✗\x1b[0m', dim: s => `\x1b[2m${s}\x1b[0m` };
const log = (...a) => console.log(...a);
const step = (s) => log(`\n\x1b[1m${s}\x1b[0m`);
function die(msg) { log(`${c.err} ${msg}`); process.exit(1); }
function run(cmd, args, opts = {}) {
  log(c.dim(`  $ ${cmd} ${args.join(' ')}`));
  if (DRY) return;
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) die(`command failed: ${cmd} ${args.join(' ')}`);
}
function tryExec(cmd, args) {
  try { return execFileSync(cmd, args, { encoding: 'utf8' }).trim(); } catch { return null; }
}
function healthy() {
  return new Promise((resolve) => {
    const req = get({ host: '127.0.0.1', port: PORT, path: '/api/health', timeout: 1500 }, (res) => {
      res.resume(); resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

log('\x1b[1mFlowBoard setup\x1b[0m' + (DRY ? c.dim(' (dry-run — nothing will change)') : ''));

// ── 1. Prerequisites ────────────────────────────────────────────────────────
step('1. Prerequisites');
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 18) die(`Node >= 18 required (found ${process.versions.node})`);
log(`${c.ok} Node ${process.versions.node}`);
if (!tryExec('npm', ['--version'])) die('npm not found on PATH');
log(`${c.ok} npm ${tryExec('npm', ['--version'])}`);
const ocVer = tryExec('openclaw', ['--version']) || tryExec(join(homedir(), '.npm-global/bin/openclaw'), ['--version']);
log(ocVer ? `${c.ok} OpenClaw ${ocVer.split('\n')[0]}` : `${c.warn} OpenClaw CLI not found — the dashboard runs standalone, but the project-context hook needs OpenClaw. Install it for the full integration.`);
if (!existsSync(DASH)) die(`dashboard/ not found at ${DASH} — run this from the FlowBoard plugin directory.`);

// ── 2. Already running? (idempotency guard) ─────────────────────────────────
const alreadyUp = await healthy();
if (alreadyUp && !FORCE) {
  log(`\n${c.ok} A dashboard is already healthy on http://127.0.0.1:${PORT}.`);
  log(c.dim('  Nothing to do. Re-run with --update to rebuild & restart, or --force to re-register.'));
  process.exit(0);
}
if (UPDATE) log(c.dim('\n  update mode: rebuilding & restarting an existing install'));

// ── 3. Dependencies + UI build ──────────────────────────────────────────────
step('2. Install dependencies & build the dashboard');
run('npm', ['install', '--no-audit', '--no-fund'], { cwd: DASH });
run('npm', ['run', 'build'], { cwd: DASH });
log(`${c.ok} dashboard built`);

// ── 4. Environment (.env) with safe defaults ────────────────────────────────
step('3. Environment');
const envPath = join(DASH, '.env');
if (existsSync(envPath)) {
  log(`${c.ok} dashboard/.env exists — leaving it untouched`);
} else {
  const workspace = process.env.OPENCLAW_WORKSPACE || join(homedir(), '.openclaw', 'workspace');
  const jwt = randomBytes(32).toString('hex');
  const env = [
    '# Generated by scripts/setup.mjs — adjust as needed.',
    `FLOWBOARD_PORT=${PORT}`,
    'FLOWBOARD_HOST=127.0.0.1   # loopback-only; widen only behind a tunnel/proxy',
    `OPENCLAW_WORKSPACE=${workspace}`,
    `JWT_SECRET=${jwt}`,
    '# Telegram Mini App / remote access is optional — see docs. Loopback needs no auth.',
    '# TELEGRAM_BOT_TOKEN=',
    '# ALLOWED_USER_IDS=',
    '',
  ].join('\n');
  if (DRY) log(c.dim(`  would write ${envPath} (FLOWBOARD_PORT, OPENCLAW_WORKSPACE, fresh JWT_SECRET)`));
  else { writeFileSync(envPath, env, { mode: 0o600 }); }
  log(`${c.ok} wrote dashboard/.env with a fresh JWT secret (loopback defaults)`);
}

// ── 5. Service registration (launchd / systemd --user) ──────────────────────
step('4. Register the dashboard service');
const node = process.execPath;
if (platform() === 'darwin') {
  const label = 'ai.openclaw.flowboard-dashboard';
  const plistDir = join(homedir(), 'Library', 'LaunchAgents');
  const plistPath = join(plistDir, `${label}.plist`);
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array><string>${node}</string><string>server.js</string></array>
  <key>WorkingDirectory</key><string>${DASH}</string>
  <key>EnvironmentVariables</key><dict><key>FLOWBOARD_PORT</key><string>${PORT}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>/tmp/flowboard-dashboard.log</string>
  <key>StandardOutPath</key><string>/tmp/flowboard-dashboard.log</string>
</dict></plist>
`;
  const uid = tryExec('id', ['-u']) || '';
  if (DRY) {
    log(c.dim(`  would write ${plistPath}`));
    log(c.dim(`  would: launchctl bootstrap gui/${uid} ${plistPath}`));
  } else {
    mkdirSync(plistDir, { recursive: true });
    writeFileSync(plistPath, plist);
    spawnSync('launchctl', ['bootout', `gui/${uid}/${label}`], { stdio: 'ignore' }); // ignore if not loaded
    run('launchctl', ['bootstrap', `gui/${uid}`, plistPath]);
  }
  log(`${c.ok} launchd service ${label} registered`);
} else if (platform() === 'linux') {
  const unitDir = join(homedir(), '.config', 'systemd', 'user');
  const unitPath = join(unitDir, 'flowboard-dashboard.service');
  const unit = `[Unit]
Description=FlowBoard Project Dashboard
After=network.target

[Service]
Type=simple
WorkingDirectory=${DASH}
ExecStart=${node} server.js
Environment=FLOWBOARD_PORT=${PORT}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
  if (DRY) {
    log(c.dim(`  would write ${unitPath}`));
    log(c.dim('  would: systemctl --user daemon-reload && systemctl --user enable --now flowboard-dashboard'));
  } else {
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(unitPath, unit);
    run('systemctl', ['--user', 'daemon-reload']);
    run('systemctl', ['--user', 'enable', '--now', 'flowboard-dashboard']);
  }
  log(`${c.ok} systemd --user service flowboard-dashboard registered`);
} else {
  log(`${c.warn} Unsupported platform (${platform()}) for automatic service registration.`);
  log(c.dim(`  Start manually: cd ${DASH} && FLOWBOARD_PORT=${PORT} node server.js`));
}

// ── 6. Health check ─────────────────────────────────────────────────────────
step('5. Health check');
if (DRY) {
  log(c.dim(`  would poll http://127.0.0.1:${PORT}/api/health`));
} else {
  let up = false;
  for (let i = 0; i < 20 && !up; i++) { up = await healthy(); if (!up) await new Promise(r => setTimeout(r, 500)); }
  if (up) log(`${c.ok} dashboard is healthy on http://127.0.0.1:${PORT}`);
  else die(`dashboard did not come up on port ${PORT} — check /tmp/flowboard-dashboard.log`);
}

step('Done.');
log(`  Open  \x1b[36mhttp://127.0.0.1:${PORT}\x1b[0m`);
log(c.dim('  Remote access (Telegram Mini App / tunnel) is optional — see docs/ for setup.'));
