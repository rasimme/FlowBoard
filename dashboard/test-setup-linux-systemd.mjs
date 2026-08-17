#!/usr/bin/env node
// Regression coverage for scripts/setup.mjs Linux service configuration.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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

async function withHealthServer(fn) {
  const server = createServer((req, res) => {
    if (req.url === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
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
  });
}

function existingUnit(lines = []) {
  return `[Unit]\nDescription=Existing FlowBoard\n\n[Service]\n${lines.join('\n')}\n\n[Install]\nWantedBy=default.target\n`;
}

console.log('# setup.mjs Linux systemd configuration');

{
  const result = await runSetup(['--force']);
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

console.log(`\n# results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log('# failures:');
  failures.forEach(f => console.log(`#   - ${f}`));
  process.exitCode = 1;
}
