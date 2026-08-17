#!/usr/bin/env node
// Regression coverage for scripts/setup.mjs macOS launchd configuration.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import {
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
const LABEL = 'ai.openclaw.flowboard-dashboard';

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

function makeHarness(initialPlist) {
  const dir = mkdtempSync(join(tmpdir(), 'fb-setup-launchd-'));
  const bin = join(dir, 'bin');
  const home = join(dir, 'home');
  const plistDir = join(home, 'Library', 'LaunchAgents');
  const plistPath = join(plistDir, `${LABEL}.plist`);
  mkdirSync(bin, { recursive: true });
  mkdirSync(plistDir, { recursive: true });
  writeFileSync(plistPath, initialPlist, { mode: 0o644 });

  const commandLog = join(dir, 'commands.log');
  for (const command of ['npm', 'launchctl']) {
    const body = command === 'npm'
      ? `if (process.argv[2] === '--version') console.log('10.0.0');`
      : `if (process.argv[2] === 'print') {
  if (process.env.FAKE_LAUNCHCTL_PRINT_STDOUT) process.stdout.write(process.env.FAKE_LAUNCHCTL_PRINT_STDOUT);
  if (process.env.FAKE_LAUNCHCTL_PRINT_STDERR) process.stderr.write(process.env.FAKE_LAUNCHCTL_PRINT_STDERR);
  if (process.env.FAKE_LAUNCHCTL_PRINT_STATUS) process.exit(Number(process.env.FAKE_LAUNCHCTL_PRINT_STATUS));
}`;
    writeFileSync(join(bin, command), `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
appendFileSync(process.env.FAKE_COMMAND_LOG, '${command} ' + process.argv.slice(2).join(' ') + '\\n');
${body}
process.exit(0);
`, { mode: 0o755 });
  }

  const safeEnv = {};
  for (const key of ['LANG', 'LC_ALL', 'TMPDIR']) {
    if (process.env[key]) safeEnv[key] = process.env[key];
  }

  return {
    home,
    plistPath,
    commandLog,
    env: {
      ...safeEnv,
      HOME: home,
      NODE_ENV: 'test',
      FLOWBOARD_SETUP_TEST_PLATFORM: 'darwin',
      FAKE_COMMAND_LOG: commandLog,
      PATH: [bin, process.env.PATH].filter(Boolean).join(delimiter),
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function runSetup(args, initialPlist, extraEnv = {}) {
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
  const harness = makeHarness(initialPlist.replaceAll('__FLOWBOARD_PORT__', String(port)));

  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [join(ROOT, 'scripts', 'setup.mjs'), ...args], {
        cwd: ROOT,
        env: {
          ...harness.env,
          ...extraEnv,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', data => { stdout += data; });
      child.stderr.on('data', data => { stderr += data; });
      child.on('error', reject);
      child.on('close', code => resolve({
        code,
        stdout,
        stderr,
        commands: readLines(harness.commandLog),
        plist: readFileSync(harness.plistPath, 'utf8'),
        mode: statSync(harness.plistPath).mode & 0o777,
      }));
    });
  } finally {
    harness.cleanup();
    await new Promise(resolve => server.close(resolve));
  }
}

const existingPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>EnvironmentVariables</key><dict>
    <key>JWT_SECRET</key><string>test-launchd-secret</string>
    <key>TELEGRAM_BOT_TOKEN</key><string>test-launchd-bot</string>
    <key>ALLOWED_USER_IDS</key><string>100</string>
    <key>DASHBOARD_ORIGIN</key><string>https://flowboard.example.invalid</string>
    <key>FLOWBOARD_ENABLE_SELF_UPDATE</key><string>true</string>
    <key>FLOWBOARD_PORT</key><string>__FLOWBOARD_PORT__</string>
    <key>CUSTOM_PROXY_LABEL</key><string>blue &amp; green</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
`;

console.log('# setup.mjs macOS launchd configuration');

{
  const launchctlStdoutSecret = 'adversarial-launchctl-stdout-secret';
  const launchctlStderrSecret = 'adversarial-launchctl-stderr-secret';
  const result = await runSetup(['--update'], existingPlist, {
    DASHBOARD_ORIGIN: 'https://shell-override.example.invalid',
    JWT_SECRET: 'test-shell-secret-must-not-win',
    FAKE_LAUNCHCTL_PRINT_STDOUT: launchctlStdoutSecret,
    FAKE_LAUNCHCTL_PRINT_STDERR: launchctlStderrSecret,
  });
  ok(result.code === 0, 'launchd update exits successfully');
  assert.deepEqual(result.commands.map(line => line.replace(/gui\/\d+/g, 'gui/UID')), [
    'npm --version',
    'npm --version',
    'npm install --no-audit --no-fund',
    'npm run build',
    `launchctl bootout gui/UID/${LABEL}`,
    `launchctl bootstrap gui/UID ${result.commands[5]?.split(' ').slice(-1)[0]}`,
    `launchctl print gui/UID/${LABEL}`,
  ]);
  for (const expected of [
    '<key>JWT_SECRET</key><string>test-launchd-secret</string>',
    '<key>TELEGRAM_BOT_TOKEN</key><string>test-launchd-bot</string>',
    '<key>ALLOWED_USER_IDS</key><string>100</string>',
    '<key>DASHBOARD_ORIGIN</key><string>https://flowboard.example.invalid</string>',
    '<key>FLOWBOARD_ENABLE_SELF_UPDATE</key><string>true</string>',
    '<key>CUSTOM_PROXY_LABEL</key><string>blue &amp; green</string>',
  ]) {
    ok(result.plist.includes(expected), `launchd update preserves ${expected.match(/<key>(.*?)<\/key>/)?.[1]}`);
  }
  ok(result.plist.includes('<key>RunAtLoad</key><true/>'), 'launchd service remains RunAtLoad');
  ok(result.plist.includes('<key>KeepAlive</key><true/>'), 'launchd service remains KeepAlive');
  ok(result.mode === 0o600, 'launchd plist is tightened to owner-only permissions');
  ok(!result.stdout.includes('test-launchd-secret'), 'launchd JWT secret is not printed');
  ok(!result.stdout.includes('test-launchd-bot'), 'launchd bot token is not printed');
  ok(!result.plist.includes('shell-override.example.invalid'), 'update ignores an implicit shell override of persistent config');
  ok(!result.plist.includes('test-shell-secret-must-not-win'), 'update ignores an implicit shell JWT replacement');
  ok(!result.stdout.includes(launchctlStdoutSecret) && !result.stderr.includes(launchctlStdoutSecret), 'launchctl print stdout is never relayed');
  ok(!result.stdout.includes(launchctlStderrSecret) && !result.stderr.includes(launchctlStderrSecret), 'launchctl print stderr is never relayed');
  ok(result.stdout.includes('remote auth configuration has all required variables'), 'launchd remote configuration is diagnosed');
}

{
  const result = await runSetup(['--update', '--override-env=DASHBOARD_ORIGIN'], existingPlist, {
    DASHBOARD_ORIGIN: 'https://explicit-override.example.invalid',
  });
  ok(result.code === 0, 'explicit launchd environment override succeeds');
  ok(result.plist.includes('<key>DASHBOARD_ORIGIN</key><string>https://explicit-override.example.invalid</string>'), 'named --override-env change is persisted');
  ok(result.stdout.includes('explicit service environment override requested for: DASHBOARD_ORIGIN'), 'explicit override is reported by key without its value');
}

{
  const leakedStdout = 'failed-launchctl-stdout-secret';
  const leakedStderr = 'failed-launchctl-stderr-secret';
  const result = await runSetup(['--update'], existingPlist, {
    FAKE_LAUNCHCTL_PRINT_STDOUT: leakedStdout,
    FAKE_LAUNCHCTL_PRINT_STDERR: leakedStderr,
    FAKE_LAUNCHCTL_PRINT_STATUS: '1',
  });
  ok(result.code === 1, 'launchctl print failure aborts setup');
  ok(!result.stdout.includes(leakedStdout) && !result.stderr.includes(leakedStdout), 'failed launchctl print stdout remains suppressed');
  ok(!result.stdout.includes(leakedStderr) && !result.stderr.includes(leakedStderr), 'failed launchctl print stderr remains suppressed');
}

{
  const result = await runSetup(['--dry-run', '--update'], existingPlist);
  ok(result.code === 0, 'launchd dry-run update exits successfully');
  ok(!result.commands.some(line => line.startsWith('launchctl ')), 'launchd dry-run executes no launchctl commands');
  ok(result.stdout.includes('launchctl bootstrap'), 'launchd dry-run shows service bootstrap');
  ok(result.stdout.includes('launchctl print'), 'launchd dry-run shows loaded-service verification');
  ok(!result.stdout.includes('test-launchd-secret'), 'launchd dry-run never prints preserved secrets');
}

console.log(`\n# results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log('# failures:');
  failures.forEach(f => console.log(`#   - ${f}`));
  process.exitCode = 1;
}
