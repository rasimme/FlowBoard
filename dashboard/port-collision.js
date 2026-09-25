'use strict';

// T-495: OpenClaw's MCP Apps host bridge (opt-in, `mcp.apps.enabled`) starts a
// sandbox-only listener on the Gateway port + 1 unless `mcp.apps.sandboxPort`
// moves it. FlowBoard's previous default (18790) is exactly that port for the
// default Gateway (18789), so name the collision instead of printing a bare
// EADDRINUSE.

const DEFAULT_GATEWAY_PORT = 18789;

function readPort(value) {
  if (value === undefined || value === null || value === '') return null;
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

// Mirrors the server's Gateway resolution: URL form wins over port-only form,
// OPENCLAW_-prefixed names win over bare aliases.
function resolveGatewayPort(env = process.env) {
  const url = env.OPENCLAW_GATEWAY_URL || env.GATEWAY_URL;
  if (url) {
    try {
      const parsed = new URL(url);
      return readPort(parsed.port) || (parsed.protocol === 'https:' || parsed.protocol === 'wss:' ? 443 : 80);
    } catch {
      return DEFAULT_GATEWAY_PORT;
    }
  }
  return readPort(env.OPENCLAW_GATEWAY_PORT) || readPort(env.GATEWAY_PORT) || DEFAULT_GATEWAY_PORT;
}

function mcpAppsSandboxPort(env = process.env) {
  return resolveGatewayPort(env) + 1;
}

function isMcpAppsSandboxPort(port, env = process.env) {
  return Number(port) === mcpAppsSandboxPort(env);
}

function sandboxCollisionText(port, env = process.env) {
  const gatewayPort = resolveGatewayPort(env);
  return [
    `Port ${port} is the OpenClaw Gateway port (${gatewayPort}) + 1, which the OpenClaw MCP Apps sandbox listener uses when mcp.apps.enabled is true.`,
    'Fix one of:',
    '  - move FlowBoard: set FLOWBOARD_PORT to a free port (default 18700) and point the plugin at it with',
    '    openclaw config set plugins.entries.flowboard.config.dashboardPort <port>',
    '  - move the sandbox: openclaw config set mcp.apps.sandboxPort <port>, then restart the Gateway',
  ].join('\n');
}

// Startup warning when the chosen port equals Gateway + 1. FlowBoard may win
// the bind race, in which case the MCP Apps sandbox is the one that fails.
function describeSandboxOverlap(port, env = process.env) {
  if (!isMcpAppsSandboxPort(port, env)) return null;
  return `[startup] Warning: ${sandboxCollisionText(port, env)}`;
}

// Actionable message for a failed app.listen().
function describeListenError(error, { port, host, env = process.env } = {}) {
  const where = `http://${host}:${port}`;
  if (error?.code !== 'EADDRINUSE') {
    return `[startup] Failed to listen on ${where}: ${error?.message || error}`;
  }
  if (isMcpAppsSandboxPort(port, env)) {
    return `[startup] Failed to listen on ${where}: port ${port} is already in use.\n${sandboxCollisionText(port, env)}`;
  }
  return [
    `[startup] Failed to listen on ${where}: port ${port} is already in use (another FlowBoard instance or another service).`,
    'Fix: stop the other process, or set FLOWBOARD_PORT to a free port and point the plugin at it with',
    '  openclaw config set plugins.entries.flowboard.config.dashboardPort <port>',
  ].join('\n');
}

module.exports = {
  DEFAULT_GATEWAY_PORT,
  describeListenError,
  describeSandboxOverlap,
  isMcpAppsSandboxPort,
  mcpAppsSandboxPort,
  resolveGatewayPort,
};
