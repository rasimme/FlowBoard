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

function splitSystemdWords(value) {
  const words = [];
  const isWhitespace = char => char === ' ' || char === '\t' || char === '\r' || char === '\n';
  let word = '';
  let quote = null;
  let escaping = false;
  let started = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (escaping) {
      // Keep the escape marker for the semantic decoder below. The previous
      // implementation consumed it here and then decoded the already
      // modified word a second time, turning e.g. `\\\\` into ` ` when the
      // second character happened to be `s`.
      word += `\\${char}`;
      escaping = false;
      started = true;
    } else if (char === '\\') {
      escaping = true;
      started = true;
    } else if (quote) {
      if (char === quote) {
        const next = value[index + 1];
        if (next !== undefined && !isWhitespace(next)) {
          throw new Error(`closing systemd ${quote} quote must be followed by whitespace`);
        }
        quote = null;
      }
      else word += char;
      started = true;
    } else if (char === '"' || char === "'") {
      if (started) throw new Error(`systemd ${char} quote must start a word`);
      quote = char;
      started = true;
    } else if (isWhitespace(char)) {
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
  if (escaping) throw new Error(`unterminated systemd escape at position ${value.length - 1}`);
  if (quote) throw new Error(`unterminated systemd ${quote} quote`);
  if (started) words.push(word);
  return words;
}

function isUnicodeNoncharacter(codepoint) {
  return (codepoint >= 0xFDD0 && codepoint <= 0xFDEF)
    || (codepoint & 0xFFFF) >= 0xFFFE;
}

function assertUnicodeScalar(codepoint, context) {
  if (codepoint === 0 || codepoint > 0x10FFFF
      || (codepoint >= 0xD800 && codepoint <= 0xDFFF)
      || codepoint === 0xFEFF
      || isUnicodeNoncharacter(codepoint)) {
    throw new Error(`invalid Unicode scalar in ${context}`);
  }
}

function validateUnicodeScalars(value, context) {
  for (let index = 0; index < value.length; index += 1) {
    const codepoint = value.codePointAt(index);
    assertUnicodeScalar(codepoint, context);
    if (codepoint > 0xFFFF) index += 1;
  }
}

function unescapeSystemdString(value) {
  const bytes = [];
  const encoder = new TextEncoder();
  const appendText = text => {
    validateUnicodeScalars(text, 'systemd unit escape');
    bytes.push(...encoder.encode(text));
  };
  let i = 0;
  while (i < value.length) {
    if (value[i] === '\\' && i + 1 < value.length) {
      const next = value[i + 1];
      switch (next) {
        case '\\': appendText('\\'); i += 2; break;
        case '"': appendText('"'); i += 2; break;
        case "'": appendText("'"); i += 2; break;
        case 'n': appendText('\n'); i += 2; break;
        case 'r': appendText('\r'); i += 2; break;
        case 't': appendText('\t'); i += 2; break;
        case 's': appendText(' '); i += 2; break;
        case 'a': appendText('\x07'); i += 2; break;
        case 'b': appendText('\b'); i += 2; break;
        case 'f': appendText('\f'); i += 2; break;
        case 'v': appendText('\v'); i += 2; break;
        case 'x': {
          const hex = value.slice(i + 2, i + 4);
          if (hex.length === 2 && /^[0-9a-f]{2}$/i.test(hex)) {
            const byte = Number.parseInt(hex, 16);
            if (byte === 0) throw new Error(`invalid NUL escape at position ${i}`);
            bytes.push(byte);
            i += 4;
            break;
          }
          throw new Error(`invalid escape sequence \\x at position ${i}; expected \\xHH`);
        }
        case 'u': {
          const hex = value.slice(i + 2, i + 6);
          if (hex.length === 4 && /^[0-9a-f]{4}$/i.test(hex)) {
            const codepoint = Number.parseInt(hex, 16);
            if (codepoint > 0 && codepoint <= 0x10FFFF) {
              assertUnicodeScalar(codepoint, 'systemd unit escape');
              appendText(String.fromCodePoint(codepoint));
              i += 6;
              break;
            }
          }
          throw new Error(`invalid escape sequence \\u at position ${i}; expected \\uHHHH`);
        }
        case 'U': {
          const hex = value.slice(i + 2, i + 10);
          if (hex.length === 8 && /^[0-9a-f]{8}$/i.test(hex)) {
            const codepoint = Number.parseInt(hex, 16);
            if (codepoint > 0 && codepoint <= 0x10FFFF) {
              assertUnicodeScalar(codepoint, 'systemd unit escape');
              appendText(String.fromCodePoint(codepoint));
              i += 10;
              break;
            }
          }
          throw new Error(`invalid escape sequence \\U at position ${i}; expected \\UHHHHHHHH`);
        }
        default: {
          // Unit-file octal escapes are exactly three digits. In particular,
          // do not accept `\\ ` (space is represented by `\\s`) or consume a
          // two-digit prefix such as `\\09`.
          if (/^[0-7]$/.test(next)) {
            const octal = value.slice(i + 1, i + 4);
            if (!/^[0-7]{3}$/.test(octal)) {
              throw new Error(`invalid octal escape at position ${i}; expected exactly three digits`);
            }
            const code = Number.parseInt(octal, 8);
            if (code === 0) throw new Error(`invalid NUL escape at position ${i}`);
            if (code > 0xFF) throw new Error(`invalid octal escape at position ${i}; expected a byte`);
            bytes.push(code);
            i += 4;
            break;
          }
          throw new Error(`unsupported escape sequence \\${next} at position ${i}`);
        }
      }
    } else {
      const codepoint = value.codePointAt(i);
      const text = String.fromCodePoint(codepoint);
      appendText(text);
      i += text.length;
    }
  }
  if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    throw new Error('invalid UTF-8 byte-order mark in systemd unit escape');
  }
  let result;
  try {
    result = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    throw new Error('invalid UTF-8 byte sequence in systemd unit escape');
  }
  validateUnicodeScalars(result, 'systemd unit escape');
  return result;
}

