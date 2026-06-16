#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const REQUIRED_PACKAGE_FILES = [
  'openclaw.plugin.json',
  'README.md',
  'LICENSE',
  'llms.txt',
  'hooks/**',
  'dashboard/**'
];

const FORBIDDEN_PACK_PATTERNS = [
  /^\.env$/,
  /^\.env\.(?!example$)/,
  /\/\.env/,
  /^dashboard\/\.env/,
  /^dashboard\/dashboard-data\.json$/,
  /^dashboard\/\.cloudflared\//,
  /(^|\/)node_modules\//,
  /(^|\/)dist\//,
  /\.(db|sqlite|log)$/i
];

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function fail(message) {
  console.error(`plugin lint failed: ${message}`);
  process.exitCode = 1;
}

const pkg = readJson('package.json');
const manifest = readJson('openclaw.plugin.json');

if (!pkg.name) fail('package.json must define name');
if (!pkg.version) fail('package.json must define version');
if (!pkg.description) fail('package.json must define description');
if (!Array.isArray(pkg.files) || pkg.files.length === 0) {
  fail('package.json must define a publish allowlist in files');
}

for (const expected of REQUIRED_PACKAGE_FILES) {
  if (!pkg.files?.includes(expected)) fail(`package.json files must include ${expected}`);
}

if (manifest.id !== pkg.name) fail('openclaw.plugin.json id must match package.json name');
if (manifest.version !== pkg.version) fail('openclaw.plugin.json version must match package.json version');
if (!manifest.description) fail('openclaw.plugin.json must define description');
if (manifest.enabledByDefault !== false) fail('plugin must not be enabled by default before install consent');
if (manifest.configContracts?.secretInputs?.bundledDefaultEnabled !== false) {
  fail('plugin must declare bundled secret defaults disabled');
}
if (pkg.openclaw?.release?.publishToClawHub !== true) {
  fail('package.json openclaw.release.publishToClawHub must be true for ClawHub dry-run readiness');
}
if (pkg.openclaw?.release?.publishToNpm !== false) {
  fail('package.json openclaw.release.publishToNpm must be false unless intentionally changed');
}

const pack = spawnSync('npm', ['pack', '--dry-run', '--json'], {
  cwd: process.cwd(),
  encoding: 'utf8',
  shell: false
});

if (pack.status !== 0) {
  console.error(pack.stdout);
  console.error(pack.stderr);
  fail('npm pack dry-run failed');
} else {
  let files = [];
  try {
    files = JSON.parse(pack.stdout)[0]?.files?.map((entry) => entry.path) || [];
  } catch (error) {
    fail(`could not parse npm pack dry-run output: ${error.message}`);
  }

  for (const required of ['openclaw.plugin.json', 'package.json', 'README.md', 'llms.txt']) {
    if (!files.includes(required)) fail(`package artifact missing ${required}`);
  }

  for (const path of files) {
    if (FORBIDDEN_PACK_PATTERNS.some((pattern) => pattern.test(path))) {
      fail(`package artifact includes forbidden path: ${path}`);
    }
  }
}

if (process.exitCode) process.exit(process.exitCode);
console.log('plugin lint ok');
