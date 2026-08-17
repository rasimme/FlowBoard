/**
 * apiFetch — Centralized fetch wrapper for FlowBoard API calls.
 *
 * Handles:
 * - Telegram WebApp authentication (sends initData header if available)
 * - Cookie credentials (for session-based auth via Cloudflare tunnel)
 * - JSON Content-Type for POST/PUT/PATCH
 * - Optional request deadlines with caller abort propagation
 * - Error extraction from response body through apiJson
 *
 * @param {string} path - API path (e.g., '/api/projects/myproject/tasks')
 * @param {object} [opts] - Fetch options plus optional timeoutMs
 * @returns {Promise<Response>} - The fetch Response object
 */
export const DEFAULT_API_TIMEOUT_MS = 10000;

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

  const { timeoutMs = null, signal: callerSignal, ...fetchOptions } = opts;
  const hasDeadline = Number.isFinite(timeoutMs) && timeoutMs > 0;
  const controller = hasDeadline ? new AbortController() : null;
  let timedOut = false;
  let timeoutId = null;
  let removeAbortForwarder = null;

  if (controller && callerSignal) {
    const forwardAbort = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      controller.abort(callerSignal.reason);
    };
    if (callerSignal.aborted) forwardAbort();
    else {
      callerSignal.addEventListener('abort', forwardAbort, { once: true });
      removeAbortForwarder = () => callerSignal.removeEventListener('abort', forwardAbort);
    }
  }

  if (controller && !controller.signal.aborted) {
    timeoutId = setTimeout(() => {
      if (controller.signal.aborted) return;
      timedOut = true;
      controller.abort(new DOMException('FlowBoard API request timed out', 'TimeoutError'));
    }, timeoutMs);
  }

  let request;
  try {
    request = fetch(path, {
      ...fetchOptions,
      headers,
      credentials,
      body,
      signal: controller?.signal || callerSignal,
    });
  } catch (error) {
    if (timeoutId) clearTimeout(timeoutId);
    removeAbortForwarder?.();
    throw error;
  }

  return request.catch((error) => {
    if (timedOut) {
      throw new ApiError(`FlowBoard did not respond within ${timeoutMs} ms.`, {
        kind: 'timeout',
        path,
        cause: error,
      });
    }
    throw error;
  }).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
    removeAbortForwarder?.();
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

/**
 * Run related API calls as one failure domain. The first rejection aborts every
 * still-running sibling and waits for their abort handlers to settle before the
 * group rejects, so callers cannot start a replacement while old network work
 * is still alive.
 */
export async function abortableAll(requestFactories, { signal: parentSignal } = {}) {
  const controller = new AbortController();
  const forwardParentAbort = () => controller.abort(parentSignal.reason);
  if (parentSignal?.aborted) forwardParentAbort();
  else parentSignal?.addEventListener('abort', forwardParentAbort, { once: true });

  const requests = requestFactories.map((request) => Promise.resolve().then(() => request(controller.signal)));
  try {
    return await Promise.all(requests);
  } catch (error) {
    if (!controller.signal.aborted) {
      controller.abort(new DOMException('Sibling FlowBoard request failed', 'AbortError'));
    }
    await Promise.allSettled(requests);
    throw error;
  } finally {
    parentSignal?.removeEventListener('abort', forwardParentAbort);
  }
}

export async function apiJson(path, opts = {}) {
  const normalizedPath = path.startsWith('/api/') ? path : `/api${path.startsWith('/') ? path : `/${path}`}`;
  let res;
  try {
    res = await apiFetch(normalizedPath, {
      ...opts,
      timeoutMs: opts.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error?.name === 'AbortError') {
      throw new ApiError('FlowBoard request was cancelled.', {
        kind: 'aborted',
        path: normalizedPath,
        cause: error,
      });
    }
    throw new ApiError('Unable to reach the FlowBoard service.', {
      kind: 'network',
      path: normalizedPath,
      cause: error,
    });
  }

  let data;
  let parseError = null;
  try {
    data = await res.json();
  } catch (error) {
    parseError = error;
  }

  if (!res.ok) {
    throw new ApiError((!parseError && data?.error) || `HTTP ${res.status}`, {
      status: res.status,
      kind: 'http',
      path: normalizedPath,
    });
  }

  if (parseError) {
    throw new ApiError('FlowBoard returned an invalid JSON response.', {
      kind: 'protocol',
      path: normalizedPath,
      cause: parseError,
    });
  }

  return data;
}
