'use strict';

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
const HZL_DB_PATH = path.join(__dirname, 'test-workspace', '.hzl', 'flowboard-e2e-complex.db');
const TEST_PROJECT = 'e2e-complex-proj';
const WORKSPACE = path.join(__dirname, 'test-workspace');

if (fs.existsSync(HZL_DB_PATH)) {
  try { fs.unlinkSync(HZL_DB_PATH); } catch {}
}
fs.mkdirSync(path.join(WORKSPACE, 'projects'), { recursive: true });

async function waitForServer(child) {
  const deadline = Date.now() + 5000;
  let stderr = '';
  child.stderr.on('data', d => { stderr += d.toString(); });
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${stderr}`);
    try {
      const res = await makeRequest('GET', '/api/health');
      if (res.statusCode === 200) return;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`server did not become ready: ${stderr}`);
}

function makeRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port: PORT,
      path,
      method,
      headers: { 'Content-Type': 'application/json' },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({
            statusCode: res.statusCode,
            body: data ? JSON.parse(data) : null,
          });
        } catch (e) {
          resolve({
            statusCode: res.statusCode,
            body: data,
          });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
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
    },
    stdio: 'pipe',
  });

  await waitForServer(server);

  try {
    section('E2E: Complex Canvas Flow (2+ Clarifications)');

    // Create session
    const createRes = await makeRequest('POST', '/api/specify/sessions', {
      project: TEST_PROJECT,
      origin: 'canvas',
      agentId: 'e2e-agent-complex',
      sourceNoteIds: ['canvas-note-1', 'canvas-note-2'],
      sourceDescription: 'Complex user notes with ambiguities',
    });

    ok(createRes.statusCode === 201, 'Session created');
    const sessionId = createRes.body.session.id;

    // Ask worker for initial analysis
    const nextRes = await makeRequest('POST', `/api/specify/sessions/${sessionId}/next`);
    ok(nextRes.statusCode === 200, 'POST /next returns 200');

    // Answer first clarification
    const ans1 = await makeRequest('POST', `/api/specify/sessions/${sessionId}/answer`, {
      action: 'question',
      question: 'What is the primary user audience?',
      answer: 'B2B SaaS users, internal teams',
      affectedFields: ['scope', 'audience'],
    });

    ok(ans1.statusCode === 200, 'First clarification recorded');
    ok(ans1.body.session.clarifications.length === 1, '1 clarification recorded');

    // Ask worker for next step after clarification 1
    const next2 = await makeRequest('POST', `/api/specify/sessions/${sessionId}/next`);
    ok(next2.statusCode === 200, 'POST /next returns 200 after clarification');

    // Answer second clarification
    const ans2 = await makeRequest('POST', `/api/specify/sessions/${sessionId}/answer`, {
      action: 'question',
      question: 'What integrations are needed?',
      answer: 'Slack, GitHub, Jira',
      affectedFields: ['integrations'],
    });

    ok(ans2.statusCode === 200, 'Second clarification recorded');
    ok(ans2.body.session.clarifications.length === 2, '2 clarifications recorded');

    // Worker proposes spec after clarifications
    const propRes = await makeRequest('POST', `/api/specify/sessions/${sessionId}/answer`, {
      action: 'proposal',
      specContent: '# Team Dashboard Spec\n\n## Audience\nB2B SaaS internal teams...',
      taskBreakdown: [
        { title: 'Design database schema', description: 'Teams, projects, roles' },
        { title: 'Build API layer', description: 'REST endpoints' },
        { title: 'Integrate Slack', description: 'Notifications and commands' },
      ],
    });

    ok(propRes.statusCode === 200, 'Proposal recorded');
    ok(propRes.body.session.status === 'proposal-ready', 'Status is proposal-ready');
    ok(propRes.body.session.clarifications.length === 2, 'Clarifications preserved in proposal');

    // Confirm proposal
    const confirmRes = await makeRequest('POST', `/api/specify/sessions/${sessionId}/confirm`, {
      approved: true,
    });

    ok(confirmRes.statusCode === 200, 'Confirmation successful');
    ok(confirmRes.body.session.status === 'done', 'Session marked done');
    ok(confirmRes.body.createdArtifacts.taskIds.length === 3, '3 tasks created');

    if (fail === 0) {
      console.log(`\n✅ All ${pass} tests passed`);
    } else {
      console.log(`\n❌ ${fail} failed, ${pass} passed`);
      failures.forEach(f => console.log(`  - ${f}`));
    }
  } finally {
    server.kill();
    process.exit(fail > 0 ? 1 : 0);
  }
}

runTests().catch(e => {
  console.error('Test error:', e);
  process.exit(1);
});
