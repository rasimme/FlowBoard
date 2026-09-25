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

import { createFlowBoardAdapter, toFeatureError } from './adapter.js';
import {
  createChangePoller,
  createFocusRegistry,
  MAX_TRACKED_CONNECTIONS,
  POLL_INTERVAL_MS,
  TASK_POLL_INTERVAL_MS,
} from './change-poll.js';
import { contract } from './contract.js';

// Re-exported so the poll keeps one documented import path even though its
// rules live in a module the feature SDK never touches (see change-poll.js).
export { createChangePoller, createFocusRegistry, POLL_INTERVAL_MS, TASK_POLL_INTERVAL_MS };

/**
 * Per-connection registry of Control UI clients and their Gateway-verified
 * operator identities.
 *
 * Two facts live here, and only one of them comes from the browser's request:
 *
 *  - **Presence.** A connection that called `flowboard.ui.identity` has a
 *    FlowBoard UI open. That is what gates the background poll below, so an
 *    idle Gateway does nothing at all.
 *  - **Profile.** The host-attested `authenticatedUserProfile` of that same
 *    connection, or null when there is none (a CLI or token-only client).
 *    Only `flowboard.ui.identity` writes it, and only from the host-supplied
 *    `client` object, so a browser cannot inject a profile it does not own.
 */
