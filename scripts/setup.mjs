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
//   node scripts/setup.mjs --rotate-secret  # explicit JWT rotation + restart
//
// No external dependencies — Node builtins only.

import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, delimiter } from 'node:path';
import { homedir, platform } from 'node:os';
import { randomBytes } from 'node:crypto';
import { get } from 'node:http';
import {
  applySystemdEvents,
  applySystemdUnsetEnvironment,
  collectSystemdEnvironmentValues,
  decodeSystemdEnvironmentFile,
  escapeSystemdUnitString,
  expandSupportedSystemdSpecifiers,
  formatSystemdUnsetEnvironment,
  parseSystemdEnvironment,
  parseSystemdEnvironmentFile,
  parseSystemdEnvironmentFilePath,
  quoteSystemdEnvironment,
  VALID_ENV_KEY,
  validateUnicodeScalars,
} from './systemd-config.mjs';

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
const ROTATE_SECRET = process.argv.includes('--rotate-secret');
// Rotation is itself a mutating service operation. It must never be skipped by
// the healthy-service idempotency guard.
const FORCE = process.argv.includes('--force') || UPDATE || ROTATE_SECRET;
const HEALTH_ATTEMPTS = process.env.NODE_ENV === 'test' && /^\d+$/.test(process.env.FLOWBOARD_SETUP_TEST_HEALTH_ATTEMPTS || '')
  ? Math.max(1, Number(process.env.FLOWBOARD_SETUP_TEST_HEALTH_ATTEMPTS))
  : 20;
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('Usage: node scripts/setup.mjs [--dry-run] [--force] [--update] [--rotate-secret] [--override-env KEY[,KEY...]]');
  console.log('  (no flag)       first-time bring-up: deps, build, service, health check');
  console.log('  --update        rebuild + restart an existing standard service; preserves its environment');
  console.log('  --force         re-register and restart an existing service even if the dashboard is already up');
  console.log('  --rotate-secret explicitly replace JWT_SECRET (never implied by --update/--force)');
  console.log('  --override-env  persist named allowlisted shell variables; JWT_SECRET requires --rotate-secret');
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
function runQuiet(cmd, args, opts = {}) {
  log(c.dim(`  $ ${cmd} ${args.join(' ')}`));
  if (DRY) return;
  // Service-manager inspection can include the complete environment. Never
  // inherit or relay it, even when the command exits non-zero.
  const r = spawnSync(cmd, args, { stdio: 'ignore', ...opts });
  if (r.status !== 0) die(`command failed: ${cmd} ${args.join(' ')}`);
}
function tryExec(cmd, args) {
  try { return execFileSync(cmd, args, { encoding: 'utf8' }).trim(); } catch { return null; }
}

const SERVICE_LABEL = 'ai.openclaw.flowboard-dashboard';
const SERVICE_NAME = 'flowboard-dashboard';
const launchdPlistDir = join(homedir(), 'Library', 'LaunchAgents');
const launchdPlistPath = join(launchdPlistDir, `${SERVICE_LABEL}.plist`);
const launchdLogDir = join(homedir(), 'Library', 'Logs', 'FlowBoard');
const launchdLogPath = join(launchdLogDir, 'flowboard-dashboard.log');
const launchdLegacyLogPath = process.env.NODE_ENV === 'test' && process.env.FLOWBOARD_SETUP_TEST_LEGACY_LOG_PATH
  ? process.env.FLOWBOARD_SETUP_TEST_LEGACY_LOG_PATH
  : '/tmp/flowboard-dashboard.log';
const launchdLegacyArchivePath = join(launchdLogDir, 'flowboard-dashboard.legacy.log');
const systemdConfigHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
const systemdUnitDir = join(systemdConfigHome, 'systemd', 'user');
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

function parseOverrideEnvKeys(argv) {
  const keys = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    let value = null;
    if (arg === '--override-env') {
      value = argv[index + 1];
      index += 1;
    } else if (arg.startsWith('--override-env=')) {
      value = arg.slice('--override-env='.length);
    }
    if (value === null) continue;
    if (!value || value.startsWith('--')) {
      die('--override-env requires one or more comma-separated environment variable names.');
    }
    keys.push(...value.split(',').map(key => key.trim()).filter(Boolean));
  }

  const uniqueKeys = [...new Set(keys)];
  for (const key of uniqueKeys) {
    if (!CONFIGURABLE_ENV_KEYS.includes(key)) {
      die(`--override-env does not allow ${JSON.stringify(key)}; use a documented FlowBoard service variable.`);
    }
    if (key === 'JWT_SECRET') {
      die('JWT_SECRET cannot be set with --override-env; use --rotate-secret for an explicit generated rotation.');
    }
    if (!Object.hasOwn(process.env, key)) {
      die(`--override-env requested ${key}, but that variable is not set in the operator environment.`);
    }
  }
  return new Set(uniqueKeys);
}

const OVERRIDE_ENV_KEYS = parseOverrideEnvKeys(process.argv.slice(2));

