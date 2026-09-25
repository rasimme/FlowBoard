/**
 * FlowBoard HTTP adapter for the OpenClaw Gateway facade (T-487-7, ADR-0040;
 * "needing me" and session-scoped status added in T-487-8; the board
 * projection and the three write actions in T-498; edit fields, comments and
 * trash in T-499).
 *
 * The Gateway process talks to the FlowBoard dashboard over loopback HTTP. It
 * authenticates with a shared service credential (`serviceToken` plugin config
 * / `FLOWBOARD_SERVICE_TOKEN` on the server) and forwards the *Gateway-verified*
 * principal in `X-FlowBoard-Gateway-*` headers. FlowBoard ignores those headers
 * completely unless the bearer token matched, so they carry no authority of
 * their own — the token is what makes them trustworthy.
 *
 * Nothing here logs or echoes the token, and FlowBoard's own 4xx message is
 * surfaced verbatim while stacks and response bodies stay inside this module.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { joinApiPath, resolveDashboardBaseUrl } = require(join(PACKAGE_ROOT, 'dashboard', 'flowboard-url.cjs'));

/** Read timeout for a single dashboard call. Loopback: fast, never unbounded. */
export const DEFAULT_TIMEOUT_MS = 3000;
/** Writes may touch the HZL event store and the policy ledger. */
export const WRITE_TIMEOUT_MS = 5000;

const MAX_ERROR_MESSAGE = 300;
const HEADER_MAX = 256;
const NOTE_MAX = 120;

/**
 * Bounds for one `tasks.needingMe` answer.
 *
 * The blocked/stalled lane is one cross-project call (`GET /api/tasks/stuck`,
 * served from the dashboard's in-memory projection). The review lane has no
 * cross-project endpoint, so it is fetched per project — but only for projects
 * whose `taskCounts.review` is already non-zero in the project list, and never
 * for more than MAX_REVIEW_PROJECTS of them. Worst case is therefore
 * 2 + MAX_REVIEW_PROJECTS loopback calls, independent of board size.
 */
export const MAX_REVIEW_PROJECTS = 8;
export const MAX_NEEDS_ME_ITEMS = 100;
export const DEFAULT_NEEDS_ME_LIMIT = 40;

/** Board bounds — the mirror of openclaw/contract.js, enforced before the wire. */
export const MAX_TASK_LIST_LIMIT = 500;
export const DEFAULT_TASK_LIST_LIMIT = 300;
export const MAX_COMMENTS = 20;
export const MAX_CHECKPOINTS = 10;
/**
 * FlowBoard's own description limit (server.js T-396, 16 KB), so the detail
 * read round-trips every description the dashboard can store. Larger legacy
 * content is still cut and flagged with `descriptionTruncated`.
 */
export const MAX_DESCRIPTION = 16384;
/** One comment on the wire, in both directions (task.comment, task.get). */
export const MAX_COMMENT = 2000;
export const MAX_TITLE = 200;
export const MAX_TAGS = 20;
export const MAX_TAG_LENGTH = 40;
export const MAX_DETAIL_LENGTH = 200;
export const MAX_ACTOR_LENGTH = 128;
export const MAX_REASON = 500;

/** Errors the host turns into a feature-operation failure, message only. */
export class FlowBoardAdapterError extends Error {
  constructor(message, code = 'flowboard_unavailable') {
    super(message);
    this.name = 'FlowBoardAdapterError';
    this.code = code;
  }
}

/**
 * The error a feature handler rethrows for an adapter failure.
 *
 * It carries FlowBoard's message and its `code` unchanged — so a client can
 * branch on `SPECIFY_REQUIRED`, `NOT_OWNER` or `NOT_IN_REVIEW` exactly as the
 * dashboard does — and nothing else: no stack from this module, no cause
 * chain, no response body.
 *
 * It is a class of its own, not a plain Error, because the feature SDK does
 * not forward a thrown error's message: `defineFeaturePlugin` turns only its
 * private validation error into a `{ ok: false, code }` result and rethrows
 * everything else, which the Gateway reports as "plugin session action
 * failed" (verified on 2026.9.6). The session-action wrapper in
 * feature-entry.js recognises exactly this class and answers with the refusal
 * envelope the Gateway does forward. Nothing else may be an instance of it.
 */
export class FlowBoardFeatureRefusal extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'FlowBoardFeatureRefusal';
    this.code = code;
  }
}

/** Longest refusal text the envelope carries (the Control UI shows 300). */
export const MAX_REFUSAL_MESSAGE = 300;

/**
 * Map an adapter failure to the refusal the feature layer reports. Anything
 * that is not an adapter error is returned as it is; the host already reports
 * those without their internals.
 */
