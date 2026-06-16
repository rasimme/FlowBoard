'use strict';

/**
 * Specify Worker Bridge — adapts between Dashboard API and Specify worker.
 * Supports the OpenClaw CLI worker (production), a fake adapter
 * (deterministic tests), and a gated static fallback (dev/test only).
 *
 * Policy enforcement (question cap, single-note guard, response validation)
 * happens here so every transport gets the same behavior. Spec: T-262-9.
 */

const specifySession = require('./specify-sessions');
const policy = require('./specify-policy');

// Worker adapter interface — implementations must provide .call(sessionId, request)
let _workerAdapter = null;

function _fallbackAllowed() {
  return process.env.SPECIFY_ALLOW_FALLBACK === 'true' || process.env.NODE_ENV === 'test';
}

function _buildFallbackProposal(session) {
  const title = session.sourceDescription
    ? session.sourceDescription.split('\n').find(line => line.trim())?.replace(/^[-\s]+/, '').slice(0, 80)
    : 'Specify request';
  const summary = title || 'Specify request';
  return {
    summary,
    taskStructure: 'Single task',
    specContent: [
      `# ${summary}`,
      '',
      '## Goal',
      summary,
      '',
      '## User Stories',
      '### Story 1 - Implement requested workflow (Priority: P1)',
      'As a user, I can turn the specified input into a concrete FlowBoard task.',
      '',
      '## Requirements',
      '- **FR-001**: System MUST preserve the user-provided Specify input in the generated task context.',
      '',
      '## Success Criteria',
      '- **SC-001**: A linked FlowBoard task is created after explicit confirmation.',
    ].join('\n'),
    taskBreakdown: [
      {
        title: summary,
        description: session.sourceDescription || summary,
        priority: 'medium',
      },
    ],
    quality: 'fallback',
    sourceCleanupPlan: session.sourceNoteIds || [],
  };
}

/**
 * Set the worker adapter (real or fake).
 */
function setWorkerAdapter(adapter) {
  _workerAdapter = adapter;
}

/**
 * Get current worker adapter.
 */
function getWorkerAdapter() {
  return _workerAdapter;
}

/**
 * Build the structured request sent to the worker for one step.
 * Carries the full session context — the worker is stateless.
 */
function _buildWorkerRequest(session, directive) {
  return {
    sessionId: session.id,
    project: session.project,
    origin: session.origin,
    directive,
    input: {
      sourceNoteIds: session.sourceNoteIds,
      sourceDescription: session.sourceDescription || '',
      previousClarifications: session.clarifications,
      revisionNotes: session.revisionNotes || [],
      proposalDraft: session.draftProposal,
    },
  };
}

/**
 * Normalize an adapter response to the bridge result shape:
 *   { action, workerRequest, message, ambiguityScan }
 *
 * Accepts the structured worker contract ({ action, question | proposal })
 * and — for test adapters only — the legacy fake-adapter shape
 * ({ action, workerRequest }). The legacy path bypasses policy validation,
 * so model-produced output (openclaw-cli adapter) must never reach it:
 * a prompt-injected worker could otherwise smuggle arbitrary proposals
 * past the schema (review finding).
 * Malformed structured responses become recoverable 'error' results.
 * Legacy responses with unknown actions throw (historical contract).
 */
function _normalizeResponse(response, allowLegacy) {
  if (allowLegacy && response && typeof response === 'object' && 'workerRequest' in response) {
    // Legacy shape — validate action only.
    if (!response.action || !['question', 'proposal', 'done', 'error'].includes(response.action)) {
      throw new Error(`Invalid worker response action: ${response && response.action}`);
    }
    return {
      action: response.action,
      workerRequest: response.workerRequest || null,
      message: response.message || null,
      ambiguityScan: response.ambiguityScan || null,
    };
  }

  const check = policy.validateWorkerResponse(response);
  if (!check.ok) {
    return {
      action: 'error',
      workerRequest: null,
      message: `Malformed worker response: ${check.errors.join('; ')}`,
      ambiguityScan: null,
    };
  }

  if (response.action === 'question') {
    const q = response.question;
    return {
      action: 'question',
      workerRequest: {
        question: q.text,
        options: Array.isArray(q.options) ? q.options : [],
        recommended: q.recommended ?? null,
        affectedFields: q.affectedFields,
      },
      message: response.message || null,
      ambiguityScan: response.ambiguityScan || null,
    };
  }

  if (response.action === 'proposal') {
    const p = response.proposal;
    return {
      action: 'proposal',
      workerRequest: {
        summary: p.summary,
        taskStructure: p.taskStructure || 'Single task',
        specContent: p.specContent,
        taskBreakdown: p.taskBreakdown,
        quality: p.quality || 'worker',
        // Note: persistence deletes session.sourceNoteIds only — worker
        // output never controls cleanup (prompt-injection boundary).
      },
      message: response.message || null,
      ambiguityScan: response.ambiguityScan || null,
    };
  }

  return {
    action: response.action,
    workerRequest: null,
    message: response.message || null,
    ambiguityScan: response.ambiguityScan || null,
  };
}

/**
 * One worker step with policy enforcement.
 *  - question cap: a question beyond MAX_CLARIFICATIONS triggers one
 *    force-proposal re-request; a question after that becomes an error.
 *  - single-note guard: an instant proposal for a single-note session
 *    triggers one require-clarification re-request (first attempt only).
 *  - skip/force directives: a question in response to them becomes an error.
 */