function encodeXml(value) {
  const text = String(value);
  validateUnicodeScalars(text, 'launchd plist value');
  for (const character of text) {
    const codepoint = character.codePointAt(0);
    if (codepoint < 0x20 && ![0x09, 0x0A, 0x0D].includes(codepoint)) {
      throw new Error('launchd plist value contains an XML 1.0 control character');
    }
  }
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function parseLaunchdEnvironment(path) {
  // Node does not ship a plist parser. Prefer a future builtin parser when one
  // is available, otherwise ask macOS's plutil to produce JSON. Do not parse
  // XML with regexes: plist whitespace, entities, binary plists and string
  // boundaries are all valid inputs that a regex cannot represent faithfully.
  let parsed;
  const builtin = typeof process.getBuiltinModule === 'function'
    ? process.getBuiltinModule('node:plist')
    : null;
  if (builtin && typeof builtin.parse === 'function') {
    try {
      parsed = builtin.parse(readFileSync(path, 'utf8'));
    } catch {
      throw new Error(`invalid launchd plist: ${path}`);
    }
  } else {
    // The test harness may provide a standards-compatible converter on
    // non-macOS CI; production always uses Apple's fixed system tool.
    const plistTool = process.env.NODE_ENV === 'test' && process.env.FLOWBOARD_SETUP_TEST_PLUTIL
      ? process.env.FLOWBOARD_SETUP_TEST_PLUTIL
      : '/usr/bin/plutil';
    const result = spawnSync(plistTool, ['-convert', 'json', '-o', '-', '--', path], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error?.code === 'ENOENT') {
      throw new Error(`cannot parse launchd plist safely: /usr/bin/plutil is unavailable (${path})`);
    }
    if (result.status !== 0 || typeof result.stdout !== 'string' || !result.stdout.trim()) {
      throw new Error(`invalid launchd plist: ${path}`);
    }
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new Error(`invalid launchd plist JSON conversion: ${path}`);
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const variables = parsed.EnvironmentVariables;
  if (!variables || typeof variables !== 'object' || Array.isArray(variables)) return null;

  const env = {};
  for (const [key, value] of Object.entries(variables)) {
    // Silently dropping a value would make an update destructive. Refuse a
    // malformed dictionary instead; launchd itself expects string values.
    if (!VALID_ENV_KEY.test(key)) throw new Error(`invalid launchd environment key in ${path}`);
    if (typeof value !== 'string') throw new Error(`launchd environment value for ${key} is not a string in ${path}`);
    env[key] = value;
  }
  return env;
}

function readUtf8File(path, label) {
  try {
    // Decode with ignoreBOM so a UTF-8 BOM remains visible. systemd unit files
    // do not accept a BOM as syntax; stripping one before parsing could hide a
    // malformed first section or directive and make a rewrite destructive.
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(path));
    if (text.includes('\uFEFF')) throw new Error('contains a UTF-8 byte-order mark');
    return text.replace(/\r?\n/g, '\n');
  } catch (error) {
    if (error?.message?.includes('byte-order mark')) throw new Error(`${label} ${error.message} (${path})`);
    throw new Error(`${label} is not valid UTF-8 (${path})`);
  }
}

function systemdUnitSearchPaths() {
  const configured = process.env.SYSTEMD_UNIT_PATH;
  const home = homedir();
  const uid = typeof process.getuid === 'function' ? String(process.getuid()) : null;
  const runtime = process.env.XDG_RUNTIME_DIR || (uid === null ? null : `/run/user/${uid}`);
  const configHome = process.env.XDG_CONFIG_HOME || join(home, '.config');
  const dataHome = process.env.XDG_DATA_HOME || join(home, '.local', 'share');
  const configDirs = (process.env.XDG_CONFIG_DIRS || '/etc/xdg').split(delimiter).filter(Boolean);
  const dataDirs = (process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(delimiter).filter(Boolean);
  const defaults = [
    join(configHome, 'systemd', 'user.control'),
    runtime && join(runtime, 'systemd', 'user.control'),
    runtime && join(runtime, 'systemd', 'transient'),
    runtime && join(runtime, 'systemd', 'generator.early'),
    join(configHome, 'systemd', 'user'),
    ...configDirs.map(dir => join(dir, 'systemd', 'user')),
    '/etc/systemd/user',
    runtime && join(runtime, 'systemd', 'user'),
    '/run/systemd/user',
    runtime && join(runtime, 'systemd', 'generator'),
    join(dataHome, 'systemd', 'user'),
    ...dataDirs.map(dir => join(dir, 'systemd', 'user')),
    '/usr/local/lib/systemd/user',
    '/usr/lib/systemd/user',
    '/lib/systemd/user',
    runtime && join(runtime, 'systemd', 'generator.late'),
  ].filter(Boolean);
  if (configured === undefined) return [...new Set(defaults)];
  const configuredPaths = configured.split(delimiter).filter(Boolean);
  // systemd appends the compiled default path only when the variable ends in
  // an empty component. An explicit path list otherwise replaces it.
  return [...new Set([...configuredPaths, ...(configured.endsWith(delimiter) ? defaults : [])])];
}

function safeDirectoryEntries(path) {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw new Error(`cannot inspect systemd configuration directory (${error?.code || 'unknown error'})`);
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error('systemd configuration directory is not a real directory');
  }
  try {
    return readdirSync(path);
  } catch {
    throw new Error('cannot read systemd configuration directory');
  }
}

function systemdDropInDirectories(paths) {
  const exact = `${SERVICE_NAME}.service.d`;
  const prefix = SERVICE_NAME.includes('-')
    ? `${SERVICE_NAME.slice(0, SERVICE_NAME.lastIndexOf('-') + 1)}.service.d`
    : null;
  return paths.flatMap((root, pathIndex) => [
    { path: join(root, exact), pathIndex, specificity: 3 },
    ...(prefix ? [{ path: join(root, prefix), pathIndex, specificity: 2 }] : []),
    { path: join(root, 'service.d'), pathIndex, specificity: 1 },
  ]);
}

function collectSystemdDropIns(paths) {
  const selected = new Map();
  for (const directory of systemdDropInDirectories(paths)) {
    for (const name of safeDirectoryEntries(directory.path)) {
      if (!name.endsWith('.conf')) continue;
      const candidate = { name, path: join(directory.path, name), pathIndex: directory.pathIndex, specificity: directory.specificity };
      const previous = selected.get(name);
      // A name-specific drop-in outranks type.d; otherwise earlier unit-load
      // paths outrank later paths. Equal-priority duplicates are impossible
      // after the directory de-duplication above, but keep the first one.
      if (!previous || candidate.specificity > previous.specificity
          || (candidate.specificity === previous.specificity && candidate.pathIndex < previous.pathIndex)) {
        selected.set(name, candidate);
      }
    }
  }
  // systemd uses bytewise/alphanumeric filename order; localeCompare would
  // make the effective configuration depend on the operator's locale.
  return [...selected.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function applySystemdEventsWithSources(state, events, source, dropIn) {
  const next = {
    env: { ...state.env },
    environmentFiles: state.environmentFiles.map(entry => ({ ...entry })),
    unsetEnvironment: [...state.unsetEnvironment],
  };
  for (const event of events) {
    if (event.type === 'environment-reset') {
      next.env = {};
    }
    if (event.type === 'environment') {
      for (const assignment of event.assignments) {
        next.env[assignment.key] = assignment.value;
      }
    }
    if (event.type === 'environment-file-reset') next.environmentFiles = [];
    if (event.type === 'environment-file') next.environmentFiles.push({
      value: event.value,
      source,
      origin: source,
      dropIn,
    });
    if (event.type === 'unset-environment-reset') next.unsetEnvironment = [];
    if (event.type === 'unset-environment') next.unsetEnvironment.push(...event.entries);
  }
  return next;
}

function readSystemdEnvironmentFiles(entries) {
  const env = {};
  const owners = {};
  const unresolved = [];
  const values = [];
  const paths = [];
  const uid = typeof process.getuid === 'function' ? String(process.getuid()) : null;
  for (const entry of entries) {
    const origin = entry.origin || entry.source || 'systemd unit';
    let parsed;
    try {
      parsed = parseSystemdEnvironmentFilePath(
        entry.value,
        raw => expandSupportedSystemdSpecifiers(raw, { home: homedir(), uid }),
      );
    } catch (error) {
      throw new Error(`could not resolve EnvironmentFile (${origin}): ${error.message}`);
    }
    if (parsed.reset) continue;
    if (!parsed.absolute || /[*?\[]/.test(parsed.path)) {
      unresolved.push(origin);
      continue;
    }
    paths.push(parsed.path);
    if (!existsSync(parsed.path)) {
      if (parsed.optional) continue;
      throw new Error(`required EnvironmentFile is missing (${origin})`);
    }
    let fileEnv;
    try {
      const fileContent = decodeSystemdEnvironmentFile(readFileSync(parsed.path), parsed.path);
      fileEnv = parseSystemdEnvironmentFile(fileContent);
    } catch (error) {
      if (parsed.optional) continue;
      throw new Error(`could not read EnvironmentFile (${origin}): ${error.message}`);
    }
    for (const [key, value] of Object.entries(fileEnv)) {
      env[key] = value;
      owners[key] = origin;
      values.push(value);
    }
  }
  return { env, owners, unresolved, values, paths };
}

function emptyServiceConfig() {
  return {
    found: false,
    baseEnv: {},
    dropInEnv: {},
    dropInEvents: [],
    dropInKeys: new Set(),
    baseUnsetEnvironment: [],
    effectiveUnsetEnvironment: [],
    environmentFileEnv: {},
    environmentFileOwners: {},
    unresolvedEnvironmentFiles: [],
    effectiveEnv: {},
    environmentFiles: [],
    effectiveEnvironmentFiles: [],
    externalSources: [],
    allEnvironmentValues: [],
    environmentFilePaths: [],
    suspiciousSections: [],
  };
}

function readExistingServiceConfig() {
  if (PLATFORM === 'darwin') {
    if (!existsSync(launchdPlistPath)) return emptyServiceConfig();
    try {
      if (DRY) diagnoseOwnerOnlyRegularFile(launchdPlistPath);
      else ensureOwnerOnlyRegularFile(launchdPlistPath);
    } catch (error) {
      throw new Error(`existing launchd plist is not safe to read: ${error.message}`);
    }
    const env = parseLaunchdEnvironment(launchdPlistPath);
    if (!env) throw new Error(`existing launchd plist has no readable EnvironmentVariables dictionary: ${launchdPlistPath}`);
    return {
      ...emptyServiceConfig(),
      found: true,
      baseEnv: env,
      effectiveEnv: env,
      allEnvironmentValues: Object.values(env),
    };
  }
  if (PLATFORM !== 'linux') return emptyServiceConfig();

  const searchPaths = systemdUnitSearchPaths();
  if (!isAbsolute(systemdUnitDir)) {
    throw new Error('XDG_CONFIG_HOME must be an absolute path for systemd user services');
  }
  if (!searchPaths.includes(systemdUnitDir)) {
    throw new Error('managed systemd unit path is not in SYSTEMD_UNIT_PATH; refusing to write an unloadable service');
  }
  const candidates = searchPaths.map(root => join(root, `${SERVICE_NAME}.service`));
  const effectivePath = candidates.find(path => {
    try { lstatSync(path); return true; } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw new Error('cannot inspect a systemd unit search path');
    }
  });
  if (effectivePath && effectivePath !== systemdUnitPath) {
    throw new Error('effective systemd service is defined by a higher-priority or global unit path; refusing an incomplete merge');
  }
  const found = Boolean(effectivePath);
  const main = found ? parseSystemdEnvironment(readUtf8File(effectivePath, 'systemd unit')) : { env: {}, events: [], environmentFiles: [], suspiciousSections: [] };
  if (main.suspiciousSections.length > 0) {
    throw new Error('systemd unit contains a case-variant [Service] section; refusing to rewrite an ignored section');
  }
  let state = applySystemdEventsWithSources(
    { env: {}, environmentFiles: [], unsetEnvironment: [] },
    main.events,
    'main unit',
    false,
  );
  const baseState = state;
  const dropInEvents = [];
  const dropInKeys = new Set();
  const externalSources = [];
  const allEnvironmentValues = [...collectSystemdEnvironmentValues(main)];
  const dropIns = collectSystemdDropIns(searchPaths);
  for (const dropIn of dropIns) {
    const parsed = parseSystemdEnvironment(readUtf8File(dropIn.path, 'systemd drop-in'));
    if (parsed.suspiciousSections.length > 0) {
      throw new Error('systemd drop-in contains a case-variant [Service] section; refusing to rewrite an ignored section');
    }
    const source = `drop-in ${dropIn.path}`;
    externalSources.push(source);
    allEnvironmentValues.push(...collectSystemdEnvironmentValues(parsed));
    for (const event of parsed.events) {
      const sourcedEvent = { ...event, source };
      dropInEvents.push(sourcedEvent);
      if (event.type === 'environment') for (const assignment of event.assignments) dropInKeys.add(assignment.key);
      if (event.type === 'unset-environment') {
        for (const entry of event.entries) dropInKeys.add(entry.split('=', 1)[0]);
      }
    }
    state = applySystemdEventsWithSources(state, parsed.events, source, true);
  }
  const environmentFileEntries = state.environmentFiles;
  const externalFileConfig = readSystemdEnvironmentFiles(environmentFileEntries);
  externalSources.push(...environmentFileEntries.map(entry => `EnvironmentFile ${entry.origin || entry.source || 'systemd unit'}`));
  allEnvironmentValues.push(...externalFileConfig.values);
  const effectiveEnv = applySystemdUnsetEnvironment(
    { ...state.env, ...externalFileConfig.env },
    state.unsetEnvironment,
  );
  return {
    found,
    baseEnv: baseState.env,
    dropInEnv: state.env,
    dropInEvents,
    dropInKeys,
    baseUnsetEnvironment: baseState.unsetEnvironment,
    effectiveUnsetEnvironment: state.unsetEnvironment,
    environmentFileEnv: externalFileConfig.env,
    environmentFileOwners: externalFileConfig.owners,
    unresolvedEnvironmentFiles: externalFileConfig.unresolved,
    effectiveEnv,
    environmentFiles: baseState.environmentFiles.map(entry => entry.value),
    effectiveEnvironmentFiles: environmentFileEntries.map(entry => entry.value),
    externalSources,
    allEnvironmentValues,
    environmentFilePaths: externalFileConfig.paths,
    suspiciousSections: [],
  };
}

function mergePath(...values) {
  const parts = values.flatMap(value => String(value || '').split(delimiter)).filter(Boolean);
  return [...new Set(parts)].join(delimiter);
}

function writeOwnerOnly(path, content) {
  const tempPath = `${path}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  let fd;
  try {
    fd = openSync(
      tempPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
      0o600,
    );
    writeFileSync(fd, content, 'utf8');
    fchmodSync(fd, 0o600);
    closeSync(fd);
    fd = undefined;
    renameSync(tempPath, path);
    chmodSync(path, 0o600);
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(tempPath, { force: true });
  }
}

function currentUid() {
  if (typeof process.getuid !== 'function') throw new Error('cannot verify owner without process.getuid()');
  return process.getuid();
}

function clearMacAcl(path) {
  // PLATFORM is overridden by the regression harness, but ACL syntax is
  // native-macOS-only. Do not invoke chmod -N when a Linux CI job emulates
  // the launchd path.
  if (PLATFORM !== 'darwin' || process.platform !== 'darwin') return;
  // macOS has no Node fs API for ACLs. `chmod -N` removes the ACL from the
  // already-validated owner path; mode bits alone do not prove owner-only
  // access. The executable path is fixed so PATH cannot redirect this check.
  const result = spawnSync('/bin/chmod', ['-N', path], { stdio: 'ignore' });
  if (result.error || result.status !== 0) {
    throw new Error(`could not remove macOS ACL safely from ${path}`);
  }
}

function ensureOwnerOnlyDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  let stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error(`${path} must be a real directory, not a symlink or special file`);
  if (stats.uid !== currentUid()) throw new Error(`${path} is not owned by the current user`);
  clearMacAcl(path);
  stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isDirectory() || stats.uid !== currentUid()) {
    throw new Error(`${path} changed while ACLs were being secured`);
  }
  chmodSync(path, 0o700);
}

function noFollowFlag() {
  if (!Number.isInteger(constants.O_NOFOLLOW)) throw new Error('this platform cannot open files with O_NOFOLLOW');
  return constants.O_NOFOLLOW;
}

function nonBlockingFlag() {
  if (!Number.isInteger(constants.O_NONBLOCK)) throw new Error('this platform cannot open files with O_NONBLOCK');
  return constants.O_NONBLOCK;
}

function diagnoseOwnerOnlyRegularFile(path) {
  const noFollow = noFollowFlag();
  const nonBlocking = nonBlockingFlag();
  let initialStats;
  let fd;
  try {
    initialStats = lstatSync(path);
    if (initialStats.isSymbolicLink() || !initialStats.isFile()) {
      throw new Error(`${path} is not a regular file`);
    }
    if (initialStats.uid !== currentUid()) throw new Error(`${path} is not owned by the current user`);
    fd = openSync(path, constants.O_RDONLY | noFollow | nonBlocking);
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.uid !== currentUid() || stats.nlink !== 1) {
      throw new Error(`${path} changed during read-only inspection`);
    }
    if ((stats.mode & 0o077) !== 0) {
      log(c.warn + ` dry-run: ${path} is not owner-only; would secure it during a real run`);
    }
    if (PLATFORM === 'darwin' && process.platform === 'darwin') {
      const acl = spawnSync('/bin/ls', ['-lde', path], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (acl.status === 0 && /\+\s/.test(acl.stdout || '')) {
        log(c.warn + ` dry-run: ${path} has an ACL; would remove it during a real run`);
      }
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function ensureOwnerOnlyRegularFile(path) {
  const noFollow = noFollowFlag();
  const nonBlocking = nonBlockingFlag();
  let initialStats;
  let fd;
  try {
    // Reject pre-existing special files before opening them. O_NONBLOCK is
    // still required for the TOCTOU window between lstat() and open(): a
    // replaced FIFO/socket/device must fail quickly rather than hanging setup.
    try {
      initialStats = lstatSync(path);
      if (initialStats.isSymbolicLink() || !initialStats.isFile()) {
        throw new Error(`${path} is not a regular file`);
      }
      if (initialStats.uid !== currentUid()) throw new Error(`${path} is not owned by the current user`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | noFollow | nonBlocking,
      0o600,
    );
    const stats = fstatSync(fd);
    if (!stats.isFile()) throw new Error(`${path} is not a regular file`);
    if (stats.uid !== currentUid()) throw new Error(`${path} is not owned by the current user`);
    if (stats.nlink !== 1) throw new Error(`${path} has unexpected hard links`);
    if (initialStats && (stats.dev !== initialStats.dev || stats.ino !== initialStats.ino)) {
      throw new Error(`${path} changed during inspection`);
    }
    clearMacAcl(path);
    fchmodSync(fd, 0o600);
    const securedStats = fstatSync(fd);
    if (!securedStats.isFile() || securedStats.uid !== currentUid() || securedStats.nlink !== 1) {
      throw new Error(`${path} changed while ACLs were being secured`);
    }
  } catch (error) {
    throw new Error(`refusing unsafe launchd log path ${path}: ${error.message}`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function pathEntryExistsNoFollow(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function migrateLegacyLaunchdLog() {
  let legacyStats;
  try {
    legacyStats = lstatSync(launchdLegacyLogPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (legacyStats.isSymbolicLink() || !legacyStats.isFile() || legacyStats.uid !== currentUid()) {
    log(`${c.warn} obsolete shared launchd log is not a current-user regular file; left untouched: ${launchdLegacyLogPath}`);
    return;
  }

  const noFollow = noFollowFlag();
  const nonBlocking = nonBlockingFlag();
  let fd;
  try {
    // The lstat() check above handles the normal special-file case. Keep the
    // open non-blocking as well so a concurrent replacement cannot turn this
    // legacy-log migration into a FIFO/socket/device hang.
    fd = openSync(launchdLegacyLogPath, constants.O_RDWR | noFollow | nonBlocking);
    const openedStats = fstatSync(fd);
    if (!openedStats.isFile() || openedStats.uid !== currentUid() || openedStats.nlink !== 1) {
      throw new Error('ownership, file type, or link count changed during inspection');
    }
    clearMacAcl(launchdLegacyLogPath);
    fchmodSync(fd, 0o600);

    if (pathEntryExistsNoFollow(launchdLegacyArchivePath)) {
      log(`${c.warn} obsolete shared launchd log was secured in place because ${launchdLegacyArchivePath} already exists`);
      return;
    }
    const currentStats = lstatSync(launchdLegacyLogPath);
    if (currentStats.dev !== openedStats.dev || currentStats.ino !== openedStats.ino) {
      throw new Error('file changed during migration');
    }
    try {
      renameSync(launchdLegacyLogPath, launchdLegacyArchivePath);
      log(c.dim(`  migrated obsolete shared launchd log to ${launchdLegacyArchivePath}`));
    } catch (error) {
      if (error?.code !== 'EXDEV') throw error;
      log(`${c.warn} obsolete shared launchd log was secured in place but could not be moved across filesystems`);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function prepareLaunchdLogging() {
  ensureOwnerOnlyDirectory(launchdLogDir);
  migrateLegacyLaunchdLog();
  ensureOwnerOnlyRegularFile(launchdLogPath);
}

let existingConfig;
try {
  existingConfig = readExistingServiceConfig();
} catch (error) {
  die(`could not read the existing service configuration safely: ${error.message}`);
}
if (UPDATE && !existingConfig.found) {
  const serviceKind = PLATFORM === 'darwin' ? 'launchd' : PLATFORM === 'linux' ? 'systemd' : `${PLATFORM} managed`;
  die(`--update requires an existing standard ${serviceKind} service. Run setup without --update for a first install.`);
}

const serviceEnv = { ...existingConfig.baseEnv };
const hasEnvironmentFile = existingConfig.externalSources.some(source => source.startsWith('EnvironmentFile '));
const ignoredShellEnvKeys = [];
for (const key of CONFIGURABLE_ENV_KEYS) {
  if (!Object.hasOwn(process.env, key)) continue;
  if (!existingConfig.found) {
    serviceEnv[key] = process.env[key];
    continue;
  }
  if (!OVERRIDE_ENV_KEYS.has(key)) {
    if (process.env[key] !== existingConfig.effectiveEnv[key]) ignoredShellEnvKeys.push(key);
    continue;
  }
  if (existingConfig.dropInKeys.has(key)) {
    die(`${key} is managed by a systemd drop-in. Update that owner-only drop-in instead of overriding it from setup.`);
  }
  if (Object.hasOwn(existingConfig.environmentFileOwners, key)) {
    die(`${key} is managed by an EnvironmentFile. Update that owner-only source instead of overriding it from setup.`);
  }
  if (existingConfig.unresolvedEnvironmentFiles.length > 0) {
    die(`${key} cannot be overridden safely because an EnvironmentFile path could not be resolved. Update that source directly.`);
  }
  serviceEnv[key] = process.env[key];
}

// Defaults are seeded only on a fresh install. An update keeps the persistent
// service definition byte-for-value at the environment layer unless the
// operator names an explicit --override-env key.
if (!existingConfig.found) {
  if (!serviceEnv.FLOWBOARD_PORT) serviceEnv.FLOWBOARD_PORT = '18790';
  if (!serviceEnv.FLOWBOARD_HOST) serviceEnv.FLOWBOARD_HOST = '127.0.0.1';
  if (!serviceEnv.OPENCLAW_WORKSPACE) serviceEnv.OPENCLAW_WORKSPACE = join(homedir(), '.openclaw', 'workspace');
  serviceEnv.PATH = mergePath(dirname(process.execPath), serviceEnv.PATH, process.env.PATH);
}

let secretStatus;
if (ROTATE_SECRET) {
  if (existingConfig.dropInKeys.has('JWT_SECRET') || Object.hasOwn(existingConfig.environmentFileOwners, 'JWT_SECRET')) {
    die('JWT_SECRET is managed by a systemd drop-in/EnvironmentFile. Rotate it in that owner-only source, then run --update without --rotate-secret.');
  }
  if (existingConfig.unresolvedEnvironmentFiles.length > 0) {
    die('JWT_SECRET cannot be rotated safely because an EnvironmentFile path could not be resolved. Rotate it in that owner-only source.');
  }
  serviceEnv.JWT_SECRET = randomBytes(32).toString('hex');
  secretStatus = 'rotation requested explicitly';
} else if (existingConfig.found) {
  if (existingConfig.dropInKeys.has('JWT_SECRET')) {
    delete serviceEnv.JWT_SECRET;
    secretStatus = 'existing value preserved in its systemd drop-in';
  } else if (Object.hasOwn(existingConfig.environmentFileOwners, 'JWT_SECRET')) {
    delete serviceEnv.JWT_SECRET;
    secretStatus = 'existing value preserved in its EnvironmentFile';
  } else if (Object.hasOwn(existingConfig.baseEnv, 'JWT_SECRET')) {
    serviceEnv.JWT_SECRET = existingConfig.baseEnv.JWT_SECRET;
    secretStatus = 'existing value preserved';
  } else {
    delete serviceEnv.JWT_SECRET;
    secretStatus = 'not configured in the existing service; left unset';
  }
} else if (serviceEnv.JWT_SECRET) {
  secretStatus = 'value supplied explicitly for the first install';
} else {
  serviceEnv.JWT_SECRET = randomBytes(32).toString('hex');
  secretStatus = 'generated once for the first install';
}

if (PLATFORM === 'linux' && existingConfig.unresolvedEnvironmentFiles.length > 0) {
  die('could not resolve all EnvironmentFile paths safely; use absolute paths or supported %h/%U specifiers before updating.');
}
const effectiveInlineState = PLATFORM === 'linux'
  ? applySystemdEvents(
      serviceEnv,
      existingConfig.environmentFiles,
      existingConfig.dropInEvents,
      existingConfig.baseUnsetEnvironment,
    )
  : { env: serviceEnv, unsetEnvironment: [] };
const effectiveBeforeUnset = {
  ...effectiveInlineState.env,
  ...existingConfig.environmentFileEnv,
};
const effectiveServiceEnv = PLATFORM === 'linux'
  ? applySystemdUnsetEnvironment(effectiveBeforeUnset, effectiveInlineState.unsetEnvironment)
  : effectiveBeforeUnset;

for (const key of OVERRIDE_ENV_KEYS) {
  if (effectiveServiceEnv[key] !== process.env[key]) {
    die(`${key} is overridden or removed by systemd UnsetEnvironment; update that owning directive instead.`);
  }
}
if (ROTATE_SECRET && PLATFORM === 'linux' && effectiveServiceEnv.JWT_SECRET !== serviceEnv.JWT_SECRET) {
  die('JWT_SECRET is removed by systemd UnsetEnvironment. Remove or narrow that directive before rotating the secret.');
}
if (!ROTATE_SECRET && existingConfig.found && !effectiveServiceEnv.JWT_SECRET) {
  secretStatus = PLATFORM === 'linux'
    ? 'not active in the existing systemd service; left unset'
    : 'not configured in the existing service; left unset';
}
if (!effectiveServiceEnv.FLOWBOARD_HOST) effectiveServiceEnv.FLOWBOARD_HOST = '127.0.0.1';
if (!effectiveServiceEnv.OPENCLAW_WORKSPACE) effectiveServiceEnv.OPENCLAW_WORKSPACE = join(homedir(), '.openclaw', 'workspace');
const PORT = Number(effectiveServiceEnv.FLOWBOARD_PORT || 18790);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  die(`FLOWBOARD_PORT must be an integer between 1 and 65535 (received ${JSON.stringify(effectiveServiceEnv.FLOWBOARD_PORT)})`);
}

function buildSystemdDiagnosticCorpus() {
  const values = new Set();
  const keys = new Set();
  const addValue = value => {
    if (typeof value !== 'string' || value.length === 0) return;
    values.add(value);
    values.add(escapeSystemdUnitString(value));
    values.add(JSON.stringify(value));
    // systemd-analyze versions differ in whether control characters are shown
    // literally or as C-style escapes. Keep both representations secret-safe.
    values.add(value.replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r'));
  };
  const addMap = map => {
    for (const [key, value] of Object.entries(map || {})) {
      keys.add(key);
      addValue(value);
      if (typeof value === 'string' && value.length > 0) {
        addValue(`${key}=${value}`);
        addValue(`${key}=${escapeSystemdUnitString(value)}`);
      }
    }
  };
  addMap(existingConfig.baseEnv);
  addMap(existingConfig.dropInEnv);
  addMap(existingConfig.environmentFileEnv);
  addMap(serviceEnv);
  addMap(effectiveServiceEnv);
  for (const value of existingConfig.allEnvironmentValues || []) {
    addValue(value);
  }
  // EnvironmentFile paths can contain operator-controlled names. They are not
  // normally secrets, but redacting them costs little and closes the same
  // diagnostic channel for a path such as /run/credentials/<token>.
  for (const value of existingConfig.environmentFiles || []) addValue(value);
  for (const value of existingConfig.effectiveEnvironmentFiles || []) addValue(value);
  for (const value of existingConfig.environmentFilePaths || []) {
    addValue(value);
  }
  return { values: [...values].sort((a, b) => b.length - a.length), keys };
}

const systemdDiagnosticCorpus = buildSystemdDiagnosticCorpus();

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

function redactSystemdDiagnostics(text, corpus) {
  let redacted = String(text);
  for (const value of corpus?.values || []) redacted = redacted.split(value).join('<redacted>');
  const sensitiveKeys = [...(corpus?.keys || [])]
    .filter(key => /(?:secret|token|credential|password|passwd|private|api[_-]?key|auth|cookie|signature|webhook|cert)/i.test(key))
    .sort((a, b) => b.length - a.length)
    .map(key => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (sensitiveKeys.length > 0) {
    const keyPattern = new RegExp(`(^|[^A-Za-z0-9_])(${sensitiveKeys.join('|')})\\s*=\\s*("(?:\\\\.|[^"])*"|'(?:\\\\.|[^'])*'|[^\\s,;)}\\]]+)`, 'gi');
    redacted = redacted.replace(keyPattern, '$1$2=<redacted>');
  }
  return redacted.trim().slice(0, 2400);
}

function verifySystemdUnit(unit) {
  if (DRY || PLATFORM !== 'linux') return;
  const verifyPath = `${systemdUnitPath}.verify-${process.pid}.service`;
  writeOwnerOnly(verifyPath, unit);
  let failure = null;
  try {
    const result = spawnSync('systemd-analyze', ['--user', 'verify', verifyPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error?.code === 'ENOENT') return;
    const diagnostics = [result.stdout, result.stderr]
      .filter(value => typeof value === 'string' && value.trim())
      .join('\n');
    // A zero exit code is not sufficient: systemd-analyze can report a unit
    // diagnostic on stdout/stderr while still accepting the process exit.
    if (result.error || result.status !== 0 || diagnostics.trim()) {
      const detail = redactSystemdDiagnostics(
        diagnostics || result.error?.message || 'unknown diagnostic',
        systemdDiagnosticCorpus,
      );
      failure = new Error(`systemd-analyze rejected the generated unit${detail ? `: ${detail}` : ''}`);
    }
  } finally {
    rmSync(verifyPath, { force: true });
  }
  if (failure) die(failure.message);
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
if (alreadyUp && FORCE) {
  const managedService = PLATFORM === 'darwin' ? SERVICE_LABEL : PLATFORM === 'linux' ? `${SERVICE_NAME}.service` : `${PLATFORM} service`;
  log(`${c.warn} a dashboard already answers on :${PORT}; this manages the '${managedService}' service — a different supervisor on the same port would conflict.`);
}

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
if (OVERRIDE_ENV_KEYS.size > 0) {
  log(`${c.ok} explicit service environment override requested for: ${[...OVERRIDE_ENV_KEYS].join(', ')}`);
}
if (ignoredShellEnvKeys.length > 0) {
  log(c.dim(`  Ignored non-persistent shell values for: ${ignoredShellEnvKeys.join(', ')}. Use --override-env to persist an intentional change.`));
}
log(`${c.ok} JWT_SECRET: ${secretStatus}`);
const remoteGaps = remoteConfigurationGaps();
if (remoteGaps === null) {
  log(c.dim('  Remote access is not configured; the loopback dashboard needs no auth.'));
} else if (remoteGaps.length > 0) {
  log(`${c.warn} remote access configuration is incomplete; missing: ${remoteGaps.join(', ')}`);
  if (hasEnvironmentFile) {
    log(c.dim('  EnvironmentFile directives were evaluated without printing values; verify missing settings in those owner-only files.'));
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
  <key>Umask</key><integer>63</integer>
  <key>StandardErrorPath</key><string>${encodeXml(launchdLogPath)}</string>
  <key>StandardOutPath</key><string>${encodeXml(launchdLogPath)}</string>
</dict></plist>
`;
  const uid = tryExec('id', ['-u']) || '';
  if (DRY) {
    log(c.dim(`  would write ${launchdPlistPath} (mode 0600)`));
    log(c.dim(`  would prepare ${launchdLogPath} (directory 0700, file 0600) and safely retire ${launchdLegacyLogPath}`));
    log(c.dim(`  would: launchctl bootstrap gui/${uid} ${launchdPlistPath}`));
    log(c.dim(`  would: launchctl print gui/${uid}/${SERVICE_LABEL}`));
  } else {
    try {
      ensureOwnerOnlyDirectory(launchdPlistDir);
    } catch (error) {
      die(`could not secure owner-only launchd plist directory: ${error.message}`);
    }
    // Validate and secure the destination before stopping a healthy existing
    // job. Renaming an open legacy log is safe on POSIX; launchd keeps its file
    // descriptor until the immediately following bootout.
    try {
      prepareLaunchdLogging();
    } catch (error) {
      die(`could not prepare owner-only launchd logging safely: ${error.message}`);
    }
    spawnSync('launchctl', ['bootout', `gui/${uid}/${SERVICE_LABEL}`], { stdio: 'ignore' }); // ignore if not loaded
    writeOwnerOnly(launchdPlistPath, plist);
    try {
      ensureOwnerOnlyRegularFile(launchdPlistPath);
    } catch (error) {
      die(`could not secure generated launchd plist safely: ${error.message}`);
    }
    run('launchctl', ['bootstrap', `gui/${uid}`, launchdPlistPath]);
    runQuiet('launchctl', ['print', `gui/${uid}/${SERVICE_LABEL}`]);
  }
  log(`${c.ok} launchd service ${SERVICE_LABEL} registered with RunAtLoad + KeepAlive`);
} else if (PLATFORM === 'linux') {
  const environmentFileLines = existingConfig.environmentFiles.map(value => `EnvironmentFile=${value}`).join('\n');
  const unsetEnvironmentLine = formatSystemdUnsetEnvironment(existingConfig.baseUnsetEnvironment);
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
${unsetEnvironmentLine}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
  if (DRY) {
    log(c.dim(`  would write ${systemdUnitPath} (mode 0600)`));
    log(c.dim('  would: systemctl --user daemon-reload'));
    if (existingConfig.found && FORCE) {
      log(c.dim('  would: systemctl --user enable flowboard-dashboard'));
      log(c.dim('  would: systemctl --user restart flowboard-dashboard'));
    } else {
      log(c.dim('  would: systemctl --user enable --now flowboard-dashboard'));
    }
    log(c.dim('  would: systemctl --user is-enabled --quiet flowboard-dashboard'));
  } else {
    mkdirSync(systemdUnitDir, { recursive: true });
    verifySystemdUnit(unit);
    writeOwnerOnly(systemdUnitPath, unit);
    run('systemctl', ['--user', 'daemon-reload']);
    if (existingConfig.found && FORCE) {
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
  log(`${c.ok} systemd --user service ${SERVICE_NAME}.service registered and enabled for autostart`);
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
  for (let i = 0; i < HEALTH_ATTEMPTS && !up; i++) { up = await healthy(); if (!up) await new Promise(r => setTimeout(r, 500)); }
  if (up) log(`${c.ok} dashboard is healthy on http://127.0.0.1:${PORT}`);
  else if (PLATFORM === 'darwin') {
    const uid = tryExec('id', ['-u']) || '<uid>';
    die(`dashboard did not come up on port ${PORT} — check ${launchdLogPath} and launchctl print gui/${uid}/${SERVICE_LABEL}`);
  } else if (PLATFORM === 'linux') {
    die(`dashboard did not come up on port ${PORT} — check systemctl --user status ${SERVICE_NAME}.service and journalctl --user -u ${SERVICE_NAME}.service`);
  } else {
    die(`dashboard did not come up on port ${PORT} — inspect the manually started dashboard process output`);
  }
}

step('Done.');
log(`  Open  \x1b[36mhttp://127.0.0.1:${PORT}\x1b[0m`);
log(c.dim('  Remote access (Telegram Mini App / tunnel) is optional — see docs/ for setup.'));
