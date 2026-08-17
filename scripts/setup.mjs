#!/usr/bin/env node
// T-114 — FlowBoard one-shot setup.
//
// After `openclaw plugins install flowboard` wires the project-context hook,
// this brings up the dashboard service: install deps + build the UI, then
// register a per-user service (launchd on macOS, systemd --user on Linux)
// with the env baked in — preserving an existing standard service's complete
// environment on reinstall/update — and verify health.
//
// Idempotent: if a healthy dashboard already answers on the port, it skips
// service registration instead of clobbering an existing install.
//
//   node scripts/setup.mjs            # do it
//   node scripts/setup.mjs --dry-run  # print the plan, change nothing
//   node scripts/setup.mjs --force    # re-register the service even if up
//   node scripts/setup.mjs --update --rotate-secret  # explicit JWT rotation
//
// No external dependencies — Node builtins only.

import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, delimiter } from 'node:path';
import { homedir, platform } from 'node:os';
import { randomBytes } from 'node:crypto';
import { get } from 'node:http';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DASH = join(ROOT, 'dashboard');
const PLATFORM = process.env.NODE_ENV === 'test' && process.env.FLOWBOARD_SETUP_TEST_PLATFORM
  ? process.env.FLOWBOARD_SETUP_TEST_PLATFORM
  : platform();
const DRY = process.argv.includes('--dry-run');
// --update: rebuild + restart an existing install (e.g. after
// `openclaw plugins update`). Like --force but semantically "refresh". The
// in-dashboard upgrade panel can shell out to `setup.mjs --update`.
const UPDATE = process.argv.includes('--update');
const FORCE = process.argv.includes('--force') || UPDATE;
const ROTATE_SECRET = process.argv.includes('--rotate-secret');
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('Usage: node scripts/setup.mjs [--dry-run] [--force] [--update] [--rotate-secret]');
  console.log('  (no flag)       first-time bring-up: deps, build, service, health check');
  console.log('  --update        rebuild + restart an existing standard service; preserves its environment');
  console.log('  --force    re-register the service even if the dashboard is already up');
  console.log('  --rotate-secret explicitly replace JWT_SECRET (never implied by --update/--force)');
  console.log('  --dry-run  print the plan, change nothing');
  process.exit(0);
}

const c = { ok: '\x1b[32m✓\x1b[0m', warn: '\x1b[33m!\x1b[0m', err: '\x1b[31m✗\x1b[0m', dim: s => `\x1b[2m${s}\x1b[0m` };
const log = (...a) => console.log(...a);
const step = (s) => log(`\n\x1b[1m${s}\x1b[0m`);
function die(msg) { log(`${c.err} ${msg}`); process.exit(1); }
// Static-scanner note (T-417-18): setup.mjs is the operator-run installer, not
// runtime plugin code, and is never auto-executed (no npm pre/post-install hook).
// spawnSync/execFileSync use fixed commands with arg arrays — no shell:true, no
// untrusted input — to register a per-user (NOT root) loopback service.
function run(cmd, args, opts = {}) {
  log(c.dim(`  $ ${cmd} ${args.join(' ')}`));
  if (DRY) return;
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) die(`command failed: ${cmd} ${args.join(' ')}`);
}
function runStatus(cmd, args, opts = {}) {
  log(c.dim(`  $ ${cmd} ${args.join(' ')}`));
  if (DRY) return 0;
  return spawnSync(cmd, args, { stdio: 'inherit', ...opts }).status ?? 1;
}
function tryExec(cmd, args) {
  try { return execFileSync(cmd, args, { encoding: 'utf8' }).trim(); } catch { return null; }
}

const SERVICE_LABEL = 'ai.openclaw.flowboard-dashboard';
const SERVICE_NAME = 'flowboard-dashboard';
const launchdPlistDir = join(homedir(), 'Library', 'LaunchAgents');
const launchdPlistPath = join(launchdPlistDir, `${SERVICE_LABEL}.plist`);
const systemdUnitDir = join(homedir(), '.config', 'systemd', 'user');
const systemdUnitPath = join(systemdUnitDir, `${SERVICE_NAME}.service`);

