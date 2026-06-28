#!/usr/bin/env node
// Regression coverage for scripts/setup.mjs Linux systemd service commands.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DASH = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(DASH);

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

function makeHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'fb-setup-systemd-'));
  const bin = join(dir, 'bin');
  const home = join(dir, 'home');
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });

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
process.exit(0);
`), { mode: 0o755 });

  return {
    dir,
    home,
    commandLog,
    env: {
      ...process.env,
      HOME: home,
      NODE_ENV: 'test',
      FLOWBOARD_SETUP_TEST_PLATFORM: 'linux',
      FAKE_COMMAND_LOG: commandLog,
      PATH: [bin, process.env.PATH].filter(Boolean).join(delimiter),
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

async function runSetup(args, extraEnv = {}) {
  return await withHealthServer(port => new Promise((resolve, reject) => {
    const harness = makeHarness();
    const child = spawn(process.execPath, [join(ROOT, 'scripts', 'setup.mjs'), ...args], {
      cwd: ROOT,
      env: {
        ...harness.env,
        ...extraEnv,
        FLOWBOARD_PORT: String(port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', err => {
      harness.cleanup();
      reject(err);
    });
    child.on('close', code => {
      const commands = readLines(harness.commandLog);
      harness.cleanup();
      resolve({ code, stdout, stderr, commands });
    });
  }));
}

console.log('# setup.mjs Linux systemd commands');

{
  const result = await runSetup(['--force']);
  ok(result.code === 0, 'non-update setup exits successfully with fake systemctl');
  assert.deepEqual(result.commands, [
    'npm --version',
    'npm --version',
    'npm install --no-audit --no-fund',
    'npm run build',
    'systemctl --user daemon-reload',
    'systemctl --user enable --now flowboard-dashboard',
  ]);
  ok(true, 'non-update executes daemon-reload then enable --now');
}

{
  const result = await runSetup(['--update']);
  ok(result.code === 0, 'update setup exits successfully with fake systemctl');
  assert.deepEqual(result.commands, [
    'npm --version',
    'npm --version',
    'npm install --no-audit --no-fund',
    'npm run build',
    'systemctl --user daemon-reload',
    'systemctl --user enable flowboard-dashboard',
    'systemctl --user restart flowboard-dashboard',
  ]);
  ok(true, 'update executes daemon-reload, enable without --now, then restart');
}

{
  const result = await runSetup(['--update'], {
    FAKE_SYSTEMCTL_RESTART_STATUS: '1',
    FAKE_SYSTEMCTL_IS_ACTIVE_STATUS: '3',
  });
  ok(result.code === 0, 'update falls back to start when restart fails and unit is inactive');
  assert.deepEqual(result.commands, [
    'npm --version',
    'npm --version',
    'npm install --no-audit --no-fund',
    'npm run build',
    'systemctl --user daemon-reload',
    'systemctl --user enable flowboard-dashboard',
    'systemctl --user restart flowboard-dashboard',
    'systemctl --user is-active --quiet flowboard-dashboard',
    'systemctl --user start flowboard-dashboard',
  ]);
  ok(result.stdout.includes('restart failed; unit is inactive'), 'fallback emits a warning');
}

{
  const result = await runSetup(['--dry-run', '--update']);
  ok(result.code === 0, 'dry-run update exits successfully');
  ok(!result.commands.some(line => line.startsWith('systemctl ')), 'dry-run does not execute systemctl');
  ok(result.stdout.includes('systemctl --user enable flowboard-dashboard'), 'dry-run prints enable without --now');
  ok(result.stdout.includes('systemctl --user restart flowboard-dashboard'), 'dry-run prints restart');
}

console.log(`\n# results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log('# failures:');
  failures.forEach(f => console.log(`#   - ${f}`));
  process.exitCode = 1;
}
