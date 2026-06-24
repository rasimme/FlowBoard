#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const REQUIRED_PACKAGE_FILES = [
  'openclaw.plugin.json',
  'README.md',
  'LICENSE',
  'llms.txt',
  'openclaw/**',
  'hooks/**',
  'dashboard/**',
  'scripts/setup.mjs'
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

const FORBIDDEN_PACKED_FILES = [
  /^scripts\/(?:capture-|release-|privacy-scan|clawpack-gate|plugin-lint|v5-demo-fixture)/,
  /^dashboard\/tools\//,
  /^docs\/dev\//,
  /^docs\/plans\//,
  /^docs\/reviews\//
];

const TEXT_PACK_EXTENSIONS = new Set([
  '.cjs',
  '.css',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.service',
  '.sh',
  '.txt',
  '.yml',
  '.yaml'
]);

const PACKED_SUSPICIOUS_PATTERNS = [
  {
    name: 'destructive shell removal',
    pattern: /\brm\s+-rf\b/,
    allow: new Set()
  },
  {
    name: 'CDP Runtime.evaluate helper',
    pattern: /Runtime\.evaluate/,
    allow: new Set()
  },
  {
    name: 'child_process runtime bridge',
    pattern: /(?:node:child_process|require\(['"]child_process['"]\)|from ['"]child_process['"])/,
    allow: new Set([
      'scripts/setup.mjs',
      'dashboard/server.js',
      'dashboard/snippets-doctor.js',
      'dashboard/specify-worker-openclaw.js'
    ])
  }
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

const packageScripts = Object.keys(pkg.scripts || {});
const allowedPublishedScripts = new Set(['setup']);
for (const scriptName of packageScripts) {
  if (!allowedPublishedScripts.has(scriptName)) {
    fail(`package.json script ${scriptName} is dev/release-only; run scripts directly so package metadata stays install-focused`);
  }
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
if (!Array.isArray(pkg.openclaw?.extensions) || pkg.openclaw.extensions.length === 0) {
  fail('package.json openclaw.extensions must declare the native plugin entry used by ClawHub installs');
} else {
  for (const [index, entry] of pkg.openclaw.extensions.entries()) {
    if (typeof entry !== 'string' || !entry.trim()) {
      fail(`package.json openclaw.extensions[${index}] must be a non-empty string`);
      continue;
    }
    if (entry.includes('..')) fail(`package.json openclaw.extensions[${index}] must not contain '..'`);
  }
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
  for (const entry of pkg.openclaw?.extensions || []) {
    const normalized = entry.replace(/^\.\//, '');
    if (!files.includes(normalized)) fail(`package artifact missing openclaw.extensions entry: ${entry}`);
  }
  for (const entry of pkg.openclaw?.hooks || []) {
    const normalized = entry.replace(/^\.\//, '').replace(/\/$/, '');
    if (!files.some(path => path === normalized || path.startsWith(`${normalized}/`))) {
      fail(`package artifact missing openclaw.hooks entry: ${entry}`);
    }
  }

  for (const path of files) {
    if (FORBIDDEN_PACK_PATTERNS.some((pattern) => pattern.test(path))) {
      fail(`package artifact includes forbidden path: ${path}`);
    }
    if (FORBIDDEN_PACKED_FILES.some((pattern) => pattern.test(path))) {
      fail(`package artifact includes dev/release-only path: ${path}`);
    }
  }

  for (const path of files) {
    const extension = path.match(/(\.[^./]+)$/)?.[1] || '';
    if (!TEXT_PACK_EXTENSIONS.has(extension)) continue;

    let content = '';
    try {
      content = readFileSync(path, 'utf8');
    } catch {
      continue;
    }

    for (const rule of PACKED_SUSPICIOUS_PATTERNS) {
      if (rule.pattern.test(content) && !rule.allow.has(path)) {
        fail(`package artifact suspicious pattern (${rule.name}) in ${path}`);
      }
      rule.pattern.lastIndex = 0;
    }
  }
}

if (process.exitCode) process.exit(process.exitCode);
console.log('plugin lint ok');
