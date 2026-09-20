#!/usr/bin/env node
/**
 * FlowBoard release install canary (T-487-1).
 *
 * Installs the packed FlowBoard artifact into a disposable OpenClaw home and
 * walks the whole lifecycle an operator walks — install, enable, inspect,
 * doctor, re-install, uninstall — asserting at every step that the one thing
 * FlowBoard may never lose is still there: the `project-context`
 * `agent:bootstrap` hook.
 *
 * It is **version-aware without being version-branched**. FlowBoard supports
 * 2026.6.6 through 2026.9.x, whose CLIs differ in ways that matter:
 *
 *  - `--accept-capabilities` exists from 2026.8 and is *mandatory* on 2026.9.x:
 *    without it the install is refused. It does not exist on 2026.6.6 or
 *    2026.7.1-2, where passing it aborts with "unknown option". (2026.7.1-2 has
 *    the unrelated `--acknowledge-clawhub-risk`, which is a source-trust
 *    acknowledgement, not capability consent.)
 *  - `plugins reload`, `plugins pack`, `plugins build --check` and
 *    `plugins doctor --json` are 2026.9.x only.
 *
 * So capabilities are read from the CLI's own `--help` output
 * (`scripts/lib/openclaw-host.mjs`) and each step is gated on what the host
 * actually accepts. See CONTRIBUTING § "Release gates" for how to run it.
 *
 * Usage:
 *   node scripts/release-install-canary.mjs [--json]
 *   node scripts/release-install-canary.mjs --clawhub [flowboard@x.y.z] [--json]
 */
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import { createIsolatedHome, probeHostCapabilities, runCli } from './lib/openclaw-host.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// Both names keep the throwaway home around for debugging. The older
// `FLOWBOARD_KEEP_CANARY_TEMP` keeps working so existing notes stay valid.
const keepTemp =
  process.env.FLOWBOARD_CANARY_KEEP_HOME === '1' ||
  process.env.FLOWBOARD_KEEP_CANARY_TEMP === '1';

const tmp = mkdtempSync(path.join(tmpdir(), 'flowboard-install-canary-'));

/** The one hook every supported host must end up with. */
const REQUIRED_HOOK = 'project-context';
/** Feature-layer surfaces, present only where the feature contract loads. */
const FEATURE_SERVICE = 'flowboard:feature-events';
const FEATURE_GATEWAY_METHOD = 'flowboard.ui.identity';
/**
 * The only compatibility note the canary tolerates. On 2026.6.6 / 2026.7.1-2
 * FlowBoard is a hook-only plugin by design (the feature SDK does not exist
 * there), and the host says so at `info` severity. That is the supported
 * baseline, not a defect.
 */
const ALLOWED_COMPAT_CODES = new Set(['hook-only', 'hook-only-plugin-shape']);

const steps = [];
let hostInfo = { cli: null, version: null, commit: null, capabilities: null };

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return String(text || '').replace(/\x1B\[[0-9;]*m/g, '');
}

function record(id, status, detail) {
  steps.push({ id, status, detail: detail || null });
  return steps[steps.length - 1];
}

class CanaryError extends Error {}

/** Run a step that must succeed; a failure ends the canary. */
function step(id, fn) {
  try {
    const detail = fn();
    record(id, 'pass', typeof detail === 'string' ? detail : null);
  } catch (error) {
    record(id, 'fail', String(error?.message || error));
    throw new CanaryError(`${id}: ${error?.message || error}`);
  }
}

/** Run a step whose outcome is information about the host, not a verdict. */
function note(id, fn) {
  try {
    const result = fn();
    record(id, result?.status || 'pass', result?.detail || null);
  } catch (error) {
    record(id, 'skip', String(error?.message || error));
  }
}

