#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const steps = [
  ['git', ['diff', '--check']],
  ['node', ['scripts/privacy-scan.mjs']],
  ['node', ['scripts/plugin-lint.mjs']],
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
