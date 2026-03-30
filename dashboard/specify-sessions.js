'use strict';

// In-memory session state for active Specify sessions.
// No database, no file I/O — pure RAM state, lost on server restart.

const _sessions = new Map(); // id → session object

/**
 * Create a new Specify session.
 * Throws if:
 *   - another active session has overlapping sourceNoteIds for same project
 *   - the agent already has an active session
 */
function createSession({ project, origin, sourceNoteIds = [], agentId }) {
  if (!project) throw new Error('project is required');
  if (!agentId) throw new Error('agentId is required');

  // Check agent concurrency
  for (const s of _sessions.values()) {
    if (s.agentId === agentId && !_isTerminal(s.status)) {
      throw new Error(`Agent "${agentId}" already has an active Specify session (${s.id})`);
    }
  }

  // Check duplicate sourceNoteIds per project
  if (sourceNoteIds.length > 0) {
    for (const s of _sessions.values()) {
      if (s.project === project && !_isTerminal(s.status)) {
        const overlap = sourceNoteIds.filter(id => s.sourceNoteIds.includes(id));
        if (overlap.length > 0) {
          throw new Error(`Note(s) already in active Specify session ${s.id}: ${overlap.join(', ')}`);
        }
      }
    }
  }

  const session = {
    id: `specify-${Date.now()}`,
    project,
    origin: origin || 'canvas',
    sourceNoteIds: [...sourceNoteIds],
    agentId,
    status: 'active',
    createdAt: Date.now(),
    lastActivity: Date.now(),
  };

  _sessions.set(session.id, session);
  return { ...session };
}

/**
 * Get session by ID.
 * Returns null if not found.
 */
function getSession(id) {
  const s = _sessions.get(id);
  return s ? { ...s } : null;
}

/**
 * Get the active (non-terminal) session for an agent.
 * Returns null if the agent has no active session.
 */
function getActiveSessionForAgent(agentId) {
  for (const s of _sessions.values()) {
    if (s.agentId === agentId && !_isTerminal(s.status)) {
      return { ...s };
    }
  }
  return null;
}

/**
 * Update session fields. Always bumps lastActivity.
 * Returns updated session or null if not found.
 */
function updateSession(id, patch) {
  const s = _sessions.get(id);
  if (!s) return null;
  Object.assign(s, patch, { lastActivity: Date.now() });
  return { ...s };
}

/**
 * Abort a session (sets status to 'aborted').
 * Returns updated session or null if not found.
 */
function abortSession(id) {
  return updateSession(id, { status: 'aborted' });
}

/**
 * Mark session as done (sets status to 'done').
 * Returns updated session or null if not found.
 */
function completeSession(id) {
  return updateSession(id, { status: 'done' });
}

/**
 * Abort all sessions older than maxAgeMs (default 2h).
 * Returns count of sessions that were aborted.
 */
function cleanupExpired(maxAgeMs = 2 * 60 * 60 * 1000) {
  const cutoff = Date.now() - maxAgeMs;
  let count = 0;
  for (const s of _sessions.values()) {
    if (!_isTerminal(s.status) && s.lastActivity < cutoff) {
      s.status = 'aborted';
      count++;
    }
  }
  return count;
}

/**
 * List sessions with optional filters.
 * opts: { project?, status? }
 */
function listSessions({ project, status } = {}) {
  const results = [];
  for (const s of _sessions.values()) {
    if (project && s.project !== project) continue;
    if (status && s.status !== status) continue;
    results.push({ ...s });
  }
  return results;
}

// --- Helpers ---

function _isTerminal(status) {
  return status === 'done' || status === 'aborted';
}

module.exports = {
  createSession,
  getSession,
  getActiveSessionForAgent,
  updateSession,
  abortSession,
  completeSession,
  cleanupExpired,
  listSessions,
};
