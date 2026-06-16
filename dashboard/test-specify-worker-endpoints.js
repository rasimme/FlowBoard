'use strict';

/**
 * Integration tests for Specify worker API endpoints.
 * Tests: POST /api/specify/sessions/:id/next
 *        POST /api/specify/sessions/:id/answer
 *        POST /api/specify/sessions/:id/confirm
 */

const express = require('express');
const http = require('http');
const specifySession = require('./specify-sessions');
const specifyWorkerBridge = require('./specify-worker-bridge');

let pass = 0, fail = 0;

function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✅ ${msg}`); }
  else { fail++; console.log(`  ❌ ${msg}`); }
}

function section(title) { console.log(`\n## ${title}\n`); }

// Setup test server with worker endpoints
const app = express();
app.use(express.json());

// POST /api/specify/sessions/:id/next
app.post('/api/specify/sessions/:id/next', async (req, res) => {
  try {
    const session = specifySession.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    // Transition created → analyzing on first call
    if (session.status === 'created') {
      specifySession.updateSession(req.params.id, { status: 'analyzing' });
    }

    const result = await specifyWorkerBridge.requestNext(req.params.id);

    if (result.action === 'question') {
      const qId = `q-${session.clarifications.length + 1}`;
      const updated = session.clarifications.concat([{
        id: qId,
        question: result.workerRequest.question,
        recommended: result.workerRequest.recommended,
        answer: null,
        affectedFields: result.workerRequest.affectedFields || [],
      }]);
      specifySession.updateSession(req.params.id, {
        status: 'clarifying',
        clarifications: updated,
      });
    } else if (result.action === 'proposal') {
      specifySession.updateSession(req.params.id, {
        status: 'proposal-ready',
        draftProposal: result.workerRequest,
      });
    }

    res.json({
      action: result.action,
      session: specifySession.getSession(req.params.id),
      workerRequest: result.workerRequest,
    });
  } catch (err) {
    console.error('[api]', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/specify/sessions/:id/answer
app.post('/api/specify/sessions/:id/answer', async (req, res) => {
  try {
    const { clarificationId, answer } = req.body;
    if (!clarificationId || !answer) {
      return res.status(400).json({ error: 'clarificationId and answer required' });
    }

    const result = await specifyWorkerBridge.recordAnswer(req.params.id, clarificationId, answer);

    const session = specifySession.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    if (result.action === 'proposal') {
      specifySession.updateSession(req.params.id, {
        status: 'proposal-ready',
        draftProposal: result.workerRequest,
      });
    }

    res.json({
      action: result.action,
      session: specifySession.getSession(req.params.id),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/specify/sessions/:id/confirm
app.post('/api/specify/sessions/:id/confirm', async (req, res) => {
  try {
    const { userApproval } = req.body;
    if (userApproval === undefined) {
      return res.status(400).json({ error: 'userApproval required' });
    }

    const result = await specifyWorkerBridge.confirmProposal(req.params.id, userApproval);
    res.json({ session: result.session });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

const server = http.createServer(app);
const PORT = 18888;

section('Setup');
console.log(`✓ Test server configured on port ${PORT}`);

// Helper to make HTTP requests
function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: PORT,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({
            status: res.statusCode,
            body: JSON.parse(data),
          });
        } catch (e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// Start server and run tests
server.listen(PORT, async () => {
  console.log(`✓ Test server listening on ${PORT}`);

  try {
    // Test 1: POST /next endpoint
    section('POST /next Endpoint');

    const sess1 = specifySession.createSession({
      project: 'test',
      origin: 'canvas',
      agentId: 'test-agent-1',
    });

    const fakeWorker = specifyWorkerBridge.createFakeWorkerAdapter();
    fakeWorker.setResponses(sess1.id, [
      {
        action: 'question',
        workerRequest: {
          question: 'What is the scope?',
          recommended: 'API design',
          affectedFields: ['scope'],
        },
      },
    ]);
    specifyWorkerBridge.setWorkerAdapter(fakeWorker);

    const res1 = await request('POST', `/api/specify/sessions/${sess1.id}/next`);
    ok(res1.status === 200, 'POST /next returns 200');
    ok(res1.body.action === 'question', 'Returns question action');
    ok(res1.body.session.status === 'clarifying', 'Session moved to clarifying');
    ok(res1.body.session.clarifications.length === 1, 'Clarification added');

    // Test 2: POST /answer endpoint
    section('POST /answer Endpoint');

    const clarId = res1.body.session.clarifications[0].id;
    fakeWorker.setResponses(sess1.id, [
      {
        action: 'proposal',
        workerRequest: {
          specContent: '# API Spec\n\nDesign the REST API',
          taskBreakdown: [{ id: 't-1', title: 'Design', effort: 3 }],
          quality: 'high',
          sourceCleanupPlan: [],
        },
      },
    ]);

    const res2 = await request('POST', `/api/specify/sessions/${sess1.id}/answer`, {
      clarificationId: clarId,
      answer: 'REST API for user management',
    });

    ok(res2.status === 200, 'POST /answer returns 200');
    ok(res2.body.action === 'proposal', 'Returns proposal action');
    ok(res2.body.session.status === 'proposal-ready', 'Session moved to proposal-ready');
    ok(res2.body.session.draftProposal, 'Draft proposal set');

    // Test 3: POST /confirm endpoint
    section('POST /confirm Endpoint');

    const res3 = await request('POST', `/api/specify/sessions/${sess1.id}/confirm`, {
      userApproval: true,
    });

    ok(res3.status === 200, 'POST /confirm returns 200');
    ok(res3.body.session.status === 'persisting', 'Session moved to persisting');

    // Test 4: Error handling — missing session
    section('Error Handling');

    const res4 = await request('POST', '/api/specify/sessions/nonexistent/next');
    ok(res4.status === 404, 'Returns 404 for missing session');
    ok(res4.body.error, 'Error message present');

    // Test 5: Missing required fields in confirm
    const sess2 = specifySession.createSession({
      project: 'test',
      origin: 'canvas',
      agentId: 'test-agent-2',
    });

    const res5 = await request('POST', `/api/specify/sessions/${sess2.id}/confirm`, {});
    ok(res5.status === 400, 'Returns 400 for missing userApproval');

    section('Summary');
    if (fail === 0) {
      console.log(`✅ All ${pass} endpoint tests passed`);
      process.exit(0);
    } else {
      console.log(`❌ ${fail} failed, ${pass} passed`);
      process.exit(1);
    }
  } catch (err) {
    console.error('Test error:', err);
    process.exit(1);
  } finally {
    server.close();
  }
});

// Timeout failsafe
setTimeout(() => {
  console.error('Test timeout');
  process.exit(1);
}, 10000);