// Environment values an operator may deliberately supply while installing.
// Existing service definitions preserve every valid key, including custom
// variables, while this allowlist prevents unrelated shell variables from
// being copied into a fresh service by accident.
const CONFIGURABLE_ENV_KEYS = [
  'ALLOWED_USER_IDS', 'AUTH_ALWAYS', 'DASHBOARD_ORIGIN', 'DEBUG',
  'FLOWBOARD_AGENT_IDLE_TTL_HOURS', 'FLOWBOARD_ALLOW_ACTIVE_PROJECT_FILE_FALLBACK',
  'FLOWBOARD_ALLOW_LAN', 'FLOWBOARD_API', 'FLOWBOARD_BASE_URL',
  'FLOWBOARD_ENABLE_SELF_UPDATE', 'FLOWBOARD_GITHUB_TOKEN',
  'FLOWBOARD_HOOK_FETCH_RETRIES', 'FLOWBOARD_HOOK_FETCH_TIMEOUT_MS',
  'FLOWBOARD_HOOK_TELEMETRY', 'FLOWBOARD_HOST', 'FLOWBOARD_KNOWN_AGENT_IDS',
  'FLOWBOARD_MANAGED_AGENT_IDS', 'FLOWBOARD_NOTIFICATION_CHANNEL',
  'FLOWBOARD_NOTIFICATION_TARGET', 'FLOWBOARD_NOTIFICATION_TO',
  'FLOWBOARD_NOTIFY_ON_COMPLETE', 'FLOWBOARD_PORT', 'FLOWBOARD_PROJECTS_DIR',
  'FLOWBOARD_REPO', 'FLOWBOARD_RULES_TELEMETRY', 'FLOWBOARD_TELEGRAM_AGENT_IDS',
  'FLOWBOARD_WAKE_AGENT', 'GATEWAY_PORT', 'GATEWAY_URL', 'GITHUB_TOKEN',
  'HOOKS_TOKEN', 'HZL_DB_PATH', 'HZL_INTEGRITY_STRICT', 'INTEGRITY_WEBHOOK_TOKEN',
  'INTEGRITY_WEBHOOK_URL', 'JWT_SECRET', 'LOCAL_HOSTNAME', 'LOG_REQUESTS',
  'NODE_ENV', 'NOTIFICATION_WINDOW_MINUTES', 'OPENCLAW_DELIVER_CHANNEL',
  'OPENCLAW_DELIVER_TO', 'OPENCLAW_GATEWAY_PORT', 'OPENCLAW_GATEWAY_URL',
  'OPENCLAW_HOME', 'OPENCLAW_HOOKS_TOKEN', 'OPENCLAW_WORKSPACE',
  'SPECIFY_ALLOW_FALLBACK', 'SPECIFY_MAX_QUESTIONS', 'SPECIFY_OPENCLAW_CLI',
  'SPECIFY_WORKER_AGENT', 'SPECIFY_WORKER_DISABLED', 'SPECIFY_WORKER_TIMEOUT',
  'PORT', 'STALE_THRESHOLD_MINUTES', 'STUCK_NOTIFICATION_CHANNEL', 'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_BOT_TOKENS',
];

const VALID_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

