#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

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

const steps = [
  ['git', ['diff', '--check']],
  ['node', ['scripts/privacy-scan.mjs']],
  ['node', ['scripts/plugin-lint.mjs']],
  ['node', ['scripts/clawpack-gate.mjs']],
  ['node', ['scripts/release-install-canary.mjs']],
  ['npm', ['run', 'build'], { cwd: 'dashboard' }],
  ['npm', ['test'], { cwd: 'dashboard' }]
];

for (const [command, args, options = {}] of steps) {
  const label = `${command} ${args.join(' ')}`;
  console.log(`\n> ${label}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd || process.cwd(),
    stdio: 'inherit',
    shell: false
  });

  if (result.status !== 0) {
    console.error(`\nrelease gate failed: ${label}`);
    process.exit(result.status || 1);
  }
}

console.log('\nrelease check ok');
