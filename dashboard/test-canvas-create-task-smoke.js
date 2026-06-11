'use strict';

// T-272 — Smoke test: Canvas Create Task happy path.
// Verifies that promoting a real canvas note through the dashboard Specify
// flow creates exactly one retrievable FlowBoard task whose title reflects
// the source note text. Field mapping, note cleanup, rendering and error
// handling are out of scope (FR5).

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = __dirname;
const DASHBOARD_PORT = 18803;
const PROJECT = 'canvas-create-task-smoke';
const NOTE_TEXT = 'Smoke-Test: Canvas Create Task happy path';

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
  console.log('# Canvas Create Task smoke (T-272)');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-create-task-smoke-'));
  const workspace = path.join(tempRoot, 'workspace');
  const projectsDir = path.join(tempRoot, 'projects');
  fs.mkdirSync(path.join(workspace, 'projects'), { recursive: true });
  fs.mkdirSync(projectsDir, { recursive: true });

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
      NODE_ENV: 'test',
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

    let res = await fetchJson(base, 'POST', '/api/projects', { name: PROJECT });
    ok(res.status === 201 && res.body?.project?.name === PROJECT, 'creates isolated test project');

    // A real canvas note, not a synthetic id — the happy path starts on the canvas.
    res = await fetchJson(base, 'POST', `/api/projects/${PROJECT}/canvas/notes`, {
      text: NOTE_TEXT,
      x: 100,
      y: 100,
      color: 'yellow',
    });
    ok(res.status === 200 && res.body?.note?.id, 'creates canvas note');
    const note = res.body.note;

    res = await fetchJson(base, 'GET', `/api/projects/${PROJECT}/canvas`);
    ok(res.body?.notes?.some(n => n.id === note.id), 'canvas note is persisted');

    res = await fetchJson(base, 'GET', `/api/projects/${PROJECT}/tasks`);
    const tasksBefore = res.body?.tasks?.length ?? 0;
    ok(res.status === 200, 'task list readable before promote');

    // Create Task from the dashboard: promote without agentId starts a Specify session.
    res = await fetchJson(base, 'POST', `/api/projects/${PROJECT}/canvas/promote`, {
      notes: [note],
      connections: [],
      mode: 'single',
    });
    ok(res.status === 200 && res.body?.sessionId, 'promote starts dashboard Specify session');
    const sessionId = res.body.sessionId;

    res = await fetchJson(base, 'POST', `/api/specify/sessions/${sessionId}/next`);
    ok(res.status === 200 && res.body?.session?.status === 'proposal-ready', 'worker step reaches proposal-ready');

    res = await fetchJson(base, 'POST', `/api/specify/sessions/${sessionId}/confirm`, { approved: true });
    ok(res.status === 200 && res.body?.session?.status === 'done', 'confirm completes the session');
    const taskIds = res.body?.createdArtifacts?.taskIds || [];
    // FR1/SC1: exactly one task — zero or more than one is a failure.
    ok(taskIds.length === 1, `creates exactly one task (got ${taskIds.length})`);
    const taskId = taskIds[0];

    // FR2/SC2: the task must be retrievable from the task source.
    res = await fetchJson(base, 'GET', `/api/projects/${PROJECT}/tasks`);
    const tasks = res.body?.tasks || [];
    ok(tasks.length === tasksBefore + 1, `task list grew by exactly one (${tasksBefore} -> ${tasks.length})`);
    const created = tasks.find(t => t.id === taskId);
    ok(Boolean(created), `created task ${taskId} is retrievable from the task API`);

    // FR3/SC3: title must recognizably derive from the source note text.
    ok(
      Boolean(created) && (created.title.includes('Smoke-Test') || created.title.includes(NOTE_TEXT)),
      `task title reflects the note text (got "${created?.title}")`
    );
  } catch (err) {
    fail++;
    failures.push(err.message);
    console.log(`  not ok - ${err.message}`);
    if (logs) console.log(logs.split('\n').slice(-20).join('\n'));
  } finally {
    child.kill();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  if (fail === 0) {
    console.log(`\n✅ All ${pass} checks passed`);
  } else {
    console.log(`\n❌ ${fail} failed, ${pass} passed`);
    failures.forEach(f => console.log(`  - ${f}`));
  }
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
