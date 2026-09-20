/**
 * Host detection for the FlowBoard release canaries (T-487-1).
 *
 * FlowBoard supports three generations of OpenClaw at once — 2026.6.6 up —
 * and the CLI surface changed underneath it more than once. Two rules follow
 * from that and both live here:
 *
 *  1. **Never branch on a version string.** A version number tells you which
 *     release you are on, not which flags that build actually accepts (a
 *     backport, a fork, or a `-rc` tag all lie). The CLI documents itself, so
 *     capabilities are read out of `--help` and nothing else. Passing an
 *     unsupported flag is not a soft failure: commander exits non-zero with
 *     "unknown option", which would turn a healthy old host into a red canary.
 *  2. **Never touch the operator's real OpenClaw state.** Everything runs in a
 *     disposable home — including the `exec-approvals.json` stub, which is not
 *     hygiene but a hard requirement; see `writeExecApprovalsStub`.
 *
 * The parsers are pure functions over captured `--help` text so they can be
 * unit-tested against fixtures from real hosts
 * (`dashboard/test-openclaw-host-capabilities.js`).
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * Lines belonging to one commander help section ("Options:", "Commands:", …).
 *
 * A section ends at the next unindented line, which is what separates the
 * option list from the command list in `openclaw plugins --help`.
 */
export function sectionLines(helpText, heading) {
  const lines = String(helpText || '').split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return [];
  const out = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') continue;
    if (!/^\s/.test(line)) break;
    out.push(line);
  }
  return out;
}

/**
 * Long flags a command accepts, e.g. `--accept-capabilities`.
 *
 * Only the flag column counts. Descriptions wrap onto deeply indented
 * continuation lines and routinely *mention* flags in prose — 2026.9.5's
 * consent error names `--accept-capabilities` in the text of another option —
 * so a naive `/--[a-z-]+/` scan would report flags the build does not have.
 */
export function parseFlags(helpText) {
  const flags = new Set();
  for (const line of sectionLines(helpText, 'Options:')) {
    const match = /^ {2}(-[^\s,]+)(?:,\s*(-[^\s,]+))?/.exec(line);
    if (!match) continue;
    for (const token of [match[1], match[2]]) {
      if (token && token.startsWith('--')) flags.add(token);
    }
  }
  return flags;
}

/** Subcommand names a command group exposes, e.g. `reload` under `plugins`. */
export function parseSubcommands(helpText) {
  const commands = new Set();
  for (const line of sectionLines(helpText, 'Commands:')) {
    const match = /^ {2}([a-z][a-z0-9:-]*)\s{2,}\S/.exec(line);
    if (match) commands.add(match[1]);
  }
  return commands;
}

/** `OpenClaw 2026.9.5 (ec9c1a1)` → `{ version: '2026.9.5', commit: 'ec9c1a1' }`. */
export function parseVersion(versionText) {
  const raw = String(versionText || '').trim();
  const match = /OpenClaw\s+(\S+)(?:\s+\(([^)]+)\))?/.exec(raw);
  if (!match) return { version: raw || null, commit: null, raw };
  return { version: match[1], commit: match[2] || null, raw };
}

/**
 * Map captured help texts onto the capability flags the canary branches on.
 *
 * Every field answers "may I pass this?" or "may I call this?", never "which
 * release is this?". Verified against real hosts (fixtures carry the output):
 *
 * | capability                   | 2026.6.6 | 2026.7.1-2 | 2026.9.5 |
 * |------------------------------|----------|------------|----------|
 * | acceptCapabilities           | no       | no         | yes      |
 * | acknowledgeClawhubRisk       | no       | yes        | no       |
 * | acknowledgeInstallPolicy     | no       | no         | yes      |
 * | inspectRuntime / inspectJson | yes      | yes        | yes      |
 * | doctorJson                   | no       | no         | yes      |
 * | reload / pack                | no       | no         | yes      |
 * | validateJson                 | no       | no         | yes      |
 * | build / buildCheck           | yes      | yes        | yes      |
 *
 * `build` and `--check` are the trap: both old CLIs have them, but there they
 * only generate *tool*-plugin metadata and reject FlowBoard's entry. The
 * marker for a feature-plugin-aware CLI is `validateJson` together with the
 * `pack` subcommand, never `buildCheck`.
 */
