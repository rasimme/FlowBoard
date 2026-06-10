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
      // Isolate from host/CI env — a global FLOWBOARD_PROJECTS_DIR would
      // leak into the spawned server and confuse the m004 migration.
      FLOWBOARD_PROJECTS_DIR: path.join(WORKSPACE, 'projects'),
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
    section('Confirm: note cleanup opt-out and backlog status (T-262-14/15)');

    async function promoteNotes(marker) {
      const ids = [];
      for (let i = 0; i < 2; i++) {
        const noteRes = await makeRequest('POST', `/api/projects/${TEST_PROJECT}/canvas/notes`, {
          text: `${marker} note ${i + 1}`, color: 'yellow', x: 100 + i * 50, y: 100,
        });
        ids.push((noteRes.body.note || noteRes.body).id);
      }
      const promoteRes2 = await makeRequest('POST', `/api/projects/${TEST_PROJECT}/canvas/promote`, {
        notes: ids.map(id => ({ id, text: `${marker} idea`, color: 'yellow' })),
        connections: [], mode: 'selected',
      });
      return { noteIds: ids, sessionId: promoteRes2.body.sessionId };
    }

    async function canvasHasNote(id) {
      const res = await makeRequest('GET', `/api/projects/${TEST_PROJECT}/canvas`);
      return (res.body.notes || []).some(n => n.id === id);
    }

    // Opt-out: cleanupNotes=false keeps the notes on the canvas
    const keep = await promoteNotes('keep-my-notes');
    await makeRequest('POST', `/api/specify/sessions/${keep.sessionId}/next`);
    const keepConfirm = await makeRequest('POST', `/api/specify/sessions/${keep.sessionId}/confirm`, {
      userApproval: true,
      customizations: { cleanupNotes: false },
    });
    ok(keepConfirm.statusCode === 200, 'confirm with cleanupNotes=false succeeds');
    ok((keepConfirm.body.cleanedNotes || []).length === 0, 'no notes reported cleaned');
    ok(await canvasHasNote(keep.noteIds[0]), 'source notes stay on canvas with opt-out');

    const keepTaskId = (keepConfirm.body.createdTasks || [])[0];
    const tasksRes = await makeRequest('GET', `/api/projects/${TEST_PROJECT}/tasks`);
    const keepTask = (tasksRes.body.tasks || []).find(t => t.id === keepTaskId);
    ok(keepTask && keepTask.status === 'backlog', `created tasks start in backlog (got: ${keepTask?.status})`);

    // Default: notes are removed
    const clean = await promoteNotes('clean-these-notes');
    await makeRequest('POST', `/api/specify/sessions/${clean.sessionId}/next`);
    const cleanConfirm = await makeRequest('POST', `/api/specify/sessions/${clean.sessionId}/confirm`, {
      userApproval: true,
    });
    ok((cleanConfirm.body.cleanedNotes || []).length === 2, 'default confirm cleans source notes');
    ok(!(await canvasHasNote(clean.noteIds[0])), 'source notes removed from canvas by default');

    // -----------------------------------------------------------------------
    section('Parent + subtasks structure and canonical spec naming');

    const parentFlow = await promoteNotes('[SCENARIO:parent]');
    await makeRequest('POST', `/api/specify/sessions/${parentFlow.sessionId}/next`);
    const parentConfirm = await makeRequest('POST', `/api/specify/sessions/${parentFlow.sessionId}/confirm`, {
      userApproval: true,
    });
    const createdIds = parentConfirm.body.createdTasks || [];
    ok(createdIds.length === 3, `three tasks created (got ${createdIds.length})`);

    const allTasks = (await makeRequest('GET', `/api/projects/${TEST_PROJECT}/tasks`)).body.tasks || [];
    const parentTask = allTasks.find(t => t.id === createdIds[0]);
    const subTasks = createdIds.slice(1).map(id => allTasks.find(t => t.id === id));

    ok(parentTask && (parentTask.subtaskIds || []).length === 2, 'first entry became the parent with 2 subtasks');
    ok(subTasks.every(t => t && t.parentId === parentTask.id), 'remaining entries are subtasks of the parent');
    ok(subTasks.every(t => t && t.id.startsWith(`${parentTask.id}-`)), 'subtask IDs derive from the parent ID');

    const specFile = parentConfirm.body.specPath;
    ok(new RegExp(`^specs/${parentTask.id}-[a-z0-9-]+\\.md$`).test(specFile || ''),
      `spec follows canonical naming specs/<taskId>-<slug>.md (got: ${specFile})`);
    ok(parentTask.specFile === specFile, 'spec is linked to the parent');
    ok(subTasks.every(t => !t.specFile), 'subtasks carry no spec link (spec lives on the parent)');

    // -----------------------------------------------------------------------
    section('Multiple parents with individual specs (high complexity)');

    const multi = await promoteNotes('[SCENARIO:multiparent]');
    await makeRequest('POST', `/api/specify/sessions/${multi.sessionId}/next`);
    const multiConfirm = await makeRequest('POST', `/api/specify/sessions/${multi.sessionId}/confirm`, {
      userApproval: true,
    });
    const multiIds = multiConfirm.body.createdTasks || [];
    ok(multiIds.length === 5, `five tasks created (got ${multiIds.length})`);

    const tasksNow = (await makeRequest('GET', `/api/projects/${TEST_PROJECT}/tasks`)).body.tasks || [];
    const byId = id => tasksNow.find(t => t.id === id);
    const [alphaId, alphaSub1Id, betaId, betaSub1Id, betaSub2Id] = multiIds;
    const alpha = byId(alphaId), beta = byId(betaId);

    ok(alpha && (alpha.subtaskIds || []).length === 1, 'first parent has its own subtask');
    ok(beta && (beta.subtaskIds || []).length === 2, 'second parent has its two subtasks');
    ok(byId(alphaSub1Id)?.parentId === alphaId, 'alpha subtask attached to alpha');
    ok(byId(betaSub1Id)?.parentId === betaId && byId(betaSub2Id)?.parentId === betaId,
      'beta subtasks attached to beta');

    const multiSpecs = multiConfirm.body.createdArtifacts?.specFiles || [];
    ok(multiSpecs.length === 3, `three spec files written (umbrella + beta + beta slice; got ${multiSpecs.length})`);
    ok(alpha.specFile && new RegExp(`^specs/${alphaId}-`).test(alpha.specFile),
      'umbrella spec attached to first parent with canonical name');
    ok(beta.specFile && new RegExp(`^specs/${betaId}-`).test(beta.specFile),
      'second parent carries its own canonical spec');
    ok(byId(betaSub1Id)?.specFile && new RegExp(`^specs/${betaSub1Id}-`).test(byId(betaSub1Id).specFile),
      'subtask with individual specContent got its own spec');
    ok(!byId(betaSub2Id)?.specFile, 'subtask without specContent has no spec link');

    // -----------------------------------------------------------------------
    section('Revise loop: proposal feedback produces improved proposal');

    const rev = await promoteNotes('[SCENARIO:revise]');
    await makeRequest('POST', `/api/specify/sessions/${rev.sessionId}/next`);
    let revSession = (await makeRequest('GET', `/api/specify/sessions/${rev.sessionId}`)).body;
    ok(revSession.status === 'proposal-ready', 'first draft proposal ready');
    ok(/Lumped/.test(revSession.draftProposal?.taskBreakdown?.[0]?.title || ''), 'first draft lumps features');

    const badRevise = await makeRequest('POST', `/api/specify/sessions/${rev.sessionId}/revise`, {});
    ok(badRevise.statusCode === 400, 'revise without feedback rejected (400)');

    const reviseRes = await makeRequest('POST', `/api/specify/sessions/${rev.sessionId}/revise`, {
      feedback: 'Split this into two parent tasks, one per feature',
    });
    ok(reviseRes.statusCode === 200, 'POST /revise returns 200');
    ok(reviseRes.body.action === 'proposal', 'revise yields a new proposal');
    revSession = reviseRes.body.session;
    ok(revSession.status === 'proposal-ready', 'session back to proposal-ready');
    ok((revSession.revisionNotes || []).length === 1, 'feedback recorded on session');
    ok(revSession.draftProposal.taskStructure === 'Multiple parents', 'revised proposal restructured');
    ok(/Revised after feedback/.test(revSession.draftProposal.summary || ''), 'worker saw the revision notes');

    const reviseConfirm = await makeRequest('POST', `/api/specify/sessions/${rev.sessionId}/confirm`, {
      userApproval: true,
    });
    ok((reviseConfirm.body.createdTasks || []).length === 4, 'revised structure persisted (2 parents + 2 subtasks)');

    const reviseOnDone = await makeRequest('POST', `/api/specify/sessions/${rev.sessionId}/revise`, {
      feedback: 'too late',
    });
    ok(reviseOnDone.statusCode === 409, 'revise after confirm rejected (409)');

    // maxQuestions exposed for the UI label
    ok(typeof revSession.maxQuestions === 'undefined' || revSession.maxQuestions === 4,
      'session payload carries maxQuestions consistent with policy default');
    const freshGet = (await makeRequest('GET', `/api/specify/sessions/${rev.sessionId}`)).body;
    ok(freshGet.maxQuestions === 4, 'GET session exposes maxQuestions (default 4)');

    // -----------------------------------------------------------------------
    section('Persist failure must leave a recoverable session (review HIGH)');

    const pf = await promoteNotes('[SCENARIO:persistfail]');
    await makeRequest('POST', `/api/specify/sessions/${pf.sessionId}/next`);
    const pfConfirm = await makeRequest('POST', `/api/specify/sessions/${pf.sessionId}/confirm`, {
      userApproval: true,
    });
    ok(pfConfirm.statusCode === 400, `failed persist returns 400 (got ${pfConfirm.statusCode})`);
    ok(pfConfirm.body.session?.status === 'error',
      `session lands in recoverable error state, not stuck persisting (got: ${pfConfirm.body.session?.status})`);

    // The shared 'human'/dashboard agent must not stay blocked: error is a
    // terminal status for the concurrency check, so a fresh promote for
    // other notes must work immediately.
    const pfSecond = await promoteNotes('loop');
    ok(!!pfSecond.sessionId, 'new dashboard session possible after persist failure');
    await makeRequest('POST', `/api/specify/sessions/${pfSecond.sessionId}/abort`);

    // And the failed session itself is retryable end-to-end.
    const pfRetry = await makeRequest('POST', `/api/specify/sessions/${pf.sessionId}/retry`);
    ok(pfRetry.statusCode === 200 && pfRetry.body.action === 'proposal', 'failed session retries to a new proposal');
    const pfConfirm2 = await makeRequest('POST', `/api/specify/sessions/${pf.sessionId}/confirm`, {
      userApproval: true,
    });
    ok(pfConfirm2.statusCode === 200 && (pfConfirm2.body.createdTasks || []).length === 1,
      'retried session persists successfully');

    // -----------------------------------------------------------------------
    section('Session create validates project (review HIGH: path traversal)');

    for (const evil of ['../../../tmp/evil', 'no-such-project-xyz']) {
      const evilRes = await makeRequest('POST', '/api/specify/sessions', {
        project: evil, origin: 'canvas', agentId: `evil-${evil.length}`, sourceNoteIds: [],
        sourceDescription: 'x',
      });
      ok(evilRes.statusCode === 404, `project "${evil}" rejected with 404 (got ${evilRes.statusCode})`);
    }

    // -----------------------------------------------------------------------
    section('Status guards: no worker call on settled sessions');

    const settled = await promoteNotes('loop');
    await makeRequest('POST', `/api/specify/sessions/${settled.sessionId}/skip`);
    const nextOnReady = await makeRequest('POST', `/api/specify/sessions/${settled.sessionId}/next`);
    ok(nextOnReady.statusCode === 409, `/next on proposal-ready rejected with 409 (got ${nextOnReady.statusCode})`);
    const skipOnReady = await makeRequest('POST', `/api/specify/sessions/${settled.sessionId}/skip`);
    ok(skipOnReady.statusCode === 409, `/skip on proposal-ready rejected with 409 (got ${skipOnReady.statusCode})`);
    await makeRequest('POST', `/api/specify/sessions/${settled.sessionId}/abort`);

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
