/**
 * Allow-list and limits for the Gateway API passthrough (T-515-1).
 *
 * The native Control UI runs the same React client as the standalone
 * dashboard. Its browser bundle cannot reach the dashboard port (the Control
 * UI's CSP forbids it), so every `/api/` call travels as one of two raw
 * Gateway methods and is replayed here over loopback HTTP.
 *
 * Raw Gateway methods are not schema-checked by the host. This module is that
 * check: a request is forwarded only when its method and path match a rule
 * below, and both directions are size-bounded. It is SDK-free on purpose so
 * the suite can pin it on every Node.
 *
 * The list is "what the dashboard client calls", not "what the API offers".
 * Deliberately absent: self-update (`/api/update/run`), dashboard sign-in
 * (`/api/auth`), webhooks, agent-row deletion, and the agent workflow
 * endpoints, none of which the native page needs.
 */

/** Gateway method names; shared by the plugin backend and the browser bundle. */
export const API_READ_METHOD = 'flowboard.api.read';
export const API_WRITE_METHOD = 'flowboard.api.write';

/** Longest request path (including query) that is forwarded. */
export const MAX_PATH_LENGTH = 2048;
/** Largest request body, in UTF-16 code units of the string the client sent. */
export const MAX_REQUEST_BODY = 16 * 1024 * 1024;
/** Largest response body returned to the browser. */
export const MAX_RESPONSE_BODY = 16 * 1024 * 1024;
export const PASSTHROUGH_READ_TIMEOUT_MS = 15000;
export const PASSTHROUGH_WRITE_TIMEOUT_MS = 30000;

/** Request content types the dashboard client sends. */
export const ALLOWED_CONTENT_TYPES = Object.freeze([
  'application/json',
  'application/vnd.flowboard.project+json',
]);

/** Response headers the React client reads; nothing else is passed back. */
export const FORWARDED_RESPONSE_HEADERS = Object.freeze([
  'content-type',
  'etag',
  'retry-after',
  'content-disposition',
]);

const SEG = '[^/]+';
const P = `/api/projects/${SEG}`;
const T = `${P}/tasks/${SEG}`;
const S = `/api/specify/sessions/${SEG}`;

const TASK_ACTIONS = [
  'approve', 'reject', 'comment', 'claim', 'release', 'complete', 'checkpoint', 'move', 'parent',
  'route', 'exception-review', 'structure-review', 'stuck-indicator/clear', 'stuck-indicator/retry',
].join('|');
const SPECIFY_ACTIONS = 'next|abort|answer|complete|confirm|retry|revise|skip';

/** [method, pathname pattern]. Patterns are anchored when compiled. */
export const ALLOW_RULES = Object.freeze([
  // Global reads
  ['GET', '/api/info'],
  ['GET', '/api/health'],
  ['GET', '/api/status'],
  ['GET', '/api/agents'],
  ['GET', '/api/search'],
  ['GET', '/api/tasks/stuck'],
  ['GET', '/api/overview/widgets'],
  ['GET', '/api/dashboard/snapshot/v1'],
  ['GET', '/api/github/(?:insight|repo-status)'],
  ['GET', '/api/settings/github-token'],
  ['GET', '/api/snippets/status'],
  ['GET', '/api/migrations/canvas/status'],
  ['GET', '/api/update/status'],
  ['GET', '/api/specify/sessions'],
  ['GET', S],
  // Project reads
  ['GET', '/api/projects'],
  ['GET', '/api/projects/(?:deleted|drift|import/status)'],
  ['GET', `/api/projects/import/${SEG}`],
  ['GET', `${P}/(?:tasks|overview|canvas|files|github|task-discipline|activity|activity/daily|questions|export|stats|exceptions)`],
  ['GET', `${P}/files/.+`],
  ['GET', T],
  ['GET', `${T}/(?:checkpoints|comments|events)`],
  // Global writes
  ['PUT', '/api/status'],
  ['PUT', '/api/settings/github-token'],
  ['DELETE', '/api/settings/github-token'],
  ['POST', '/api/snippets/apply'],
  ['POST', '/api/migrations/canvas/run'],
  ['POST', '/api/specify/sessions'],
  ['POST', `${S}/(?:${SPECIFY_ACTIONS})`],
  // Project writes
  ['POST', '/api/projects'],
  ['POST', '/api/projects/import'],
  ['POST', '/api/projects/import/preview'],
  ['PUT', P],
  ['DELETE', P],
  ['POST', `${P}/(?:restore|export|tasks|files/context|overview/ops)`],
  ['POST', `${P}/specs/${SEG}`],
  ['PUT', `${P}/(?:overview|github|task-discipline)`],
  ['PUT', `${P}/files/.+`],
  ['DELETE', `${P}/files/.+`],
  ['PUT', T],
  ['DELETE', T],
  ['POST', `${T}/(?:${TASK_ACTIONS})`],
  ['POST', `${P}/canvas/(?:notes|connections|promote)`],
  ['PUT', `${P}/canvas/notes/${SEG}`],
  // A note id, never the batch endpoint (the dashboard client does not use it).
  ['DELETE', `${P}/canvas/notes/(?!batch$)${SEG}`],
  ['DELETE', `${P}/canvas/connections`],
]);