export function toFeatureError(error) {
  if (error instanceof FlowBoardAdapterError) {
    return new FlowBoardFeatureRefusal(error.message, error.code);
  }
  return error;
}

/**
 * The session-action result for a refusal, or null for anything else.
 *
 * `{ ok: false, error, code }` is the failure shape the Gateway forwards to
 * the caller unchanged (PluginsSessionActionFailureResultSchema). The message
 * is bounded and the code is only passed on when it is a short string.
 */
export function refusalEnvelope(error) {
  if (!(error instanceof FlowBoardFeatureRefusal)) return null;
  const message = typeof error.message === 'string' && error.message ? error.message : 'FlowBoard refused the request';
  const envelope = { ok: false, error: message.slice(0, MAX_REFUSAL_MESSAGE) };
  if (typeof error.code === 'string' && error.code) envelope.code = error.code.slice(0, 64);
  return envelope;
}

/**
 * Wrap one session-action handler so a FlowBoard refusal becomes the failure
 * envelope instead of a thrown error. Every other error is rethrown untouched
 * and keeps the host's own, detail-free "plugin session action failed".
 */
export function wrapSessionActionHandler(handler) {
  if (typeof handler !== 'function') return handler;
  return async function flowBoardSessionAction(...args) {
    try {
      return await handler.apply(this, args);
    } catch (error) {
      const envelope = refusalEnvelope(error);
      if (envelope) return envelope;
      throw error;
    }
  };
}

/**
 * The plugin API as the feature SDK should see it: identical, except that
 * every session action it registers answers a FlowBoard refusal with
 * `{ ok: false, error, code }`.
 *
 * `defineFeaturePlugin` calls the flat `api.registerSessionAction` (9.6
 * `feature-plugin.ts`), and its own handler wrapper rethrows our refusal after
 * the output schema would have run — a refusal is thrown before any output
 * exists, so no schema ever sees the envelope. The Gateway validates it only
 * against the generic failure shape, which it matches.
 *
 * Everything else is the real API: other members are read from it and its
 * methods are bound to it, so `api.id`, `api.pluginConfig`, `api.logger` and
 * the host's own registration wrappers behave exactly as before. A host that
 * hands out an API whose `registerSessionAction` cannot be shadowed gets it
 * unchanged — refusals then read as before, nothing breaks.
 */