function decodeXml(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, number) => String.fromCodePoint(Number.parseInt(number, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

function encodeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function parseLaunchdEnvironment(content) {
  const block = content.match(/<key>\s*EnvironmentVariables\s*<\/key>\s*<dict>([\s\S]*?)<\/dict>/i);
  if (!block) return null;
  const env = {};
  const pair = /<key>\s*([\s\S]*?)\s*<\/key>\s*<string>\s*([\s\S]*?)\s*<\/string>/gi;
  for (const match of block[1].matchAll(pair)) {
    const key = decodeXml(match[1].trim());
    if (VALID_ENV_KEY.test(key)) env[key] = decodeXml(match[2]);
  }
  return env;
}

function splitSystemdWords(value) {
  const words = [];
  let word = '';
  let quote = null;
  let escaping = false;
  let started = false;
  for (const char of value) {
    if (escaping) {
      word += char;
      escaping = false;
      started = true;
    } else if (char === '\\') {
      escaping = true;
      started = true;
    } else if (quote) {
      if (char === quote) quote = null;
      else word += char;
      started = true;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) {
        words.push(word);
        word = '';
        started = false;
      }
    } else {
      word += char;
      started = true;
    }
  }
  if (escaping) word += '\\';
  if (started) words.push(word);
  return words;
}

function parseSystemdEnvironment(content) {
  const env = {};
  const environmentFiles = [];
  const logicalLines = content.replace(/\\\r?\n/g, ' ').split(/\r?\n/);
  for (const rawLine of logicalLines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    if (line.startsWith('EnvironmentFile=')) {
      const value = line.slice('EnvironmentFile='.length).trim();
      if (value && !environmentFiles.includes(value)) environmentFiles.push(value);
      continue;
    }
    if (!line.startsWith('Environment=')) continue;
    for (const assignment of splitSystemdWords(line.slice('Environment='.length).trim())) {
      const separator = assignment.indexOf('=');
      if (separator <= 0) continue;
      const key = assignment.slice(0, separator);
      if (VALID_ENV_KEY.test(key)) env[key] = assignment.slice(separator + 1);
    }
  }
  return { env, environmentFiles };
}

function readExistingServiceConfig() {
  if (PLATFORM === 'darwin') {
    if (!existsSync(launchdPlistPath)) {
      return { found: false, baseEnv: {}, dropInEnv: {}, effectiveEnv: {}, environmentFiles: [], externalSources: [] };
    }
    const env = parseLaunchdEnvironment(readFileSync(launchdPlistPath, 'utf8'));
    if (!env) throw new Error(`existing launchd plist has no readable EnvironmentVariables dictionary: ${launchdPlistPath}`);
    return {
      found: true,
      baseEnv: env,
      dropInEnv: {},
      effectiveEnv: env,
      environmentFiles: [],
      externalSources: [],
    };
  }
  if (PLATFORM === 'linux') {
    let baseEnv = {};
    let environmentFiles = [];
    const dropInEnv = {};
    const externalSources = [];
    const found = existsSync(systemdUnitPath);
    if (existsSync(systemdUnitPath)) {
      const parsed = parseSystemdEnvironment(readFileSync(systemdUnitPath, 'utf8'));
      baseEnv = parsed.env;
      environmentFiles = parsed.environmentFiles;
      externalSources.push(...parsed.environmentFiles.map(value => `EnvironmentFile ${value}`));
    }
    const dropInDir = `${systemdUnitPath}.d`;
    if (existsSync(dropInDir)) {
      const files = readdirSync(dropInDir).filter(name => name.endsWith('.conf')).sort();
      for (const file of files) {
        const parsed = parseSystemdEnvironment(readFileSync(join(dropInDir, file), 'utf8'));
        Object.assign(dropInEnv, parsed.env);
        externalSources.push(`drop-in ${file}`);
        externalSources.push(...parsed.environmentFiles.map(value => `EnvironmentFile ${value}`));
      }
    }
    return {
      found,
      baseEnv,
      dropInEnv,
      effectiveEnv: { ...baseEnv, ...dropInEnv },
      environmentFiles,
      externalSources,
    };
  }
  return { found: false, baseEnv: {}, dropInEnv: {}, effectiveEnv: {}, environmentFiles: [], externalSources: [] };
}

function mergePath(...values) {
  const parts = values.flatMap(value => String(value || '').split(delimiter)).filter(Boolean);
  return [...new Set(parts)].join(delimiter);
}

function quoteSystemdEnvironment(key, value) {
  const assignment = `${key}=${String(value)}`
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
  return `Environment="${assignment}"`;
}

function writeOwnerOnly(path, content) {
  const tempPath = `${path}.tmp-${process.pid}`;
  writeFileSync(tempPath, content, { mode: 0o600 });
  chmodSync(tempPath, 0o600);
  renameSync(tempPath, path);
  chmodSync(path, 0o600);
}

let existingConfig;
try {
  existingConfig = readExistingServiceConfig();
} catch (error) {
  die(`could not read the existing service configuration safely: ${error.message}`);
}
if (UPDATE && !existingConfig.found) {
  die(`--update requires an existing standard ${PLATFORM === 'darwin' ? 'launchd' : 'systemd'} service. Run setup without --update for a first install.`);
}

const serviceEnv = { ...existingConfig.baseEnv };
const inheritedExternalEnv = {};
const hasEnvironmentFile = existingConfig.externalSources.some(source => source.startsWith('EnvironmentFile '));
const hasMainEnvironmentFile = existingConfig.environmentFiles.length > 0;
for (const key of CONFIGURABLE_ENV_KEYS) {
  if (!Object.hasOwn(process.env, key)) continue;
  if (Object.hasOwn(existingConfig.dropInEnv, key)) {
    if (process.env[key] !== existingConfig.dropInEnv[key]) {
      die(`${key} is managed by a systemd drop-in. Update that owner-only drop-in instead of overriding it from setup.`);
    }
    continue;
  }
  if (hasEnvironmentFile && !Object.hasOwn(existingConfig.effectiveEnv, key)) {
    // A running service passes EnvironmentFile values to the in-dashboard
    // updater. Use them for health/diagnostics, but leave ownership in the
    // file instead of copying them into the generated unit permanently.
    inheritedExternalEnv[key] = process.env[key];
    continue;
  }
  // The in-dashboard updater inherits the service environment. Do not copy an
  // unchanged inherited value out of its original EnvironmentFile/drop-in and
  // into the generated main unit, where it would become sticky after removal.
  if (!existingConfig.found || process.env[key] !== existingConfig.effectiveEnv[key]) {
    serviceEnv[key] = process.env[key];
  }
}
const currentlyEffective = { ...serviceEnv, ...inheritedExternalEnv, ...existingConfig.dropInEnv };
// A main-unit EnvironmentFile may own these values even when setup cannot read
// it. Do not add a later default that would silently override that source.
if (!currentlyEffective.FLOWBOARD_PORT && !hasMainEnvironmentFile) serviceEnv.FLOWBOARD_PORT = '18790';
if (!currentlyEffective.FLOWBOARD_HOST && !hasMainEnvironmentFile) serviceEnv.FLOWBOARD_HOST = '127.0.0.1';
if (!currentlyEffective.OPENCLAW_WORKSPACE && !hasMainEnvironmentFile) serviceEnv.OPENCLAW_WORKSPACE = join(homedir(), '.openclaw', 'workspace');
if (!hasMainEnvironmentFile || Object.hasOwn(existingConfig.baseEnv, 'PATH')) {
  serviceEnv.PATH = mergePath(dirname(process.execPath), existingConfig.effectiveEnv.PATH, process.env.PATH);
} else {
  delete serviceEnv.PATH;
}

const explicitSecret = Object.hasOwn(process.env, 'JWT_SECRET');
let secretStatus;
if (ROTATE_SECRET) {
  if (Object.hasOwn(existingConfig.dropInEnv, 'JWT_SECRET') || hasEnvironmentFile) {
    die('JWT_SECRET is managed by a systemd drop-in/EnvironmentFile. Rotate it in that owner-only source, then run --update without --rotate-secret.');
  }
  serviceEnv.JWT_SECRET = randomBytes(32).toString('hex');
  secretStatus = 'rotation requested explicitly';
} else if (explicitSecret) {
  secretStatus = Object.hasOwn(inheritedExternalEnv, 'JWT_SECRET')
    ? 'existing value preserved in its EnvironmentFile'
    : 'value supplied explicitly by the operator environment';
} else if (existingConfig.found) {
  if (Object.hasOwn(existingConfig.baseEnv, 'JWT_SECRET')) {
    serviceEnv.JWT_SECRET = existingConfig.baseEnv.JWT_SECRET;
    secretStatus = 'existing value preserved';
  } else if (Object.hasOwn(existingConfig.dropInEnv, 'JWT_SECRET')) {
    delete serviceEnv.JWT_SECRET;
    secretStatus = 'existing value preserved in its systemd drop-in';
  } else {
    delete serviceEnv.JWT_SECRET;
    secretStatus = 'not configured in the existing service; left unset';
  }
} else {
  serviceEnv.JWT_SECRET = randomBytes(32).toString('hex');
  secretStatus = 'generated once for the first install';
}

const effectiveServiceEnv = { ...serviceEnv, ...inheritedExternalEnv, ...existingConfig.dropInEnv };
const PORT = Number(effectiveServiceEnv.FLOWBOARD_PORT || 18790);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  die(`FLOWBOARD_PORT must be an integer between 1 and 65535 (received ${JSON.stringify(effectiveServiceEnv.FLOWBOARD_PORT)})`);
}