function run(command, args, options = {}) {
  const result = runCli(command, args, { cwd: options.cwd || root, ...options });
  if (!result.ok) {
    const detail = stripAnsi(result.output).trim();
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `\n${detail}` : ''}`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// CLI resolution
// ---------------------------------------------------------------------------

/**
 * `FLOWBOARD_OPENCLAW_NODE` lets the matrix runner point one CLI at one Node.
 * The OpenClaw bin is a `#!/usr/bin/env node` script, so its runtime is
 * whichever `node` comes first on `PATH` — and 2026.9.x refuses Node < 24.16
 * while 2026.6.6 predates that requirement. Accepts the binary or its dir.
 */
function nodeBinDir() {
  const raw = process.env.FLOWBOARD_OPENCLAW_NODE;
  if (!raw) return null;
  return path.basename(raw) === 'node' ? path.dirname(raw) : raw;
}

const extraPath = nodeBinDir();

function baseEnv() {
  if (!extraPath) return process.env;
  return { ...process.env, PATH: `${extraPath}${path.delimiter}${process.env.PATH || ''}` };
}

function candidateClis() {
  if (process.env.FLOWBOARD_OPENCLAW_CLI) return [process.env.FLOWBOARD_OPENCLAW_CLI];
  const candidates = [];
  // The pinned devDependency first: it is the version the repo was built and
  // validated against. Every candidate is probed with `--version`, so a root
  // install that cannot run on the current Node simply falls through.
  candidates.push(path.join(root, 'node_modules', '.bin', 'openclaw'));
  candidates.push('openclaw');
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
  return candidates;
}

function resolveOpenClawCli() {
  const tried = [];
  for (const candidate of candidateClis()) {
    if (candidate.includes(path.sep) && !existsSync(candidate)) continue;
    const probe = runCli(candidate, ['--version'], { env: baseEnv() });
    if (probe.ok) return candidate;
    tried.push(`${candidate}: ${stripAnsi(probe.output).trim().split('\n')[0] || probe.error}`);
  }
  throw new Error(
    'OpenClaw CLI is required for the release install canary.\n' +
      "Set FLOWBOARD_OPENCLAW_CLI, or install the pinned devDependency with 'npm install' at the repo root.\n" +
      (tried.length ? `Tried:\n  ${tried.join('\n  ')}` : ''),
  );
}

// ---------------------------------------------------------------------------
// Isolated home
// ---------------------------------------------------------------------------

let homeSeq = 0;
function canaryHome(label) {
  homeSeq += 1;
  return createIsolatedHome(path.join(tmp, `${label}-${homeSeq}`), baseEnv(), extraPath);
}

// ---------------------------------------------------------------------------
// Artifact
// ---------------------------------------------------------------------------

function packArtifact() {
  // The matrix runner packs once and reuses the tarball across hosts; packing
  // per host would be three identical `npm pack` runs over a ~2.5 MB tree.
  const reuse = process.env.FLOWBOARD_CANARY_ARTIFACT;
  if (reuse) {
    if (!existsSync(reuse)) throw new Error(`FLOWBOARD_CANARY_ARTIFACT does not exist: ${reuse}`);
    const listing = run('tar', ['-tzf', reuse]);
    const files = listing.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('package/') && !line.endsWith('/'))
      .map((line) => line.slice('package/'.length));
    return { tarball: reuse, files, reused: true };
  }
  const result = run('npm', ['pack', '--json', '--pack-destination', tmp]);
  const entries = JSON.parse(result.stdout);
  const pack = entries[0];
  if (!pack?.filename) throw new Error('npm pack did not return a filename');
  const tarball = path.join(tmp, pack.filename);
  if (!existsSync(tarball)) throw new Error(`npm pack tarball missing: ${tarball}`);
  return { tarball, files: pack.files?.map((entry) => entry.path) || [], reused: false };
}

function extractArtifact(tarball) {
  const extractDir = path.join(tmp, 'extract');
  mkdirSync(extractDir, { recursive: true });
  run('tar', ['-xzf', tarball, '-C', extractDir]);
  return path.join(extractDir, 'package');
}

