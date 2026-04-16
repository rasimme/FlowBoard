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

  // Always send credentials (cookies) for cross-origin auth via tunnel
  const credentials = 'include';

  // If Telegram WebApp is available, send initData for auth
  const tg = window.Telegram?.WebApp;
  if (tg?.initData) {
    headers['X-Telegram-Init-Data'] = tg.initData;
  }

  // Auto-set Content-Type for JSON bodies
  if (opts.body && typeof opts.body === 'string' && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  return fetch(path, {
    ...opts,
    headers,
    credentials,
  });
}
