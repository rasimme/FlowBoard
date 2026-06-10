'use strict';

const policy = require('./specify-policy');
const specifySession = require('./specify-sessions');

let pass = 0, fail = 0, failures = [];

function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✅ ${msg}`); }
  else { fail++; failures.push(msg); console.log(`  ❌ ${msg}`); }
}

function section(title) { console.log(`\n## ${title}\n`); }

// ---------------------------------------------------------------------------
section('Worker Response Schema — question');

const validQuestion = {
  action: 'question',
  ambiguityScan: { identifiedGaps: ['scope', 'data'], confidence: 0.6 },
  question: {
    text: 'Should completed items be archived or deleted?',
    options: [
      { key: 'A', label: 'Archive', rationale: 'History stays available' },
      { key: 'B', label: 'Delete permanently' },
    ],
    recommended: 'A',
    affectedFields: ['FR-001', 'SC-001'],
  },
};

ok(policy.validateWorkerResponse(validQuestion).ok, 'valid multiple-choice question passes');

const freeTextQuestion = {
  action: 'question',
  question: { text: 'What is the target platform?', options: [], affectedFields: ['constraints'] },
};
ok(policy.validateWorkerResponse(freeTextQuestion).ok, 'free-text question (no options) passes');

ok(!policy.validateWorkerResponse({ action: 'question', question: { text: '', affectedFields: ['FR'] } }).ok,
  'empty question text rejected');
ok(!policy.validateWorkerResponse({ action: 'question', question: { text: 'x?', affectedFields: [] } }).ok,
  'missing affectedFields rejected');
ok(!policy.validateWorkerResponse({
  action: 'question',
  question: { text: 'x?', affectedFields: ['FR'], options: [{ key: 'A', label: 'one' }] },
}).ok, 'single option rejected (need 2-4 or none)');
ok(!policy.validateWorkerResponse({
  action: 'question',
  question: {
    text: 'x?', affectedFields: ['FR'],
    options: [{ key: 'A', label: 'a' }, { key: 'A', label: 'dup' }],
  },
}).ok, 'duplicate option keys rejected');
ok(!policy.validateWorkerResponse({
  action: 'question',
  question: {
    text: 'x?', affectedFields: ['FR'],
    options: [{ key: 'A', label: 'a' }, { key: 'B', label: 'b' }],
    recommended: 'C',
  },
}).ok, 'recommended must match an option key');

// ---------------------------------------------------------------------------
section('Worker Response Schema — proposal');

const validProposal = {
  action: 'proposal',
  proposal: {
    summary: 'Build the archive flow',
    taskStructure: 'Parent + 2 subtasks',
    specContent: '# Spec\n\n## Goal\n...',
    taskBreakdown: [{ title: 'Parent task' }, { title: 'Subtask 1' }],
  },
};
ok(policy.validateWorkerResponse(validProposal).ok, 'valid proposal passes');
ok(!policy.validateWorkerResponse({ action: 'proposal', proposal: { summary: 's', specContent: '', taskBreakdown: [{ title: 't' }] } }).ok,
  'proposal without specContent rejected');
ok(!policy.validateWorkerResponse({ action: 'proposal', proposal: { summary: 's', specContent: 'x', taskBreakdown: [] } }).ok,
  'proposal with empty taskBreakdown rejected');
ok(!policy.validateWorkerResponse({ action: 'proposal', proposal: { summary: 's', specContent: 'x', taskBreakdown: [{ notitle: 1 }] } }).ok,
  'taskBreakdown entries need titles');