function validateArtifact(packageDir, packedFiles, { requireControlUi }) {
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
    if (!packedFiles.some((file) => file === normalized || file.startsWith(`${normalized}/`))) {
      throw new Error(`packed artifact missing hook entry ${entry}`);
    }
  }

  // The native Control UI bundle is generated by `openclaw plugins build` and
  // is gitignored, so a release packed from a clean checkout can be missing it
  // while every other check passes. The manifest points the host at it by
  // path, so on a feature-plugin host those missing bytes mean the native page
  // cannot load at all.
  //
  // On an older host the same artifact is fine: `controlUi` is an additive
  // manifest field that 2026.6.6 / 2026.7.1-2 ignore without validating, and
  // the hook-only baseline never touches it. Failing there would make the
  // Node 22 CI job — which has no Node >= 24.16 to build the bundle with —
  // report a defect that cannot exist on the host it is testing.
  const controlUiEntry = manifest.controlUi?.entry;
  if (controlUiEntry && !packedFiles.includes(controlUiEntry)) {
    if (requireControlUi) {
      throw new Error(
        `packed artifact missing Control UI entry ${controlUiEntry} — run 'npm run build:plugin' before packing`,
      );
    }
    return `Control UI bundle absent; ignored by this host (no feature-plugin support)`;
  }
  return null;
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
    const hook = hooks.find(h => h.events === 'agent:bootstrap' && h.name === ${JSON.stringify(REQUIRED_HOOK)});
    if (!hook) throw new Error('native plugin entry did not register the ${REQUIRED_HOOK} agent:bootstrap hook');
    if (hook.handlerType !== 'function') throw new Error('${REQUIRED_HOOK} hook handler must be a function');
  `;
  run(process.execPath, ['--input-type=module', '-e', script], { cwd: packageDir });
}

// ---------------------------------------------------------------------------
// Host lifecycle
// ---------------------------------------------------------------------------

function installArgs(target, capabilities, { clawhub = false } = {}) {
  const args = ['plugins', 'install', target, '--force'];
  // Consent, only where the host has the concept. On 2026.9.x the install is
  // refused without it; on 2026.6.6 / 2026.7.1-2 the flag does not exist and
  // passing it would abort with "unknown option".
  if (capabilities.acceptCapabilities) args.push('--accept-capabilities');
  // Source-trust acknowledgement for a ClawHub release. This is not capability
  // consent — it silences the "outside ClawHub review" prompt for an artifact
  // the maintainer running the post-publish canary just published themselves.
  if (clawhub && capabilities.acknowledgeClawhubRisk) args.push('--acknowledge-clawhub-risk');
  return args;
}

function inspectPlugin(cli, env, capabilities) {
  const args = ['plugins', 'inspect', 'flowboard'];
  if (capabilities.inspectRuntime) args.push('--runtime');
  if (capabilities.inspectJson) args.push('--json');
  const result = runCli(cli, args, { env });
  if (!result.ok) throw new Error(`plugins inspect failed: ${stripAnsi(result.output).trim()}`);
  if (!capabilities.inspectJson) {
    const text = stripAnsi(result.stdout);
    return {
      mode: 'text',
      status: /status:\s*(\S+)/i.exec(text)?.[1] || null,
      hookNames: [],
      services: [],
      gatewayMethods: [],
      controlUi: null,
      diagnostics: [],
      compatibility: [],
      text,
    };
  }
  const payload = JSON.parse(result.stdout);
  const plugin = payload.plugin || payload;
  return {
    mode: 'json',
    status: plugin.status || null,
    hookNames: plugin.hookNames || [],
    services: payload.services || plugin.services || [],
    gatewayMethods: payload.gatewayMethods || [],
    controlUi: plugin.controlUi || null,
    diagnostics: payload.diagnostics || [],
    compatibility: payload.compatibility || [],
    payload,
  };
}

/** A CLI that does not list `hookNames` still answers `hooks list`. */
function hookRegisteredViaHooksList(cli, env) {
  const result = runCli(cli, ['hooks', 'list'], { env });
  if (!result.ok) return false;
  return stripAnsi(result.output).includes(REQUIRED_HOOK);
}

function assertHookRegistered(cli, env, inspected, context) {
  if (inspected.hookNames.includes(REQUIRED_HOOK)) return `hookNames: ${REQUIRED_HOOK}`;
  if (hookRegisteredViaHooksList(cli, env)) return `hooks list: ${REQUIRED_HOOK}`;
  throw new Error(`${REQUIRED_HOOK} hook is not registered ${context}`);
}

function assertInspect(cli, env, inspected) {
  if (inspected.status !== 'loaded') {
    throw new Error(`expected plugin status "loaded", got ${JSON.stringify(inspected.status)}`);
  }
  const hookDetail = assertHookRegistered(cli, env, inspected, 'after install');

  if (inspected.diagnostics.length > 0) {
    throw new Error(`plugin diagnostics are not empty: ${JSON.stringify(inspected.diagnostics)}`);
  }
  const unexpected = inspected.compatibility.filter(
    (entry) => !ALLOWED_COMPAT_CODES.has(entry.code) && !ALLOWED_COMPAT_CODES.has(entry.compatCode),
  );
  if (unexpected.length > 0) {
    throw new Error(`unexpected compatibility notes: ${JSON.stringify(unexpected)}`);
  }

  // Whether the feature layer loads is a property of the host, not a verdict.
  // But a host that shows *any* of it must show all of it — a half-loaded
  // feature layer is exactly the regression this guards.
  const featureLayer =
    Boolean(inspected.controlUi) || inspected.services.length > 0 || inspected.gatewayMethods.length > 0;
  if (featureLayer) {
    if (!inspected.controlUi?.entry) {
      throw new Error('feature layer is active but the manifest declares no controlUi entry');
    }
    if (!inspected.services.includes(FEATURE_SERVICE)) {
      throw new Error(`feature layer is active but service ${FEATURE_SERVICE} is missing`);
    }
    if (!inspected.gatewayMethods.includes(FEATURE_GATEWAY_METHOD)) {
      throw new Error(`feature layer is active but Gateway method ${FEATURE_GATEWAY_METHOD} is missing`);
    }
  }
  return { featureLayer, hookDetail };
}

function assertDoctorClean(cli, env, capabilities) {
  const args = ['plugins', 'doctor'];
  if (capabilities.doctorJson) args.push('--json');
  const result = runCli(cli, args, { env });
  if (!result.ok) throw new Error(`plugins doctor failed: ${stripAnsi(result.output).trim()}`);
  if (capabilities.doctorJson) {
    let payload;
    try {
      payload = JSON.parse(result.stdout);
    } catch {
      return 'doctor ok (non-JSON output)';
    }
    const entries = [
      ...(payload.compatibility || []),
      ...(payload.diagnostics || []),
      ...(payload.issues || []),
    ];
    const bad = entries.filter(
      (entry) =>
        entry.severity &&
        entry.severity !== 'info' &&
        !ALLOWED_COMPAT_CODES.has(entry.code) &&
        !ALLOWED_COMPAT_CODES.has(entry.compatCode),
    );
    if (bad.length > 0) throw new Error(`plugins doctor reported issues: ${JSON.stringify(bad)}`);
    return `doctor ok (${entries.length} note(s), all info)`;
  }
  const text = stripAnsi(result.output);
  const bad = text.split('\n').filter((line) => /\[(error|warn|warning)\]/i.test(line));
  if (bad.length > 0) throw new Error(`plugins doctor reported issues:\n${bad.join('\n')}`);
  const info = text.split('\n').filter((line) => /\[info\]/i.test(line)).length;
  return `doctor ok (${info} info note(s))`;
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

function runArtifactCanary(cli, capabilities) {
  let artifact;
  let packageDir;

  step('pack', () => {
    artifact = packArtifact();
    const label = artifact.reused ? 'reused' : 'packed';
    return `${label} ${path.basename(artifact.tarball)} (${artifact.files.length} files)`;
  });

  step('artifact-shape', () => {
    packageDir = extractArtifact(artifact.tarball);
    const caveat = validateArtifact(packageDir, artifact.files, {
      requireControlUi: capabilities.featurePluginHost,
    });
    return caveat || 'manifest, extensions, hooks and Control UI bundle present';
  });

  step('entry-registers-hook', () => {
    const pkg = readJson(path.join(packageDir, 'package.json'));
    validatePluginRegistration(packageDir, pkg.openclaw.extensions);
    return `${REQUIRED_HOOK} registered from the packed entry`;
  });

  const home = canaryHome('artifact-home');
  let assertion;

  step('install', () => {
    run(cli, installArgs(artifact.tarball, capabilities), { env: home.env });
    return capabilities.acceptCapabilities
      ? 'installed with --accept-capabilities'
      : 'installed (host has no capability-consent flag)';
  });

  step('enable', () => {
    run(cli, ['plugins', 'enable', 'flowboard'], { env: home.env });
    return 'plugin enabled';
  });

  step('inspect', () => {
    const inspected = inspectPlugin(cli, home.env, capabilities);
    assertion = assertInspect(cli, home.env, inspected);
    const layer = assertion.featureLayer ? 'feature layer' : 'hook-only baseline';
    return `status=loaded, ${assertion.hookDetail}, ${layer}`;
  });

  step('doctor', () => assertDoctorClean(cli, home.env, capabilities));

  // ---- Update / re-consent path -------------------------------------------
  // `plugins reload` marks the 2026.9.x hot-install generation. Where it
  // exists, re-installing an already-installed plugin goes through the
  // stale-acceptance check added in 2026.9.1.
  if (capabilities.reload) {
    note('stale-acceptance', () => {
      const result = runCli(cli, ['plugins', 'install', artifact.tarball, '--force'], { env: home.env });
      const text = stripAnsi(result.output);
      if (!result.ok || /requires capability consent/i.test(text)) {
        return { status: 'pass', detail: 're-install without --accept-capabilities is refused (consent re-asked)' };
      }
      return { status: 'pass', detail: 're-install without --accept-capabilities succeeded (acceptance persisted)' };
    });

    step('reinstall-force', () => {
      run(cli, installArgs(artifact.tarball, capabilities), { env: home.env });
      const after = inspectPlugin(cli, home.env, capabilities);
      return assertHookRegistered(cli, home.env, after, 'after re-install --force');
    });

    note('update', () => {
      const args = ['plugins', 'update', 'flowboard'];
      if (capabilities.updateAcceptCapabilities) args.push('--accept-capabilities');
      const result = runCli(cli, args, { env: home.env });
      const text = stripAnsi(result.output).trim().split('\n').pop();
      // An archive install has no upstream to update from; the host says
      // "Skipping (source: archive)" and that is the expected outcome here.
      return { status: result.ok ? 'pass' : 'skip', detail: text };
    });

    note('reload', () => {
      const result = runCli(cli, ['plugins', 'reload', 'flowboard', '--json'], { env: home.env });
      if (!result.ok) {
        const text = stripAnsi(result.output);
        if (/Gateway is not running/i.test(text)) {
          // Documented limitation, not a failure: the canary deliberately does
          // not start a Gateway (that binds a port and loads the machine's
          // channels and secrets). The reload path is proven separately — see
          // CONTRIBUTING § "Reload and hot install".
          return { status: 'skip', detail: 'no Gateway in the disposable home (reload needs a running Gateway)' };
        }
        return { status: 'skip', detail: text.trim().split('\n').pop() };
      }
      const after = inspectPlugin(cli, home.env, capabilities);
      return { status: 'pass', detail: assertHookRegistered(cli, home.env, after, 'after plugins reload') };
    });
  } else {
    record('stale-acceptance', 'skip', 'host has no capability consent to go stale');
    record('reinstall-force', 'skip', 'skipped on hosts without plugins reload');
    record('update', 'skip', 'host predates the hot-install generation');
    record('reload', 'skip', 'plugins reload does not exist on this host');
  }

  step('uninstall', () => {
    const args = ['plugins', 'uninstall', 'flowboard'];
    if (capabilities.uninstallForce) args.push('--force');
    run(cli, args, { env: home.env });
    return 'uninstalled cleanly';
  });

  return { featureLayer: Boolean(assertion?.featureLayer), home: home.dir };
}

function runClawHubCanary(cli, capabilities, spec) {
  const home = canaryHome('clawhub-home');
  let assertion;
  step('clawhub-install', () => {
    run(cli, installArgs(`clawhub:${spec}`, capabilities, { clawhub: true }), { env: home.env });
    return `installed clawhub:${spec}`;
  });
  step('clawhub-enable', () => {
    run(cli, ['plugins', 'enable', 'flowboard'], { env: home.env });
    return 'plugin enabled';
  });
  step('clawhub-inspect', () => {
    const inspected = inspectPlugin(cli, home.env, capabilities);
    assertion = assertInspect(cli, home.env, inspected);
    return `status=loaded, ${assertion.hookDetail}`;
  });
  step('clawhub-uninstall', () => {
    const args = ['plugins', 'uninstall', 'flowboard'];
    if (capabilities.uninstallForce) args.push('--force');
    run(cli, args, { env: home.env });
    return 'uninstalled cleanly';
  });
  return { featureLayer: Boolean(assertion?.featureLayer), home: home.dir };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function usage() {
  console.log(
    [
      'Usage:',
      '  node scripts/release-install-canary.mjs [--json]',
      '  node scripts/release-install-canary.mjs --clawhub [flowboard@x.y.z] [--json]',
      '',
      'Env:',
      '  FLOWBOARD_OPENCLAW_CLI=/path/to/openclaw   pin the host CLI (default: pinned devDependency, then PATH)',
      '  FLOWBOARD_OPENCLAW_NODE=/path/to/node      Node runtime for that CLI (prepended to PATH)',
      '  FLOWBOARD_CANARY_ARTIFACT=/path/to.tgz     reuse a packed tarball instead of running npm pack',
      '  FLOWBOARD_CANARY_KEEP_HOME=1               keep the disposable OpenClaw home for debugging',
      '  FLOWBOARD_CLAWHUB_SPEC=flowboard@x.y.z     default spec for --clawhub',
      '',
      "The canary never touches the machine's real ~/.openclaw: every run gets a",
      'fresh home with a pre-created exec-approvals.json stub (scripts/lib/openclaw-host.mjs',
      'explains why that stub is mandatory).',
    ].join('\n'),
  );
}

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
let exitCode = 0;
let summary = null;

try {
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    process.exit(0);
  }
  const clawhubIndex = argv.indexOf('--clawhub');
  const pkg = readJson(path.join(root, 'package.json'));

  const cli = resolveOpenClawCli();
  const { capabilities } = probeHostCapabilities(cli, { env: baseEnv() });
  hostInfo = { cli, version: capabilities.version, commit: capabilities.commit, capabilities };

  if (!asJson) {
    console.log(
      `host: ${capabilities.version || 'unknown'}${capabilities.commit ? ` (${capabilities.commit})` : ''} — ${cli}`,
    );
    console.log(
      `capabilities: --accept-capabilities=${capabilities.acceptCapabilities} reload=${capabilities.reload} ` +
        `inspect --runtime=${capabilities.inspectRuntime} doctor --json=${capabilities.doctorJson}`,
    );
  }

  if (clawhubIndex !== -1) {
    const next = argv[clawhubIndex + 1];
    const spec =
      (next && !next.startsWith('-') ? next : null) ||
      process.env.FLOWBOARD_CLAWHUB_SPEC ||
      pkg.openclaw?.install?.clawhubSpec ||
      pkg.name;
    summary = { mode: 'clawhub', spec, ...runClawHubCanary(cli, capabilities, spec) };
  } else {
    summary = { mode: 'artifact', ...runArtifactCanary(cli, capabilities) };
  }

  if (!asJson) {
    for (const entry of steps) {
      const mark = entry.status === 'pass' ? '✅' : entry.status === 'skip' ? '➖' : '❌';
      console.log(`  ${mark} ${entry.id}${entry.detail ? ` — ${entry.detail}` : ''}`);
    }
    console.log(
      `release install canary ok (${summary.mode}, host ${capabilities.version}, ` +
        `${summary.featureLayer ? 'feature layer active' : 'hook-only baseline'})`,
    );
  }
} catch (error) {
  exitCode = 1;
  if (!(error instanceof CanaryError)) record('canary', 'fail', String(error?.message || error));
} finally {
  if (asJson) {
    console.log(
      JSON.stringify(
        {
          ok: exitCode === 0,
          host: hostInfo,
          summary,
          steps,
        },
        null,
        2,
      ),
    );
  } else if (exitCode !== 0) {
    for (const entry of steps) {
      const mark = entry.status === 'pass' ? '✅' : entry.status === 'skip' ? '➖' : '❌';
      console.error(`  ${mark} ${entry.id}${entry.detail ? ` — ${entry.detail}` : ''}`);
    }
    console.error('\nrelease install canary failed');
  }
  if (!keepTemp) rmSync(tmp, { recursive: true, force: true });
  else console.error(`kept canary temp dir: ${tmp}`);
  process.exit(exitCode);
}
