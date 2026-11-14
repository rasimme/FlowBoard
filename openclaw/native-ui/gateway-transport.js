/**
 * Browser half of the Gateway API passthrough (T-515-1, ADR-0042).
 *
 * Turns the `(path, init)` the dashboard client would hand to `fetch` into one
 * raw Gateway method call and the answer back into a `Response`, so the React
 * client keeps its own status, ETag and error handling unchanged.
 *
 * `request(method, params)` is the host's Gateway request function. This file
 * has no SDK import so the suite can exercise it on plain Node.
 */
import { API_READ_METHOD, API_WRITE_METHOD } from '../api-passthrough.js';

function headerValue(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return headers.get(name) || '';
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && value != null) return String(value);
  }
  return '';
}

async function bodyToString(body) {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body;
  if (typeof Blob !== 'undefined' && body instanceof Blob) return body.text();
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return new TextDecoder().decode(body);
  throw new TypeError('FlowBoard Gateway transport: unsupported request body');
}

function abortError(signal) {
  return signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

export function createGatewayTransport(request) {
  if (typeof request !== 'function') throw new TypeError('createGatewayTransport needs the host request function');
  return async function gatewayTransport(path, init = {}) {
    const { signal } = init;
    if (signal?.aborted) throw abortError(signal);
    const method = String(init.method || 'GET').toUpperCase();
    const params = { path: String(path) };
    let gatewayMethod = API_READ_METHOD;
    if (method === 'GET') {
      const ifNoneMatch = headerValue(init.headers, 'if-none-match');
      if (ifNoneMatch) params.ifNoneMatch = ifNoneMatch;
    } else {
      gatewayMethod = API_WRITE_METHOD;
      params.method = method;
      const body = await bodyToString(init.body);
      if (body !== undefined) {
        params.body = body;
        const contentType = headerValue(init.headers, 'content-type').split(';')[0].trim().toLowerCase();
        if (contentType && contentType !== 'application/json') params.contentType = contentType;
      }
      const confirmation = headerValue(init.headers, 'x-flowboard-sensitive-confirmation');
      if (confirmation) params.sensitiveConfirmation = confirmation;
    }

    let onAbort = null;
    const aborted = signal
      ? new Promise((_, reject) => {
          onAbort = () => reject(abortError(signal));
          signal.addEventListener('abort', onAbort, { once: true });
        })
      : null;
    let result;
    try {
      const call = request(gatewayMethod, params);
      result = await (aborted ? Promise.race([call, aborted]) : call);
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }

    const status = Number.isInteger(result?.status) && result.status >= 200 && result.status <= 599 ? result.status : 502;
    const bodyless = status === 204 || status === 205 || status === 304;
    const headers = result?.headers && typeof result.headers === 'object' ? result.headers : {};
    return new Response(bodyless ? null : String(result?.body ?? ''), { status, headers });
  };
}
