/**
 * FlowBoard HTTP adapter for the OpenClaw Gateway facade (T-487-7, ADR-0040).
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
      }));
    },

    async getStatus(principal, { agentId, sessionKey }) {
      const query = new URLSearchParams({ agentId });
      const payload = await call('GET', `/api/status?${query.toString()}`, { principal });
      return {
        activeProject: typeof payload.activeProject === 'string' ? payload.activeProject : null,
        binding: {
          agentId: String(payload.agentId ?? agentId),
          contextReady: payload.contextReady === true,
          sessionKey: typeof sessionKey === 'string' && sessionKey ? sessionKey : null,
        },
      };
    },

    async setStatus(principal, { agentId, project }) {
      const payload = await call('PUT', '/api/status', {
        principal,
        body: { agentId, project: project === null ? 'none' : project },
        timeoutMs: WRITE_TIMEOUT_MS,
      });
      return { activeProject: typeof payload.activeProject === 'string' ? payload.activeProject : null };
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