function createPrincipalRegistry(onPresenceChange) {
  const byConnection = new Map();
  const notify = () => {
    try {
      onPresenceChange?.(byConnection.size);
    } catch {
      /* presence is a hint for the poller; never fail a request over it */
    }
  };
  return {
    remember(connId, principal) {
      if (!connId) return;
      byConnection.delete(connId);
      byConnection.set(connId, principal || null);
      while (byConnection.size > MAX_TRACKED_CONNECTIONS) {
        const oldest = byConnection.keys().next();
        if (oldest.done) break;
        byConnection.delete(oldest.value);
      }
      notify();
    },
    forget(connId) {
      if (connId && byConnection.delete(connId)) notify();
    },
    has(connId) {
      return Boolean(connId && byConnection.has(connId));
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

/**
 * Feature handlers report FlowBoard's own message and code (for example
 * SPECIFY_REQUIRED or NOT_OWNER), never a stack or a body. The mapping lives
 * in the SDK-free adapter so FlowBoard's suite can pin it on every Node.
 */
async function guarded(run) {
  try {
    return await run();
  } catch (error) {
    throw toFeatureError(error);
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
      // Declared before the registry so the presence callback can never read
      // it in its temporal dead zone, even if a host calls in during setup.
      let poller = null;
      const registry = createPrincipalRegistry(() => poller?.wake());
      const focus = createFocusRegistry(() => poller?.wake());
      poller = createChangePoller({
        adapter,
        events,
        logger: api.logger,
        hasClients: () => registry.size > 0,
        watchedProjects: () => focus.projects(),
      });

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
          // Presence is recorded whether or not this connection has a profile:
          // a token-only client still has a FlowBoard page open, and that is
          // what the background poll is gated on. Only the *profile* half is
          // conditional, and it comes from the host, never from the caller.
          const known = registry.has(connId);
          registry.remember(
            connId,
            profile ? { ...profile, scopes: readConnectionScopes(client?.connect?.scopes) } : null,
          );
          if (!known) {
            client?.connectionSignal?.addEventListener?.(
              'abort',
              () => {
                registry.forget(connId);
                focus.forget(connId);
              },
              { once: true },
            );
          }
          opts.respond(true, {
            dashboardUrl: adapter.dashboardUrl(),
            profileBound: Boolean(profile),
            displayName: profile?.displayName ?? null,
          });
        },
        { scope: 'operator.read', profileAccess: 'required' },
      );

      // The poll is a long-lived side effect, so it belongs to a service and
      // not to `setup` (the SDK is explicit about that).
      //
      // The id must NOT be `<pluginId>:feature-events`: `defineFeaturePlugin`
      // registers a service under exactly that id for the event emitter, and
      // a second registration with the same id is silently dropped — the
      // handler never starts and nothing says so (measured on 2026.9.5,
      // `dist/plugin-sdk/feature-plugin.js`). Because that emitter service is
      // declared before `setup` runs, it is also started first, so
      // `events.emit` is already live by the time this poller ticks.
      api.registerService?.({
        id: 'flowboard:change-poll',
        start: () => poller.start(),
        stop: () => poller.stop(),
      });

      const principal = (context, input) => resolveCallerPrincipal(registry, context, input);
      /**
       * A write names the one task it touched, so a board refreshes that card
       * instead of the column it lives in. The poll fills the same field for
       * changes nobody here made.
       *
       * The poll's baseline for that board is deliberately *not* invalidated
       * here, so a write is usually followed by a second `tasks-changed` on
       * the next tick. One redundant refetch is the cheaper mistake: dropping
       * the baseline would also swallow anything an agent changed on the same
       * board in the same window, and a silently stale card is the bug this
       * whole poll exists to prevent.
       */
      const changed = (project, id) => events.emit('tasks-changed', { project, ids: [id] });

      return {
        'ui.config': () => ({ dashboardUrl: adapter.dashboardUrl() }),

        'projects.list': (input, context) =>
          guarded(async () => ({ projects: await adapter.listProjects(principal(context, input)) })),

        'status.get': (input, context) => guarded(() => adapter.getStatus(principal(context, input), input)),

        'tasks.list': (input, context) => guarded(() => adapter.listTasks(principal(context, input), input)),

        'task.get': (input, context) => guarded(() => adapter.getTask(principal(context, input), input)),

        'tasks.needing-me': (input, context) => guarded(() => adapter.listNeedingMe(principal(context, input), input)),

        'status.set': (input, context) =>
          guarded(async () => {
            const result = await adapter.setStatus(principal(context, input), input);
            events.emit('projects-changed', {});
            return result;
          }),

        'task.create': (input, context) =>
          guarded(async () => {
            const result = await adapter.createTask(principal(context, input), input);
            changed(input.project, result.id);
            return result;
          }),

        // The write actions below are `operator.write` at the Gateway
        // and *authorized* by FlowBoard: the review gate (ADR-0022), the
        // lease-ownership rule and the work-state contract all live on the
        // server, and their refusals reach the caller as FlowBoard's own
        // message. Nothing here decides whether a move is allowed.
        'task.update': (input, context) =>
          guarded(async () => {
            const result = await adapter.updateTask(principal(context, input), input);
            changed(input.project, input.id);
            return result;
          }),

        'task.approve': (input, context) =>
          guarded(async () => {
            const result = await adapter.approveTask(principal(context, input), input);
            changed(input.project, input.id);
            return result;
          }),

        'task.reject': (input, context) =>
          guarded(async () => {
            const result = await adapter.rejectTask(principal(context, input), input);
            changed(input.project, input.id);
            return result;
          }),

        // T-499: the author is composed from the connection's verified
        // profile inside the adapter; operation input cannot name it.
        'task.comment': (input, context) =>
          guarded(async () => {
            const result = await adapter.commentTask(principal(context, input), input);
            changed(input.project, input.id);
            return result;
          }),

        // Soft delete only. The timestamp is made in the adapter, here in the
        // Gateway process, and a trashed task leaves `tasks.list`.
        'task.trash': (input, context) =>
          guarded(async () => {
            const result = await adapter.trashTask(principal(context, input), input);
            changed(input.project, input.id);
            return result;
          }),

        // Not a FlowBoard call at all: it records what this connection is
        // looking at so the poll above watches that board. A caller without a
        // connection (CLI, agent tool) has no page to keep fresh, so it is
        // accepted and ignored rather than refused.
        'ui.focus': (input, context) => {
          const action = context?.source === 'session-action' ? context.action : null;
          focus.remember(optionalString(action?.client?.connId), input?.project ?? null);
          return { ok: true };
        },
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
