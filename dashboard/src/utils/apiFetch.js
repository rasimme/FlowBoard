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

  // Always send credentials (cookies) for cross-origin auth via tunnel
  const credentials = 'include';

  // If Telegram WebApp is available, send initData for auth
  const tg = window.Telegram?.WebApp;
  if (tg?.initData) {
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

export async function apiJson(path, opts = {}) {
  const normalizedPath = path.startsWith('/api/') ? path : `/api${path.startsWith('/') ? path : `/${path}`}`;
  const res = await apiFetch(normalizedPath, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || `HTTP ${res.status}`);
  }
  return data;
}
