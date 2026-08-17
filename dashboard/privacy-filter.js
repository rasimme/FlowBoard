'use strict';

/**
 * Privacy filter for logs (T-441-4): prevents sensitive parameters from leaking
 * into logs or error messages.
 *
 * This is a defense-in-depth layer that sanitizes common logging patterns
 * before they reach stdout/stderr.
 */

const SENSITIVE_PATTERNS = [
  // Telegram bot tokens (format: 123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11)
  /\d+:[A-Za-z0-9_-]{34,}/g,

  // JWT tokens (format: header.payload.signature)
  /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,

  // Generic bearer tokens
  /Bearer\s+[A-Za-z0-9_.-]+/gi,

  // Common secret patterns
  /["']?(password|secret|token|key|api_?key|auth_?token)["']?\s*[:=]\s*["']?[^\s"']+/gi,

  // GitHub tokens
  /ghp_[A-Za-z0-9_]{36,}/g,
  /github_[A-Za-z0-9_]{32,}/g,
];

const SENSITIVE_HEADERS = new Set([
  'x-telegram-init-data',
  'authorization',
  'cookie',
  'set-cookie',
]);

const SENSITIVE_QUERY_PARAMS = new Set([
  'token',
  'api_key',
  'apikey',
  'secret',
  'password',
  'auth',
]);

/**
 * Sanitize a string by removing sensitive tokens/secrets.
 */
function sanitizeString(str) {
  if (typeof str !== 'string') return str;

  let result = str;
  SENSITIVE_PATTERNS.forEach(pattern => {
    result = result.replace(pattern, '[REDACTED]');
  });
  return result;
}

/**
 * Filter request headers, redacting sensitive ones.
 */
function filterHeaders(headers) {
  const filtered = { ...headers };
  SENSITIVE_HEADERS.forEach(key => {
    if (key in filtered) {
      filtered[key] = '[REDACTED]';
    }
  });
  return filtered;
}

/**
 * Filter query parameters, redacting sensitive ones.
 */
function filterQueryParams(query) {
  const filtered = { ...query };
  SENSITIVE_QUERY_PARAMS.forEach(key => {
    if (key in filtered) {
      filtered[key] = '[REDACTED]';
    }
  });
  return filtered;
}

/**
 * Middleware to wrap console methods and sanitize logs.
 */
function installPrivacyFilter() {
  const originalWarn = console.warn;
  const originalError = console.error;
  const originalLog = console.log;

  console.warn = function(...args) {
    const sanitized = args.map(arg => sanitizeString(String(arg)));
    originalWarn.apply(console, sanitized);
  };

  console.error = function(...args) {
    const sanitized = args.map(arg => sanitizeString(String(arg)));
    originalError.apply(console, sanitized);
  };

  console.log = function(...args) {
    const sanitized = args.map(arg => sanitizeString(String(arg)));
    originalLog.apply(console, sanitized);
  };
}

module.exports = {
  sanitizeString,
  filterHeaders,
  filterQueryParams,
  installPrivacyFilter,
  SENSITIVE_PATTERNS,
  SENSITIVE_HEADERS,
  SENSITIVE_QUERY_PARAMS,
};
