/**
 * FlowBoard feature-plugin layer (T-487-7).
 *
 * This module is the *only* place that imports the OpenClaw feature SDK, and
 * `openclaw/flowboard-plugin.js` loads it behind a guard. On a host older than
 * 2026.9.2 the `openclaw/plugin-sdk/feature-plugin` and `feature-contract`
 * subpaths do not exist, loading this module throws, and FlowBoard keeps
 * running as the hook-only plugin it has always been (ADR-0037 rule 4,
 * progressive enhancement). Nothing reachable from here — including
 * `./contract.js` and `./adapter.js` — may appear on the baseline path.
 *
 * Two host limitations shape the composition (both verified on 2026.9.5):
 *
 *  1. `defineFeaturePlugin` has no `configSchema` option, and the generated
 *     manifest takes `configSchema` from the entry's authoring metadata
 *     (plugins-authoring-command-*.mjs, `buildToolPluginManifest`). FlowBoard
 *     needs real config keys, so the feature entry is composed into a
 *     `definePluginEntry` that carries the schema, and the published metadata
 *     is re-emitted with it. Everything used here is public plugin SDK.
 *
 *  2. A feature operation runs on the plugin session-action transport, whose
 *     handler context only receives `client: { connId, scopes }`
 *     (agent-harness-runtime-*.d.ts:4704-4714, plugin-host-hooks-*.mjs:113-123)
 *     — not the authenticated operator profile. The verified profile is
 *     therefore captured once per connection through the narrow
 *     `flowboard.ui.identity` Gateway method, which *does* receive the
 *     host-attested client, and looked up by `connId` afterwards. The browser
 *     never supplies the identity; it only triggers the capture. See ADR-0040.
 */
