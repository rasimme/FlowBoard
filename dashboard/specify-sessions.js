'use strict';

// In-memory session state for active Specify sessions.
// Schema: id, project, origin, transport, agentId, sourceNoteIds, sourceDescription,
//         status, clarifications, ambiguityScan, draftProposal, createdArtifacts,
//         failureState, createdAt, lastActivity

const _sessions = new Map(); // id → session object
let _sessionSeq = 0;

// Valid state transitions (directed graph)
const TRANSITIONS = {
  created: ['analyzing', 'error', 'aborted'],
  analyzing: ['clarifying', 'proposal-ready', 'error', 'aborted'],
  clarifying: ['proposal-ready', 'clarifying', 'error', 'aborted'],
  // proposal-ready → analyzing: user requested changes (revise loop)
  'proposal-ready': ['confirmed', 'analyzing', 'error', 'aborted'],
  confirmed: ['persisting', 'error', 'aborted'],
  persisting: ['done', 'error', 'aborted'],
  done: [],
  error: [],
  aborted: [],
};

/**
 * Create a new Specify session.
 * Throws if:
 *   - another active session has overlapping sourceNoteIds for same project
 *   - the agent already has an active session
 */
function createSession({ project, origin, sourceNoteIds = [], agentId, sourceDescription = '', transport = 'api' }) {
  if (!project) throw new Error('project is required');
  if (!agentId) throw new Error('agentId is required');

  // Check agent concurrency
  for (const s of _sessions.values()) {
    if (s.agentId === agentId && !isTerminal(s.status)) {
      throw new Error(`Agent "${agentId}" already has an active Specify session (${s.id})`);
    }
  }

  // Check duplicate sourceNoteIds per project
  if (sourceNoteIds.length > 0) {
    for (const s of _sessions.values()) {
      if (s.project === project && !isTerminal(s.status)) {
        const overlap = sourceNoteIds.filter(id => s.sourceNoteIds.includes(id));
        if (overlap.length > 0) {
          throw new Error(`Note(s) already in active Specify session ${s.id}: ${overlap.join(', ')}`);
        }
      }
    }
  }

  const now = Date.now();
  const session = {
    id: `specify-${now}-${++_sessionSeq}`,
    project,
    origin: origin || 'canvas',
    transport: transport || 'api',
    sourceNoteIds: [...sourceNoteIds],
    sourceDescription: sourceDescription || '',
    agentId,
    status: 'created',
    clarifications: [],
    ambiguityScan: null,
    revisionNotes: [],
    draftProposal: null,
    createdArtifacts: {
      specFiles: [],
      taskIds: [],
      cleanedNoteIds: [],
    },
    failureState: null,
    createdAt: now,
    lastActivity: now,
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
    if (s.agentId === agentId && !isTerminal(s.status)) {
      return { ...s };
    }
  }
  return null;
}

/**
 * Check if a state transition is valid.
 */
function canTransition(fromStatus, toStatus) {
  if (!TRANSITIONS[fromStatus]) return false;
  return TRANSITIONS[fromStatus].includes(toStatus);
}

/**
 * Check if a status is terminal (no further transitions).
 */
function isTerminal(status) {
  return status === 'done' || status === 'error' || status === 'aborted';
}

/**
 * Update session fields and bump lastActivity.
 * Validates state transition if status is being changed.
 * Returns updated session or null if not found.
 * Throws if transition is invalid.
 */
function updateSession(id, patch) {
  const s = _sessions.get(id);
  if (!s) return null;

  // If status is changing, validate transition
  if (patch.status && patch.status !== s.status) {
    if (!canTransition(s.status, patch.status)) {
      throw new Error(`Invalid state transition: ${s.status} → ${patch.status}`);
    }
  }

  Object.assign(s, patch, { lastActivity: Math.max(Date.now(), s.lastActivity + 1) });
  return { ...s };
}

/**
 * Transition to 'error' state with failure details.
 * Returns updated session or null if not found.
 */
function recordFailure(id, action, error) {
  return updateSession(id, {
    status: 'error',
    failureState: {
      action,
      error: error.message || String(error),
      timestamp: Date.now(),
    },
  });
}

/**
 * Abort a session (sets status to 'aborted').
 * Returns updated session or null if not found.
 */
function abortSession(id) {
  return updateSession(id, { status: 'aborted' });
}

/**
 * Recover a session from 'error' back to 'analyzing' so a retry can run.
 * 'error' is terminal in the transition graph, so this is the one sanctioned
 * bypass (T-262-11 retry semantics): only error → analyzing, nothing else.
 * Returns updated session, or null if not found / not in error state.
 */
function recoverFromError(id) {
  const s = _sessions.get(id);
  if (!s || s.status !== 'error') return null;
  s.status = 'analyzing';
  s.failureState = null;
  s.lastActivity = Math.max(Date.now(), s.lastActivity + 1);
  return { ...s };
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
    if (!isTerminal(s.status) && s.lastActivity < cutoff) {
      s.status = 'aborted';
      count++;
    }
  }
  return count;
}

/**
 * List sessions with optional filters.
 * opts: { project?, status?, agentId? }
 */
function listSessions({ project, status, agentId } = {}) {
  const results = [];
  for (const s of _sessions.values()) {
    if (project && s.project !== project) continue;
    if (status && s.status !== status) continue;
    if (agentId && s.agentId !== agentId) continue;
    results.push({ ...s });
  }
  return results;
}

module.exports = {
  createSession,
  getSession,
  getActiveSessionForAgent,
  updateSession,
  recordFailure,
  abortSession,
  recoverFromError,
  completeSession,
  cleanupExpired,
  listSessions,
  canTransition,
  isTerminal,
};