const COMPILED = ALLOW_RULES.map(([method, pattern]) => ({ method, re: new RegExp(`^${pattern}$`) }));

const WRITE_METHODS = new Set(['POST', 'PUT', 'DELETE']);

function refuse(status, code, error) {
  return { ok: false, status, code, error };
}

/**
 * Decide whether one request may be forwarded.
 *
 * @param {{ method?: unknown, path?: unknown, body?: unknown, contentType?: unknown }} request
 * @param {{ allowWrite: boolean }} lane - the Gateway method the call arrived on
 * @returns {{ ok: true, method: string, path: string } | { ok: false, status: number, code: string, error: string }}
 */
export function checkApiRequest(request, { allowWrite }) {
  const method = allowWrite ? String(request?.method || '').toUpperCase() : 'GET';
  if (allowWrite && !WRITE_METHODS.has(method)) {
    return refuse(405, 'GATEWAY_METHOD_NOT_ALLOWED', 'Method not allowed');
  }
  const raw = request?.path;
  if (typeof raw !== 'string' || !raw.startsWith('/api/') || raw.length > MAX_PATH_LENGTH) {
    return refuse(400, 'GATEWAY_PATH_INVALID', 'Only FlowBoard /api/ paths can be requested');
  }
  // No backslashes, control characters, fragments or encoded separators: the
  // pathname that is matched below must be the pathname the dashboard routes.
  if (/[\\\u0000-\u001f\u007f#]/.test(raw) || /%(?:2f|5c|2e)/i.test(raw.split('?')[0])) {
    return refuse(400, 'GATEWAY_PATH_INVALID', 'Unsupported characters in the request path');
  }
  let url;
  try {
    url = new URL(raw, 'http://flowboard.invalid');
  } catch {
    return refuse(400, 'GATEWAY_PATH_INVALID', 'Malformed request path');
  }
  // URL parsing resolves dot segments; a path that changed was not canonical.
  if (url.origin !== 'http://flowboard.invalid' || url.pathname !== raw.split('?')[0]) {
    return refuse(400, 'GATEWAY_PATH_INVALID', 'The request path must be canonical');
  }
  if (!COMPILED.some((rule) => rule.method === method && rule.re.test(url.pathname))) {
    return refuse(403, 'GATEWAY_PATH_NOT_ALLOWED', 'This FlowBoard endpoint is not available through the Gateway');
  }
  if (request?.body !== undefined) {
    if (!allowWrite || typeof request.body !== 'string') {
      return refuse(400, 'GATEWAY_BODY_INVALID', 'The request body must be a string');
    }
    if (request.body.length > MAX_REQUEST_BODY) {
      return refuse(413, 'GATEWAY_BODY_TOO_LARGE', 'The request body is too large for the Gateway transport');
    }
  }
  if (request?.contentType !== undefined && !ALLOWED_CONTENT_TYPES.includes(request.contentType)) {
    return refuse(415, 'GATEWAY_CONTENT_TYPE_NOT_ALLOWED', 'Unsupported content type');
  }
  return { ok: true, method, path: `${url.pathname}${url.search}` };
}

/** The `{ status, headers, body }` envelope for a refusal made here. */
export function refusalResponse({ status, code, error }) {
  return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: false, error, code }) };
}
