/**
 * FlowBoard HTTP adapter for the OpenClaw Gateway facade (T-487-7, ADR-0040;
 * "needing me" and session-scoped status added in T-487-8).
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

/** Errors the host turns into a feature-operation failure, message only. */
export class FlowBoardAdapterError extends Error {
  constructor(message, code = 'flowboard_unavailable') {
    super(message);
    this.name = 'FlowBoardAdapterError';
    this.code = code;
  }
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
          typeof payload?.code === 'string' ? payload.code.slice(0, 64) : 'flowboard_rejected',
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
          const rows = Array.isArray(payload.tasks) ? payload.tasks : [];
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

    async listTasks(principal, { project, status }) {
      const query = status ? `?${new URLSearchParams({ status }).toString()}` : '';
      const payload = await call('GET', `/api/projects/${encodeURIComponent(project)}/tasks${query}`, { principal });
      const rows = Array.isArray(payload.tasks) ? payload.tasks : [];
      return rows.slice(0, 500).map((task) => ({
        id: String(task?.id ?? ''),
        title: String(task?.title ?? '').slice(0, 256),
        status: String(task?.status ?? 'unknown'),
        agent: typeof task?.agent === 'string' && task.agent ? task.agent.slice(0, 64) : null,
        priority: String(task?.priority ?? 'medium'),
      }));
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
