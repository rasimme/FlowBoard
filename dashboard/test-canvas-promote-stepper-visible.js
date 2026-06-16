'use strict';

const assert = require('assert');
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = __dirname;
const DASHBOARD_PORT = 18792;
const TOKEN = 'test-stepper-token';
const PROJECT = 'stepper-test';

let pass = 0;
let fail = 0;
const failures = [];

function ok(condition, message) {
  if (condition) {
    pass++;
    console.log(`  ok - ${message}`);
  } else {
    fail++;
    failures.push(message);
    console.log(`  not ok - ${message}`);
  }
}

async function fetchJson(base, method, urlPath, body) {
  const res = await fetch(base + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
}

async function waitForServer(base, child) {
  const started = Date.now();
  while (Date.now() - started < 10000) {
    if (child.exitCode !== null) throw new Error(`dashboard exited early with ${child.exitCode}`);
    try {
      const res = await fetch(base + '/api/health', { signal: AbortSignal.timeout(300) });
      if (res.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('dashboard did not become ready');
}

async function run() {
  console.log('# Canvas promote stepper visibility regression test');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-stepper-test-'));
  const workspace = path.join(tempRoot, 'workspace');
  const projectsDir = path.join(tempRoot, 'projects');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(path.join(workspace, 'projects'), { recursive: true });
  fs.mkdirSync(projectsDir, { recursive: true });
  fs.writeFileSync(path.join(projectsDir, '.keep'), '');

  const base = `http://127.0.0.1:${DASHBOARD_PORT}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      FLOWBOARD_PORT: String(DASHBOARD_PORT),
      FLOWBOARD_HOST: '127.0.0.1',
      OPENCLAW_WORKSPACE: workspace,
      FLOWBOARD_PROJECTS_DIR: projectsDir,
      HZL_DB_PATH: path.join(tempRoot, 'flowboard.db'),
      OPENCLAW_GATEWAY_URL: 'http://127.0.0.1:18999',
      OPENCLAW_HOOKS_TOKEN: TOKEN,
      TELEGRAM_BOT_TOKEN: '',
      TELEGRAM_BOT_TOKENS: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let logs = '';
  child.stdout.on('data', d => { logs += d.toString(); });
  child.stderr.on('data', d => { logs += d.toString(); });

  try {
    await waitForServer(base, child);

    // Create test project
    let res = await fetchJson(base, 'POST', '/api/projects', { name: PROJECT });
    ok(res.status === 201 && res.body?.project?.name === PROJECT, 'creates test project');

    // Test 1: Canvas promote without agentId creates dashboard Specify session
    res = await fetchJson(base, 'POST', `/api/projects/${PROJECT}/canvas/promote`, {
      notes: [{ id: 'n-visual-1', text: 'Test idea for stepper visibility', color: 'yellow' }],
      connections: [],
      mode: 'single',
    });
    ok(res.status === 200 && res.body?.sessionId, 'promote returns sessionId immediately');
    const sessionId = res.body?.sessionId || 'unknown';

    // Test 2: Verify session exists and has proposal-ready state
    res = await fetchJson(base, 'GET', `/api/specify/sessions/${sessionId}`);
    ok(res.status === 200, 'session endpoint returns 200');
    ok(res.body?.agentId === 'human', 'session uses human agentId for dashboard');
    ok(res.body?.status === 'created' || res.body?.status === 'analyzing', 'session starts in created/analyzing state');

    // Test 3: Duplicate active session is detected
    res = await fetchJson(base, 'POST', `/api/projects/${PROJECT}/canvas/promote`, {
      notes: [{ id: 'n-visual-1', text: 'Duplicate note', color: 'blue' }],
      connections: [],
      mode: 'single',
    });
    ok(res.status === 409, 'duplicate active session returns 409 conflict');
    ok(res.body?.error?.includes('active Specify session'), 'error message mentions active session');

    // Test 4: Extract session ID from duplicate error message
    if (res.body?.error) {
      const match = res.body.error.match(/(specify-[\w-]+)/);
      ok(match?.[1] === sessionId, 'error message contains the original session ID for recovery');
    } else {
      ok(false, 'error message contains the original session ID for recovery');
    }

    // Test 5: Code inspection: SpecifyStepper passes open prop to Modal
    const stepperPath = path.join(__dirname, 'src', 'components', 'SpecifyStepper.jsx');
    const stepperContent = fs.readFileSync(stepperPath, 'utf8');
    ok(stepperContent.includes('const [isOpen, setIsOpen] = useState(true)'),
      'SpecifyStepper initializes isOpen state');
    ok(stepperContent.includes('<Modal open={isOpen}'),
      'SpecifyStepper passes open prop to Modal component');
    ok(stepperContent.includes('setIsOpen(false)') || stepperContent.includes('setIsOpen = false'),
      'SpecifyStepper manages isOpen state');

    // Test 6: Code inspection: the canvas promote mutation handles duplicate sessions
    const mutationsPath = path.join(__dirname, 'src', 'state', 'canvasMutations.mjs');
    const mutationsContent = fs.readFileSync(mutationsPath, 'utf8');
    ok(mutationsContent.includes('active Specify session'),
      'canvasMutations checks for active session error');
    ok(mutationsContent.includes('showStepper(match[1])'),
      'canvasMutations extracts and shows existing session ID on duplicate');

  } catch (err) {
    if (logs) console.error('Dashboard logs:', logs);
    throw err;
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise(resolve => child.once('exit', resolve));
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  const total = pass + fail;
  console.log(`\nPassed: ${pass}/${total}`);
  if (fail > 0) {
    console.log(`\nFailures:\n${failures.map(f => `  - ${f}`).join('\n')}`);
    process.exit(1);
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
