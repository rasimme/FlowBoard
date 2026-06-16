'use strict';

const specifySession = require('./specify-sessions');
const bridge = require('./specify-worker-bridge');

let pass = 0, fail = 0;

function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✅ ${msg}`); }
  else { fail++; console.log(`  ❌ ${msg}`); }
}

function section(title) { console.log(`\n## ${title}\n`); }

// Setup fake worker for tests
section('Setup');

const fakeWorker = bridge.createFakeWorkerAdapter();
bridge.setWorkerAdapter(fakeWorker);

console.log('✓ Fake worker adapter configured');

// Test 1: Request next when session in created state
section('Request Next');

const session1 = specifySession.createSession({
  project: 'test',
  origin: 'canvas',
  agentId: 'agent-1',
});

fakeWorker.setResponses(session1.id, [
  {
    action: 'question',
    workerRequest: {
      question: 'What is the scope?',
      recommended: 'API endpoints',
      affectedFields: ['specContent'],
    },
  },
]);

(async () => {
  try {
    const result = await bridge.requestNext(session1.id);
    ok(result.action === 'question', 'Returned question action');
    ok(result.workerRequest.question, 'Question present in response');
    console.log('✓ requestNext works');
  } catch (err) {
    fail++;
    console.log(`  ❌ requestNext failed: ${err.message}`);
  }

  // Test 2: Request next returns proposal
  section('Request Proposal');

  const session2 = specifySession.createSession({
    project: 'test',
    origin: 'canvas',
    agentId: 'agent-2',
  });

  fakeWorker.setResponses(session2.id, [
    {
      action: 'proposal',
      workerRequest: {
        specContent: '# API Spec\n\nEndpoints: GET, POST, PUT, DELETE',
        taskBreakdown: [
          { id: 't-1', title: 'Task 1', effort: 3 },
          { id: 't-2', title: 'Task 2', effort: 5 },
        ],
        quality: 'high',
        sourceCleanupPlan: [],
      },
    },
  ]);

  try {
    const result = await bridge.requestNext(session2.id);
    ok(result.action === 'proposal', 'Returned proposal action');
    ok(result.workerRequest.specContent, 'Spec content present');
    ok(result.workerRequest.taskBreakdown.length === 2, 'Task breakdown has 2 items');
    console.log('✓ Proposal response validated');
  } catch (err) {
    fail++;
    console.log(`  ❌ Proposal test failed: ${err.message}`);
  }

  // Test 3: Record answer to clarification
  section('Record Answer');

  const session3 = specifySession.createSession({
    project: 'test',
    origin: 'canvas',
    agentId: 'agent-3',
  });

  // Add a clarification to the session (transition: created → analyzing → clarifying)
  specifySession.updateSession(session3.id, {
    status: 'analyzing',
  });
  specifySession.updateSession(session3.id, {
    status: 'clarifying',
    clarifications: [
      {
        id: 'q-1',
        question: 'What framework?',
        recommended: 'FastAPI',
        answer: null,
        affectedFields: ['tech-stack'],
      },
    ],
  });

  fakeWorker.setResponses(session3.id, [
    {
      action: 'proposal',
      workerRequest: {
        specContent: '# API Spec\n\nUsing FastAPI',
        taskBreakdown: [{ id: 't-1', title: 'Setup FastAPI', effort: 2 }],
        quality: 'high',
        sourceCleanupPlan: [],
      },
    },
  ]);

  try {
    const result = await bridge.recordAnswer(session3.id, 'q-1', 'FastAPI with Pydantic');
    ok(result.action === 'proposal', 'Answer triggered proposal');

    const updated = specifySession.getSession(session3.id);
    ok(updated.clarifications[0].answer === 'FastAPI with Pydantic', 'Answer recorded in session');
    console.log('✓ recordAnswer works');
  } catch (err) {
    fail++;
    console.log(`  ❌ recordAnswer failed: ${err.message}`);
  }

  // Test 4: Confirm proposal
  section('Confirm Proposal');

  const session4 = specifySession.createSession({
    project: 'test',
    origin: 'canvas',
    agentId: 'agent-4',
  });

  specifySession.updateSession(session4.id, { status: 'analyzing' });
  specifySession.updateSession(session4.id, { status: 'proposal-ready' });
  specifySession.updateSession(session4.id, {
    draftProposal: {
      specContent: '# Final Spec',
      taskBreakdown: [{ id: 't-1', title: 'Task', effort: 3 }],
      quality: 'high',
      sourceCleanupPlan: [],
    },
  });

  try {
    const result = await bridge.confirmProposal(session4.id, true);
    ok(result.specPath === null, 'specPath pending persistence');
    ok(Array.isArray(result.createdTasks), 'createdTasks array present');

    const sess = specifySession.getSession(session4.id);
    ok(sess.status === 'persisting', 'Session moved to persisting state');
    console.log('✓ confirmProposal works');
  } catch (err) {
    fail++;
    console.log(`  ❌ confirmProposal failed: ${err.message}`);
  }

  // Test 5: Fallback handling — no adapter configured
  section('Fallback Handling');

  const session5 = specifySession.createSession({
    project: 'test',
    origin: 'canvas',
    agentId: 'agent-5',
  });

  bridge.setWorkerAdapter(null);

  // Without the opt-in flag, a missing adapter is a recoverable error (T-262-11):
  // the static fallback proposal must never silently replace the real worker.
  const prevFallback = process.env.SPECIFY_ALLOW_FALLBACK;
  const prevNodeEnv = process.env.NODE_ENV;
  delete process.env.SPECIFY_ALLOW_FALLBACK;
  delete process.env.NODE_ENV;

  try {
    const result = await bridge.requestNext(session5.id);
    ok(result.action === 'error', 'Missing adapter without opt-in returns error action');
    ok(/not configured/i.test(result.message || ''), 'Error message says worker is not configured');
  } catch (err) {
    fail++;
    console.log(`  ❌ Ungated fallback test failed: ${err.message}`);
  }

  process.env.SPECIFY_ALLOW_FALLBACK = 'true';

  try {
    const result = await bridge.requestNext(session5.id);
    ok(result.action === 'proposal', 'Missing adapter with SPECIFY_ALLOW_FALLBACK returns fallback proposal');
    ok(result.workerRequest.specContent, 'Fallback proposal includes spec content');
  } catch (err) {
    fail++;
    console.log(`  ❌ Fallback proposal failed: ${err.message}`);
  }

  if (prevFallback === undefined) delete process.env.SPECIFY_ALLOW_FALLBACK;
  else process.env.SPECIFY_ALLOW_FALLBACK = prevFallback;
  if (prevNodeEnv !== undefined) process.env.NODE_ENV = prevNodeEnv;

  // Restore adapter
  bridge.setWorkerAdapter(fakeWorker);

  // Test 6: Invalid response action
  section('Invalid Response');

  const session6 = specifySession.createSession({
    project: 'test',
    origin: 'canvas',
    agentId: 'agent-6',
  });

  fakeWorker.setResponses(session6.id, [
    {
      action: 'invalid-action',
      workerRequest: null,
    },
  ]);

  try {
    await bridge.requestNext(session6.id);
    fail++;
    console.log('  ❌ Should have rejected invalid action');
  } catch (err) {
    ok(err.message.includes('Invalid worker response action'), 'Rejected invalid action');
  }

  // Final summary
  section('Summary');
  if (fail === 0) {
    console.log(`✅ All ${pass} tests passed`);
    process.exit(0);
  } else {
    console.log(`❌ ${fail} failed, ${pass} passed`);
    process.exit(1);
  }
})();
