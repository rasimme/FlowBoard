#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createIsolatedHome, probeHostCapabilities } from './lib/openclaw-host.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// Release discipline: FlowBoard releases are cut from `main`, never from `dev`
// or a feature branch. The flow is: merge dev -> main FIRST (with approval),
// then bump/tag/publish from `main`. This guard fails fast if release-check is
// run anywhere but `main`, so an accidental release off `dev` is caught before
// any tag/publish. For a local dry-run on another branch, set
// FLOWBOARD_RELEASE_ALLOW_BRANCH=1.
const branchProbe = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' });
const currentBranch = (branchProbe.stdout || '').trim();
if (process.env.FLOWBOARD_RELEASE_ALLOW_BRANCH !== '1' && currentBranch !== 'main') {
  console.error(`\nrelease gate failed: releases must be cut from 'main' (current branch: '${currentBranch || 'unknown'}').`);
  console.error('Merge dev -> main first (with approval), then run release-check from main.');
  console.error('For a local dry-run on another branch, set FLOWBOARD_RELEASE_ALLOW_BRANCH=1.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Plugin-metadata gate (T-487-1)
// ---------------------------------------------------------------------------
//
// `openclaw.plugin.json` and `dist/control-ui/<hash>/` are *generated* from the
// plugin entry by `openclaw plugins build`. Nothing else in the repo notices
// when they drift: a stale manifest still lints, still packs, still installs —
// and then points a ≥ 2026.9.2 host at a Control UI bundle that no longer
// matches the code, or omits a config field the entry now declares. So the
// release gate regenerates and compares, which needs a CLI new enough to know
// about feature plugins at all.
//
// The CLI is feature-detected, never version-matched. The marker is
// `plugins validate --json` plus the `plugins pack` subcommand, both of which
// arrived with the feature-plugin CLI. `plugins build --check` is NOT a marker
// even though the gate uses it: 2026.6.6 and 2026.7.1-2 have that flag too,
// they just generate tool-plugin metadata with it and reject FlowBoard's
// entry.
//
// NOTE — `openclaw plugins pack` is deliberately NOT part of this gate and must
// not be added. It bundles the backend, which hoists the
// `openclaw/plugin-sdk/feature-*` imports out of `openclaw/feature-entry.js`
// into the entry itself; those subpaths do not exist before 2026.9.2, so the
// entry would fail to load outright on an older host and take the
// `agent:bootstrap` hook down with it. FlowBoard ships source installs
// (ClawHub package / `--link`). See docs/adr/0040-gateway-verified-principal-via-service-credential.md and the T-487-7 spike
// result.
function resolvePluginCli(env) {
  const candidates = [];
  if (process.env.FLOWBOARD_OPENCLAW_CLI) candidates.push(process.env.FLOWBOARD_OPENCLAW_CLI);
  candidates.push(path.join(repoRoot, 'node_modules', '.bin', 'openclaw'));

  const tried = [];
  for (const candidate of candidates) {
    if (candidate.includes(path.sep) && !existsSync(candidate)) {
      tried.push(`${candidate}: not found`);
      continue;
    }
    const { capabilities } = probeHostCapabilities(candidate, { env });
    if (capabilities.featurePluginHost) return { cli: candidate, capabilities };
    tried.push(
      `${candidate}: ${capabilities.version || 'unknown version'} has no 'plugins validate --json' / 'plugins pack' (pre-2026.9 plugin CLI)`,
    );
  }

  console.error('\nrelease gate failed: no OpenClaw CLI that can build/validate the plugin metadata.');
  console.error("Install the pinned devDependency with 'npm install' at the repo root (needs Node >= 24.16),");
  console.error('or point FLOWBOARD_OPENCLAW_CLI at an OpenClaw >= 2026.9 CLI.');
  for (const line of tried) console.error(`  - ${line}`);
  rmSync(pluginHomeRoot, { recursive: true, force: true });
  process.exit(1);
}

// Every OpenClaw invocation in this gate — including the capability probe —
// runs against a throwaway home, for the same reason the install canary does:
// a maintainer's real ~/.openclaw is not a test fixture, and on 2026.6.x /
// 2026.7.x a CLI call can migrate state out of it. See
// scripts/lib/openclaw-host.mjs.
const pluginHomeRoot = mkdtempSync(path.join(tmpdir(), 'flowboard-release-check-'));
const pluginHome = createIsolatedHome(path.join(pluginHomeRoot, 'openclaw-home'));

const { cli: pluginCli, capabilities } = resolvePluginCli(pluginHome.env);
console.log(`\nplugin CLI: ${pluginCli} (${capabilities.version})`);

const steps = [
  ['git', ['diff', '--check']],
  ['node', ['scripts/privacy-scan.mjs']],
  ['node', ['scripts/plugin-lint.mjs']],
  // `npm run build:plugin` / `npm run validate:plugin`, invoked directly so
  // FLOWBOARD_OPENCLAW_CLI is honoured and the isolated home applies.
  //
  // The build runs BEFORE the checks on purpose. `dist/control-ui/` is
  // gitignored, and both `--check` and `validate` refuse outright when it is
  // missing ("Control UI build is missing or stale"), so on a clean release
  // checkout they would only ever report the absence of a build. Building
  // first and then diffing the two generated files is what actually catches
  // the drift that matters: a committed manifest that no longer matches the
  // plugin entry.
  [pluginCli, ['plugins', 'build'], { env: pluginHome.env }],
  ['git', ['diff', '--exit-code', '--', 'openclaw.plugin.json', 'package.json']],
  [pluginCli, ['plugins', 'build', '--check'], { env: pluginHome.env }],
  [pluginCli, ['plugins', 'validate', '--json'], { env: pluginHome.env }],
  ['node', ['scripts/clawpack-gate.mjs']],
  ['node', ['scripts/release-install-canary.mjs']],
  ['npm', ['run', 'build'], { cwd: 'dashboard' }],
  ['npm', ['test'], { cwd: 'dashboard' }]
];

let failure = null;
for (const [command, args, options = {}] of steps) {
  const label = `${command} ${args.join(' ')}`;
  console.log(`\n> ${label}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
    stdio: 'inherit',
    shell: false
  });

  if (result.status !== 0) {
    failure = { label, status: result.status || 1 };
    break;
  }
}

rmSync(pluginHomeRoot, { recursive: true, force: true });

if (failure) {
  console.error(`\nrelease gate failed: ${failure.label}`);
  if (failure.label.includes('--exit-code')) {
    console.error('The generated plugin metadata is out of date. Commit the regenerated');
    console.error('openclaw.plugin.json / package.json produced by `npm run build:plugin`.');
  }
  process.exit(failure.status);
}

console.log('\nrelease check ok');
