/**
 * FlowBoard OpenClaw plugin entry.
 *
 * The entry is deliberately layered, because FlowBoard supports a wider range
 * of hosts than its newest surface does (ADR-0037 rule 4, progressive
 * enhancement):
 *
 *  - **Baseline — every host ≥ 2026.6.6.** The `agent:bootstrap` hook that
 *    live-injects the active project (ADR-0001), plus the standalone
 *    dashboard. This layer imports nothing but FlowBoard's own hook handler,
 *    so it cannot fail to load on an older Gateway.
 *  - **Feature layer — hosts ≥ 2026.9.2.** `./feature-entry.js` adds the typed
 *    feature contract and the native Control UI page. It is the only module
 *    that touches `openclaw/plugin-sdk/feature-*`; those subpaths do not exist
 *    on 2026.6.6 / 2026.7.x, so it is loaded behind a guard and a missing SDK
 *    downgrades FlowBoard instead of breaking it.
 *
 * The guard is a *synchronous* require, and both halves of that are forced:
 *
 *  - Top-level `await` cannot be used. Hosts load plugin entries through jiti,
 *    which transpiles this module to CommonJS, and the parse fails outright
 *    ("await is only valid in async functions…") — measured on 2026.9.5.
 *  - An async factory export cannot be used either: the runtime's
 *    `resolvePluginModuleExport` treats a function default export as the
 *    plugin's `register`, not as something to call for an entry.
 *
 * The host installs its own module-resolution aliases for
 * `openclaw/plugin-sdk/*`, so this require reaches the *running host's* SDK
 * and works for an ordinary package install with no vendored `node_modules`
 * (verified on 2026.9.5 with a dependency-free copy install).
 *
 * A failed load is never fatal and never noisy: the reason is kept and
 * reported once, at debug level, when the plugin registers.
 */
import { createRequire } from 'node:module';

import { createProjectContextHandler } from '../hooks/project-context/handler.js';

const requireFromEntry = createRequire(import.meta.url);

export const PLUGIN_ID = 'flowboard';
export const PLUGIN_NAME = 'FlowBoard';
export const PLUGIN_DESCRIPTION =
  'Project workspaces, dashboard, and project-context hook for OpenClaw agents.';

export const CONFIG_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    projectsDir: {
      type: 'string',
      minLength: 1,
      description: 'Optional override for FLOWBOARD_PROJECTS_DIR.',
    },
    dashboardPort: {
      type: 'number',
      minimum: 1,
      maximum: 65535,
      description: 'Optional dashboard port the project-context hook uses when dashboardBaseUrl is not set (default 18700).',
    },
    dashboardBaseUrl: {
      type: 'string',
      minLength: 1,
      description: 'Optional dashboard API base URL for the project-context hook, for example http://localhost:18843.',
    },
    serviceToken: {
      type: 'string',
      minLength: 32,
      description:
        'Service credential shared with the dashboard (FLOWBOARD_SERVICE_TOKEN). Lets the Gateway act for the signed-in operator; store it as a SecretRef, never inline.',
    },
  },
};

/** Why the feature layer is not active, or null while it is. */
let featureUnavailableReason = null;

/** Test seam: the reason string the last resolveEntry() call settled on. */
export function featureLayerStatus() {
  return featureUnavailableReason === null
    ? { active: true, reason: null }
    : { active: false, reason: featureUnavailableReason };
}

/**
 * The baseline registration: FlowBoard's oldest and only required contract.
 *
 * The feature layer calls this too, so the hook behaves identically on every
 * host — it is never re-implemented for the new path.
 */
export function registerBaseline(api) {
  api.registerHook('agent:bootstrap', createProjectContextHandler(api.pluginConfig || {}), {
    name: 'project-context',
    description: 'Live-injects active FlowBoard project context before every agent run',
  });
  if (featureUnavailableReason) {
    api.logger?.debug?.(
      `[flowboard] native Gateway facade unavailable on this host (${featureUnavailableReason}); running hook-only. The standalone dashboard is unaffected.`,
    );
  }
}

/** Hook-only plugin definition — the shape FlowBoard shipped before T-487-7. */
export const baselineEntry = {
  id: PLUGIN_ID,
  name: PLUGIN_NAME,
  description: PLUGIN_DESCRIPTION,
  configSchema: CONFIG_SCHEMA,
  register: registerBaseline,
};

/**
 * Resolve the entry this host can actually run.
 *
 * `importFeature` is injectable so the fallback can be exercised without an
 * old host. It must be synchronous, like the production default: a loader that
 * returns a promise degrades to the baseline rather than silently half-loading.
 */
export function resolveEntry({ importFeature } = {}) {
  const load = importFeature || (() => requireFromEntry('./feature-entry.js'));
  try {
    const module = load();
    const create = module?.createFeatureEntry || module?.default;
    if (typeof create !== 'function') {
      throw new Error('feature entry does not export createFeatureEntry');
    }
    const composed = create(baselineEntry);
    featureUnavailableReason = null;
    return composed;
  } catch (error) {
    // An older host has no feature SDK. Anything else that goes wrong here is
    // equally non-fatal: the hook is what must not be lost.
    featureUnavailableReason = String(error?.message || error).slice(0, 200);
    return baselineEntry;
  }
}

const entry = resolveEntry();

export default entry;
