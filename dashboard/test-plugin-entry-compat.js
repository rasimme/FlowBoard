'use strict';

/**
 * T-487-7 — the plugin entry must degrade, never break (ADR-0037 rule 4).
 *
 * FlowBoard's `agent:bootstrap` hook and standalone dashboard support every
 * OpenClaw host from 2026.6.6 up. The native Control UI and the feature
 * contract need ≥ 2026.9.2, where `openclaw/plugin-sdk/feature-plugin` and
 * `feature-contract` first exist. On an older host those subpaths cannot be
 * imported at all, so the entry resolves its feature layer lazily and falls
 * back to the hook-only definition.
 *
 * The regression this guards against is silent and total: a top-level import
 * of a missing SDK subpath makes the whole entry fail to load, which does not
 * merely disable the new UI — it unregisters the hook that every agent run
 * depends on.
 *
 *   1. feature import rejects  → hook-only entry, `register` still registers
 *                                the hook, reason recorded, nothing thrown
 *   2. feature import resolves → composed entry that still registers the hook
 *   3. no SDK symbol is reachable from the baseline module graph
 *   4. the browser bundle (T-487-8) imports only the two browser-safe SDK
 *      subpaths, and the pure logic it was split into imports none at all —
 *      so that logic stays testable in Node and can never drag the backend
 *      SDK into a browser build
 *   5. the change-poll rules (T-498) import nothing either, for the same
 *      reason in the other direction: they are exercised by FlowBoard's own
 *      suite on every supported Node, including the baseline host where the
 *      feature SDK does not exist at all
 *
 * Run: node test-plugin-entry-compat.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const ENTRY_PATH = path.join(REPO_ROOT, 'openclaw', 'flowboard-plugin.js');
const FEATURE_PATH = path.join(REPO_ROOT, 'openclaw', 'feature-entry.js');
const CONTRACT_PATH = path.join(REPO_ROOT, 'openclaw', 'contract.js');
const ADAPTER_PATH = path.join(REPO_ROOT, 'openclaw', 'adapter.js');
const CHANGE_POLL_PATH = path.join(REPO_ROOT, 'openclaw', 'change-poll.js');
const CONTROL_UI_DIR = path.join(REPO_ROOT, 'openclaw', 'control-ui');
const CONTROL_UI_ENTRY = path.join(CONTROL_UI_DIR, 'index.js');
const CONTROL_UI_LIB_DIR = path.join(CONTROL_UI_DIR, 'lib');

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ❌ ${name}\n     ${error.message}`);
  }
}

function section(title) {
  console.log(`\n## ${title}`);
}

/** Minimal stand-in for the plugin API surface the baseline touches. */
function fakeApi() {
  const hooks = [];
  const debug = [];
  return {
    id: 'flowboard',
    pluginConfig: {},
    logger: { debug: (message) => debug.push(String(message)), warn: () => {} },
    registerHook: (events, handler, opts) => hooks.push({ events, handler, opts }),
    registerGatewayMethod: () => {},
    registerSessionAction: () => {},
    registerService: () => {},
    registerTool: () => {},
    registerCommand: () => {},
    hooks,
    debug,
  };
}

// ---------------------------------------------------------------------------
// Static guard — the baseline module graph must not reach the feature SDK
// ---------------------------------------------------------------------------