import { defineFeaturePlugin } from 'openclaw/plugin-sdk/feature-plugin';
import { buildJsonPluginConfigSchema, definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { getToolPluginMetadata, toolPluginMetadataSymbol } from 'openclaw/plugin-sdk/tool-plugin';

import { createFlowBoardAdapter, FlowBoardAdapterError } from './adapter.js';
import { contract } from './contract.js';

/** Bounded per-connection identity cache; oldest entry is evicted first. */
const MAX_TRACKED_CONNECTIONS = 64;

/**
 * Per-connection map of Gateway-verified operator identities.
 *
 * Only `flowboard.ui.identity` writes to it, and only from the host-supplied
 * `client` object, so a browser cannot inject a profile it does not own.
 */
function createPrincipalRegistry() {
  const byConnection = new Map();
  return {
    remember(connId, principal) {
      if (!connId) return;
      byConnection.delete(connId);
      byConnection.set(connId, principal);
      while (byConnection.size > MAX_TRACKED_CONNECTIONS) {
        const oldest = byConnection.keys().next();
        if (oldest.done) break;
        byConnection.delete(oldest.value);
      }
    },
    forget(connId) {
      if (connId) byConnection.delete(connId);
    },
    get(connId) {
      return (connId && byConnection.get(connId)) || null;
    },
    get size() {
      return byConnection.size;
    },
  };
}

function readConnectionProfile(client) {
  // The verified profile lives on the GatewayClient itself. `connect` is the
  // client's own handshake payload and carries no profile — reading it there
  // silently yields an unattributed operator (measured, 2026.9.5).
  const profile = client?.authenticatedUserProfile || client?.connect?.authenticatedUserProfile;
  const profileId = typeof profile?.profileId === 'string' ? profile.profileId : null;
  if (!profileId) return null;
  return {
    profileId,
    displayName: typeof profile.displayName === 'string' ? profile.displayName : null,
  };
}

function readConnectionScopes(source) {
  const scopes = Array.isArray(source) ? source : [];
  return scopes.filter((scope) => typeof scope === 'string');
}

function optionalString(value) {
  return typeof value === 'string' && value ? value : null;
}

/**
 * Compose the effective caller identity for one operation.
 *
 * The profile half is server-attested (captured per connection). `agentId` and
 * `sessionKey` are descriptive routing context: FlowBoard records them, it
 * never authorizes on them (ADR-0033, ADR-0003).
 */
function resolveCallerPrincipal(registry, context, input) {
  const action = context?.source === 'session-action' ? context.action : null;
  const connId = optionalString(action?.client?.connId);
  const bound = registry.get(connId);
  const scopes = readConnectionScopes(action?.client?.scopes);
  return {
    profileId: bound?.profileId ?? null,
    displayName: bound?.displayName ?? null,
    scopes: scopes.length ? scopes : readConnectionScopes(bound?.scopes),
    agentId: optionalString(input?.agentId) || optionalString(action?.agentId),
    sessionKey: optionalString(input?.sessionKey) || optionalString(action?.sessionKey),
  };
}

/** Feature handlers report FlowBoard's own message, never a stack or a body. */
async function guarded(run) {
  try {
    return await run();
  } catch (error) {
    if (error instanceof FlowBoardAdapterError) {
      throw Object.assign(new Error(error.message), { code: error.code });
    }
    throw error;
  }
}

/**
 * Build the feature-plugin entry.
 *
 * `baseline` is the hook-only plugin definition from flowboard-plugin.js: its
 * `register` still runs first here, so the `agent:bootstrap` contract behaves
 * identically whether or not the feature SDK was available.
 */
export function createFeatureEntry(baseline) {
  const featureEntry = defineFeaturePlugin({
    contract,
    name: baseline.name,
    description: baseline.description,
    setup(api, events) {
      const pluginConfig = api.pluginConfig || {};
      const adapter = createFlowBoardAdapter(pluginConfig);
      const registry = createPrincipalRegistry();

      // Exactly what an old host registers, and nothing else: the
      // project-context hook stays the baseline contract (ADR-0001).
      baseline.register(api);

      if (!adapter.hasServiceToken()) {
        api.logger?.warn?.(
          '[flowboard] no serviceToken configured — Gateway operations are attributed to the local operator, not to the signed-in profile.',
        );
      }

      // Identity bridge. The Control UI calls this once when its page mounts.
      // It is deliberately read-only and returns nothing the caller did not
      // already prove: its purpose is to move the host-attested profile of THIS
      // connection into the registry the feature handlers read.
      api.registerGatewayMethod(
        'flowboard.ui.identity',
        async (opts) => {
          const client = opts?.client;
          const connId = optionalString(client?.connId);
          const profile = readConnectionProfile(client);
          if (profile) {
            registry.remember(connId, { ...profile, scopes: readConnectionScopes(client?.connect?.scopes) });
            client?.connectionSignal?.addEventListener?.('abort', () => registry.forget(connId), { once: true });
          } else {
            registry.forget(connId);
          }
          opts.respond(true, {
            dashboardUrl: adapter.dashboardUrl(),
            profileBound: Boolean(profile),
            displayName: profile?.displayName ?? null,
          });
        },
        { scope: 'operator.read', profileAccess: 'required' },
      );

      const principal = (context, input) => resolveCallerPrincipal(registry, context, input);

      return {
        'ui.config': () => ({ dashboardUrl: adapter.dashboardUrl() }),

        'projects.list': (input, context) =>
          guarded(async () => ({ projects: await adapter.listProjects(principal(context, input)) })),

        'status.get': (input, context) => guarded(() => adapter.getStatus(principal(context, input), input)),

        'tasks.list': (input, context) =>
          guarded(async () => ({ tasks: await adapter.listTasks(principal(context, input), input) })),

        'status.set': (input, context) =>
          guarded(async () => {
            const result = await adapter.setStatus(principal(context, input), input);
            events.emit('projects-changed', {});
            return result;
          }),

        'task.create': (input, context) =>
          guarded(async () => {
            const result = await adapter.createTask(principal(context, input), input);
            events.emit('tasks-changed', { project: input.project });
            return result;
          }),
      };
    },
  });

  const configSchema = buildJsonPluginConfigSchema(baseline.configSchema, {
    cacheKey: 'flowboard:plugin-config',
  });

  const entry = definePluginEntry({
    id: baseline.id,
    name: baseline.name,
    description: baseline.description,
    configSchema,
    register(api) {
      featureEntry.register(api);
    },
  });

  // Re-publish the feature metadata with FlowBoard's config schema so
  // `openclaw plugins build` generates a manifest that accepts the plugin's
  // configuration. Everything else (id, name, description, activation, tools)
  // is taken unchanged from the feature contract.
  Object.defineProperty(entry, toolPluginMetadataSymbol, {
    value: { ...getToolPluginMetadata(featureEntry), configSchema: configSchema.jsonSchema },
    enumerable: false,
  });

  return entry;
}

export default createFeatureEntry;