function decodeSystemdEnvironmentFile(content, source) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    throw new Error('EnvironmentFile contains a UTF-8 byte-order mark');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`EnvironmentFile is not valid UTF-8${source ? ` (${source})` : ''}`);
  }
}

function readUtf8File(path, label) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path));
  } catch {
    throw new Error(`${label} is not valid UTF-8 (${path})`);
  }
}

function expandSupportedSystemdSpecifiers(value) {
  const uid = typeof process.getuid === 'function' ? String(process.getuid()) : null;
  let expanded = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char !== '%') {
      expanded += char;
      continue;
    }
    const specifier = value[index + 1];
    if (specifier === '%') expanded += '%';
    else if (specifier === 'h') expanded += homedir();
    else if (specifier === 'U' && uid !== null) expanded += uid;
    else {
      const token = specifier === undefined ? '%' : `%${specifier}`;
      throw new Error(`unsupported or incomplete systemd specifier ${JSON.stringify(token)}; setup supports only %%, %h and %U`);
    }
    index += 1;
  }
  return expanded;
}

function joinSystemdUnitLines(content) {
  const logicalLines = [];
  let pending = '';
  let continued = false;
  for (const physical of String(content).split(/\r?\n/)) {
    if (continued && /^[ \t]*[#;]/.test(physical)) continue;
    let trailingBackslashes = 0;
    for (let index = physical.length - 1; index >= 0 && physical[index] === '\\'; index -= 1) {
      trailingBackslashes += 1;
    }
    if (trailingBackslashes % 2 === 1) {
      pending += `${physical.slice(0, -1)} `;
      continued = true;
      continue;
    }
    logicalLines.push(pending + physical);
    pending = '';
    continued = false;
  }
  if (pending) throw new Error('unterminated systemd line continuation');
  return logicalLines;
}

function parseSystemdEnvironment(content) {
  const env = {};
  const environmentFiles = [];
  const events = [];
  let section = null;
  for (const rawLine of joinSystemdUnitLines(content)) {
    const line = rawLine.replace(/^[ \t\r]+|[ \t\r]+$/g, '');
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1].toLowerCase();
      continue;
    }
    if (section !== 'service') continue;
    const assignment = line.match(/^([A-Za-z][A-Za-z0-9]*)[ \t\r]*=[ \t\r]*(.*)$/);
    if (!assignment) continue;
    const directive = assignment[1];
    const value = assignment[2].trim();
    if (directive === 'EnvironmentFile') {
      if (!value) {
        environmentFiles.length = 0;
        events.push({ type: 'environment-file-reset' });
      } else {
        // Keep the original spelling for a lossless rewrite, but parse every
        // token now so malformed quotes/escapes fail before setup mutates the
        // service. readSystemdEnvironmentFiles() decodes the same token once
        // when resolving the path.
        for (const entry of splitSystemdWords(value)) unescapeSystemdString(entry);
        environmentFiles.push(value);
        events.push({ type: 'environment-file', value });
      }
      continue;
    }
    if (directive === 'UnsetEnvironment') {
      if (!value) {
        events.push({ type: 'unset-environment-reset' });
        continue;
      }
      const entries = splitSystemdWords(value).map((entry) => {
        const unescapedEntry = unescapeSystemdString(entry);
        const expandedEntry = expandSupportedSystemdSpecifiers(unescapedEntry);
        const separator = expandedEntry.indexOf('=');
        const key = separator < 0 ? expandedEntry : expandedEntry.slice(0, separator);
        if (!VALID_ENV_KEY.test(key)) throw new Error(`invalid systemd UnsetEnvironment entry for ${JSON.stringify(key)}`);
        if (separator < 0) return key;
        return expandedEntry;
      });
      events.push({ type: 'unset-environment', entries });
      continue;
    }
    if (directive !== 'Environment') continue;
    if (!value) {
      for (const key of Object.keys(env)) delete env[key];
      events.push({ type: 'environment-reset' });
      continue;
    }
    const assignments = [];
    for (const assignment of splitSystemdWords(value)) {
      const unescapedAssignment = unescapeSystemdString(assignment);
      const expandedAssignment = expandSupportedSystemdSpecifiers(unescapedAssignment);
      const separator = expandedAssignment.indexOf('=');
      if (separator <= 0) throw new Error('invalid systemd Environment assignment');
      const key = expandedAssignment.slice(0, separator);
      if (!VALID_ENV_KEY.test(key)) throw new Error(`invalid systemd Environment key ${JSON.stringify(key)}`);
      const entry = { key, value: expandedAssignment.slice(separator + 1) };
      env[key] = entry.value;
      assignments.push(entry);
    }
    if (assignments.length > 0) events.push({ type: 'environment', assignments });
  }
  return { env, environmentFiles, events };
}