export function detectCapabilities(help) {
  const installFlags = parseFlags(help.install);
  const inspectFlags = parseFlags(help.inspect);
  const doctorFlags = parseFlags(help.doctor);
  const uninstallFlags = parseFlags(help.uninstall);
  const updateFlags = parseFlags(help.update);
  const buildFlags = parseFlags(help.build);
  const validateFlags = parseFlags(help.validate);
  const commands = parseSubcommands(help.plugins);
  const { version, commit } = parseVersion(help.version);

  return {
    version,
    commit,
    acceptCapabilities: installFlags.has('--accept-capabilities'),
    acknowledgeClawhubRisk: installFlags.has('--acknowledge-clawhub-risk'),
    acknowledgeInstallPolicy: installFlags.has('--acknowledge-install-policy-warning'),
    installForce: installFlags.has('--force'),
    inspectRuntime: inspectFlags.has('--runtime'),
    inspectJson: inspectFlags.has('--json'),
    doctorJson: doctorFlags.has('--json'),
    uninstallForce: uninstallFlags.has('--force'),
    updateAcceptCapabilities: updateFlags.has('--accept-capabilities'),
    buildCheck: buildFlags.has('--check'),
    validateJson: validateFlags.has('--json'),
    reload: commands.has('reload'),
    pack: commands.has('pack'),
    build: commands.has('build'),
    validate: commands.has('validate'),
    // Derived: this CLI belongs to the feature-plugin generation (>= 2026.9),
    // i.e. it knows what `controlUi` and a feature contract are. Everything
    // that depends on the native UI existing keys off this, never off
    // `buildCheck` (see the note above) and never off the version string.
    featurePluginHost: commands.has('pack') && validateFlags.has('--json'),
  };
}

/** The `plugins <sub> --help` captures `detectCapabilities` consumes. */
export const HELP_PROBES = [
  ['version', ['--version']],
  ['plugins', ['plugins', '--help']],
  ['install', ['plugins', 'install', '--help']],
  ['inspect', ['plugins', 'inspect', '--help']],
  ['doctor', ['plugins', 'doctor', '--help']],
  ['uninstall', ['plugins', 'uninstall', '--help']],
  ['update', ['plugins', 'update', '--help']],
  ['build', ['plugins', 'build', '--help']],
  ['validate', ['plugins', 'validate', '--help']],
];

/**
 * Why every isolated run pre-creates `exec-approvals.json`.
 *
 * On 2026.6.x and 2026.7.x the first CLI call against a fresh
 * `OPENCLAW_STATE_DIR` runs a one-shot legacy-state migration whose source
 * path is derived from the *home directory*, not from the state dir. When the
 * isolated target file does not exist yet, it adopts the machine's real
 * `~/.openclaw/exec-approvals.json` and renames the live file to
 * `exec-approvals.json.migrated-<ts>` — i.e. running the canary on a machine
 * with a live OpenClaw silently moves that instance's exec-approval socket
 * config out from under it. Observed twice on 2026-09-20.
 *
 * A stub at the isolated path makes the migration a no-op, so the canary is
 * safe to run next to a working Gateway. This is not optional belt-and-braces:
 * it is the reason the canary may be handed to contributors at all.
 */
export function writeExecApprovalsStub(stateDir) {
  mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, 'exec-approvals.json');
  if (existsSync(file)) return file;
  const stub = {
    version: 1,
    socket: {
      path: path.join(stateDir, 'exec-approvals.sock'),
      token: randomBytes(24).toString('hex'),
    },
    defaults: {},
    agents: {},
  };
  writeFileSync(file, `${JSON.stringify(stub, null, 2)}\n`, { mode: 0o600 });
  return file;
}

/**
 * A disposable OpenClaw home plus the environment that pins the CLI to it.
 *
 * `HOME` is overridden as well as `OPENCLAW_STATE_DIR`, because parts of the
 * older CLIs resolve paths from the home directory directly (see
 * `writeExecApprovalsStub`). `OPENCLAW_CONFIG_PATH` is required on 2026.9.x,
 * where the config file is otherwise still read from the real `~/.openclaw`.
 */
export function createIsolatedHome(homeDir, baseEnv = process.env, extraPath = null) {
  mkdirSync(homeDir, { recursive: true });
  const execApprovals = writeExecApprovalsStub(homeDir);
  const env = {
    ...baseEnv,
    HOME: homeDir,
    OPENCLAW_HOME: homeDir,
    OPENCLAW_STATE_DIR: homeDir,
    OPENCLAW_CONFIG_PATH: path.join(homeDir, 'openclaw.json'),
  };
  if (extraPath) env.PATH = `${extraPath}${path.delimiter}${baseEnv.PATH || ''}`;
  return { dir: homeDir, execApprovals, env };
}

/** Run a CLI command; never throws, always reports status/stdout/stderr. */
export function runCli(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: 'utf8',
    stdio: options.stdio || 'pipe',
    shell: false,
    timeout: options.timeout,
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  return {
    ok: !result.error && result.status === 0,
    status: result.status,
    error: result.error ? result.error.message : null,
    stdout,
    stderr,
    output: [stdout, stderr].filter(Boolean).join('\n'),
  };
}

/** Capture every help text `detectCapabilities` needs from a live CLI. */
export function probeHelp(command, options = {}) {
  const help = {};
  for (const [key, args] of HELP_PROBES) {
    const result = runCli(command, args, options);
    // A missing subcommand exits non-zero; that IS the answer (no such
    // capability), so an empty capture is recorded rather than thrown.
    help[key] = result.ok ? result.output : '';
  }
  return help;
}

/** `probeHelp` + `detectCapabilities` against a live CLI. */
export function probeHostCapabilities(command, options = {}) {
  const help = probeHelp(command, options);
  return { help, capabilities: detectCapabilities(help) };
}
