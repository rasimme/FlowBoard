/**
 * apiFetch — Centralized fetch wrapper for FlowBoard API calls.
 *
 * Handles:
 * - Telegram WebApp authentication (sends initData header if available)
 * - Cookie credentials (for session-based auth via Cloudflare tunnel)
 * - JSON Content-Type for POST/PUT/PATCH
 * - Error extraction from response body
 *
 * @param {string} path - API path (e.g., '/api/projects/myproject/tasks')
 * @param {object} [opts] - Fetch options (method, body, signal, etc.)
 * @returns {Promise<Response>} - The fetch Response object
 */
export function apiFetch(path, opts = {}) {
  const headers = { ...opts.headers };

  // Identify the dashboard UI to the server so it can tell a human-driven
  // request from an agent/headless one (e.g. creation-time overview suggestion
  // is offered for confirmation in the UI but auto-applied for agents — T-365).
  if (!headers['X-FlowBoard-Client']) headers['X-FlowBoard-Client'] = 'dashboard';

  // T-432: reject explicit external URLs before fetch can leave the dashboard origin.
  let credentials = 'omit';
  let isSameOriginApi = false;
  const isExplicitAbsoluteUrl = /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(path) || path.startsWith('//');
  if (path.startsWith('/api/')) {
    // relative path starting with /api/ is same-origin
    isSameOriginApi = true;
    credentials = 'include';
  } else {
    try {
      const origin = globalThis.window?.location?.origin;
      if (origin) {
        const url = new URL(path, origin);
        if (url.origin === origin && url.pathname.startsWith('/api/')) {
          isSameOriginApi = true;
          credentials = 'include';
        } else if (isExplicitAbsoluteUrl && url.origin !== origin) {
          throw new Error('apiFetch: external URLs are not allowed');
        }
      } else if (isExplicitAbsoluteUrl) {
        throw new Error('apiFetch: absolute URLs require a browser origin');
      }
    } catch (error) {
      if (error?.message?.startsWith('apiFetch:')) throw error;
      if (isExplicitAbsoluteUrl) throw new Error('apiFetch: invalid absolute URL');
    }
  }

  // If Telegram WebApp is available and this is a same-origin /api request, send initData
  const tg = window.Telegram?.WebApp;
  if (isSameOriginApi && tg?.initData) {
    headers['X-Telegram-Init-Data'] = tg.initData;
  }

  let body = opts.body;
  const isJsonObject = body && typeof body === 'object' && !(body instanceof FormData);

  // Auto-set Content-Type for JSON bodies
  if ((isJsonObject || typeof body === 'string') && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  if (isJsonObject) body = JSON.stringify(body);

  return fetch(path, {
    ...opts,
    headers,
    credentials,
    body,
  });
}

export class ApiError extends Error {
  constructor(message, { status = null, kind = 'http', path = null, cause = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.kind = kind;
    this.path = path;
    if (cause) this.cause = cause;
  }
}

export async function apiJson(path, opts = {}) {
  const normalizedPath = path.startsWith('/api/') ? path : `/api${path.startsWith('/') ? path : `/${path}`}`;
  let res;
  try {
    res = await apiFetch(normalizedPath, opts);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('Unable to reach the FlowBoard service.', {
      kind: 'network',
      path: normalizedPath,
      cause: error,
    });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(data?.error || `HTTP ${res.status}`, {
      status: res.status,
      kind: 'http',
      path: normalizedPath,
    });
  }
  return data;
}