function applySystemdEvents(initialEnv, initialEnvironmentFiles, events, initialUnsetEnvironment = []) {
  let env = { ...initialEnv };
  let environmentFiles = [...initialEnvironmentFiles];
  let unsetEnvironment = [...initialUnsetEnvironment];
  for (const event of events) {
    if (event.type === 'environment-reset') env = {};
    if (event.type === 'environment') {
      for (const assignment of event.assignments) env[assignment.key] = assignment.value;
    }
    if (event.type === 'environment-file-reset') environmentFiles = [];
    if (event.type === 'environment-file') environmentFiles.push(event.value);
    if (event.type === 'unset-environment-reset') unsetEnvironment = [];
    if (event.type === 'unset-environment') unsetEnvironment.push(...event.entries);
  }
  return { env, environmentFiles, unsetEnvironment };
}

function applySystemdUnsetEnvironment(environment, entries) {
  const env = { ...environment };
  for (const entry of entries) {
    const separator = entry.indexOf('=');
    if (separator < 0) {
      delete env[entry];
      continue;
    }
    const key = entry.slice(0, separator);
    const expectedValue = entry.slice(separator + 1);
    if (env[key] === expectedValue) delete env[key];
  }
  return env;
}

function parseSystemdEnvironmentFile(content) {
  validateUnicodeScalars(content, 'EnvironmentFile');
  const env = {};
  let key = '';
  let value = '';
  let keyTrailingWhitespace = -1;
  let valueTrailingWhitespace = -1;
  let state = 'pre-key';
  let hasAssignment = false;
  let line = 1;

  const reset = () => {
    key = '';
    value = '';
    keyTrailingWhitespace = -1;
    valueTrailingWhitespace = -1;
    hasAssignment = false;
  };
  const finish = (final = false) => {
    if (!hasAssignment) {
      reset();
      state = 'pre-key';
      return;
    }
    const finalKey = keyTrailingWhitespace >= 0 ? key.slice(0, keyTrailingWhitespace) : key;
    const finalValue = state === 'value' && valueTrailingWhitespace >= 0
      ? value.slice(0, valueTrailingWhitespace)
      : value;
    if (!VALID_ENV_KEY.test(finalKey)) throw new Error(`invalid EnvironmentFile key on line ${line}`);
    validateUnicodeScalars(finalKey, 'EnvironmentFile key');
    validateUnicodeScalars(finalValue, 'EnvironmentFile value');
    env[finalKey] = finalValue;
    reset();
    state = 'pre-key';
    if (!final) line += 1;
  };
  const isWhitespace = char => char === ' ' || char === '\t' || char === '\r';
  const isNewline = char => char === '\n';
  const doubleQuoteEscapes = new Set(['"', '\\', '$', '`']);

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    switch (state) {
      case 'pre-key':
        if (isNewline(char)) line += 1;
        else if (isWhitespace(char)) {
          // Leading whitespace is ignored.
        } else if (char === '#' || char === ';') state = 'comment';
        else {
          state = 'key';
          key += char;
        }
        break;
      case 'key':
        if (isNewline(char)) {
          reset();
          state = 'pre-key';
          line += 1;
        } else if (char === '=') {
          hasAssignment = true;
          state = 'pre-value';
        } else {
          key += char;
          if (isWhitespace(char)) {
            if (keyTrailingWhitespace < 0) keyTrailingWhitespace = key.length - 1;
          } else keyTrailingWhitespace = -1;
        }
        break;
      case 'pre-value':
        if (isNewline(char)) finish();
        else if (char === "'") state = 'single-quote';
        else if (char === '"') state = 'double-quote';
        else if (char === '\\') state = 'value-escape';
        else if (!isWhitespace(char)) {
          value += char;
          state = 'value';
        }
        break;
      case 'value':
        if (isNewline(char)) finish();
        else if (char === '\\') {
          valueTrailingWhitespace = -1;
          state = 'value-escape';
        } else {
          value += char;
          if (isWhitespace(char)) {
            if (valueTrailingWhitespace < 0) valueTrailingWhitespace = value.length - 1;
          } else valueTrailingWhitespace = -1;
        }
        break;
      case 'value-escape':
        if (isNewline(char)) {
          state = 'value';
          line += 1;
        } else {
          value += char;
          valueTrailingWhitespace = -1;
          state = 'value';
        }
        break;
      case 'single-quote':
        if (char === "'") state = 'pre-value';
        else value += char;
        break;
      case 'double-quote':
        if (char === '"') state = 'pre-value';
        else if (char === '\\') state = 'double-quote-escape';
        else value += char;
        break;
      case 'double-quote-escape':
        if (isNewline(char)) {
          state = 'double-quote';
          line += 1;
        } else if (doubleQuoteEscapes.has(char)) {
          value += char;
          state = 'double-quote';
        } else {
          value += `\\${char}`;
          state = 'double-quote';
        }
        break;
      case 'comment':
        if (char === '\\') state = 'comment-escape';
        else if (isNewline(char)) {
          state = 'pre-key';
          line += 1;
        }
        break;
      case 'comment-escape':
        if (isNewline(char)) {
          state = 'pre-key';
          line += 1;
        } else state = 'comment';
        break;
      default:
        throw new Error(`invalid EnvironmentFile parser state on line ${line}`);
    }
  }

  if (state !== 'pre-key' && state !== 'key' && state !== 'comment' && state !== 'comment-escape') finish(true);
  return env;
}

