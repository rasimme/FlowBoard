import { isAuthenticationFailure, markAuthHalted } from '../state/authState.mjs';

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

async function authenticationFailureForResponse(response, path) {
  if (response.status === 401) return { status: response.status, path };
  if (response.status !== 403 || typeof response.clone !== 'function') return null;

  // Keep the original response for the caller. The clone lets apiFetch
  // classify a typed auth denial even when a view uses apiFetch directly and
  // parses the original response itself instead of going through apiJson.
  try {
    const data = await response.clone().json();
    const failure = { status: response.status, path, code: data?.code };
    return isAuthenticationFailure(failure) ? failure : null;
  } catch {
    // A malformed/untyped 403 is a domain or protocol failure, not proof that
    // the dashboard credentials are stale.
    return null;
  }
}

export function apiFetch(path, opts = {}) {
  const headers = { ...opts.headers };

  // Descriptive client marker for UI-specific, non-authoritative behavior
  // (e.g. creation-time overview suggestions — T-365). It is intentionally not
  // an authentication or human-authorization signal; request headers are
  // caller-controlled.
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

  return request.then(async (response) => {
    // 401 is unambiguously an authentication failure. A 403 must carry one of
    // the server's stable auth codes; authorization conflicts such as
    // NOT_OWNER, AGENT_REQUIRED, and ROUTING_MISMATCH must remain local to the
    // failed action and cannot halt global polling.
    const authFailure = await authenticationFailureForResponse(response, path);
    if (authFailure) markAuthHalted(authFailure);
    return response;
  }).catch((error) => {
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
  constructor(message, {
    status = null,
    kind = 'http',
    path = null,
    cause = null,
    code = null,
    retryAfterSeconds = null,
    rateLimitScope = null,
  } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.kind = kind;
    this.path = path;
    if (typeof code === 'string' && code) this.code = code;
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
      this.retryAfterSeconds = retryAfterSeconds;
    }
    if (typeof rateLimitScope === 'string' && rateLimitScope) this.rateLimitScope = rateLimitScope;
    if (cause) this.cause = cause;
  }
}

function createRequestAbortScope(callerSignal, timeoutMs) {
  const controller = new AbortController();
  const hasDeadline = Number.isFinite(timeoutMs) && timeoutMs > 0;
  let timedOut = false;
  let timeoutId = null;
  let removeCallerAbort = null;

  const abortFromCaller = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    if (!controller.signal.aborted) controller.abort(callerSignal.reason);
  };

  if (callerSignal?.aborted) {
    abortFromCaller();
  } else if (callerSignal) {
    callerSignal.addEventListener('abort', abortFromCaller, { once: true });
    removeCallerAbort = () => callerSignal.removeEventListener('abort', abortFromCaller);
  }

  if (hasDeadline && !controller.signal.aborted) {
    timeoutId = setTimeout(() => {
      if (controller.signal.aborted) return;
      timedOut = true;
      controller.abort(new DOMException('FlowBoard API request timed out', 'TimeoutError'));
    }, timeoutMs);
  }

  return {
    signal: controller.signal,
    didTimeOut: () => timedOut,
    cleanup() {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      removeCallerAbort?.();
      removeCallerAbort = null;
    },
  };
}

function normalizeRequestError(error, { callerSignal, deadline, path, timeoutMs }) {
  if (deadline.didTimeOut()) {
    return new ApiError(`FlowBoard did not respond within ${timeoutMs} ms.`, {
      kind: 'timeout',
      path,
      cause: error,
    });
  }
  if (callerSignal?.aborted || error?.name === 'AbortError') {
    return new ApiError('FlowBoard request was cancelled.', {
      kind: 'aborted',
      path,
      cause: error,
    });
  }
  if (error instanceof ApiError) return error;
  return new ApiError('Unable to reach the FlowBoard service.', {
    kind: 'network',
    path,
    cause: error,
  });
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

  // Start every sibling in this turn. Deferring factories to a microtask lets
  // React StrictMode's mount rehearsal abort the whole initial group before a
  // single fetch is even issued, making the real mount depend on a poll tick.
  // Promise.resolve still normalizes synchronous returns, while the try/catch
  // preserves rejection semantics for a synchronously throwing factory.
  const requests = requestFactories.map((request) => {
    try {
      return Promise.resolve(request(controller.signal));
    } catch (error) {
      return Promise.reject(error);
    }
  });
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
  const {
    timeoutMs = DEFAULT_API_TIMEOUT_MS,
    signal: callerSignal,
    // T-450-4: opt-in only. Every existing caller keeps getting the bare
    // parsed body back exactly as before; `withETag` is not forwarded to the
    // underlying fetch() call (it is stripped into requestOptions here, not
    // spread into it).
    withETag = false,
    ...requestOptions
  } = opts;
  const deadline = createRequestAbortScope(callerSignal, timeoutMs);
  const requestContext = {
    callerSignal,
    deadline,
    path: normalizedPath,
    timeoutMs,
  };

  try {
    let res;
    try {
      // apiJson owns one deadline for the complete operation. Passing only its
      // linked signal prevents apiFetch from clearing a second timer as soon as
      // headers arrive; the scope stays alive through response.json().
      res = await apiFetch(normalizedPath, {
        ...requestOptions,
        signal: deadline.signal,
      });
    } catch (error) {
      throw normalizeRequestError(error, requestContext);
    }

    // T-450-3/T-450-4: a conditional GET (caller sent If-None-Match) answers
    // with a bodyless 304 when the digest is unchanged. That is not the
    // normal !res.ok error path — res.json() would fail on the empty body —
    // so a `withETag` caller gets this handled explicitly instead. 304 still
    // counts against the read-lane rate-limit budget server-side (spec's
    // "Vertragspunkte zwischen den Lanes"); this only changes what the
    // *client* does with the response.
    if (withETag && res.status === 304) {
      return { notModified: true, data: null, etag: res.headers?.get?.('etag') || null };
    }

    let data;
    let parseError = null;
    try {
      data = await res.json();
    } catch (error) {
      if (deadline.didTimeOut() || callerSignal?.aborted || error?.name === 'AbortError') {
        throw normalizeRequestError(error, requestContext);
      }
      parseError = error;
    }

    if (!res.ok) {
      const retryAfterHeader = res.headers?.get?.('retry-after') || null;
      const retryAfterSeconds = retryAfterHeader && /^\d+(?:\.\d+)?$/.test(retryAfterHeader.trim())
        ? Math.max(0, Number(retryAfterHeader.trim()))
        : (!parseError && Number.isFinite(data?.retryAfter) ? Math.max(0, Number(data.retryAfter)) : null);
      throw new ApiError((!parseError && data?.error) || `HTTP ${res.status}`, {
        status: res.status,
        kind: 'http',
        path: normalizedPath,
        code: !parseError && typeof data?.code === 'string' ? data.code : null,
        retryAfterSeconds,
        rateLimitScope: !parseError && typeof data?.scope === 'string'
          ? data.scope
          : (!parseError && typeof data?.lane === 'string' ? data.lane : null),
      });
    }

    if (parseError) {
      throw new ApiError('FlowBoard returned an invalid JSON response.', {
        kind: 'protocol',
        path: normalizedPath,
        cause: parseError,
      });
    }

    return withETag ? { notModified: false, data, etag: res.headers?.get?.('etag') || null } : data;
  } finally {
    deadline.cleanup();
  }
}