const multiParentProposal = {
  action: 'proposal',
  proposal: {
    summary: 'Two features',
    taskStructure: 'Multiple parents',
    specContent: '# Umbrella',
    taskBreakdown: [
      { title: 'Feature A', role: 'parent' },
      { title: 'A slice', role: 'subtask' },
      { title: 'Feature B', role: 'parent', specContent: '# B Spec' },
      { title: 'B slice', role: 'subtask', specContent: '# B slice spec' },
    ],
  },
};
ok(policy.validateWorkerResponse(multiParentProposal).ok, 'multi-parent role breakdown passes');
ok(!policy.validateWorkerResponse({
  action: 'proposal',
  proposal: { summary: 's', specContent: 'x', taskBreakdown: [{ title: 'orphan', role: 'subtask' }] },
}).ok, 'subtask before any parent rejected');
ok(!policy.validateWorkerResponse({
  action: 'proposal',
  proposal: { summary: 's', specContent: 'x', taskBreakdown: [{ title: 'x', role: 'epic' }] },
}).ok, 'unknown role rejected');

// ---------------------------------------------------------------------------
section('Worker Response Schema — general');

ok(!policy.validateWorkerResponse(null).ok, 'null response rejected');
ok(!policy.validateWorkerResponse('{}').ok, 'string response rejected');
ok(!policy.validateWorkerResponse({ action: 'persist' }).ok, 'unknown action rejected');
ok(!policy.validateWorkerResponse({ action: 'error' }).ok, 'error without message rejected');
ok(policy.validateWorkerResponse({ action: 'error', message: 'worker failed' }).ok, 'error with message passes');
ok(policy.validateWorkerResponse({ action: 'done' }).ok, 'done passes');
ok(!policy.validateWorkerResponse({ action: 'done', ambiguityScan: { confidence: 2 } }).ok,
  'ambiguityScan confidence out of range rejected');

// ---------------------------------------------------------------------------
section('Question Cap (max 4)');

ok(policy.MAX_CLARIFICATIONS === 4, 'cap is 4');
ok(policy.canAskQuestion({ clarifications: [] }), '0 answered → may ask');
ok(policy.canAskQuestion({ clarifications: [1, 2, 3] }), '3 answered → may ask');
ok(!policy.canAskQuestion({ clarifications: [1, 2, 3, 4] }), '4 answered → cap reached');

// ---------------------------------------------------------------------------
section('Single-Note Guard');

const singleNoteSession = { origin: 'canvas', sourceNoteIds: ['n1'], clarifications: [] };
ok(policy.needsSingleNoteGuard(singleNoteSession, 'proposal', 0), 'single note + instant proposal → guard');
ok(!policy.needsSingleNoteGuard(singleNoteSession, 'proposal', 1), 'second attempt → no guard (no loop)');
ok(!policy.needsSingleNoteGuard(singleNoteSession, 'question', 0), 'question action → no guard');
ok(!policy.needsSingleNoteGuard({ origin: 'canvas', sourceNoteIds: ['n1', 'n2'], clarifications: [] }, 'proposal', 0),
  'multi-note session → no guard');
ok(!policy.needsSingleNoteGuard({ origin: 'canvas', sourceNoteIds: ['n1'], clarifications: [{ q: 'x' }] }, 'proposal', 0),
  'already clarified → no guard');
ok(!policy.needsSingleNoteGuard({ origin: 'chat', sourceNoteIds: [], clarifications: [] }, 'proposal', 0),
  'chat origin without notes → no guard');
ok(!policy.needsSingleNoteGuard({ origin: 'canvas', sourceNoteIds: [], clarifications: [] }, 'proposal', 0),
  'canvas session without notes → no guard (guard targets exactly one note)');

// ---------------------------------------------------------------------------
section('Session ambiguityScan storage');

const sess = specifySession.createSession({ project: 'test-policy', agentId: 'test-policy-agent' });
ok(sess.ambiguityScan === null, 'new session has ambiguityScan: null');
const updated = specifySession.updateSession(sess.id, {
  ambiguityScan: { identifiedGaps: ['scope'], confidence: 0.4 },
});
ok(updated.ambiguityScan && updated.ambiguityScan.identifiedGaps[0] === 'scope', 'ambiguityScan persisted on session');

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log('Failures:', failures);
  process.exit(1);
}