function expandSystemdEnvironmentFilePath(value) {
  const expanded = expandSupportedSystemdSpecifiers(value);
  if (/[*?\[]/.test(expanded) || !isAbsolute(expanded)) return null;
  return expanded;
}

function readSystemdEnvironmentFiles(entries) {
  const env = {};
  const owners = {};
  const unresolved = [];
  for (const entry of entries) {
    for (const token of splitSystemdWords(entry.value)) {
      const optional = token.startsWith('-');
      const escapedPath = optional ? token.slice(1) : token;
      const configuredPath = unescapeSystemdString(escapedPath);
      const resolvedPath = expandSystemdEnvironmentFilePath(configuredPath);
      if (!resolvedPath) {
        unresolved.push(`${entry.origin}: ${configuredPath}`);
        continue;
      }
      if (!existsSync(resolvedPath)) {
        if (optional) continue;
        throw new Error(`required EnvironmentFile is missing: ${configuredPath}`);
      }
      let fileEnv;
      try {
        const fileContent = decodeSystemdEnvironmentFile(readFileSync(resolvedPath), configuredPath);
        fileEnv = parseSystemdEnvironmentFile(fileContent);
      } catch (error) {
        if (optional) continue;
        throw new Error(`could not read EnvironmentFile ${configuredPath}: ${error.message}`);
      }
      for (const [key, value] of Object.entries(fileEnv)) {
        env[key] = value;
        owners[key] = `${entry.origin}: ${configuredPath}`;
      }
    }
  }
  return { env, owners, unresolved };
}

function readExistingServiceConfig() {
  if (PLATFORM === 'darwin') {
    if (!existsSync(launchdPlistPath)) {
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
        externalSources: [],
      };
    }
    try {
      ensureOwnerOnlyRegularFile(launchdPlistPath);
    } catch (error) {
      throw new Error(`existing launchd plist is not safe to read: ${error.message}`);
    }
    const env = parseLaunchdEnvironment(launchdPlistPath);
    if (!env) throw new Error(`existing launchd plist has no readable EnvironmentVariables dictionary: ${launchdPlistPath}`);
    return {
      found: true,
      baseEnv: env,
      dropInEnv: {},
      dropInEvents: [],
      dropInKeys: new Set(),
      baseUnsetEnvironment: [],
      effectiveUnsetEnvironment: [],
      environmentFileEnv: {},
      environmentFileOwners: {},
      unresolvedEnvironmentFiles: [],
      effectiveEnv: env,
      environmentFiles: [],
      externalSources: [],
    };
  }
  if (PLATFORM === 'linux') {
    let baseEnv = {};
    let environmentFiles = [];
    let baseUnsetEnvironment = [];
    let mergedState = { env: {}, environmentFiles: [], unsetEnvironment: [] };
    const dropInEvents = [];
    const dropInKeys = new Set();
    const externalSources = [];
    const found = existsSync(systemdUnitPath);
    if (existsSync(systemdUnitPath)) {
      const parsed = parseSystemdEnvironment(readUtf8File(systemdUnitPath, 'systemd unit'));
      mergedState = applySystemdEvents({}, [], parsed.events);
      baseEnv = mergedState.env;
      environmentFiles = mergedState.environmentFiles;
      baseUnsetEnvironment = mergedState.unsetEnvironment;
    }
    const dropInDir = `${systemdUnitPath}.d`;
    if (existsSync(dropInDir)) {
      const files = readdirSync(dropInDir).filter(name => name.endsWith('.conf')).sort();
      for (const file of files) {
        const parsed = parseSystemdEnvironment(readUtf8File(join(dropInDir, file), 'systemd drop-in'));
        externalSources.push(`drop-in ${file}`);
        for (const event of parsed.events) {
          dropInEvents.push(event);
          if (event.type === 'environment') {
            for (const assignment of event.assignments) dropInKeys.add(assignment.key);
          }
        }
        mergedState = applySystemdEvents(
          mergedState.env,
          mergedState.environmentFiles,
          parsed.events,
          mergedState.unsetEnvironment,
        );
      }
    }
    const environmentFileEntries = mergedState.environmentFiles.map(value => ({
      value,
      origin: environmentFiles.includes(value) ? 'main unit' : 'drop-in',
    }));
    const externalFileConfig = readSystemdEnvironmentFiles(environmentFileEntries);
    externalSources.push(...environmentFileEntries.map(entry => `EnvironmentFile ${entry.value}`));
    const effectiveEnv = applySystemdUnsetEnvironment(
      { ...mergedState.env, ...externalFileConfig.env },
      mergedState.unsetEnvironment,
    );
    return {
      found,
      baseEnv,
      dropInEnv: mergedState.env,
      dropInEvents,
      dropInKeys,
      baseUnsetEnvironment,
      effectiveUnsetEnvironment: mergedState.unsetEnvironment,
      environmentFileEnv: externalFileConfig.env,
      environmentFileOwners: externalFileConfig.owners,
      unresolvedEnvironmentFiles: externalFileConfig.unresolved,
      effectiveEnv,
      environmentFiles,
      externalSources,
    };
  }
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
    externalSources: [],
  };
}

