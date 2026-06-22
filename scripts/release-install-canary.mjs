#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const keepTemp = process.env.FLOWBOARD_KEEP_CANARY_TEMP === '1';
const tmp = mkdtempSync(path.join(tmpdir(), 'flowboard-install-canary-'));

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || root,
    env: options.env || process.env,
    encoding: options.encoding || 'utf8',
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

function resolveOpenClawCommand() {
  if (process.env.FLOWBOARD_OPENCLAW_CLI) return process.env.FLOWBOARD_OPENCLAW_CLI;
  const pathProbe = spawnSync('openclaw', ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    shell: false,
  });
  if (!pathProbe.error && pathProbe.status === 0) return 'openclaw';

  const candidates = [];
  const npmPrefix = spawnSync('npm', ['prefix', '-g'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    shell: false,
  });
  if (!npmPrefix.error && npmPrefix.status === 0 && npmPrefix.stdout.trim()) {
    candidates.push(path.join(npmPrefix.stdout.trim(), 'bin', 'openclaw'));
  }
  if (process.env.HOME) {
    candidates.push(path.join(process.env.HOME, '.npm-global', 'bin', 'openclaw'));
  }
  return candidates.find(candidate => existsSync(candidate)) || 'openclaw';
}

function ensureOpenClawAvailable() {
  const command = resolveOpenClawCommand();
  try {
    run(command, ['--version']);
  } catch (error) {
    throw new Error(`OpenClaw CLI is required for the release install canary (${command}). ${error.message}`);
  }
  return command;
}

function createCanaryEnv(label) {
  const home = path.join(tmp, label);
  mkdirSync(home, { recursive: true });
  return {
    ...process.env,
    HOME: home,
    OPENCLAW_HOME: home,
    OPENCLAW_STATE_DIR: home,
    OPENCLAW_CONFIG_PATH: path.join(home, 'openclaw.json'),
  };
}

function packArtifact() {
  const result = run('npm', ['pack', '--json', '--pack-destination', tmp]);
  const entries = JSON.parse(result.stdout);
  const pack = entries[0];
  if (!pack?.filename) throw new Error('npm pack did not return a filename');
  const tarball = path.join(tmp, pack.filename);
  if (!existsSync(tarball)) throw new Error(`npm pack tarball missing: ${tarball}`);
  return { tarball, files: pack.files?.map(entry => entry.path) || [] };
}

function extractArtifact(tarball) {
  const extractDir = path.join(tmp, 'extract');
  mkdirSync(extractDir, { recursive: true });
  run('tar', ['-xzf', tarball, '-C', extractDir]);
  return path.join(extractDir, 'package');
}

function validateArtifact(packageDir, packedFiles) {
  const pkg = readJson(path.join(packageDir, 'package.json'));
  const manifest = readJson(path.join(packageDir, 'openclaw.plugin.json'));

  if (manifest.id !== pkg.name) throw new Error('openclaw.plugin.json id must match package.json name');
  if (manifest.version !== pkg.version) throw new Error('openclaw.plugin.json version must match package.json version');

  const extensions = pkg.openclaw?.extensions;
  if (!Array.isArray(extensions) || extensions.length === 0) {
    throw new Error('package artifact is a native OpenClaw plugin but package.json openclaw.extensions is empty');
  }
  for (const entry of extensions) {
    const normalized = entry.replace(/^\.\//, '');
    if (!packedFiles.includes(normalized)) throw new Error(`packed artifact missing extension entry ${entry}`);
    if (!existsSync(path.join(packageDir, normalized))) throw new Error(`extracted artifact missing extension entry ${entry}`);
  }
  run(process.execPath, ['-e', `import(${JSON.stringify(path.join(packageDir, extensions[0]))})`], {
    cwd: packageDir,
  });

  const hooks = pkg.openclaw?.hooks;
  if (!Array.isArray(hooks) || hooks.length === 0) {
    throw new Error('package artifact must still declare openclaw.hooks for hook-pack compatibility');
  }
  for (const entry of hooks) {
    const normalized = entry.replace(/^\.\//, '').replace(/\/$/, '');
    if (!packedFiles.some(file => file === normalized || file.startsWith(`${normalized}/`))) {
      throw new Error(`packed artifact missing hook entry ${entry}`);
    }
  }
}

function validatePluginRegistration(packageDir, extensions) {
  const entryPath = path.join(packageDir, extensions[0].replace(/^\.\//, ''));
  const script = `
    const mod = await import(${JSON.stringify(pathToFileURL(entryPath).href)});
    const plugin = mod.default;
    if (!plugin || typeof plugin.register !== 'function') {
      throw new Error('native plugin entry must default-export an object with register(api)');
    }
    const hooks = [];
    plugin.register({
      pluginConfig: { dashboardPort: 18844 },
      registerHook(events, handler, opts) {
        hooks.push({ events, handlerType: typeof handler, name: opts?.name });
      },
    });
    const hook = hooks.find(h => h.events === 'agent:bootstrap' && h.name === 'project-context');
    if (!hook) throw new Error('native plugin entry did not register project-context agent:bootstrap hook');
    if (hook.handlerType !== 'function') throw new Error('project-context hook handler must be a function');
  `;
  run(process.execPath, ['--input-type=module', '-e', script], {
    cwd: packageDir,
  });
}

function installArtifact(openclaw, tarball) {
  run(openclaw, ['plugins', 'install', tarball, '--force'], {
    env: createCanaryEnv('artifact-home'),
  });
}

function installClawHub(openclaw, spec) {
  run(openclaw, ['plugins', 'install', `clawhub:${spec}`, '--force'], {
    env: createCanaryEnv('clawhub-home'),
    stdio: 'inherit',
  });
}

function usage() {
  console.log([
    'Usage:',
    '  node scripts/release-install-canary.mjs',
    '  node scripts/release-install-canary.mjs --clawhub [flowboard@x.y.z]',
    '',
    'Env:',
    '  FLOWBOARD_OPENCLAW_CLI=/path/to/openclaw',
    '  FLOWBOARD_KEEP_CANARY_TEMP=1',
  ].join('\n'));
}

try {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    usage();
    process.exit(0);
  }

  const openclaw = ensureOpenClawAvailable();
  const pkg = readJson(path.join(root, 'package.json'));

  if (args[0] === '--clawhub') {
    const spec = args[1] || process.env.FLOWBOARD_CLAWHUB_SPEC || pkg.openclaw?.install?.clawhubSpec || pkg.name;
    installClawHub(openclaw, spec);
    console.log(`release install canary ok (clawhub:${spec})`);
    process.exit(0);
  }

  const { tarball, files } = packArtifact();
  const packageDir = extractArtifact(tarball);
  validateArtifact(packageDir, files);
  validatePluginRegistration(packageDir, readJson(path.join(packageDir, 'package.json')).openclaw.extensions);
  installArtifact(openclaw, tarball);
  console.log('release install canary ok');
} finally {
  if (!keepTemp) rmSync(tmp, { recursive: true, force: true });
  else console.log(`kept canary temp dir: ${tmp}`);
}
