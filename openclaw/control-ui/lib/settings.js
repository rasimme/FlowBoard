/**
 * Operator settings the native rail keeps in the browser (T-487-8).
 *
 * These are per-browser conveniences, never authority: which agent's project
 * binding the rail shows and writes, and whether the rail is collapsed. The
 * Gateway re-validates the agent id on every call and FlowBoard validates it
 * again (`dashboard/agent-identity.js`), so the guard here exists to keep
 * nonsense out of storage and out of the request, not to authorize anything.
 *
 * Keys are namespaced with the plugin id because the Control UI is one origin
 * shared by every installed plugin (T-487-4 measured un-namespaced FlowBoard
 * keys as a real collision risk there).
 */

export const AGENT_ID_KEY = 'flowboard.controlUi.agentId';
export const RAIL_COLLAPSED_KEY = 'flowboard.controlUi.railCollapsed';
export const DEFAULT_AGENT_ID = 'main';

/** Ids FlowBoard rejects as "not a stable identity" (agent-identity.js). */
const RESERVED_AGENT_IDS = new Set(['agent', 'default', 'none', 'null', 'unknown']);

/**
 * The shape rule FlowBoard enforces server-side: lowercase kebab-case, ≤ 64.
 * Returns the normalized id, or null when it could never be accepted.
 */
export function normalizeAgentId(value) {
  const id = String(value ?? '').trim().toLowerCase();
  if (!id || id.length > 64) return null;
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(id)) return null;
  if (RESERVED_AGENT_IDS.has(id)) return null;
  return id;
}

function readRaw(storage, key) {
  try {
    return storage?.getItem?.(key) ?? null;
  } catch {
    // Private windows and blocked site data throw on access, not on write.
    return null;
  }
}

function writeRaw(storage, key, value) {
  try {
    if (value === null) storage?.removeItem?.(key);
    else storage?.setItem?.(key, value);
    return true;
  } catch {
    return false;
  }
}

/** The agent whose binding the rail reflects; `main` until someone changes it. */
export function readAgentId(storage) {
  return normalizeAgentId(readRaw(storage, AGENT_ID_KEY)) || DEFAULT_AGENT_ID;
}

/**
 * Persist an agent id. An id the server would reject is never stored and never
 * returned, so a typo cannot silently detach the rail from every board.
 * Returns the id now in effect, or null when the input was rejected.
 */
export function writeAgentId(storage, value) {
  const id = normalizeAgentId(value);
  if (!id) return null;
  writeRaw(storage, AGENT_ID_KEY, id);
  return id;
}

export function readRailCollapsed(storage) {
  return readRaw(storage, RAIL_COLLAPSED_KEY) === '1';
}

export function writeRailCollapsed(storage, collapsed) {
  return writeRaw(storage, RAIL_COLLAPSED_KEY, collapsed ? '1' : '0');
}