function remoteConfigurationGaps() {
  const hasRemoteIntent = [
    'TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_TOKENS', 'ALLOWED_USER_IDS',
    'DASHBOARD_ORIGIN', 'AUTH_ALWAYS', 'LOCAL_HOSTNAME',
  ].some(key => Boolean(effectiveServiceEnv[key])) || !['127.0.0.1', '::1', 'localhost'].includes(effectiveServiceEnv.FLOWBOARD_HOST);
  if (!hasRemoteIntent) return null;
  const missing = [];
  if (!effectiveServiceEnv.TELEGRAM_BOT_TOKEN && !effectiveServiceEnv.TELEGRAM_BOT_TOKENS) missing.push('TELEGRAM_BOT_TOKEN or TELEGRAM_BOT_TOKENS');
  if (!effectiveServiceEnv.JWT_SECRET) missing.push('JWT_SECRET');
  if (!effectiveServiceEnv.ALLOWED_USER_IDS) missing.push('ALLOWED_USER_IDS');
  if (!effectiveServiceEnv.DASHBOARD_ORIGIN) missing.push('DASHBOARD_ORIGIN');
  return missing;
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
if (alreadyUp && FORCE) log(`${c.warn} a dashboard already answers on :${PORT}; this manages the '${SERVICE_LABEL}' service — a different supervisor on the same port would conflict.`);

// ── 3. Dependencies + UI build ──────────────────────────────────────────────
step('2. Install dependencies & build the dashboard');
run('npm', ['install', '--no-audit', '--no-fund'], { cwd: DASH });
run('npm', ['run', 'build'], { cwd: DASH });
log(`${c.ok} dashboard built`);

// ── 4. Service environment ──────────────────────────────────────────────────
// server.js reads config from process.env only. On update/reinstall, values
// from the existing standard service are merged before the definition is
// replaced. Values are never printed, and the resulting file is owner-only.
step('3. Service environment');
if (existingConfig.found) {
  log(`${c.ok} existing service environment detected; ${Object.keys(existingConfig.effectiveEnv).length} readable variables will be preserved/merged`);
} else {
  log(`${c.ok} first-install service environment prepared`);
}
log(`${c.ok} JWT_SECRET: ${secretStatus}`);
const remoteGaps = remoteConfigurationGaps();
if (remoteGaps === null) {
  log(c.dim('  Remote access is not configured; the loopback dashboard needs no auth.'));
} else if (remoteGaps.length > 0) {
  log(`${c.warn} remote access configuration is incomplete; missing: ${remoteGaps.join(', ')}`);
  if (hasEnvironmentFile) {
    log(c.dim('  EnvironmentFile directives are preserved but not opened by setup; verify the missing values there.'));
  }
} else {
  log(`${c.ok} remote auth configuration has all required variables`);
}

// ── 5. Service registration (launchd / systemd --user) ──────────────────────
step('4. Register the dashboard service');
const node = process.execPath;
if (PLATFORM === 'darwin') {
  const envXml = Object.entries(serviceEnv).sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `    <key>${encodeXml(k)}</key><string>${encodeXml(v)}</string>`).join('\n');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key><array><string>${encodeXml(node)}</string><string>${encodeXml(join(DASH, 'server.js'))}</string></array>
  <key>WorkingDirectory</key><string>${encodeXml(DASH)}</string>
  <key>EnvironmentVariables</key><dict>
${envXml}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>/tmp/flowboard-dashboard.log</string>
  <key>StandardOutPath</key><string>/tmp/flowboard-dashboard.log</string>
</dict></plist>
`;
  const uid = tryExec('id', ['-u']) || '';
  if (DRY) {
    log(c.dim(`  would write ${launchdPlistPath} (mode 0600)`));
    log(c.dim(`  would: launchctl bootstrap gui/${uid} ${launchdPlistPath}`));
    log(c.dim(`  would: launchctl print gui/${uid}/${SERVICE_LABEL}`));
  } else {
    mkdirSync(launchdPlistDir, { recursive: true });
    writeOwnerOnly(launchdPlistPath, plist);
    spawnSync('launchctl', ['bootout', `gui/${uid}/${SERVICE_LABEL}`], { stdio: 'ignore' }); // ignore if not loaded
    run('launchctl', ['bootstrap', `gui/${uid}`, launchdPlistPath]);
    run('launchctl', ['print', `gui/${uid}/${SERVICE_LABEL}`]);
  }
  log(`${c.ok} launchd service ${SERVICE_LABEL} registered with RunAtLoad + KeepAlive`);
} else if (PLATFORM === 'linux') {
  const environmentFileLines = existingConfig.environmentFiles.map(value => `EnvironmentFile=${value}`).join('\n');
  const envLines = Object.entries(serviceEnv).sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => quoteSystemdEnvironment(k, v)).join('\n');
  const unit = `[Unit]
Description=FlowBoard Project Dashboard
After=network.target

[Service]
Type=simple
WorkingDirectory=${DASH}
ExecStart=${node} ${join(DASH, 'server.js')}
${environmentFileLines}
${envLines}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
  if (DRY) {
    log(c.dim(`  would write ${systemdUnitPath} (mode 0600)`));
    log(c.dim('  would: systemctl --user daemon-reload'));
    if (UPDATE) {
      log(c.dim('  would: systemctl --user enable flowboard-dashboard'));
      log(c.dim('  would: systemctl --user restart flowboard-dashboard'));
    } else {
      log(c.dim('  would: systemctl --user enable --now flowboard-dashboard'));
    }
    log(c.dim('  would: systemctl --user is-enabled --quiet flowboard-dashboard'));
  } else {
    mkdirSync(systemdUnitDir, { recursive: true });
    writeOwnerOnly(systemdUnitPath, unit);
    run('systemctl', ['--user', 'daemon-reload']);
    if (UPDATE) {
      run('systemctl', ['--user', 'enable', 'flowboard-dashboard']);
      // Try restart first; if it fails and the unit is in a recoverable state
      // (inactive/dead), fallback to start with a warning.
      const restartStatus = runStatus('systemctl', ['--user', 'restart', 'flowboard-dashboard']);
      if (restartStatus !== 0) {
        const activeStatus = runStatus('systemctl', ['--user', 'is-active', '--quiet', 'flowboard-dashboard']);
        const isInactive = activeStatus !== 0; // is-active returns non-zero if not active
        if (isInactive) {
          log(`${c.warn} restart failed; unit is inactive, trying start instead`);
          run('systemctl', ['--user', 'start', 'flowboard-dashboard']);
        } else {
          die(`systemctl --user restart flowboard-dashboard failed`);
        }
      }
    } else {
      run('systemctl', ['--user', 'enable', '--now', 'flowboard-dashboard']);
    }
    run('systemctl', ['--user', 'is-enabled', '--quiet', 'flowboard-dashboard']);
  }
  log(`${c.ok} systemd --user service flowboard-dashboard registered and enabled for autostart`);
} else {
  log(`${c.warn} Unsupported platform (${PLATFORM}) for automatic service registration.`);
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
