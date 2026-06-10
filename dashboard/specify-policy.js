'use strict';

/**
 * Specify Clarify Policy — question discipline, worker response schema
 * validation, and clarification caps.
 *
 * Spec: T-262-9 (Specify Clarify Loop). The policy is transport-neutral:
 * the worker bridge enforces it for dashboard sessions, and the agent
 * prompt instructions mirror it for chat sessions.
 */

// Hard cap: a session asks at most this many clarification questions.
// A worker "question" beyond the cap is rejected and a proposal is forced.
const MAX_CLARIFICATIONS = 4;

// Multiple-choice questions carry 2-4 options. Zero options means
// free-text only (allowed, but discouraged by the worker prompt).
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;

const VALID_ACTIONS = ['question', 'proposal', 'done', 'error'];

// Directives sent to the worker with each request.
const DIRECTIVES = {
  NEXT: 'next',                                // normal step
  SKIP_REMAINING: 'skip-remaining',            // user skipped: produce proposal from recommendations/defaults
  FORCE_PROPOSAL: 'force-proposal',            // question cap reached: produce proposal now
  REQUIRE_CLARIFICATION: 'require-clarification', // single-note guard: ask at least one question first
};

function _isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function _validateAmbiguityScan(scan, errors) {
  if (scan === undefined || scan === null) return;
  if (typeof scan !== 'object' || Array.isArray(scan)) {
    errors.push('ambiguityScan must be an object');
    return;
  }
  if (scan.identifiedGaps !== undefined &&
      (!Array.isArray(scan.identifiedGaps) || scan.identifiedGaps.some(g => !_isNonEmptyString(g)))) {
    errors.push('ambiguityScan.identifiedGaps must be an array of non-empty strings');
  }
  if (scan.confidence !== undefined &&
      (typeof scan.confidence !== 'number' || scan.confidence < 0 || scan.confidence > 1)) {
    errors.push('ambiguityScan.confidence must be a number between 0 and 1');
  }
}

function _validateQuestion(question, errors) {
  if (!question || typeof question !== 'object') {
    errors.push('question payload is required for action "question"');
    return;
  }
  if (!_isNonEmptyString(question.text)) {
    errors.push('question.text must be a non-empty string');
  }
  if (!Array.isArray(question.affectedFields) || question.affectedFields.length === 0 ||
      question.affectedFields.some(f => !_isNonEmptyString(f))) {
    errors.push('question.affectedFields must be a non-empty array of strings (which FR/Story/SC the answer changes)');
  }
  const options = question.options;
  if (options !== undefined && options !== null) {
    if (!Array.isArray(options)) {
      errors.push('question.options must be an array');
    } else if (options.length > 0) {
      if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
        errors.push(`question.options must contain ${MIN_OPTIONS}-${MAX_OPTIONS} entries (or be empty for free-text)`);
      }
      const keys = new Set();
      for (const opt of options) {
        if (!opt || !_isNonEmptyString(opt.key) || !_isNonEmptyString(opt.label)) {
          errors.push('each option needs a non-empty key and label');
          break;
        }
        if (keys.has(opt.key)) {
          errors.push(`duplicate option key: ${opt.key}`);
          break;
        }
        keys.add(opt.key);
      }
      if (question.recommended !== undefined && question.recommended !== null &&
          !keys.has(question.recommended)) {
        errors.push('question.recommended must match one of the option keys');
      }
    }
  }
}

function _validateProposal(proposal, errors) {
  if (!proposal || typeof proposal !== 'object') {
    errors.push('proposal payload is required for action "proposal"');
    return;
  }
  if (!_isNonEmptyString(proposal.summary)) {
    errors.push('proposal.summary must be a non-empty string');
  }
  if (!_isNonEmptyString(proposal.specContent)) {
    errors.push('proposal.specContent must be a non-empty string');
  }
  if (!Array.isArray(proposal.taskBreakdown) || proposal.taskBreakdown.length === 0) {
    errors.push('proposal.taskBreakdown must be a non-empty array');
  } else {
    for (const item of proposal.taskBreakdown) {
      const title = typeof item === 'string' ? item : item && item.title;
      if (!_isNonEmptyString(title)) {
        errors.push('each taskBreakdown entry needs a title');
        break;
      }
    }
  }
}

/**
 * Validate a worker response against the Specify contract.
 * Returns { ok: boolean, errors: string[] }.
 */
function validateWorkerResponse(response) {
  const errors = [];
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    return { ok: false, errors: ['worker response must be a JSON object'] };
  }
  if (!VALID_ACTIONS.includes(response.action)) {
    return { ok: false, errors: [`invalid worker response action: ${response.action}`] };
  }
  _validateAmbiguityScan(response.ambiguityScan, errors);
  if (response.action === 'question') _validateQuestion(response.question, errors);
  if (response.action === 'proposal') _validateProposal(response.proposal, errors);
  if (response.action === 'error' && !_isNonEmptyString(response.message)) {
    errors.push('error responses must include a message');
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Question cap: may this session accept another clarification question?
 */
function canAskQuestion(session) {
  return (session.clarifications || []).length < MAX_CLARIFICATIONS;
}

/**
 * Single-note guard (T-262-13): a single canvas note is underspecified by
 * definition. If the worker proposes immediately — zero clarifications —
 * the bridge re-requests once with DIRECTIVES.REQUIRE_CLARIFICATION.
 * Only the first attempt is guarded; if the worker insists, the proposal
 * is accepted (no retry loop).
 */
function needsSingleNoteGuard(session, responseAction, attempt = 0) {
  return responseAction === 'proposal' &&
    attempt === 0 &&
    session.origin === 'canvas' &&
    (session.sourceNoteIds || []).length === 1 &&
    (session.clarifications || []).length === 0;
}

module.exports = {
  MAX_CLARIFICATIONS,
  MIN_OPTIONS,
  MAX_OPTIONS,
  VALID_ACTIONS,
  DIRECTIVES,
  validateWorkerResponse,
  canAskQuestion,
  needsSingleNoteGuard,
};
