#!/usr/bin/env node
// Regression coverage for scripts/setup.mjs Linux service configuration.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DASH = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(DASH);
const UNIT_NAME = 'flowboard-dashboard.service';

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

function readLines(path) {
  try {
    return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function quoteScript(script) {
  return `#!/usr/bin/env node\n${script}\n`;
}

function makeHarness({ initialUnit = '', dropIns = {}, environmentFiles = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fb-setup-systemd-'));
  const bin = join(dir, 'bin');
  const home = join(dir, 'home');
  const unitDir = join(home, '.config', 'systemd', 'user');
  const unitPath = join(unitDir, UNIT_NAME);
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });

  if (initialUnit) {
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(unitPath, initialUnit, { mode: 0o600 });
  }
  if (Object.keys(dropIns).length > 0) {
    const dropInDir = `${unitPath}.d`;
    mkdirSync(dropInDir, { recursive: true });
    for (const [name, content] of Object.entries(dropIns)) {
      writeFileSync(join(dropInDir, name), content, { mode: 0o600 });
    }
  }
  for (const [relativePath, content] of Object.entries(environmentFiles)) {
    const path = join(home, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, { mode: 0o600 });
  }

  const commandLog = join(dir, 'commands.log');
  const npmBin = join(bin, 'npm');
  const systemctlBin = join(bin, 'systemctl');
  const systemdAnalyzeBin = join(bin, 'systemd-analyze');

  writeFileSync(npmBin, quoteScript(`
const { appendFileSync } = require('node:fs');
appendFileSync(process.env.FAKE_COMMAND_LOG, 'npm ' + process.argv.slice(2).join(' ') + '\\n');
if (process.argv[2] === '--version') console.log('10.0.0');
process.exit(0);
`), { mode: 0o755 });

  writeFileSync(systemctlBin, quoteScript(`
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_COMMAND_LOG, 'systemctl ' + args.join(' ') + '\\n');
if (args.includes('restart') && process.env.FAKE_SYSTEMCTL_RESTART_STATUS) {
  process.exit(Number(process.env.FAKE_SYSTEMCTL_RESTART_STATUS));
}
if (args.includes('is-active') && process.env.FAKE_SYSTEMCTL_IS_ACTIVE_STATUS) {
  process.exit(Number(process.env.FAKE_SYSTEMCTL_IS_ACTIVE_STATUS));
}
if (args.includes('is-enabled') && process.env.FAKE_SYSTEMCTL_IS_ENABLED_STATUS) {
  process.exit(Number(process.env.FAKE_SYSTEMCTL_IS_ENABLED_STATUS));
}
process.exit(0);
`), { mode: 0o755 });

  writeFileSync(systemdAnalyzeBin, quoteScript(`
const { appendFileSync } = require('node:fs');
if (process.env.FAKE_SYSTEMD_ANALYZE_LOG === '1') {
  appendFileSync(process.env.FAKE_COMMAND_LOG, 'systemd-analyze ' + process.argv.slice(2).join(' ') + '\\n');
}
if (process.env.FAKE_SYSTEMD_ANALYZE_STDOUT) process.stdout.write(process.env.FAKE_SYSTEMD_ANALYZE_STDOUT + '\\n');
if (process.env.FAKE_SYSTEMD_ANALYZE_STDERR) process.stderr.write(process.env.FAKE_SYSTEMD_ANALYZE_STDERR + '\\n');
process.exit(Number(process.env.FAKE_SYSTEMD_ANALYZE_STATUS || 0));
`), { mode: 0o755 });

  const safeEnv = {};
  for (const key of ['LANG', 'LC_ALL', 'TMPDIR']) {
    if (process.env[key]) safeEnv[key] = process.env[key];
  }

  return {
    dir,
    home,
    unitPath,
    commandLog,
    env: {
      ...safeEnv,
      HOME: home,
      NODE_ENV: 'test',
      FLOWBOARD_SETUP_TEST_PLATFORM: 'linux',
      FAKE_COMMAND_LOG: commandLog,
      PATH: [bin, process.env.PATH].filter(Boolean).join(delimiter),
    },
    artifact() {
      return {
        unit: existsSync(unitPath) ? readFileSync(unitPath, 'utf8') : '',
        mode: existsSync(unitPath) ? statSync(unitPath).mode & 0o777 : null,
      };
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function withHealthServer(fn, statusCode = 200) {
  const server = createServer((req, res) => {
    if (req.url === '/api/health') {
      res.writeHead(statusCode, { 'content-type': 'application/json' });
      res.end(statusCode === 200 ? '{"ok":true}' : '{"ok":false}');
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn(port);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function spawnSetup(harness, port, args, extraEnv = {}, { injectPort = true } = {}) {
  const before = readLines(harness.commandLog).length;
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(ROOT, 'scripts', 'setup.mjs'), ...args], {
      cwd: ROOT,
      env: {
        ...harness.env,
        ...(injectPort ? { FLOWBOARD_PORT: String(port) } : {}),
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => {
      const commands = readLines(harness.commandLog).slice(before);
      resolve({ code, stdout, stderr, commands, ...harness.artifact() });
    });
  });
}

async function runSetup(args, options = {}, extraEnv = {}) {
  return await withHealthServer(async port => {
    const resolvedOptions = {
      ...options,
      initialUnit: typeof options.initialUnit === 'function' ? options.initialUnit(port) : options.initialUnit,
      dropIns: Object.fromEntries(Object.entries(options.dropIns || {}).map(([name, content]) => [
        name,
        typeof content === 'function' ? content(port) : content,
      ])),
      environmentFiles: Object.fromEntries(Object.entries(options.environmentFiles || {}).map(([path, content]) => [
        path,
        typeof content === 'function' ? content(port) : content,
      ])),
    };
    const harness = makeHarness(resolvedOptions);
    try {
      return await spawnSetup(harness, port, args, extraEnv, { injectPort: options.injectPort !== false });
    } finally {
      harness.cleanup();
    }
  }, options.healthStatus || 200);
}

function existingUnit(lines = []) {
  return `[Unit]\nDescription=Existing FlowBoard\n\n[Service]\n${lines.join('\n')}\n\n[Install]\nWantedBy=default.target\n`;
}

console.log('# setup.mjs Linux systemd configuration');

let generatedFreshUnit = '';

{
  const result = await runSetup(['--force']);
  generatedFreshUnit = result.unit;
  ok(result.code === 0, 'first install exits successfully with fake systemctl');
  assert.deepEqual(result.commands, [
    'npm --version',
    'npm --version',
    'npm install --no-audit --no-fund',
    'npm run build',
    'systemctl --user daemon-reload',
    'systemctl --user enable --now flowboard-dashboard',
    'systemctl --user is-enabled --quiet flowboard-dashboard',
  ]);
  ok(result.unit.includes('Environment="JWT_SECRET='), 'first install generates a JWT secret in the service');
  ok(result.unit.includes('Restart=on-failure'), 'first install keeps the service restartable');
  ok(result.mode === 0o600, 'generated service unit is owner-only');
  ok(!/[a-f0-9]{64}/i.test(result.stdout), 'generated secret is not printed');
}

const preservedUnit = port => existingUnit([
  `Environment="FLOWBOARD_PORT=${port}"`,
  'Environment="JWT_SECRET=test-secret-v1"',
  'Environment="TELEGRAM_BOT_TOKENS=test-bot-a,test-bot-b"',
  'Environment="ALLOWED_USER_IDS=100,200"',
  'Environment="DASHBOARD_ORIGIN=https://flowboard.example.invalid"',
  'Environment="FLOWBOARD_ENABLE_SELF_UPDATE=true"',
  'Environment="CUSTOM_TUNNEL_MODE=enabled"',
  'EnvironmentFile=-%h/.config/flowboard/optional.env',
]);

{
  const result = await runSetup(['--update'], { initialUnit: preservedUnit });
  ok(result.code === 0, 'update exits successfully with an existing standard service');
  assert.deepEqual(result.commands, [
    'npm --version',
    'npm --version',
    'npm install --no-audit --no-fund',
    'npm run build',
    'systemctl --user daemon-reload',
    'systemctl --user enable flowboard-dashboard',
    'systemctl --user restart flowboard-dashboard',
    'systemctl --user is-enabled --quiet flowboard-dashboard',
  ]);
  for (const expected of [
    'JWT_SECRET=test-secret-v1',
    'TELEGRAM_BOT_TOKENS=test-bot-a,test-bot-b',
    'ALLOWED_USER_IDS=100,200',
    'DASHBOARD_ORIGIN=https://flowboard.example.invalid',
    'FLOWBOARD_ENABLE_SELF_UPDATE=true',
    'CUSTOM_TUNNEL_MODE=enabled',
    'EnvironmentFile=-%h/.config/flowboard/optional.env',
  ]) {
    ok(result.unit.includes(expected), `update preserves ${expected.split('=')[0]}`);
  }
  ok(!result.stdout.includes('test-secret-v1'), 'preserved JWT secret is not printed');
  ok(!result.stdout.includes('test-bot-a'), 'preserved bot tokens are not printed');
  ok(result.stdout.includes('remote auth configuration has all required variables'), 'complete remote auth configuration is diagnosed');
}

{
  const escapedUnit = port => existingUnit([
    `Environment="FLOWBOARD_PORT=${port}"`,
    'Environment="OPENCLAW_WORKSPACE=/Users/test\\x20workspace"',
    'Environment="CUSTOM_UTF8_VALUE=\\xC3\\xA9"',
    'Environment="CUSTOM_EMOJI=🦞"',
    'Environment="FLOWBOARD_RULES_TELEMETRY=left\\sright"',
    'Environment="FLOWBOARD_HOOK_TELEMETRY=tab\\tvalue"',
    'Environment="FLOWBOARD_PROJECTS_DIR=/srv/flowboard\\040projects"',
    'Environment="FLOWBOARD_BASE_URL=C:\\\\Users\\\\FlowBoard\\\\bin"',
    'Environment="FLOWBOARD_REPO=/srv/flowboard\\\\s-cache"',
  ]);
  const result = await runSetup(['--update'], { initialUnit: escapedUnit });
  ok(result.code === 0, 'systemd Environment escape sequences round-trip without double-unescaping');
  ok(result.unit.includes('Environment="OPENCLAW_WORKSPACE=/Users/test workspace"'), '\\x20 decodes to one space');
  ok(result.unit.includes('Environment="CUSTOM_UTF8_VALUE=é"'), 'UTF-8 byte escapes decode as one Unicode value');
  ok(result.unit.includes('Environment="CUSTOM_EMOJI=🦞"'), 'raw astral Unicode values round-trip');
  ok(result.unit.includes('Environment="FLOWBOARD_RULES_TELEMETRY=left right"'), '\\s decodes to one space');
  ok(result.unit.includes('Environment="FLOWBOARD_HOOK_TELEMETRY=tab\tvalue"'), '\\t decodes to one tab');
  ok(result.unit.includes('Environment="FLOWBOARD_PROJECTS_DIR=/srv/flowboard projects"'), 'octal \\040 decodes to one space');
  ok(result.unit.includes('Environment="FLOWBOARD_BASE_URL=C:\\\\Users\\\\FlowBoard\\\\bin"'), 'escaped backslashes preserve a Windows-style path');
  ok(result.unit.includes('Environment="FLOWBOARD_REPO=/srv/flowboard\\\\s-cache"'), 'a literal backslash is not decoded a second time');
}

{
  const result = await runSetup(['--update'], {
    initialUnit: port => existingUnit([
      `Environment \t = \t"FLOWBOARD_PORT=9"`,
      'Environment="CUSTOM_CONTINUED=ok" \\',
      '# comments after a continuation are ignored',
      ' "CUSTOM_CONTINUED_TWO=ok"',
      'EnvironmentFile \t = \t%h/.config/flowboard/whitespace.env',
      'UnsetEnvironment \t = \t"FLOWBOARD_PORT=9"',
    ]),
    environmentFiles: {
      '.config/flowboard/whitespace.env': port => `FLOWBOARD_PORT=${port}\n`,
    },
    injectPort: false,
  });
  ok(result.code === 0, 'systemd directives accept whitespace around equals');
  ok(result.unit.includes('EnvironmentFile=%h/.config/flowboard/whitespace.env'), 'whitespace-normalized EnvironmentFile survives');
  ok(result.unit.includes('UnsetEnvironment="FLOWBOARD_PORT=9"'), 'whitespace-normalized UnsetEnvironment survives');
  ok(result.unit.includes('Environment="CUSTOM_CONTINUED_TWO=ok"'), 'systemd continuation skips intervening comments');
}

{
  const result = await runSetup(['--force'], { initialUnit: preservedUnit });
  ok(result.code === 0, 'forced re-registration succeeds with an existing service');
  ok(result.unit.includes('JWT_SECRET=test-secret-v1'), 'forced re-registration preserves the existing JWT secret');
  ok(result.unit.includes('CUSTOM_TUNNEL_MODE=enabled'), 'forced re-registration preserves custom variables');
  ok(result.commands.includes('systemctl --user enable flowboard-dashboard'), 'forced re-registration keeps systemd autostart enabled');
  ok(result.commands.includes('systemctl --user restart flowboard-dashboard'), '--force restarts an already-running Linux service');
  ok(!result.commands.includes('systemctl --user enable --now flowboard-dashboard'), '--force does not mistake enable --now for a restart');
}

{
  const result = await runSetup(['--update'], { initialUnit: preservedUnit }, {
    DASHBOARD_ORIGIN: 'https://implicit-shell.example.invalid',
    JWT_SECRET: 'implicit-shell-jwt-must-not-win',
  });
  ok(result.code === 0, 'update with conflicting shell configuration still succeeds safely');
  ok(result.unit.includes('DASHBOARD_ORIGIN=https://flowboard.example.invalid'), 'persistent allowlist configuration wins over implicit shell input');
  ok(!result.unit.includes('implicit-shell.example.invalid'), 'implicit shell value is not persisted');
  ok(result.unit.includes('JWT_SECRET=test-secret-v1') && !result.unit.includes('implicit-shell-jwt-must-not-win'), 'JWT replacement requires explicit rotation');
}

{
  const result = await runSetup(['--update', '--override-env=DASHBOARD_ORIGIN'], { initialUnit: preservedUnit }, {
    DASHBOARD_ORIGIN: 'https://explicit-shell.example.invalid',
  });
  ok(result.code === 0, 'named Linux service environment override succeeds');
  ok(result.unit.includes('DASHBOARD_ORIGIN=https://explicit-shell.example.invalid'), '--override-env persists only the named operator value');
  ok(result.unit.includes('JWT_SECRET=test-secret-v1'), 'explicit non-secret override preserves JWT_SECRET');
}

{
  const result = await runSetup(['--update', '--override-env=JWT_SECRET'], { initialUnit: preservedUnit }, {
    JWT_SECRET: 'forbidden-explicit-jwt',
  });
  ok(result.code === 1, 'JWT_SECRET is rejected by generic environment override');
  ok(result.stdout.includes('use --rotate-secret'), 'JWT override error names the dedicated rotation operation');
  ok(result.commands.length === 0, 'invalid JWT override fails before build or service commands');
  ok(!result.stdout.includes('forbidden-explicit-jwt'), 'rejected JWT override value is not printed');
}

{
  const result = await withHealthServer(async port => {
    const harness = makeHarness({ initialUnit: preservedUnit(port) });
    try {
      const first = await spawnSetup(harness, port, ['--update']);
      const second = await spawnSetup(harness, port, ['--update']);
      return { first, second };
    } finally {
      harness.cleanup();
    }
  });
  ok(result.first.code === 0 && result.second.code === 0, 'two consecutive updates both succeed');
  ok(result.second.unit.includes('JWT_SECRET=test-secret-v1'), 'second update preserves the original JWT secret');
  ok(result.second.unit.includes('CUSTOM_TUNNEL_MODE=enabled'), 'second update preserves custom service variables');
}

{
  const rotationUnit = port => existingUnit([
    `Environment="FLOWBOARD_PORT=${port}"`,
    'Environment="JWT_SECRET=test-secret-v1"',
    'Environment="CUSTOM_TUNNEL_MODE=enabled"',
  ]);
  const result = await runSetup(['--rotate-secret'], { initialUnit: rotationUnit });
  ok(result.code === 0, 'standalone explicit secret rotation succeeds');
  ok(!result.unit.includes('JWT_SECRET=test-secret-v1'), '--rotate-secret replaces the prior JWT secret');
  ok(/Environment="JWT_SECRET=[a-f0-9]{64}"/i.test(result.unit), 'rotation writes a new generated JWT secret');
  ok(!/[a-f0-9]{64}/i.test(result.stdout), 'rotated secret is not printed');
  ok(result.commands.includes('systemctl --user restart flowboard-dashboard'), '--rotate-secret restarts the service to activate the new secret');
}

{
  const result = await runSetup(['--update', '--rotate-secret'], {
    initialUnit: port => existingUnit([
      `Environment="FLOWBOARD_PORT=${port}"`,
      'EnvironmentFile=%h/.config/flowboard/secret.env',
    ]),
    environmentFiles: {
      '.config/flowboard/secret.env': 'JWT_SECRET=test-environment-file-secret\n',
    },
    injectPort: false,
  });
  ok(result.code === 1, 'rotation refuses to override an external EnvironmentFile source');
  ok(result.stdout.includes('Rotate it in that owner-only source'), 'rotation error points to the owning secret source');
  ok(result.commands.length === 0, 'unsafe external-source rotation fails before build/service commands');
  ok(!result.stdout.includes('test-environment-file-secret'), 'rotation refusal does not print the existing secret');
}

{
  const result = await runSetup(['--update'], {
    initialUnit: existingUnit([
      'Environment="FLOWBOARD_PORT=9"',
      'Environment="DASHBOARD_ORIGIN=https://inline.example.invalid"',
      'EnvironmentFile=%h/.config/flowboard/first.env',
      'EnvironmentFile=-%h/.config/flowboard/second.env',
    ]),
    environmentFiles: {
      '.config/flowboard/first.env': 'FLOWBOARD_PORT=8\nJWT_SECRET=test-first-file-secret\nDASHBOARD_ORIGIN=https://first.example.invalid\n',
      '.config/flowboard/second.env': port => `FLOWBOARD_PORT=${port}\nJWT_SECRET=test-second-file-secret\nTELEGRAM_BOT_TOKEN=test-file-bot\nALLOWED_USER_IDS=400\nDASHBOARD_ORIGIN=https://second.example.invalid\n`,
    },
    injectPort: false,
  });
  ok(result.code === 0, 'EnvironmentFile-only port update succeeds without injected FLOWBOARD_PORT');
  const firstIndex = result.unit.indexOf('EnvironmentFile=%h/.config/flowboard/first.env');
  const secondIndex = result.unit.indexOf('EnvironmentFile=-%h/.config/flowboard/second.env');
  ok(firstIndex >= 0 && secondIndex > firstIndex, 'EnvironmentFile order is preserved in the generated unit');
  ok(result.unit.includes('Environment="FLOWBOARD_PORT=9"'), 'inline port remains intact while EnvironmentFile keeps runtime precedence');
  ok(!result.unit.includes('test-first-file-secret') && !result.unit.includes('test-second-file-secret'), 'EnvironmentFile secrets remain in their owner-only files');
  ok(!result.stdout.includes('test-first-file-secret') && !result.stdout.includes('test-second-file-secret') && !result.stdout.includes('test-file-bot'), 'EnvironmentFile values are never printed');
  ok(result.stdout.includes('remote auth configuration has all required variables'), 'later EnvironmentFile values drive effective diagnostics');
}

{
  const dropIn = `[Service]\nEnvironment="JWT_SECRET=test-dropin-secret"\nEnvironment="TELEGRAM_BOT_TOKEN=test-dropin-bot"\nEnvironment="ALLOWED_USER_IDS=300"\nEnvironment="DASHBOARD_ORIGIN=https://dropin.example.invalid"\nEnvironment="CUSTOM_DROPIN_MODE=enabled"\n`;
  const result = await runSetup(['--update'], {
    initialUnit: port => existingUnit([`Environment="FLOWBOARD_PORT=${port}"`]),
    dropIns: { 'auth.conf': dropIn },
  });
  ok(result.code === 0, 'update preserves systemd drop-in configuration');
  ok(!result.unit.includes('test-dropin-secret'), 'drop-in JWT stays in its source instead of becoming sticky in the main unit');
  ok(!result.unit.includes('test-dropin-bot'), 'drop-in bot token is not copied into the main unit');
  ok(!result.unit.includes('CUSTOM_DROPIN_MODE'), 'custom drop-in variables are not copied into the main unit');
  ok(result.stdout.includes('remote auth configuration has all required variables'), 'drop-in variables participate in safe remote diagnostics');
  ok(!result.stdout.includes('test-dropin-secret') && !result.stdout.includes('test-dropin-bot'), 'drop-in secret values are not printed');
}

{
  const result = await runSetup(['--dry-run', '--update'], {
    initialUnit: existingUnit([
      'Environment="FLOWBOARD_PORT=9"',
      'Environment="JWT_SECRET=test-unset-secret"',
      'UnsetEnvironment=FLOWBOARD_PORT JWT_SECRET',
    ]),
    injectPort: false,
  });
  ok(result.code === 0, 'UnsetEnvironment names are accepted during a dry-run update');
  ok(result.stdout.includes('would poll http://127.0.0.1:18790/api/health'), 'UnsetEnvironment removes FLOWBOARD_PORT from effective health-check configuration');
  ok(result.stdout.includes('JWT_SECRET: not active in the existing systemd service; left unset'), 'UnsetEnvironment removes JWT_SECRET from effective rotation diagnostics');
}

{
  const result = await runSetup(['--rotate-secret'], {
    initialUnit: port => existingUnit([
      `Environment="FLOWBOARD_PORT=${port}"`,
      'Environment="JWT_SECRET=test-unset-secret"',
      'UnsetEnvironment=JWT_SECRET',
    ]),
  });
  ok(result.code === 1, 'rotation fails safe when an unconditional UnsetEnvironment removes JWT_SECRET');
  ok(result.stdout.includes('JWT_SECRET is removed by systemd UnsetEnvironment'), 'rotation failure identifies the effective systemd owner');
  ok(result.commands.length === 0, 'ineffective JWT rotation aborts before build or service commands');
  ok(!result.stdout.includes('test-unset-secret'), 'UnsetEnvironment rotation refusal does not print the old secret');
}

{
  const result = await runSetup(['--rotate-secret'], {
    initialUnit: port => existingUnit([
      `Environment="FLOWBOARD_PORT=${port}"`,
      'Environment="JWT_SECRET=test-exact-rotation-secret"',
      'UnsetEnvironment="JWT_SECRET=test-exact-rotation-secret"',
    ]),
  });
  ok(result.code === 0, 'rotation succeeds when exact-assignment UnsetEnvironment matches only the old JWT value');
  ok(!result.unit.split('\n').includes('Environment="JWT_SECRET=test-exact-rotation-secret"'), 'exact-assignment rotation removes the old inline JWT value');
  ok(/Environment="JWT_SECRET=[a-f0-9]{64}"/i.test(result.unit), 'exact-assignment rotation installs a new active JWT value');
  ok(result.unit.includes('UnsetEnvironment="JWT_SECRET=test-exact-rotation-secret"'), 'exact-assignment JWT removal remains narrow after rotation');
}

{
  const result = await runSetup(['--update'], {
    initialUnit: port => existingUnit([
      `Environment="FLOWBOARD_PORT=${port}"`,
      'Environment="JWT_SECRET=test-reset-secret"',
      'Environment="TELEGRAM_BOT_TOKEN=test-reset-bot"',
      'Environment="ALLOWED_USER_IDS=500"',
      'Environment="DASHBOARD_ORIGIN=https://reset.example.invalid"',
      'UnsetEnvironment=FLOWBOARD_PORT JWT_SECRET',
    ]),
    dropIns: {
      'reset.conf': '[Service]\nUnsetEnvironment=\n',
    },
  });
  ok(result.code === 0, 'an empty later UnsetEnvironment resets earlier removals');
  ok(result.unit.includes('UnsetEnvironment=FLOWBOARD_PORT JWT_SECRET'), 'main-unit UnsetEnvironment directives survive normalized rewrites');
  ok(result.stdout.includes('remote auth configuration has all required variables'), 'reset UnsetEnvironment state participates in effective remote diagnostics');
}

{
  const result = await runSetup(['--update'], {
    initialUnit: existingUnit([
      'Environment="FLOWBOARD_PORT=9"',
      'Environment="JWT_SECRET=test-exact-unset-secret"',
      'EnvironmentFile=%h/.config/flowboard/runtime.env',
      'UnsetEnvironment="FLOWBOARD_PORT=9"',
    ]),
    environmentFiles: {
      '.config/flowboard/runtime.env': port => `FLOWBOARD_PORT=${port}\n`,
    },
    injectPort: false,
  });
  ok(result.code === 0, 'exact-assignment UnsetEnvironment does not remove a later different EnvironmentFile value');
  ok(result.unit.includes('UnsetEnvironment="FLOWBOARD_PORT=9"'), 'exact-assignment UnsetEnvironment is preserved without semantic broadening');
}

{
  const result = await runSetup(['--update'], {
    initialUnit: existingUnit([
      'EnvironmentFile=%h/.config/flowboard/escaped.env',
    ]),
    environmentFiles: {
      '.config/flowboard/escaped.env': port => [
        `FLOWBOARD_PORT=${port}`,
        'OPENCLAW_WORKSPACE="/Users/file\\x20workspace"',
        "FLOWBOARD_BASE_URL='C:\\\\Users\\\\FlowBoard'",
        'FLOWBOARD_REPO=C:\\\\srv\\\\flowboard\\\\cache',
        'FLOWBOARD_RULES_TELEMETRY=left\\ right',
        '',
      ].join('\n'),
    },
    injectPort: false,
  });
  ok(result.code === 0, 'EnvironmentFile POSIX-style quoting resolves the health-check port before mutation');
  ok(result.unit.includes('EnvironmentFile=%h/.config/flowboard/escaped.env'), 'escaped EnvironmentFile source remains owner-controlled');
}

for (const invalidSpecifier of ['%1', '%x', '%/', '%']) {
  const result = await runSetup(['--update'], {
    initialUnit: port => existingUnit([
      `Environment="FLOWBOARD_PORT=${port}"`,
      `EnvironmentFile=${invalidSpecifier}/flowboard.env`,
    ]),
  });
  ok(result.code === 1, `invalid EnvironmentFile specifier ${JSON.stringify(invalidSpecifier)} fails safe`);
  ok(result.stdout.includes('unsupported or incomplete systemd specifier'), `invalid specifier ${JSON.stringify(invalidSpecifier)} is diagnosed explicitly`);
  ok(result.commands.length === 0, `invalid specifier ${JSON.stringify(invalidSpecifier)} aborts before build/service commands`);
}

{
  const result = await runSetup(['--update'], {
    initialUnit: port => existingUnit([
      `Environment="FLOWBOARD_PORT=${port}"`,
      'Environment="CUSTOM_INVALID_SPECIFIER=%1"',
    ]),
  });
  ok(result.code === 1, 'invalid specifiers in Environment values also fail safe');
  ok(result.stdout.includes('unsupported or incomplete systemd specifier'), 'Environment-value specifier failure is diagnosed explicitly');
  ok(result.commands.length === 0, 'invalid Environment-value specifier aborts before build/service commands');
}

{
  const result = await runSetup(['--update'], {
    initialUnit: port => existingUnit([
      `Environment="FLOWBOARD_PORT=${port}"`,
      'Environment="%1=invalid-key"',
    ]),
  });
  ok(result.code === 1, 'invalid specifiers in Environment assignment keys fail safe');
  ok(result.stdout.includes('unsupported or incomplete systemd specifier'), 'Environment-key specifier failure is diagnosed explicitly');
  ok(result.commands.length === 0, 'invalid Environment-key specifier aborts before build/service commands');
}

for (const [label, assignment] of [
  ['an unclosed quote', 'Environment="OPENCLAW_WORKSPACE=/tmp/unclosed'],
  ['an unknown escape', 'Environment="OPENCLAW_WORKSPACE=/tmp/bad\\q"'],
  ['a short hexadecimal escape', 'Environment="OPENCLAW_WORKSPACE=/tmp/bad\\x2"'],
  ['an invalid UTF-8 byte escape', 'Environment="OPENCLAW_WORKSPACE=/tmp/bad\\xFF"'],
  ['an invalid octal escape', 'Environment="OPENCLAW_WORKSPACE=/tmp/bad\\09"'],
  ['a space escape', 'Environment="OPENCLAW_WORKSPACE=/tmp/bad\\ "'],
  ['a short octal escape', 'Environment="OPENCLAW_WORKSPACE=/tmp/bad\\07"'],
  ['a Unicode surrogate escape', 'Environment="OPENCLAW_WORKSPACE=/tmp/bad\\uD800"'],
  ['a Unicode noncharacter escape', 'Environment="OPENCLAW_WORKSPACE=/tmp/bad\\U0000FDD0"'],
]) {
  const result = await runSetup(['--update'], {
    initialUnit: port => existingUnit([
      `Environment="FLOWBOARD_PORT=${port}"`,
      assignment,
    ]),
  });
  ok(result.code === 1, `${label} fails closed`);
  ok(result.commands.length === 0, `${label} is rejected before build or service commands`);
}

{
  const result = await runSetup(['--update'], {
    initialUnit: existingUnit(['EnvironmentFile=%h/.config/flowboard/invalid.env']),
    environmentFiles: {
      '.config/flowboard/invalid.env': 'FLOWBOARD_PORT=18790\nOPENCLAW_WORKSPACE="/tmp/literal\\x20value"\n',
    },
    injectPort: false,
  });
  ok(result.code === 0, 'EnvironmentFile keeps non-POSIX C escapes literal instead of applying unit decoding');
  ok(result.commands.length > 0, 'valid EnvironmentFile content proceeds to service registration');
}

{
  const result = await runSetup(['--update'], {
    initialUnit: existingUnit(['EnvironmentFile=%h/.config/flowboard/invalid.env']),
    environmentFiles: {
      '.config/flowboard/invalid.env': Buffer.from('FLOWBOARD_PORT=18790\nBAD=\0\n', 'utf8'),
    },
    injectPort: false,
  });
  ok(result.code === 1, 'invalid EnvironmentFile Unicode content fails closed');
  ok(result.stdout.includes('could not read EnvironmentFile'), 'invalid EnvironmentFile diagnostics identify the source without its value');
  ok(result.commands.length === 0, 'invalid EnvironmentFile content is rejected before build or service commands');
}

{
  const result = await runSetup(['--update'], {
    initialUnit: existingUnit(['EnvironmentFile=%h/.config/flowboard/invalid.env']),
    environmentFiles: {
      '.config/flowboard/invalid.env': 'FLOWBOARD_PORT=18790\n# interior BOM: \uFEFF\n',
    },
    injectPort: false,
  });
  ok(result.code === 1, 'EnvironmentFile Unicode BOM content fails closed even outside the byte-order-mark prefix');
  ok(result.commands.length === 0, 'invalid EnvironmentFile BOM content is rejected before build or service commands');
}

{
  const result = await runSetup(['--update'], {
    initialUnit: port => existingUnit([
      `Environment="FLOWBOARD_PORT=${port}"`,
      'Environment="JWT_SECRET=test-analyzer-secret"',
      'Environment="CUSTOM_SHORT_SECRET=abc"',
    ]),
  }, {
    FAKE_SYSTEMD_ANALYZE_STDERR: 'systemd-analyze: warning: malformed generated unit abc',
  });
  ok(result.code === 1, 'systemd-analyze diagnostics fail setup even with a zero exit status');
  ok(result.stdout.includes('malformed generated unit'), 'systemd-analyze diagnostic is surfaced');
  ok(!result.stdout.includes('test-analyzer-secret'), 'systemd-analyze diagnostics never expose service secrets');
  ok(!result.stdout.includes('abc'), 'short custom service values are also redacted from diagnostics');
  ok(!result.commands.some(line => line.startsWith('systemctl ')), 'systemd-analyze diagnostics abort before daemon reload or service restart');
}

{
  const result = await withHealthServer(async port => {
    const harness = makeHarness({ initialUnit: preservedUnit(port) });
    try {
      const first = await spawnSetup(harness, port, ['--update', '--override-env=DASHBOARD_ORIGIN'], {
        DASHBOARD_ORIGIN: 'https://percent.example.invalid/100%25?label=50%',
      });
      const second = await spawnSetup(harness, port, ['--update']);
      return { first, second };
    } finally {
      harness.cleanup();
    }
  });
  const escapedValue = 'DASHBOARD_ORIGIN=https://percent.example.invalid/100%%25?label=50%%';
  ok(result.first.code === 0 && result.second.code === 0, 'percent-bearing Environment value survives two updates');
  ok(result.first.unit.includes(escapedValue), 'literal percent signs are doubled when writing Environment values');
  ok(result.second.unit.includes(escapedValue) && !result.second.unit.includes('100%%%%25'), 'percent escaping round-trips without double-escaping');
}

{
  const result = await runSetup(['--update'], {
    initialUnit: preservedUnit,
    healthStatus: 503,
  }, {
    FLOWBOARD_SETUP_TEST_HEALTH_ATTEMPTS: '1',
  });
  ok(result.code === 1, 'Linux health-check failure is surfaced');
  ok(result.stdout.includes('journalctl --user -u flowboard-dashboard.service'), 'Linux failure points to the systemd unit journal');
  ok(!result.stdout.includes('ai.openclaw.flowboard-dashboard') && !result.stdout.includes('/tmp/flowboard-dashboard.log'), 'Linux failure does not mention launchd or the obsolete macOS log');
}

{
  const result = await runSetup(['--update']);
  ok(result.code === 1, '--update refuses to act when the standard service does not exist');
  ok(result.stdout.includes('--update requires an existing standard systemd service'), 'missing-service error explains first install versus update');
  ok(result.commands.length === 0, 'missing-service update fails before build or service commands');
}

{
  const partialUnit = port => existingUnit([
    `Environment="FLOWBOARD_PORT=${port}"`,
    'Environment="JWT_SECRET=test-secret-v1"',
    'Environment="TELEGRAM_BOT_TOKEN=test-bot-only"',
  ]);
  const result = await runSetup(['--update'], { initialUnit: partialUnit });
  ok(result.code === 0, 'update with partial remote configuration still completes');
  ok(result.stdout.includes('remote access configuration is incomplete'), 'partial remote configuration emits a clear warning');
  ok(result.stdout.includes('ALLOWED_USER_IDS') && result.stdout.includes('DASHBOARD_ORIGIN'), 'warning names missing remote settings without values');
  ok(!result.stdout.includes('test-bot-only'), 'partial bot token is not printed');
}

{
  const result = await runSetup(['--update'], { initialUnit: preservedUnit }, {
    FAKE_SYSTEMCTL_RESTART_STATUS: '1',
    FAKE_SYSTEMCTL_IS_ACTIVE_STATUS: '3',
  });
  ok(result.code === 0, 'update falls back to start when restart fails and unit is inactive');
  assert.deepEqual(result.commands.slice(-5), [
    'systemctl --user enable flowboard-dashboard',
    'systemctl --user restart flowboard-dashboard',
    'systemctl --user is-active --quiet flowboard-dashboard',
    'systemctl --user start flowboard-dashboard',
    'systemctl --user is-enabled --quiet flowboard-dashboard',
  ]);
  ok(result.stdout.includes('restart failed; unit is inactive'), 'fallback emits a warning');
}

{
  const result = await runSetup(['--dry-run', '--update'], { initialUnit: preservedUnit });
  ok(result.code === 0, 'dry-run update exits successfully');
  ok(!result.commands.some(line => line.startsWith('systemctl ')), 'dry-run does not execute systemctl');
  ok(result.stdout.includes('systemctl --user enable flowboard-dashboard'), 'dry-run prints enable without --now');
  ok(result.stdout.includes('systemctl --user restart flowboard-dashboard'), 'dry-run prints restart');
  ok(result.stdout.includes('systemctl --user is-enabled --quiet flowboard-dashboard'), 'dry-run prints autostart verification');
}

{
  const analyzeVersion = spawnSync('systemd-analyze', ['--version'], { stdio: 'ignore' });
  if (analyzeVersion.status === 0) {
    const verifyDir = mkdtempSync(join(tmpdir(), 'fb-systemd-verify-'));
    const verifyPath = join(verifyDir, UNIT_NAME);
    try {
      writeFileSync(verifyPath, generatedFreshUnit, { mode: 0o600 });
      const verified = spawnSync('systemd-analyze', ['--user', 'verify', verifyPath], { encoding: 'utf8' });
      if (verified.status !== 0) process.stderr.write(verified.stderr || verified.stdout || 'systemd-analyze verify failed\n');
      ok(verified.status === 0, 'generated unit passes systemd-analyze --user verify');
    } finally {
      rmSync(verifyDir, { recursive: true, force: true });
    }
  } else {
    console.log('  # systemd-analyze unavailable; static verify skipped');
  }
}

console.log(`\n# results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log('# failures:');
  failures.forEach(f => console.log(`#   - ${f}`));
  process.exitCode = 1;
}
