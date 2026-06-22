#!/usr/bin/env node
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const keepTemp = process.env.FLOWBOARD_KEEP_CLAWHUB_TEMP === '1';
const tmp = mkdtempSync(path.join(tmpdir(), 'flowboard-clawpack-gate-'));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || root,
    env: options.env || process.env,
    encoding: 'utf8',
    stdio: options.stdio || 'pipe',
    shell: false,
  });
  if (result.error) {
    throw new Error(`${command} ${args.join(' ')} failed\n${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `\n${detail}` : ''}`);
  }
  return result;
}

function resolveClawHubCommand() {
  if (process.env.FLOWBOARD_CLAWHUB_CLI) return process.env.FLOWBOARD_CLAWHUB_CLI;
  const pathProbe = spawnSync('clawhub', ['--cli-version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    shell: false,
  });
  if (!pathProbe.error && pathProbe.status === 0) return 'clawhub';

  const candidates = [];
  const npmPrefix = spawnSync('npm', ['prefix', '-g'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    shell: false,
  });
  if (!npmPrefix.error && npmPrefix.status === 0 && npmPrefix.stdout.trim()) {
    candidates.push(path.join(npmPrefix.stdout.trim(), 'bin', 'clawhub'));
  }
  if (process.env.HOME) {
    candidates.push(path.join(process.env.HOME, '.npm-global', 'bin', 'clawhub'));
  }
  return candidates.find(candidate => existsSync(candidate)) || 'clawhub';
}

function parseJson(label, stdout) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`${label} did not return valid JSON\n${error.message}\n${stdout}`);
  }
}

function repoSlug() {
  const result = run('git', ['config', '--get', 'remote.origin.url']);
  return result.stdout
    .trim()
    .replace(/^git@github\.com:/, '')
    .replace(/^https:\/\/github\.com\//, '')
    .replace(/\.git$/, '');
}

function currentRef() {
  const result = run('git', ['branch', '--show-current']);
  return result.stdout.trim() || 'HEAD';
}

try {
  const clawhub = resolveClawHubCommand();
  run(clawhub, ['--cli-version']);

  const pack = parseJson(
    'clawhub package pack',
    run(clawhub, ['package', 'pack', '.', '--pack-destination', tmp, '--json']).stdout
  );
  if (!pack.path || !pack.path.endsWith('.tgz')) {
    throw new Error('clawhub package pack did not return a .tgz path');
  }
  if (!existsSync(pack.path)) {
    throw new Error(`ClawPack artifact missing: ${pack.path}`);
  }

  const validate = parseJson(
    'clawhub package validate',
    run(clawhub, [
      'package',
      'validate',
      '.',
      '--out',
      path.join(tmp, 'validate'),
      '--runtime',
      '--allow-execute',
      '--json',
    ]).stdout
  );
  if (validate.status !== 'pass') {
    throw new Error(`clawhub package validate status is ${validate.status}`);
  }

  const sha = run('git', ['rev-parse', 'HEAD']).stdout.trim();
  const dryRun = parseJson(
    'clawhub package publish --dry-run',
    run(clawhub, [
      'package',
      'publish',
      pack.path,
      '--dry-run',
      '--json',
      '--source-repo',
      repoSlug(),
      '--source-commit',
      sha,
      '--source-ref',
      currentRef(),
    ]).stdout
  );
  if (dryRun.name !== pack.name || dryRun.version !== pack.version) {
    throw new Error(`publish dry-run resolved ${dryRun.name}@${dryRun.version}, expected ${pack.name}@${pack.version}`);
  }
  if (dryRun.commit !== sha) {
    throw new Error(`publish dry-run resolved commit ${dryRun.commit}, expected ${sha}`);
  }
  if (dryRun.files !== pack.files || dryRun.totalBytes !== pack.size) {
    throw new Error('publish dry-run did not use the ClawPack artifact produced by package pack');
  }

  console.log([
    'clawpack gate ok',
    `artifact: ${path.basename(pack.path)}`,
    `version: ${pack.version}`,
    `files: ${pack.files}`,
    `bytes: ${pack.size}`,
    `dry-run: ${dryRun.name}@${dryRun.version}`,
  ].join('\n'));
} finally {
  if (keepTemp) console.log(`kept clawpack temp dir: ${tmp}`);
  else rmSync(tmp, { recursive: true, force: true });
}
