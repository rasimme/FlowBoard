#!/usr/bin/env node
// Regression coverage for scripts/setup.mjs macOS launchd configuration.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  lstatSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
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
  const logDir = join(home, 'Library', 'Logs', 'FlowBoard');
  const logPath = join(logDir, 'flowboard-dashboard.log');
  const legacyArchivePath = join(logDir, 'flowboard-dashboard.legacy.log');
  const legacyLogPath = join(dir, 'legacy-flowboard-dashboard.log');
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
      FLOWBOARD_SETUP_TEST_LEGACY_LOG_PATH: legacyLogPath,
      FAKE_COMMAND_LOG: commandLog,
      PATH: [bin, process.env.PATH].filter(Boolean).join(delimiter),
    },
    logDir,
    logPath,
    legacyArchivePath,
    legacyLogPath,
    artifact() {
      const safeStat = path => {
        try { return lstatSync(path); } catch { return null; }
      };
      const logStat = safeStat(logPath);
      const legacyStat = safeStat(legacyLogPath);
      const archiveStat = safeStat(legacyArchivePath);
      return {
        commands: readLines(commandLog),
        plist: readFileSync(plistPath, 'utf8'),
        mode: statSync(plistPath).mode & 0o777,
        logMode: logStat && !logStat.isSymbolicLink() ? logStat.mode & 0o777 : null,
        logIsSymlink: Boolean(logStat?.isSymbolicLink()),
        logDirMode: existsSync(logDir) ? statSync(logDir).mode & 0o777 : null,
        legacyExists: Boolean(legacyStat),
        legacyIsSymlink: Boolean(legacyStat?.isSymbolicLink()),
        legacyArchiveMode: archiveStat && !archiveStat.isSymbolicLink() ? archiveStat.mode & 0o777 : null,
        legacyArchiveContent: archiveStat && !archiveStat.isSymbolicLink() ? readFileSync(legacyArchivePath, 'utf8') : null,
      };
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function runSetup(args, initialPlist, extraEnv = {}, options = {}) {
  const server = createServer((req, res) => {
    if (req.url === '/api/health') {
      const statusCode = options.healthStatus || 200;
      res.writeHead(statusCode, { 'content-type': 'application/json' });
      res.end(statusCode === 200 ? '{"ok":true}' : '{"ok":false}');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const harness = makeHarness(initialPlist.replaceAll('__FLOWBOARD_PORT__', String(port)));
  if (options.prepare) options.prepare(harness);

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
        ...harness.artifact(),
        ...(options.capture ? options.capture(harness) : {}),
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

let generatedLaunchdPlist = '';

{
  const launchctlStdoutSecret = 'adversarial-launchctl-stdout-secret';
  const launchctlStderrSecret = 'adversarial-launchctl-stderr-secret';
  const result = await runSetup(['--update'], existingPlist, {
    DASHBOARD_ORIGIN: 'https://shell-override.example.invalid',
    JWT_SECRET: 'test-shell-secret-must-not-win',
    FAKE_LAUNCHCTL_PRINT_STDOUT: launchctlStdoutSecret,
    FAKE_LAUNCHCTL_PRINT_STDERR: launchctlStderrSecret,
  });
  generatedLaunchdPlist = result.plist;
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
  const expectedLogPath = join(result.plist.match(/<key>StandardOutPath<\/key><string>(.*?)<\/string>/)?.[1] || '');
  ok(expectedLogPath.endsWith('/Library/Logs/FlowBoard/flowboard-dashboard.log'), 'launchd writes to the owner-scoped Library log path');
  ok(!result.plist.includes('/tmp/flowboard-dashboard.log'), 'launchd no longer uses the predictable shared /tmp log');
  ok(result.plist.includes('<key>Umask</key><integer>63</integer>'), 'launchd service enforces owner-only file creation via umask 077');
  ok(result.logDirMode === 0o700, 'launchd log directory is owner-only');
  ok(result.logMode === 0o600, 'launchd log file is pre-created owner-only');
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

{
  const result = await runSetup(['--update'], existingPlist, {}, {
    prepare(harness) {
      mkdirSync(harness.logDir, { recursive: true, mode: 0o777 });
      writeFileSync(harness.logPath, 'pre-created log\n', { mode: 0o666 });
      chmodSync(harness.logDir, 0o777);
      chmodSync(harness.logPath, 0o666);
    },
  });
  ok(result.code === 0, 'same-owner pre-created launchd log is secured before use');
  ok(result.logDirMode === 0o700 && result.logMode === 0o600, 'pre-created log path permissions are tightened to owner-only');
}

{
  let victimPath;
  const result = await runSetup(['--update'], existingPlist, {}, {
    prepare(harness) {
      victimPath = join(harness.home, 'victim.log');
      mkdirSync(harness.logDir, { recursive: true, mode: 0o700 });
      writeFileSync(victimPath, 'must remain untouched\n', { mode: 0o644 });
      chmodSync(victimPath, 0o644);
      symlinkSync(victimPath, harness.logPath);
    },
    capture() {
      return {
        victimContent: readFileSync(victimPath, 'utf8'),
        victimMode: statSync(victimPath).mode & 0o777,
      };
    },
  });
  ok(result.code === 1, 'pre-created symlink at the secure log path fails closed');
  ok(result.logIsSymlink, 'unsafe secure-log symlink is not replaced or followed');
  ok(result.victimContent === 'must remain untouched\n' && result.victimMode === 0o644, 'secure-log symlink target is not modified');
  ok(!result.commands.some(line => line.startsWith('launchctl ')), 'unsafe log pre-creation aborts before stopping or bootstrapping launchd');
}

{
  const result = await runSetup(['--update'], existingPlist, {}, {
    prepare(harness) {
      writeFileSync(harness.legacyLogPath, 'legacy private output\n', { mode: 0o644 });
      chmodSync(harness.legacyLogPath, 0o644);
    },
  });
  ok(result.code === 0, 'owner-owned legacy /tmp-style log migrates safely');
  ok(!result.legacyExists, 'migrated legacy log is removed from the shared path');
  ok(result.legacyArchiveMode === 0o600, 'migrated legacy log archive is owner-only');
  ok(result.legacyArchiveContent === 'legacy private output\n', 'legacy log migration preserves existing diagnostics');
}

{
  let victimPath;
  const result = await runSetup(['--update'], existingPlist, {}, {
    prepare(harness) {
      victimPath = join(harness.home, 'legacy-victim.log');
      writeFileSync(victimPath, 'legacy victim\n', { mode: 0o644 });
      chmodSync(victimPath, 0o644);
      symlinkSync(victimPath, harness.legacyLogPath);
    },
    capture() {
      return {
        victimContent: readFileSync(victimPath, 'utf8'),
        victimMode: statSync(victimPath).mode & 0o777,
      };
    },
  });
  ok(result.code === 0, 'legacy shared-path symlink does not block migration to the secure log');
  ok(result.legacyExists && result.legacyIsSymlink, 'legacy shared-path symlink is left untouched instead of followed');
  ok(result.victimContent === 'legacy victim\n' && result.victimMode === 0o644, 'legacy symlink target remains untouched and world-readable mode is not changed');
  ok(result.logMode === 0o600, 'secure owner-only log is used despite hostile legacy pre-creation');
}

{
  const result = await runSetup(['--update'], existingPlist, {
    FLOWBOARD_SETUP_TEST_HEALTH_ATTEMPTS: '1',
  }, {
    healthStatus: 503,
  });
  ok(result.code === 1, 'macOS health-check failure is surfaced');
  ok(result.stdout.includes('Library/Logs/FlowBoard/flowboard-dashboard.log'), 'macOS failure points to the secure launchd log');
  ok(result.stdout.includes(`launchctl print gui/`) && result.stdout.includes(LABEL), 'macOS failure identifies the launchd job');
  ok(!result.stdout.includes('journalctl --user') && !result.stdout.includes('/tmp/flowboard-dashboard.log'), 'macOS failure does not mention systemd or the obsolete shared log');
}

{
  const plutil = spawnSync('plutil', ['-lint', '-'], { input: generatedLaunchdPlist, encoding: 'utf8' });
  if (plutil.error?.code === 'ENOENT') console.log('  # plutil unavailable; launchd plist lint skipped');
  else ok(plutil.status === 0, 'generated launchd plist passes plutil -lint');
}

console.log(`\n# results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log('# failures:');
  failures.forEach(f => console.log(`#   - ${f}`));
  process.exitCode = 1;
}