export function withRefusalEnvelopes(api) {
  if (!api || typeof api.registerSessionAction !== 'function') return api;
  const own = Object.getOwnPropertyDescriptor(api, 'registerSessionAction');
  if (own && own.configurable === false && own.writable === false) return api;
  const registerSessionAction = (action, ...rest) =>
    api.registerSessionAction(
      action && typeof action === 'object' ? { ...action, handler: wrapSessionActionHandler(action.handler) } : action,
      ...rest,
    );
  return new Proxy(api, {
    get(target, key) {
      if (key === 'registerSessionAction') return registerSessionAction;
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function boundedHeaderValue(value) {
  if (typeof value !== 'string') return null;
  // Header values must stay single-line ASCII-safe: a display name is free
  // text and could otherwise smuggle a CR/LF into the request.
  const cleaned = value.replace(/[\r\n\t]+/g, ' ').trim();
  if (!cleaned) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F]/.test(cleaned)) return null;
  return cleaned.slice(0, HEADER_MAX);
}

/**
 * Build the principal headers for one call.
 *
 * `principal` comes from the Gateway connection (see flowboard-plugin.js), not
 * from operation input — except `sessionKey`/`agentId`, which are descriptive
 * routing context. A caller without a Gateway profile (CLI, agent tool) sends
 * no profile headers at all; FlowBoard then resolves the trusted local
 * operator instead of a verified human.
 */
export function buildPrincipalHeaders(principal) {
  const headers = {};
  if (!principal || typeof principal !== 'object') return headers;
  const profileId = boundedHeaderValue(principal.profileId);
  if (profileId) {
    headers['X-FlowBoard-Gateway-Profile-Id'] = profileId;
    const displayName = boundedHeaderValue(principal.displayName);
    if (displayName) headers['X-FlowBoard-Gateway-Profile-Name'] = displayName;
  }
  const scopes = Array.isArray(principal.scopes)
    ? principal.scopes.map(boundedHeaderValue).filter(Boolean).slice(0, 16)
    : [];
  if (scopes.length) headers['X-FlowBoard-Gateway-Scopes'] = scopes.join(',');
  const agentId = boundedHeaderValue(principal.agentId);
  if (agentId) headers['X-FlowBoard-Gateway-Agent-Id'] = agentId;
  const sessionKey = boundedHeaderValue(principal.sessionKey);
  if (sessionKey) headers['X-FlowBoard-Gateway-Session-Key'] = sessionKey;
  return headers;
}

function shortMessage(value, fallback) {
  const text = typeof value === 'string' ? value.trim() : '';
  return (text || fallback).slice(0, MAX_ERROR_MESSAGE);
}

function boundedNote(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, NOTE_MAX) : null;
}

function nonNegativeInt(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function optionalAgent(value) {
  return typeof value === 'string' && value ? value.slice(0, 64) : null;
}

/**
 * Turn one `GET /api/tasks/stuck` entry into a "needing me" row.
 *
 * FlowBoard's stall detection is the authority on *why* something is stuck
 * (hzl-service `getStuckTasks`): `blocked`/`waiting` come from the canonical
 * work state, `stale`/`expired`/`routed-unclaimed`/`check-again` from lease
 * and checkpoint evidence. Only the blocked state is its own lane here; the
 * rest share the `stuck` reason with the evidence in `note`.
 */
export function stuckEntryToItem(entry) {
  const id = typeof entry?.taskId === 'string' && entry.taskId ? entry.taskId : entry?.id;
  const project = typeof entry?.project === 'string' ? entry.project : '';
  if (typeof id !== 'string' || !id || !project) return null;
  const reason = entry?.reason;
  const details = entry?.workStateDetails || {};
  let note = null;
  if (reason === 'blocked' || reason === 'waiting') {
    const who = boundedNote(details.waitingFor || details.responsible);
    note = boundedNote(details.reason) || (who ? `waiting for ${who}` : null);
    if (!note && reason === 'waiting') note = 'waiting';
  } else if (reason === 'stale') {
    note = `no checkpoint for ${nonNegativeInt(entry.staleMinutes)} min`;
  } else if (reason === 'expired') {
    note = `lease expired ${nonNegativeInt(entry.expiredMinutes)} min ago`;
  } else if (reason === 'routed-unclaimed') {
    const routed = optionalAgent(entry.routedAgent);
    note = routed ? `routed to ${routed}, never claimed` : 'routed but never claimed';
  } else if (reason === 'check-again') {
    note = 'scheduled re-check is due';
  }
  return {
    project: project.slice(0, 64),
    id: id.slice(0, 64),
    title: String(entry?.title ?? '').slice(0, 256),
    status: String(entry?.status ?? 'unknown').slice(0, 32),
    workState: String(entry?.workState ?? 'working').slice(0, 32),
    reason: reason === 'blocked' ? 'blocked' : 'stuck',
    agent: optionalAgent(entry?.agent),
    note: boundedNote(note),
  };
}

/** A task the human still has to approve. The review lane is the inbox. */
export function reviewTaskToItem(project, task) {
  const id = typeof task?.id === 'string' ? task.id : '';
  if (!id) return null;
  return {
    project: String(project).slice(0, 64),
    id: id.slice(0, 64),
    title: String(task?.title ?? '').slice(0, 256),
    status: 'review',
    workState: String(task?.workState ?? 'working').slice(0, 32),
    reason: 'review',
    agent: optionalAgent(task?.agent),
    note: null,
  };
}

/**
 * Order the answer the way the operator reads it: approvals first (they are a
 * decision only a human can make), then blocked, then stalled work, each
 * oldest-project-first by name so the list does not reshuffle between polls.
 */
export function sortNeedsMe(items) {
  const rank = { review: 0, blocked: 1, stuck: 2 };
  return [...items].sort((a, b) => {
    const byReason = (rank[a.reason] ?? 9) - (rank[b.reason] ?? 9);
    if (byReason !== 0) return byReason;
    const byProject = a.project.localeCompare(b.project);
    return byProject !== 0 ? byProject : a.id.localeCompare(b.id);
  });
}

/* ------------------------------------------------------------------ board */

function boundedText(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function boundedOrNull(value, max) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function enumOr(value, allowed, fallback) {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback;
}

const WORK_STATES = ['working', 'waiting', 'blocked', 'paused'];
const PRIORITIES = ['low', 'medium', 'high'];

/**
 * Bound the canonical work-state details without reinterpreting them.
 *
 * FlowBoard owns what these mean and always answers with all four fields
 * (null where unset), so this only truncates free text and drops anything the
 * contract does not declare. `setAt` is deliberately not forwarded: it is
 * server-owned bookkeeping, and `enteredStatusAt` already tells a card how
 * long the task has been where it is.
 */
export function projectWorkStateDetails(details) {
  const source = details && typeof details === 'object' && !Array.isArray(details) ? details : {};
  return {
    reason: boundedOrNull(source.reason, MAX_DETAIL_LENGTH),
    waitingFor: boundedOrNull(source.waitingFor, MAX_DETAIL_LENGTH),
    responsible: boundedOrNull(source.responsible, MAX_DETAIL_LENGTH),
    checkAgainAt: boundedOrNull(source.checkAgainAt, 64),
  };
}

/**
 * Five fields of FlowBoard's stall indicator, or null.
 *
 * The stored object also routes notifications (owner kind, delivery channel,
 * wake agent, available actions). None of that is a board's business, and
 * every field forwarded here is one more thing an unsandboxed bundle could
 * leak, so the chip gets what a chip draws and nothing else.
 */
export function projectStuckIndicator(indicator) {
  if (!indicator || typeof indicator !== 'object' || Array.isArray(indicator)) return null;
  if (indicator.active !== true) return null;
  return {
    active: true,
    reason: boundedOrNull(indicator.reason, 32),
    message: boundedOrNull(indicator.message, MAX_DETAIL_LENGTH),
    since: boundedOrNull(indicator.since, 64),
    detectedAt: boundedOrNull(indicator.detectedAt, 64),
  };
}

/**
 * One FlowBoard task as the contract's board card.
 *
 * Pure and total: it never throws on a partial task, because the same
 * function projects a list row, a single-task read, and the task a write
 * action answered with — and those three FlowBoard shapes differ slightly
 * (the write endpoints answer with less enrichment than the list does).
 */
export function projectTask(task) {
  const source = task && typeof task === 'object' ? task : {};
  const tags = Array.isArray(source.tags)
    ? source.tags.filter((tag) => typeof tag === 'string').slice(0, MAX_TAGS).map((tag) => tag.slice(0, MAX_TAG_LENGTH))
    : [];
  const subtaskCount = Array.isArray(source.subtaskIds)
    ? Math.min(source.subtaskIds.length, MAX_TASK_LIST_LIMIT)
    : 0;
  return {
    id: boundedText(source.id, 64),
    title: boundedText(source.title, 256),
    // Not defaulted: an unknown status is a real contract drift between
    // FlowBoard and the Gateway, and the host's output validation is the
    // only place that would ever notice it.
    status: boundedText(source.status, 32),
    workState: enumOr(source.workState, WORK_STATES, 'working'),
    workStateDetails: projectWorkStateDetails(source.workStateDetails),
    stuckIndicator: projectStuckIndicator(source.stuckIndicator),
    priority: enumOr(source.priority, PRIORITIES, 'medium'),
    agent: optionalAgent(source.agent),
    parentId: boundedOrNull(source.parentId, 64),
    subtaskCount,
    tags,
    order: Number.isFinite(source.order) ? source.order : null,
    enteredStatusAt: boundedOrNull(source.enteredStatusAt, 64),
    created: boundedOrNull(source.created, 64),
    leaseUntil: boundedOrNull(source.leaseUntil, 64),
    specExists: source.specExists === true,
  };
}

/**
 * Board order: FlowBoard's manual per-column rank first, then the task id.
 *
 * Unranked tasks sort after ranked ones rather than before: a column where
 * someone has dragged two cards to the top should show those two first, not
 * bury them under everything that was never touched. Ids compare
 * numeric-aware so T-9 precedes T-10.
 */
export function compareTasks(a, b) {
  const left = Number.isFinite(a?.order) ? a.order : null;
  const right = Number.isFinite(b?.order) ? b.order : null;
  if (left !== right) {
    if (left === null) return 1;
    if (right === null) return -1;
    return left - right;
  }
  return String(a?.id ?? '').localeCompare(String(b?.id ?? ''), 'en', { numeric: true });
}

/** Newest first, by FlowBoard's timestamp; entries without one sort last. */
function byTimestampDesc(a, b) {
  return String(b?.timestamp ?? '').localeCompare(String(a?.timestamp ?? ''));
}

export function projectComment(row) {
  const id = Number.isInteger(row?.id) && row.id >= 0 ? row.id : null;
  return {
    id,
    author: boundedOrNull(row?.author, 128),
    message: boundedText(row?.message, MAX_COMMENT),
    kind: boundedOrNull(row?.kind, 16),
    timestamp: boundedOrNull(row?.timestamp, 64),
  };
}

export function projectCheckpoint(row) {
  return {
    message: boundedText(row?.message, 256),
    agent: optionalAgent(row?.agent),
    progress: Number.isFinite(row?.progress) ? row.progress : null,
    timestamp: boundedOrNull(row?.timestamp, 64),
  };
}

/**
 * Who FlowBoard should record as the actor of a review decision.
 *
 * Approve and reject take the actor from their request *body* — they do not
 * read the Gateway principal headers (dashboard/server.js) — so the actor has
 * to be composed here, in the Gateway process, from the connection's
 * host-attested profile. It is never taken from operation input: the browser
 * cannot name who approved something.
 *
 * The form carries both halves on purpose: the display name is what a human
 * reads in the activity feed, and `gateway:<profileId>` is the same actor
 * string `governance.resolvePrincipal` derives from the headers, so a comment
 * and a governance record can still be tied together. Without a profile (a
 * CLI or token-only connection) the caller is the trusted local operator, and
 * FlowBoard's own vocabulary for that is `local:operator`.
 */
export function principalActor(principal) {
  const profileId = boundedHeaderValue(principal?.profileId);
  if (!profileId) return 'local:operator';
  const displayName = boundedHeaderValue(principal?.displayName);
  const actor = displayName ? `${displayName} (gateway:${profileId})` : `gateway:${profileId}`;
  return actor.slice(0, MAX_ACTOR_LENGTH);
}

/**
 * Project FlowBoard's status response onto the contract's binding object.
 *
 * `binding` on the wire is which layer answered — `session`, `agent`, or null
 * for "nothing bound" (flowboard-metadata `resolveActiveProject`). Anything
 * else is treated as unknown rather than passed through, so a newer server
 * cannot widen this enum behind the Gateway's validator.
 */
function readBinding(payload, { agentId, sessionKey }) {
  const scope = payload?.binding === 'session' || payload?.binding === 'agent' ? payload.binding : null;
  return {
    agentId: String(payload?.agentId ?? agentId).slice(0, 64),
    contextReady: payload?.contextReady === true,
    sessionKey: typeof sessionKey === 'string' && sessionKey ? sessionKey : null,
    scope,
  };
}

/**
 * Create an adapter bound to one plugin configuration.
 *
 * `pluginConfig` is the same object the project-context hook reads, so one
 * `dashboardBaseUrl`/`dashboardPort` setting drives the hook, the UI, and this
 * facade.
 */
export function createFlowBoardAdapter(pluginConfig = {}, options = {}) {
  const baseUrl = () => resolveDashboardBaseUrl(pluginConfig || {});
  const serviceToken = typeof pluginConfig?.serviceToken === 'string' ? pluginConfig.serviceToken.trim() : '';
  const fetchImpl = options.fetch || globalThis.fetch;
  // The trash timestamp is made here, in the Gateway process, never taken
  // from the caller. Injectable only so a test can pin it.
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const taskPath = (project, id) => `/api/projects/${encodeURIComponent(project)}/tasks/${encodeURIComponent(id)}`;

  async function call(method, apiPath, { principal, body, timeoutMs } = {}) {
    const url = joinApiPath(baseUrl(), apiPath);
    const headers = { Accept: 'application/json', ...buildPrincipalHeaders(principal) };
    if (serviceToken) headers.Authorization = `Bearer ${serviceToken}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs || DEFAULT_TIMEOUT_MS),
      });
    } catch (err) {
      // Never surface the cause chain: it can contain the request headers.
      const reason = err?.name === 'TimeoutError' ? 'timed out' : 'is unreachable';
      throw new FlowBoardAdapterError(`FlowBoard dashboard ${reason} at ${baseUrl()}`);
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      if (response.status >= 400 && response.status < 500) {
        throw new FlowBoardAdapterError(
          shortMessage(payload?.error, `FlowBoard rejected the request (HTTP ${response.status})`),
          typeof payload?.code === 'string'
            ? payload.code.slice(0, 64)
            : // A 404 without a code of its own is FlowBoard saying the task
              // (or its project) is gone; the native page closes on this code.
              response.status === 404
              ? 'flowboard_not_found'
              : 'flowboard_rejected',
        );
      }
      throw new FlowBoardAdapterError(`FlowBoard dashboard returned HTTP ${response.status}`);
    }
    return payload && typeof payload === 'object' ? payload : {};
  }

  return {
    dashboardUrl: baseUrl,
    hasServiceToken: () => Boolean(serviceToken),

    async listProjects(principal) {
      const payload = await call('GET', '/api/projects', { principal });
      const rows = Array.isArray(payload.projects) ? payload.projects : [];
      return rows.map((project) => ({
        name: String(project?.name ?? ''),
        status: String(project?.status ?? 'unknown'),
        counts: {
          review: nonNegativeInt(project?.taskCounts?.review),
          blocked: nonNegativeInt(project?.taskCounts?.blocked),
        },
      }));
    },

    async getStatus(principal, { agentId, sessionKey }) {
      // T-487-2 / ADR-0039: the session key names which binding to read. It is
      // routing context, never authorization — FlowBoard validates its shape
      // and answers with the layer that actually resolved (`binding`).
      const query = new URLSearchParams({ agentId });
      if (typeof sessionKey === 'string' && sessionKey) query.set('sessionKey', sessionKey);
      const payload = await call('GET', `/api/status?${query.toString()}`, { principal });
      return {
        activeProject: typeof payload.activeProject === 'string' ? payload.activeProject : null,
        binding: readBinding(payload, { agentId, sessionKey }),
      };
    },

    async setStatus(principal, { agentId, project, sessionKey }) {
      const payload = await call('PUT', '/api/status', {
        principal,
        body: {
          agentId,
          project: project === null ? 'none' : project,
          ...(typeof sessionKey === 'string' && sessionKey ? { sessionKey } : {}),
        },
        timeoutMs: WRITE_TIMEOUT_MS,
      });
      return {
        activeProject: typeof payload.activeProject === 'string' ? payload.activeProject : null,
        binding: readBinding(payload, { agentId, sessionKey }),
      };
    },

    /**
     * Everything waiting on the human, in one bounded answer.
     *
     * Two sources, deliberately: the review lane is FlowBoard's approve gate
     * (a status), the blocked/stalled lane is its stall detection (a live
     * projection). Merging them here — instead of in the browser — keeps the
     * definition of "needs me" server-side and identical for every client.
     */
    async listNeedingMe(principal, { project, limit } = {}) {
      const max = Math.min(
        Math.max(Number.isFinite(limit) ? Math.floor(limit) : DEFAULT_NEEDS_ME_LIMIT, 1),
        MAX_NEEDS_ME_ITEMS,
      );
      const projects = await this.listProjects(principal);
      const inScope = project ? projects.filter((entry) => entry.name === project) : projects;
      if (project && inScope.length === 0) {
        throw new FlowBoardAdapterError(`Unknown project: ${project}`, 'flowboard_unknown_project');
      }
      const names = new Set(inScope.map((entry) => entry.name));

      // Lane 1 — blocked and stalled, one call for the whole board.
      let attention = [];
      try {
        const stuck = await call('GET', '/api/tasks/stuck', { principal });
        const combined = Array.isArray(stuck?.stuck?.combined) ? stuck.stuck.combined : [];
        attention = combined
          .map(stuckEntryToItem)
          .filter((item) => item && names.has(item.project));
      } catch (error) {
        // Stall detection is best-effort: the approve gate must still render.
        if (!(error instanceof FlowBoardAdapterError)) throw error;
      }

      // Lane 2 — the review inbox, only where the project list already says
      // there is something to approve.
      const reviewProjects = inScope
        .filter((entry) => entry.counts.review > 0)
        .sort((a, b) => b.counts.review - a.counts.review || a.name.localeCompare(b.name));
      const scanned = reviewProjects.slice(0, MAX_REVIEW_PROJECTS);
      const reviewLists = await Promise.all(
        scanned.map(async (entry) => {
          // Deliberately not `listTasks`: that projection is the `tasks.list`
          // contract shape and drops `workState`, which this lane displays.
          const payload = await call('GET', `/api/projects/${encodeURIComponent(entry.name)}/tasks?status=review`, {
            principal,
          });
          // A trashed task keeps its status; it is still not waiting on anyone.
          const rows = Array.isArray(payload.tasks) ? payload.tasks.filter((task) => !task?.trashedAt) : [];
          return rows.map((task) => reviewTaskToItem(entry.name, task)).filter(Boolean);
        }),
      );

      const all = sortNeedsMe([...reviewLists.flat(), ...attention]);
      return {
        items: all.slice(0, max),
        truncated: all.length > max || reviewProjects.length > scanned.length,
        scannedProjects: scanned.length,
      };
    },

    /**
     * One project's board.
     *
     * Archived tasks are excluded by default because a board draws the work
     * that is still live. Asking for `status: "archived"` is the one case
     * where that default is wrong — the query would be empty by construction
     * — so it implies `includeArchived`, and the caller gets the column it
     * asked for instead of a silently empty one (the same failure mode T-463
     * fixed for the inert `status` filter).
     *
     * Trashed tasks are never cards (T-499). FlowBoard's task list still
     * returns them — its own board filters `trashedAt` client-side and shows
     * them only in the Trash view — so the filter has to live here, before
     * the limit, or a board of trashed work would also eat the page.
     */
    async listTasks(principal, { project, status, includeArchived, limit } = {}) {
      const max = Math.min(
        Math.max(Number.isFinite(limit) ? Math.floor(limit) : DEFAULT_TASK_LIST_LIMIT, 1),
        MAX_TASK_LIST_LIMIT,
      );
      const query = new URLSearchParams();
      if (status) query.set('status', status);
      if (includeArchived === true || status === 'archived') query.set('includeArchived', 'true');
      const search = query.toString();
      const suffix = search ? `?${search}` : '';
      const payload = await call('GET', `/api/projects/${encodeURIComponent(project)}/tasks${suffix}`, { principal });
      const rows = Array.isArray(payload.tasks) ? payload.tasks.filter((task) => !task?.trashedAt) : [];
      const tasks = rows.map(projectTask).sort(compareTasks);
      return { tasks: tasks.slice(0, max), truncated: tasks.length > max };
    },

    /**
     * One task with the context a detail panel shows.
     *
     * Three reads, in parallel: the canonical task, its comments and its
     * checkpoints. Comments and checkpoints are best-effort — FlowBoard
     * answers them from the event store, and a task whose history cannot be
     * read is still a task worth opening.
     */
    async getTask(principal, { project, id } = {}) {
      const base = `/api/projects/${encodeURIComponent(project)}/tasks/${encodeURIComponent(id)}`;
      const [payload, comments, checkpoints] = await Promise.all([
        call('GET', base, { principal }),
        call('GET', `${base}/comments`, { principal }).catch(() => ({})),
        call('GET', `${base}/checkpoints`, { principal }).catch(() => ({})),
      ]);
      const raw = payload?.task;
      if (!raw || typeof raw !== 'object') {
        throw new FlowBoardAdapterError(`Task not found: ${id}`, 'flowboard_not_found');
      }
      const description = typeof raw.description === 'string' ? raw.description : '';
      const commentRows = Array.isArray(comments?.comments) ? comments.comments : [];
      const checkpointRows = Array.isArray(checkpoints?.checkpoints) ? checkpoints.checkpoints : [];
      return {
        task: {
          ...projectTask(raw),
          description: description.slice(0, MAX_DESCRIPTION),
          descriptionTruncated: description.length > MAX_DESCRIPTION,
          specFile: boundedOrNull(raw.specFile, 512),
        },
        comments: [...commentRows].sort(byTimestampDesc).slice(0, MAX_COMMENTS).map(projectComment),
        checkpoints: [...checkpointRows].sort(byTimestampDesc).slice(0, MAX_CHECKPOINTS).map(projectCheckpoint),
      };
    },

    /**
     * Resolve the task a write action answered with.
     *
     * `PUT /tasks/:id` answers with FlowBoard's fully enriched projection, but
     * `/approve` and `/reject` answer with the raw service task — no
     * `specExists`, because those endpoints never pass through
     * `taskWithSpecStatus`. Rather than let a card lose its spec chip the
     * moment it is approved, re-read the canonical task whenever the answer
     * is not already enriched. If that read fails the write still happened,
     * so the unenriched answer is returned rather than an error.
     */
    async taskAfterWrite(principal, project, payload) {
      const raw = payload?.task;
      if (raw && typeof raw.specExists === 'boolean') return { task: projectTask(raw) };
      const id = typeof raw?.id === 'string' ? raw.id : null;
      if (id) {
        try {
          const fresh = await call(
            'GET',
            `/api/projects/${encodeURIComponent(project)}/tasks/${encodeURIComponent(id)}`,
            { principal },
          );
          if (fresh?.task) return { task: projectTask(fresh.task) };
        } catch {
          /* the write succeeded; a failed re-read must not undo that */
        }
      }
      return { task: projectTask(raw) };
    },

    /**
     * Change status, work state and/or the editable card fields.
     *
     * Deliberately no `actor` in the body. On the generic update path that
     * field is a lease-ownership *assertion* (server.js T-422-1): naming an
     * actor different from the agent holding a live claim is refused with
     * NOT_OWNER. An actor-less call is FlowBoard's trusted local operator and
     * behaves exactly like the dashboard's own status picker, including its
     * auto-release. The Gateway principal still travels in the headers.
     *
     * The edit fields (T-499) are forwarded as given — the Gateway has already
     * validated them against the contract — and only when present: an empty
     * description, an empty tag list and a null rank are values that clear
     * something, not "leave it alone". FlowBoard validates them again.
     */
    async updateTask(
      principal,
      { project, id, status, workState, workStateDetails, title, description, priority, tags, order } = {},
    ) {
      const body = {};
      if (title !== undefined) body.title = title;
      if (description !== undefined) body.description = description;
      if (priority !== undefined) body.priority = priority;
      if (tags !== undefined) body.tags = tags;
      if (order !== undefined) body.order = order;
      if (status !== undefined) body.status = status;
      if (workState !== undefined) body.workState = workState;
      if (workStateDetails !== undefined) body.workStateDetails = projectWorkStateDetails(workStateDetails);
      if (Object.keys(body).length === 0) {
        throw new FlowBoardAdapterError(
          'task.update needs at least one field to change: status, workState, workStateDetails, title, ' +
            'description, priority, tags or order',
          'flowboard_empty_update',
        );
      }
      const payload = await call('PUT', taskPath(project, id), {
        principal,
        body,
        timeoutMs: WRITE_TIMEOUT_MS,
      });
      return this.taskAfterWrite(principal, project, payload);
    },

    /**
     * Accept work in review: review -> done plus an audit comment.
     *
     * `actor` is composed from the Gateway-verified profile here and never
     * from operation input, because FlowBoard's approve endpoint reads it from
     * the body and not from the principal headers.
     */
    async approveTask(principal, { project, id, reason } = {}) {
      const note = boundedOrNull(reason, MAX_REASON);
      const payload = await call(
        'POST',
        `/api/projects/${encodeURIComponent(project)}/tasks/${encodeURIComponent(id)}/approve`,
        {
          principal,
          body: { actor: principalActor(principal), ...(note ? { reason: note } : {}) },
          timeoutMs: WRITE_TIMEOUT_MS,
        },
      );
      return this.taskAfterWrite(principal, project, payload);
    },

    /**
     * Send work back: review -> in-progress plus an audit comment.
     *
     * `target` is not exposed. FlowBoard's default sends the task back to
     * in-progress and leaves its work state alone; `target: "blocked"` would
     * additionally set workState=blocked, which the board can already do
     * explicitly through `task.update` — and rejecting is a statement about
     * the review, not about whether the assignee is blocked.
     */
    async rejectTask(principal, { project, id, reason } = {}) {
      const note = boundedOrNull(reason, MAX_REASON);
      if (!note) {
        throw new FlowBoardAdapterError('A reason is required to reject a task in review', 'flowboard_reason_required');
      }
      const payload = await call(
        'POST',
        `/api/projects/${encodeURIComponent(project)}/tasks/${encodeURIComponent(id)}/reject`,
        {
          principal,
          body: { actor: principalActor(principal), reason: note },
          timeoutMs: WRITE_TIMEOUT_MS,
        },
      );
      return this.taskAfterWrite(principal, project, payload);
    },

    /**
     * Add a comment signed by the operator behind the call.
     *
     * FlowBoard's comment endpoint takes its author from the request body (it
     * does not read the principal headers), so the author is composed here
     * from the Gateway-verified profile — the same actor string approve and
     * reject sign with — and never from operation input.
     */
    async commentTask(principal, { project, id, message } = {}) {
      if (typeof message !== 'string' || !message.trim()) {
        throw new FlowBoardAdapterError('A comment needs a message', 'flowboard_message_required');
      }
      const payload = await call('POST', `${taskPath(project, id)}/comment`, {
        principal,
        body: { message: message.slice(0, MAX_COMMENT), author: principalActor(principal) },
        timeoutMs: WRITE_TIMEOUT_MS,
      });
      return { comment: projectComment(payload?.comment) };
    },

    /**
     * Move a task to FlowBoard's Trash, or restore it.
     *
     * Soft delete only: `trashedAt` is set to an ISO timestamp made in this
     * process, or cleared. Hard delete and "empty trash" need FlowBoard's
     * typed confirmations and are deliberately not reachable from here.
     */
    async trashTask(principal, { project, id, restore } = {}) {
      const trashedAt = restore === true ? null : now().toISOString();
      const payload = await call('PUT', taskPath(project, id), {
        principal,
        body: { trashedAt },
        timeoutMs: WRITE_TIMEOUT_MS,
      });
      const raw = payload?.task;
      const trashed = raw && Object.prototype.hasOwnProperty.call(raw, 'trashedAt')
        ? Boolean(raw.trashedAt)
        : trashedAt !== null;
      return { id: typeof raw?.id === 'string' && raw.id ? raw.id.slice(0, 64) : id, trashed };
    },

    async createTask(principal, { project, title, description, priority }) {
      const payload = await call('POST', `/api/projects/${encodeURIComponent(project)}/tasks`, {
        principal,
        body: {
          title,
          ...(description === undefined ? {} : { description }),
          ...(priority === undefined ? {} : { priority }),
        },
        timeoutMs: WRITE_TIMEOUT_MS,
      });
      const id = payload?.task?.id;
      if (typeof id !== 'string' || !id) {
        throw new FlowBoardAdapterError('FlowBoard created the task but returned no id');
      }
      return { id };
    },
  };
}

export default createFlowBoardAdapter;