async function _step(sessionId, directive, attempt = 0) {
  const session = specifySession.getSession(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  if (!_workerAdapter) {
    if (_fallbackAllowed()) {
      return {
        action: 'proposal',
        workerRequest: _buildFallbackProposal(session),
        message: 'Fallback proposal generated without external worker adapter',
        ambiguityScan: null,
      };
    }
    return {
      action: 'error',
      workerRequest: null,
      message: 'Specify worker is not configured. Retry after the worker is available.',
      ambiguityScan: null,
    };
  }

  let raw;
  try {
    raw = await _workerAdapter.call(sessionId, _buildWorkerRequest(session, directive));
  } catch (err) {
    return {
      action: 'error',
      workerRequest: null,
      message: `Specify worker call failed: ${err.message || err}`,
      ambiguityScan: null,
    };
  }

  const result = _normalizeResponse(raw, _workerAdapter.kind !== 'openclaw-cli');

  if (result.action === 'question') {
    const proposalDirective = directive === policy.DIRECTIVES.SKIP_REMAINING ||
      directive === policy.DIRECTIVES.FORCE_PROPOSAL ||
      directive === policy.DIRECTIVES.REVISE;
    if (proposalDirective) {
      return {
        action: 'error',
        workerRequest: null,
        message: 'Specify worker asked a question although a proposal was required',
        ambiguityScan: result.ambiguityScan,
      };
    }
    if (!policy.canAskQuestion(session)) {
      // Question budget exhausted — demand the proposal once.
      return _step(sessionId, policy.DIRECTIVES.FORCE_PROPOSAL, attempt + 1);
    }
  }

  if (result.action === 'proposal' &&
      directive === policy.DIRECTIVES.NEXT &&
      policy.needsSingleNoteGuard(session, 'proposal', attempt)) {
    // Single underspecified note — ask for at least one clarification once.
    return _step(sessionId, policy.DIRECTIVES.REQUIRE_CLARIFICATION, attempt + 1);
  }

  if (result.ambiguityScan) {
    specifySession.updateSession(sessionId, { ambiguityScan: result.ambiguityScan });
  }

  return result;
}

/**
 * Request next action from worker: question, proposal, done, or error.
 * Returns { action, workerRequest, message, ambiguityScan }.
 * Throws if session not found.
 */
async function requestNext(sessionId) {
  return _step(sessionId, policy.DIRECTIVES.NEXT);
}

/**
 * Record user answer to a clarification question and request the next step.
 * Returns next worker action (same shape as requestNext).
 */
async function recordAnswer(sessionId, clarificationId, answer) {
  const session = specifySession.getSession(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  // Find and update clarification
  const clarIdx = session.clarifications.findIndex(c => c.id === clarificationId);
  if (clarIdx === -1) {
    throw new Error(`Clarification not found: ${clarificationId}`);
  }

  const updated = session.clarifications.map((c, i) =>
    i === clarIdx ? { ...c, answer } : c
  );

  // Update session with answered clarification
  specifySession.updateSession(sessionId, {
    clarifications: updated,
  });

  return _step(sessionId, policy.DIRECTIVES.NEXT);
}

/**
 * User skipped the remaining questions — direct the worker to produce the
 * proposal from recommended options and defaults.
 */
async function skipRemaining(sessionId) {
  return _step(sessionId, policy.DIRECTIVES.SKIP_REMAINING);
}

/**
 * User rejected the draft proposal with feedback — direct the worker to
 * produce an improved proposal. The feedback must already be recorded on
 * session.revisionNotes by the caller.
 */
async function reviseProposal(sessionId) {
  return _step(sessionId, policy.DIRECTIVES.REVISE);
}

/**
 * Record user confirmation of proposal.
 * Transitions: proposal-ready → confirmed → persisting.
 * Returns confirmation details (spec path, task IDs, cleaned notes).
 */
async function confirmProposal(sessionId, userApproval, customizations = {}) {
  const session = specifySession.getSession(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  if (!session.draftProposal) {
    throw new Error('No draft proposal to confirm');
  }

  if (!userApproval) {
    specifySession.updateSession(sessionId, { status: 'aborted' });
    throw new Error('User rejected proposal');
  }

  // Transition: proposal-ready → confirmed → persisting
  specifySession.updateSession(sessionId, { status: 'confirmed' });
  specifySession.updateSession(sessionId, { status: 'persisting' });

  // Return confirmation result (artifact details will be filled in by persistence layer)
  return {
    specPath: null,
    createdTasks: [],
    cleanedNotes: [],
    session: specifySession.getSession(sessionId),
  };
}

/**
 * Fake worker adapter for testing — returns deterministic responses.
 */
function createFakeWorkerAdapter() {
  const responses = new Map(); // sessionId → queue of responses
  const requests = new Map();  // sessionId → list of received worker requests

  return {
    setResponses(sessionId, responseQueue) {
      responses.set(sessionId, [...responseQueue]);
    },

    getRequests(sessionId) {
      return requests.get(sessionId) || [];
    },

    async call(sessionId, workerRequest) {
      if (!requests.has(sessionId)) requests.set(sessionId, []);
      requests.get(sessionId).push(workerRequest);
      const queue = responses.get(sessionId);
      if (!queue || queue.length === 0) {
        return {
          action: 'error',
          message: 'No more responses queued for fake worker',
        };
      }
      const response = queue.shift();
      return response;
    },
  };
}

module.exports = {
  setWorkerAdapter,
  getWorkerAdapter,
  requestNext,
  recordAnswer,
  skipRemaining,
  reviseProposal,
  confirmProposal,
  createFakeWorkerAdapter,
};
