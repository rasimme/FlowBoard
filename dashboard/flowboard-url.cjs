'use strict';

const DEFAULT_DASHBOARD_PORT = 18790;
const DEFAULT_DASHBOARD_BASE_URL = `http://localhost:${DEFAULT_DASHBOARD_PORT}`;

function readPort(value) {
  if (value === undefined || value === null || value === '') return null;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

function normalizeBaseUrl(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const path = url.pathname.replace(/\/+$/, '');
    return `${url.origin}${path === '/' ? '' : path}`;
  } catch {
    return null;
  }
}

function resolveDashboardPort(config = {}, env = process.env) {
  return readPort(config.dashboardPort) || readPort(env.FLOWBOARD_PORT) || DEFAULT_DASHBOARD_PORT;
}

function resolveDashboardBaseUrl(config = {}, env = process.env, options = {}) {
  const includeLegacyApi = options.includeLegacyApi !== false;
  return (
    normalizeBaseUrl(config.dashboardBaseUrl) ||
    normalizeBaseUrl(env.FLOWBOARD_BASE_URL) ||
    (includeLegacyApi ? normalizeBaseUrl(env.FLOWBOARD_API) : null) ||
    `http://localhost:${resolveDashboardPort(config, env)}`
  );
}

function joinApiPath(baseUrl, apiPath) {
  const base = normalizeBaseUrl(baseUrl) || DEFAULT_DASHBOARD_BASE_URL;
  return `${base}/${String(apiPath || '').replace(/^\/+/, '')}`;
}

function renderSnippetBaseUrl(content, baseUrl) {
  const resolved = normalizeBaseUrl(baseUrl) || DEFAULT_DASHBOARD_BASE_URL;
  let resolvedLoopbackIp = resolved;
  try {
    const url = new URL(resolved);
    if (url.hostname === 'localhost') {
      url.hostname = '127.0.0.1';
      resolvedLoopbackIp = `${url.origin}${url.pathname === '/' ? '' : url.pathname}`;
    }
  } catch {
    resolvedLoopbackIp = resolved;
  }
  return String(content || '')
    .replace(/http:\/\/localhost:18790/g, () => resolved)
    .replace(/http:\/\/127\.0\.0\.1:18790/g, () => resolvedLoopbackIp);
}

module.exports = {
  DEFAULT_DASHBOARD_PORT,
  DEFAULT_DASHBOARD_BASE_URL,
  joinApiPath,
  normalizeBaseUrl,
  readPort,
  renderSnippetBaseUrl,
  resolveDashboardBaseUrl,
  resolveDashboardPort,
};
