/**
 * T-487-1 — the release canary must read the host, not guess it.
 *
 * FlowBoard installs on OpenClaw 2026.6.6 through 2026.9.x, and those CLIs do
 * not accept the same flags. Two failure modes are being guarded here, and
 * both are silent until a release breaks on someone else's machine:
 *
 *   1. **Passing a flag the host does not have.** `--accept-capabilities` is
 *      mandatory on 2026.9.x and does not exist on 2026.6.6 / 2026.7.1-2,
 *      where commander aborts with "unknown option". A canary that hard-codes
 *      it reports a healthy old host as broken; one that omits it cannot
 *      install on a current host at all.
 *   2. **Reading a flag out of prose.** Commander wraps long descriptions, and
 *      those descriptions mention other flags. A loose scan of the help text
 *      would "detect" `--accept-capabilities` on 2026.7.1-2 (it is named in
 *      the consent error text) and `--force` everywhere.
 *
 * The fixtures under `test-fixtures/openclaw-help/` are verbatim `--help`
 * captures from the three real hosts, so the parse is tested against what the
 * CLIs actually print rather than against an idea of it.
 *
 * The third subject is `writeExecApprovalsStub`. On 2026.6.x / 2026.7.x the
 * first CLI call with a fresh `OPENCLAW_STATE_DIR` migrates the machine's real
 * `~/.openclaw/exec-approvals.json` into the isolated home and renames the
 * live file. The stub makes that a no-op; without it the canary is unsafe to
 * run on any machine with a working OpenClaw.
 *
 * Run: node test-openclaw-host-capabilities.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createIsolatedHome,
  detectCapabilities,
  parseFlags,
  parseSubcommands,
  parseVersion,
  sectionLines,
  writeExecApprovalsStub,
  HELP_PROBES,
} from '../scripts/lib/openclaw-host.mjs';
import { parseMatrixEntry } from '../scripts/release-host-matrix.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'test-fixtures', 'openclaw-help');

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ❌ ${name}\n     ${error.message}`);
  }
}

function section(title) {
  console.log(`\n## ${title}`);
}

function loadFixture(host) {
  const dir = path.join(FIXTURES, host);
  const help = {};
  for (const [key] of HELP_PROBES) {
    help[key] = fs.readFileSync(path.join(dir, `${key}.txt`), 'utf8');
  }
  return help;
}

const HOSTS = ['2026.6.6', '2026.7.1-2', '2026.9.5'];

// ---------------------------------------------------------------------------
// Fixtures exist and are real captures
// ---------------------------------------------------------------------------

section('fixtures');

check('one fixture directory per supported host generation', () => {
  const dirs = fs.readdirSync(FIXTURES).filter((entry) => !entry.startsWith('.')).sort();
  assert.deepEqual(dirs, [...HOSTS].sort());
});

for (const host of HOSTS) {
  check(`${host} fixture has every probed help text`, () => {
    const help = loadFixture(host);
    for (const [key] of HELP_PROBES) {
      assert.ok(help[key].trim().length > 0, `${key}.txt is empty`);
    }
    assert.match(help.version, /^OpenClaw /);
  });
}

// ---------------------------------------------------------------------------
// Primitive parsers
// ---------------------------------------------------------------------------

section('help parsing');

check('sectionLines stops at the next unindented block', () => {
  const help = loadFixture('2026.9.5').plugins;
  const options = sectionLines(help, 'Options:');
  const commands = sectionLines(help, 'Commands:');
  assert.ok(options.length >= 1);
  assert.ok(commands.length >= 10);
  // "Options:" comes first in `plugins --help`; if the section did not stop,
  // its lines would contain the command list too.
  assert.ok(!options.some((line) => /\breload\b/.test(line)), 'Options section leaked into Commands');
});

check('parseVersion splits version and commit', () => {
  assert.deepEqual(parseVersion('OpenClaw 2026.9.5 (ec9c1a1)'), {
    version: '2026.9.5',
    commit: 'ec9c1a1',
    raw: 'OpenClaw 2026.9.5 (ec9c1a1)',
  });
  assert.equal(parseVersion('OpenClaw 2026.7.1-2 (0790d9f)').version, '2026.7.1-2');
  assert.equal(parseVersion('').version, null);
});

check('parseFlags reads the flag column, not descriptions', () => {
  const help = [
    'Usage: openclaw plugins install [options] <spec>',
    '',
    'Options:',
    '  --force                             Overwrite an existing plugin',
    '  -l, --link                          Link a local path instead of copying',
    '  --dangerously-force-unsafe-install  Deprecated no-op; re-run with',
    '                                      --accept-capabilities to consent',
    '  -h, --help                          Display help for command',
  ].join('\n');
  const flags = parseFlags(help);
  assert.ok(flags.has('--force'));
  assert.ok(flags.has('--link'));
  assert.ok(flags.has('--dangerously-force-unsafe-install'));
  assert.ok(flags.has('--help'));
  // The regression this test exists for: a flag named only inside a wrapped
  // description must never be reported as supported.
  assert.ok(!flags.has('--accept-capabilities'), 'flag was read out of a description');
});

check('parseSubcommands reads the Commands section only', () => {
  const commands = parseSubcommands(loadFixture('2026.9.5').plugins);
  for (const expected of ['install', 'inspect', 'doctor', 'reload', 'pack', 'build', 'validate', 'uninstall']) {
    assert.ok(commands.has(expected), `missing subcommand ${expected}`);
  }
  assert.ok(!commands.has('help'), 'options leaked into the subcommand list');
});

// ---------------------------------------------------------------------------
// The capability matrix itself
// ---------------------------------------------------------------------------

section('capability matrix (captured from real hosts)');

const EXPECTED = {
  '2026.6.6': {
    version: '2026.6.6',
    acceptCapabilities: false,
    acknowledgeClawhubRisk: false,
    acknowledgeInstallPolicy: false,
    installForce: true,
    inspectRuntime: true,
    inspectJson: true,
    doctorJson: false,
    uninstallForce: true,
    updateAcceptCapabilities: false,
    buildCheck: true,
    validateJson: false,
    reload: false,
    pack: false,
    build: true,
    validate: true,
  },
  '2026.7.1-2': {
    version: '2026.7.1-2',
    acceptCapabilities: false,
    // The 2026.7 flag that is NOT capability consent: it acknowledges ClawHub
    // source-trust warnings. Conflating the two is how a canary ends up
    // claiming consent on a host that has none.
    acknowledgeClawhubRisk: true,
    acknowledgeInstallPolicy: false,
    installForce: true,
    inspectRuntime: true,
    inspectJson: true,
    doctorJson: false,
    uninstallForce: true,
    updateAcceptCapabilities: false,
    buildCheck: true,
    validateJson: false,
    reload: false,
    pack: false,
    build: true,
    validate: true,
  },
  '2026.9.5': {
    version: '2026.9.5',
    acceptCapabilities: true,
    acknowledgeClawhubRisk: false,
    acknowledgeInstallPolicy: true,
    installForce: true,
    inspectRuntime: true,
    inspectJson: true,
    doctorJson: true,
    uninstallForce: true,
    updateAcceptCapabilities: true,
    buildCheck: true,
    validateJson: true,
    reload: true,
    pack: true,
    build: true,
    validate: true,
  },
};

for (const host of HOSTS) {
  check(`${host} capabilities match the captured CLI`, () => {
    const actual = detectCapabilities(loadFixture(host));
    for (const [key, expected] of Object.entries(EXPECTED[host])) {
      assert.equal(actual[key], expected, `${host}.${key}: expected ${expected}, got ${actual[key]}`);
    }
  });
}

check('only 2026.9.x offers capability consent', () => {
  const consenting = HOSTS.filter((host) => detectCapabilities(loadFixture(host)).acceptCapabilities);
  assert.deepEqual(consenting, ['2026.9.5']);
});

check('build --check is not a feature-plugin marker', () => {
  // The release gate must not use `buildCheck` to decide whether a CLI can
  // validate a feature plugin: all three hosts have that flag, and the old
  // ones only understand tool plugins with it.
  for (const host of HOSTS) {
    assert.equal(detectCapabilities(loadFixture(host)).buildCheck, true, `${host} unexpectedly lacks build --check`);
  }
  const featureAware = HOSTS.filter((host) => {
    const caps = detectCapabilities(loadFixture(host));
    return caps.validateJson && caps.pack;
  });
  assert.deepEqual(featureAware, ['2026.9.5']);
});

check('an unknown CLI degrades to the safest capability set', () => {
  const capabilities = detectCapabilities({});
  assert.equal(capabilities.version, null);
  for (const key of ['acceptCapabilities', 'reload', 'pack', 'doctorJson', 'validateJson']) {
    assert.equal(capabilities[key], false, `${key} must default to false`);
  }
});

// ---------------------------------------------------------------------------
// exec-approvals stub + isolated home
// ---------------------------------------------------------------------------

section('disposable home + exec-approvals stub');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-host-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

check('writeExecApprovalsStub creates a self-contained stub', () => {
  withTempDir((dir) => {
    const stateDir = path.join(dir, 'home');
    const file = writeExecApprovalsStub(stateDir);
    assert.equal(file, path.join(stateDir, 'exec-approvals.json'));
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(parsed.version, 1);
    assert.deepEqual(parsed.defaults, {});
    assert.deepEqual(parsed.agents, {});
    // The socket path must point inside the disposable home — a stub that
    // referenced the machine's real socket would defeat the isolation.
    assert.equal(parsed.socket.path, path.join(stateDir, 'exec-approvals.sock'));
    assert.match(parsed.socket.token, /^[0-9a-f]{48}$/);
  });
});

check('the stub is owner-only', () => {
  withTempDir((dir) => {
    const file = writeExecApprovalsStub(path.join(dir, 'home'));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });
});

check('an existing exec-approvals file is never overwritten', () => {
  withTempDir((dir) => {
    const stateDir = path.join(dir, 'home');
    fs.mkdirSync(stateDir, { recursive: true });
    const file = path.join(stateDir, 'exec-approvals.json');
    fs.writeFileSync(file, '{"version":1,"keep":"me"}');
    writeExecApprovalsStub(stateDir);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).keep, 'me');
  });
});

check('two stubs never share a token', () => {
  withTempDir((dir) => {
    const a = JSON.parse(fs.readFileSync(writeExecApprovalsStub(path.join(dir, 'a')), 'utf8'));
    const b = JSON.parse(fs.readFileSync(writeExecApprovalsStub(path.join(dir, 'b')), 'utf8'));
    assert.notEqual(a.socket.token, b.socket.token);
  });
});

check('createIsolatedHome pins every OpenClaw path into the throwaway dir', () => {
  withTempDir((dir) => {
    const home = path.join(dir, 'home');
    const { env, execApprovals } = createIsolatedHome(home, { PATH: '/usr/bin', SOME_OTHER: 'kept' });
    assert.equal(env.HOME, home);
    assert.equal(env.OPENCLAW_HOME, home);
    assert.equal(env.OPENCLAW_STATE_DIR, home);
    assert.equal(env.OPENCLAW_CONFIG_PATH, path.join(home, 'openclaw.json'));
    assert.equal(env.SOME_OTHER, 'kept', 'unrelated env must pass through');
    assert.ok(fs.existsSync(execApprovals), 'the stub is written before any CLI can run');
  });
});

check('createIsolatedHome can prepend a Node directory to PATH', () => {
  withTempDir((dir) => {
    const { env } = createIsolatedHome(path.join(dir, 'home'), { PATH: '/usr/bin' }, '/opt/node24/bin');
    assert.equal(env.PATH, `/opt/node24/bin${path.delimiter}/usr/bin`);
  });
});

// ---------------------------------------------------------------------------
// Matrix entry syntax
// ---------------------------------------------------------------------------

section('host matrix entry syntax');

check('a bare CLI path is a valid entry', () => {
  assert.deepEqual(parseMatrixEntry('/opt/oc/bin/openclaw'), {
    label: 'openclaw',
    node: null,
    cli: '/opt/oc/bin/openclaw',
  });
});

check('node= prefix pins the runtime for one host', () => {
  assert.deepEqual(parseMatrixEntry('node=/opt/node24/bin/node /opt/oc95/openclaw'), {
    label: 'openclaw',
    node: '/opt/node24/bin/node',
    cli: '/opt/oc95/openclaw',
  });
});

check('a label names the matrix column', () => {
  assert.deepEqual(parseMatrixEntry('2026.9.5: node=/opt/node24/bin/node /opt/oc95/openclaw'), {
    label: '2026.9.5',
    node: '/opt/node24/bin/node',
    cli: '/opt/oc95/openclaw',
  });
});

check('FLOWBOARD_HOST_MATRIX_NODE fills in the missing runtime', () => {
  assert.equal(parseMatrixEntry('/opt/oc/openclaw', '/opt/node24/bin/node').node, '/opt/node24/bin/node');
  // A per-entry prefix always wins over the default.
  assert.equal(parseMatrixEntry('node=/other/node /opt/oc/openclaw', '/opt/node24/bin/node').node, '/other/node');
});

check('an empty entry is dropped, not mistaken for a CLI', () => {
  assert.equal(parseMatrixEntry('   '), null);
  assert.equal(parseMatrixEntry(''), null);
});

// ---------------------------------------------------------------------------

console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