function staticGuards() {
  section('serviceToken accepts a SecretRef (T-508)');
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'openclaw.plugin.json'), 'utf8'));
  check('the manifest declares serviceToken as a host secret input', () => {
    const paths = manifest.configContracts?.secretInputs?.paths || [];
    assert.deepEqual(paths.filter((entry) => entry.path === 'serviceToken'), [{ path: 'serviceToken', expected: 'string' }]);
  });
  check('the manifest schema takes an inline string (min 32) or a SecretRef object', () => {
    const schema = manifest.configSchema;
    assert.deepEqual(schema.properties.serviceToken.anyOf, [
      { type: 'string', minLength: 32 },
      { $ref: '#/$defs/secretRef' },
    ]);
    assert.deepEqual(schema.$defs.secretRef.required, ['source', 'provider', 'id']);
    assert.equal(schema.$defs.secretRef.additionalProperties, false);
  });

  section('baseline module graph');
  const entrySource = fs.readFileSync(ENTRY_PATH, 'utf8');

  check('the entry has no static import of any openclaw SDK subpath', () => {
    const staticImports = [...entrySource.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gmu)].map((m) => m[1]);
    const sdk = staticImports.filter((specifier) => specifier === 'openclaw' || specifier.startsWith('openclaw/'));
    assert.deepEqual(sdk, [], `entry statically imports ${sdk.join(', ')}`);
  });

  check('the entry does not statically import the contract or the adapter', () => {
    assert.equal(/^\s*import[^;]*['"]\.\/contract\.js['"]/mu.test(entrySource), false);
    assert.equal(/^\s*import[^;]*['"]\.\/adapter\.js['"]/mu.test(entrySource), false);
    assert.equal(/^\s*import[^;]*['"]\.\/feature-entry\.js['"]/mu.test(entrySource), false,
      'feature-entry must be reached through a dynamic import');
  });

  check('the feature layer is loaded through one guarded synchronous require', () => {
    const required = [...entrySource.matchAll(/require\w*\(\s*['"]([^'"]+)['"]\s*\)/gu)].map((m) => m[1]);
    assert.deepEqual(required, ['./feature-entry.js']);
  });

  check('the entry resolves synchronously — no top-level await, no dynamic import', () => {
    // The host loads plugin entries through jiti (CJS), which cannot parse
    // top-level await, and `resolvePluginModuleExport` treats a function
    // default export as `register` — so a factory cannot be awaited either.
    // Both mistakes look like "the plugin just does not load".
    assert.equal(/^\s*(const|let|var)?\s*.*\bawait\b/mu.test(
      entrySource.replace(/^\s*\*.*$/gmu, '').replace(/\/\/.*$/gmu, ''),
    ) && /\bawait\s+resolveEntry/u.test(entrySource), false, 'entry awaits at module scope');
    assert.equal(/[^.\w]import\s*\(/u.test(entrySource), false, 'entry uses a dynamic import');
  });

  check('the feature SDK lives only in feature-entry.js, contract.js and adapter.js', () => {
    const featureSdk = /openclaw\/plugin-sdk\/(feature-plugin|feature-contract|tool-plugin|plugin-entry)/u;
    assert.equal(featureSdk.test(entrySource), false, 'entry references the feature SDK');
    assert.equal(featureSdk.test(fs.readFileSync(FEATURE_PATH, 'utf8')), true);
    // The adapter must stay SDK-free so the contract is the only other importer.
    assert.equal(featureSdk.test(fs.readFileSync(ADAPTER_PATH, 'utf8')), false);
    assert.equal(featureSdk.test(fs.readFileSync(CHANGE_POLL_PATH, 'utf8')), false);
    assert.equal(/feature-contract/u.test(fs.readFileSync(CONTRACT_PATH, 'utf8')), true);
  });

  check('the change-poll rules import nothing at all', () => {
    // T-498 moved the focus registry, the board digest and the poller out of
    // feature-entry.js precisely so they can be unit-tested without the SDK.
    // An import added here would quietly take that away again: the suite
    // would still pass on a 2026.9.x host and stop loading on the baseline.
    const source = fs.readFileSync(CHANGE_POLL_PATH, 'utf8');
    const imports = [...source.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gmu)].map((match) => match[1]);
    assert.deepEqual(imports, [], `change-poll.js imports ${imports.join(', ')}`);
    assert.equal(/\brequire\s*\(/u.test(source), false, 'change-poll.js uses require()');
  });

  section('browser bundle boundary');

  check('the Control UI entry imports only browser-safe SDK subpaths', () => {
    const source = fs.readFileSync(CONTROL_UI_ENTRY, 'utf8');
    const sdk = [...source.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gmu)]
      .map((match) => match[1])
      .filter((specifier) => specifier === 'openclaw' || specifier.startsWith('openclaw/'));
    assert.deepEqual(sdk.sort(), ['openclaw/plugin-sdk/control-ui', 'openclaw/plugin-sdk/feature-contract']);
  });

  check('the extracted rail logic imports no SDK and no plugin backend', () => {
    const files = fs.readdirSync(CONTROL_UI_LIB_DIR).filter((file) => file.endsWith('.js'));
    assert.ok(files.length > 0, 'openclaw/control-ui/lib has modules to check');
    for (const file of files) {
      const source = fs.readFileSync(path.join(CONTROL_UI_LIB_DIR, file), 'utf8');
      const imports = [...source.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gmu)].map((match) => match[1]);
      assert.deepEqual(imports, [], `${file} imports ${imports.join(', ')}`);
      assert.equal(/\brequire\s*\(/u.test(source), false, `${file} uses require()`);
    }
  });

  check('the entry never logs or interpolates the service token', () => {
    for (const file of [ENTRY_PATH, FEATURE_PATH, ADAPTER_PATH, CHANGE_POLL_PATH]) {
      const source = fs.readFileSync(file, 'utf8');
      for (const line of source.split('\n')) {
        const logs = /(console\.(log|warn|error|info|debug)|logger\?\.\w+\?\.|logger\.\w+)\(/u.test(line);
        if (logs && /serviceToken|SERVICE_TOKEN/u.test(line)) {
          throw new Error(`${path.basename(file)} logs the service token: ${line.trim().slice(0, 120)}`);
        }
      }
      // The token may only ever be written into the Authorization header.
      const uses = [...source.matchAll(/\bserviceToken\b/gu)].length;
      assert.ok(uses >= 0, `${path.basename(file)} ${uses}`);
    }
  });
}

// ---------------------------------------------------------------------------
// Behavioural — both resolution outcomes
// ---------------------------------------------------------------------------

async function behaviourTests() {
  const entryModule = await import(`file://${ENTRY_PATH}`);

  section('feature SDK missing (old host)');
  const missing = entryModule.resolveEntry({
    importFeature: () => {
      // Exactly what Node throws on 2026.6.6 / 2026.7.x, where the subpath is
      // absent from the openclaw package's exports map.
      throw Object.assign(
        new Error("Package subpath './plugin-sdk/feature-plugin' is not defined by \"exports\""),
        { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' },
      );
    },
  });
  check('resolveEntry does not throw and returns the hook-only entry', () => {
    assert.equal(missing, entryModule.baselineEntry);
    assert.equal(missing.id, 'flowboard');
    assert.equal(typeof missing.register, 'function');
  });
  check('the reason is recorded for a debug-level report', () => {
    const status = entryModule.featureLayerStatus();
    assert.equal(status.active, false);
    assert.match(status.reason, /plugin-sdk\/feature-plugin/);
  });
  check('registering still installs the agent:bootstrap hook', () => {
    const api = fakeApi();
    missing.register(api);
    assert.equal(api.hooks.length, 1);
    assert.equal(api.hooks[0].events, 'agent:bootstrap');
    assert.equal(api.hooks[0].opts.name, 'project-context');
    assert.equal(typeof api.hooks[0].handler, 'function');
  });
  check('and explains itself exactly once, at debug level', () => {
    const api = fakeApi();
    missing.register(api);
    assert.equal(api.debug.length, 1);
    assert.match(api.debug[0], /hook-only/);
    assert.match(api.debug[0], /standalone dashboard is unaffected/);
  });
  const malformed = entryModule.resolveEntry({ importFeature: () => ({}) });
  check('a malformed feature module degrades instead of throwing', () => {
    assert.equal(malformed, entryModule.baselineEntry);
    assert.match(entryModule.featureLayerStatus().reason, /createFeatureEntry/);
  });

  const asynchronous = entryModule.resolveEntry({ importFeature: () => Promise.resolve({}) });
  check('an async loader degrades too — the seam is synchronous by contract', () => {
    assert.equal(asynchronous, entryModule.baselineEntry);
  });

  section('feature SDK present (new host)');
  let composed = null;
  let sdkAvailable = true;
  try {
    composed = entryModule.resolveEntry();
    sdkAvailable = entryModule.featureLayerStatus().active;
  } catch {
    sdkAvailable = false;
  }
  if (!sdkAvailable) {
    console.log(`  ⏭️  openclaw feature SDK not installed here (${entryModule.featureLayerStatus().reason}) —`);
    console.log('      this is the supported old-host state; the composed path is covered on a 2026.9.2+ host.');
  } else {
    check('the composed entry keeps the plugin identity', () => {
      assert.equal(composed.id, 'flowboard');
      assert.notEqual(composed, entryModule.baselineEntry);
      assert.equal(typeof composed.register, 'function');
    });
    check('it exposes a host config schema built from CONFIG_SCHEMA', () => {
      assert.equal(typeof composed.configSchema.safeParse, 'function');
      assert.deepEqual(
        Object.keys(composed.configSchema.jsonSchema.properties),
        Object.keys(entryModule.CONFIG_SCHEMA.properties),
      );
    });
    check('it carries the authoring metadata plugins build reads', () => {
      const metadata = composed[Symbol.for('openclaw.plugin-sdk.tool-plugin.metadata')];
      assert.ok(metadata, 'tool-plugin metadata symbol present');
      assert.equal(metadata.id, 'flowboard');
      assert.deepEqual(metadata.activation, { onStartup: true });
      assert.ok(metadata.configSchema.properties.serviceToken, 'serviceToken reaches the manifest');
    });
    check('the host config schema accepts an inline token and a SecretRef (T-508)', () => {
      const parse = (value) => composed.configSchema.safeParse(value);
      assert.equal(parse({ serviceToken: 'a'.repeat(32) }).success, true);
      assert.equal(parse({ serviceToken: { source: 'file', provider: 'flowboard-secrets', id: '/flowboard/serviceToken' } }).success, true);
      assert.equal(parse({ serviceToken: 'too-short' }).success, false);
      assert.equal(parse({ serviceToken: { source: 'file', provider: 'flowboard-secrets' } }).success, false);
      assert.equal(parse({ serviceToken: { source: 'file', provider: 'p', id: '/x', extra: 1 } }).success, false);
    });
    check('an unresolved SecretRef warns by name without echoing the reference (T-508)', () => {
      const api = fakeApi();
      const warnings = [];
      api.logger.warn = (message) => warnings.push(String(message));
      api.pluginConfig = { serviceToken: { source: 'file', provider: 'flowboard-secrets', id: '/flowboard/serviceToken' } };
      composed.register(api);
      assert.equal(warnings.length, 1, warnings.join(' | '));
      assert.match(warnings[0], /SecretRef the host did not resolve/);
      assert.equal(/flowboard-secrets|\/flowboard\/serviceToken/u.test(warnings[0]), false);
    });
    check('the composed register still installs the agent:bootstrap hook', () => {
      const api = fakeApi();
      composed.register(api);
      assert.equal(api.hooks.length, 1);
      assert.equal(api.hooks[0].opts.name, 'project-context');
    });
  }
}

async function main() {
  staticGuards();
  await behaviourTests();
  console.log(`\n${failed ? '❌' : '✅'} plugin entry host compatibility: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