function mergePath(...values) {
  const parts = values.flatMap(value => String(value || '').split(delimiter)).filter(Boolean);
  return [...new Set(parts)].join(delimiter);
}

function escapeSystemdUnitString(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/%/g, '%%')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

function quoteSystemdEnvironment(key, value) {
  return `Environment="${escapeSystemdUnitString(`${key}=${String(value)}`)}"`;
}

function quoteSystemdUnsetEnvironmentEntry(entry) {
  const escaped = escapeSystemdUnitString(entry);
  return entry.includes('=') || /[ \t\r\n]/.test(entry) ? `"${escaped}"` : escaped;
}

function formatSystemdUnsetEnvironment(entries) {
  return entries.length > 0
    ? `UnsetEnvironment=${entries.map(quoteSystemdUnsetEnvironmentEntry).join(' ')}`
    : '';
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
  if (Object.hasOwn(existingConfig.baseEnv, 'JWT_SECRET')) {
    serviceEnv.JWT_SECRET = existingConfig.baseEnv.JWT_SECRET;
    secretStatus = 'existing value preserved';
  } else if (existingConfig.dropInKeys.has('JWT_SECRET')) {
    delete serviceEnv.JWT_SECRET;
    secretStatus = 'existing value preserved in its systemd drop-in';
  } else if (Object.hasOwn(existingConfig.environmentFileOwners, 'JWT_SECRET')) {
    delete serviceEnv.JWT_SECRET;
    secretStatus = 'existing value preserved in its EnvironmentFile';
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

function redactSystemdDiagnostics(text, environment) {
  let redacted = String(text);
  for (const value of Object.values(environment || {})) {
    if (typeof value === 'string' && value.length > 0) redacted = redacted.split(value).join('<redacted>');
  }
  redacted = redacted.replace(/\b(JWT_SECRET|TELEGRAM_BOT_TOKEN|TELEGRAM_BOT_TOKENS|HOOKS_TOKEN|OPENCLAW_HOOKS_TOKEN)=([^\s"']+)/g, '$1=<redacted>');
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
      const detail = redactSystemdDiagnostics(diagnostics || result.error?.message || 'unknown diagnostic', effectiveServiceEnv);
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
