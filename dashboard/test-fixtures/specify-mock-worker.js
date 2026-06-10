'use strict';

/**
 * Scripted Specify worker for regression tests (T-262-13).
 * Injected into a spawned server via SPECIFY_WORKER_MOCK (NODE_ENV=test only).
 *
 * Behavior is keyed off the session's sourceDescription markers so one mock
 * serves every scenario:
 *   [SCENARIO:guard]     'next' → instant proposal; 'require-clarification' → question
 *   [SCENARIO:loop]      asks 2 MC questions, then proposal
 *   [SCENARIO:greedy]    always asks questions; obeys force-proposal/skip directives
 *   [SCENARIO:malformed] returns prose (no JSON contract object) once, then proposal
 */

const _state = new Map(); // sessionId → call count

function _proposal(summaryExtra = '') {
  return {
    action: 'proposal',
    ambiguityScan: { identifiedGaps: [], confidence: 0.9 },
    proposal: {
      summary: `Mock proposal${summaryExtra}`,
      taskStructure: 'Single task',
      specContent: '# Mock Spec\n\n## Goal\nMock goal\n\n## Requirements\n- **FR-001**: testable\n\n## Success Criteria\n- **SC-001**: measurable',
      taskBreakdown: [{ title: 'Mock task', description: 'Created by scripted worker', priority: 'medium' }],
      sourceCleanupPlan: [],
    },
  };
}

function _question(n) {
  return {
    action: 'question',
    ambiguityScan: { identifiedGaps: ['scope'], confidence: 0.5 },
    question: {
      text: `Mock question ${n}?`,
      options: [
        { key: 'A', label: `Option A for q${n}`, rationale: 'Safe default' },
        { key: 'B', label: `Option B for q${n}` },
      ],
      recommended: 'A',
      affectedFields: ['FR-001'],
    },
  };
}

module.exports = {
  kind: 'mock',

  async call(sessionId, workerRequest) {
    const desc = (workerRequest.input && workerRequest.input.sourceDescription) || '';
    const directive = workerRequest.directive;
    const answered = ((workerRequest.input && workerRequest.input.previousClarifications) || [])
      .filter(c => c.answer).length;
    const count = (_state.get(sessionId) || 0) + 1;
    _state.set(sessionId, count);

    if (desc.includes('[SCENARIO:guard]')) {
      if (directive === 'require-clarification') return _question(1);
      return _proposal(' (guard scenario)');
    }

    if (desc.includes('[SCENARIO:loop]')) {
      if (directive === 'skip-remaining' || directive === 'force-proposal') return _proposal(' (loop scenario)');
      if (answered < 2) return _question(answered + 1);
      return _proposal(' (loop scenario)');
    }

    if (desc.includes('[SCENARIO:greedy]')) {
      if (directive === 'skip-remaining' || directive === 'force-proposal') return _proposal(' (greedy scenario)');
      return _question(answered + 1);
    }

    if (desc.includes('[SCENARIO:malformed]')) {
      if (count === 1) return { totally: 'unexpected', shape: true };
      return _proposal(' (after retry)');
    }

    return _proposal();
  },
};
