'use strict';

/**
 * Regression suite for the Specify clarify loop (T-262-13).
 * Spawns the real server with a scripted mock worker (SPECIFY_WORKER_MOCK)
 * and exercises the full HTTP path: canvas promote → clarify rounds →
 * skip/cap/guard/malformed/retry → proposal.
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

let pass = 0, fail = 0, failures = [];

function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✅ ${msg}`); }
  else { fail++; failures.push(msg); console.log(`  ❌ ${msg}`); }
}

function section(title) { console.log(`\n## ${title}\n`); }

const PORT = 18797;
const WORKSPACE = path.join(__dirname, 'test-workspace');
const HZL_DB_PATH = path.join(WORKSPACE, '.hzl', 'flowboard-clarify-regression.db');
const TEST_PROJECT = 'clarify-regression-proj';

if (fs.existsSync(HZL_DB_PATH)) {
  try { fs.unlinkSync(HZL_DB_PATH); } catch {}
}
fs.mkdirSync(path.join(WORKSPACE, 'projects', TEST_PROJECT), { recursive: true });

function makeRequest(method, reqPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: '127.0.0.1',
      port: PORT,
      path: reqPath,
      method,
      headers: data
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
        : {},
    }, (res) => {
      let raw = '';
      res.on('data', d => { raw += d; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch {}
        resolve({ statusCode: res.statusCode, body: parsed, raw });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function waitForServer(child) {
  const deadline = Date.now() + 8000;
  let stderr = '';
  child.stderr.on('data', d => { stderr += d.toString(); });
  while (Date.now() < deadline) {
    try {
      const res = await makeRequest('GET', '/api/projects');
      if (res.statusCode === 200) return;
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Server did not start. stderr: ${stderr.slice(0, 2000)}`);
}

let _sessionSeq = 0;
async function createSession(scenario, noteIds) {
  const res = await makeRequest('POST', '/api/specify/sessions', {
    project: TEST_PROJECT,
    origin: 'canvas',
    agentId: `regress-agent-${++_sessionSeq}`,
    sourceNoteIds: noteIds,
    sourceDescription: `[SCENARIO:${scenario}] regression input`,
  });
  if (!res.body || !res.body.session) {
    throw new Error(`Session creation failed (${res.statusCode}): ${res.raw.slice(0, 300)}`);
  }
  return res.body.session;
}

async function runTests() {
  const server = spawn('node', ['server.js'], {
    cwd: __dirname,
    env: {
      ...process.env,
      HZL_DB_PATH,
      FLOWBOARD_PORT: PORT,
      OPENCLAW_WORKSPACE: WORKSPACE,
      NODE_ENV: 'test',
      SPECIFY_WORKER_MOCK: path.join(__dirname, 'test-fixtures', 'specify-mock-worker.js'),
    },
    stdio: 'pipe',
  });

  await waitForServer(server);

  try {
    // -----------------------------------------------------------------------
    section('Single-Note Guard: one-note input must trigger clarify');

    const guardSession = await createSession('guard', ['note-guard-1']);
    ok(guardSession && guardSession.id, 'guard session created');

    const guardNext = await makeRequest('POST', `/api/specify/sessions/${guardSession.id}/next`);
    ok(guardNext.statusCode === 200, 'POST /next returns 200');
    ok(guardNext.body.action === 'question',
      `one-note instant proposal was intercepted — worker re-asked (got: ${guardNext.body.action})`);
    ok(guardNext.body.session.status === 'clarifying', 'session is clarifying, not proposal-ready');
    const guardQ = guardNext.body.session.clarifications[0];
    ok(guardQ && Array.isArray(guardQ.options) && guardQ.options.length === 2, 'question carries options');
    ok(guardQ.recommended === 'A', 'question carries recommended option');

    // -----------------------------------------------------------------------
    section('Multi-Round Clarify Loop: answers persist across rounds');

    const loopSession = await createSession('loop', ['note-loop-1', 'note-loop-2']);
    const loopNext = await makeRequest('POST', `/api/specify/sessions/${loopSession.id}/next`);
    ok(loopNext.body.action === 'question', 'first question asked');

    const q1 = loopNext.body.session.clarifications[0];
    const a1 = await makeRequest('POST', `/api/specify/sessions/${loopSession.id}/answer`, {
      clarificationId: q1.id,
      answer: 'A: Option A for q1',
    });
    ok(a1.body.action === 'question', 'second question follows first answer');
    const afterA1 = a1.body.session.clarifications;
    ok(afterA1.length === 2, 'two clarifications recorded');
    ok(afterA1[0].answer === 'A: Option A for q1',
      'first answer survives second question (stale-snapshot regression)');

    const q2 = afterA1.find(c => !c.answer);
    const a2 = await makeRequest('POST', `/api/specify/sessions/${loopSession.id}/answer`, {
      clarificationId: q2.id,
      answer: 'custom free-text answer',
    });
    ok(a2.body.action === 'proposal', 'proposal after enough clarification');
    ok(a2.body.session.status === 'proposal-ready', 'session reaches proposal-ready');
    ok(a2.body.session.clarifications.every(c => c.answer), 'all answers recorded');
    ok(a2.body.session.ambiguityScan && typeof a2.body.session.ambiguityScan.confidence === 'number',
      'ambiguity scan stored on session');

    // -----------------------------------------------------------------------
    section('Skip Remaining: user shortcut produces proposal');

    const skipSession = await createSession('loop', ['note-skip-1', 'note-skip-2']);
    const skipNext = await makeRequest('POST', `/api/specify/sessions/${skipSession.id}/next`);
    ok(skipNext.body.action === 'question', 'question asked before skip');

    const skipRes = await makeRequest('POST', `/api/specify/sessions/${skipSession.id}/skip`);
    ok(skipRes.statusCode === 200, 'POST /skip returns 200');
    ok(skipRes.body.action === 'proposal', 'skip yields proposal');
    ok(skipRes.body.session.status === 'proposal-ready', 'session proposal-ready after skip');

    // -----------------------------------------------------------------------
    section('Question Cap: max 4 questions enforced');

    const capSession = await createSession('greedy', ['note-cap-1', 'note-cap-2']);
    let capRes = await makeRequest('POST', `/api/specify/sessions/${capSession.id}/next`);
    ok(capRes.body.action === 'question', 'greedy worker asks first question');

    for (let i = 0; i < 4; i++) {
      const openQ = capRes.body.session.clarifications.find(c => !c.answer);
      if (!openQ) break;
      capRes = await makeRequest('POST', `/api/specify/sessions/${capSession.id}/answer`, {
        clarificationId: openQ.id,
        answer: `answer ${i + 1}`,
      });
    }
    ok(capRes.body.action === 'proposal',
      `greedy worker forced to proposal after cap (got: ${capRes.body.action})`);
    ok(capRes.body.session.clarifications.length === 4, 'exactly 4 questions were asked');

    // -----------------------------------------------------------------------
    section('Malformed Worker Response → recoverable error → retry');

    const malformedSession = await createSession('malformed', ['note-mal-1', 'note-mal-2']);
    const malNext = await makeRequest('POST', `/api/specify/sessions/${malformedSession.id}/next`);
    ok(malNext.body.action === 'error', 'malformed worker response becomes error action');
    ok(malNext.body.session.status === 'error', 'session enters error state');
    ok(/Malformed worker response/.test(malNext.body.session.failureState?.error || ''),
      'failure state explains the malformed response');

    const retryRes = await makeRequest('POST', `/api/specify/sessions/${malformedSession.id}/retry`);
    ok(retryRes.statusCode === 200, 'POST /retry returns 200');
    ok(retryRes.body.action === 'proposal', 'retry recovers and yields proposal');
    ok(retryRes.body.session.status === 'proposal-ready', 'session recovered to proposal-ready');
    ok(retryRes.body.session.failureState === null, 'failure state cleared after recovery');

    const retryOnHealthy = await makeRequest('POST', `/api/specify/sessions/${malformedSession.id}/retry`);
    ok(retryOnHealthy.statusCode === 409, 'retry on non-error session rejected with 409');

    // -----------------------------------------------------------------------
    section('Promote endpoint still creates dashboard sessions');

    const promoteRes = await makeRequest('POST', `/api/projects/${TEST_PROJECT}/canvas/promote`, {
      notes: [{ id: 'note-promote-1', text: '[SCENARIO:guard] single idea', color: 'yellow' }],
      connections: [],
      mode: 'single',
    });
    // Dashboard-path promote (no agentId) must work without a hooks token —
    // only the chat-agent webhook path needs OPENCLAW_HOOKS_TOKEN (SC-001).
    ok(promoteRes.statusCode === 200, `dashboard promote works without hooks token (${promoteRes.statusCode})`);
    ok(promoteRes.body && promoteRes.body.sessionId, 'promote returned a session id for the stepper');
  } finally {
    server.kill();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log('Failures:', failures);
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Regression suite crashed:', err);
  process.exit(1);
});
