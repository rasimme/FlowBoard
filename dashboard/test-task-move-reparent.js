'use strict';

// T-302 — move task to another project; re-parent within a project.

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = __dirname;
const PORT = 18810;

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

async function run() {
  console.log('# Task move & re-parent (T-302)');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-move-'));
  fs.mkdirSync(path.join(tmp, 'ws', 'projects'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'projects'), { recursive: true });

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      FLOWBOARD_PORT: String(PORT),
      FLOWBOARD_HOST: '127.0.0.1',
      OPENCLAW_WORKSPACE: path.join(tmp, 'ws'),
      FLOWBOARD_PROJECTS_DIR: path.join(tmp, 'projects'),
      HZL_DB_PATH: path.join(tmp, 'fb.db'),
      NODE_ENV: 'test',
      TELEGRAM_BOT_TOKEN: '',
      TELEGRAM_BOT_TOKENS: '',
    },
    stdio: 'ignore',
  });

  const api = async (m, p, b) => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api${p}`, {
      method: m,
      headers: { 'Content-Type': 'application/json' },
      body: b ? JSON.stringify(b) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  try {
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(300) });
        if (r.ok) break;
      } catch {}
      await new Promise(r => setTimeout(r, 150));
    }

    await api('POST', '/projects', { name: 'src' });
    await api('POST', '/projects', { name: 'dst' });
    await api('POST', '/projects/src/tasks', { title: 'Epic with children' });          // T-001
    await api('POST', '/projects/src/tasks', { title: 'Child A', parentId: 'T-001' });  // T-001-1
    await api('POST', '/projects/src/tasks', { title: 'Child B', parentId: 'T-001' });  // T-001-2
    await api('POST', '/projects/dst/tasks', { title: 'Existing in dst' });             // dst/T-001

    // --- title validation (T-355): empty/whitespace/oversized rejected ---
    ok((await api('POST', '/projects/src/tasks', { title: '   ' })).status === 400, 'whitespace-only title → 400');
    ok((await api('POST', '/projects/src/tasks', { title: '' })).status === 400, 'empty title → 400');
    ok((await api('POST', '/projects/src/tasks', {})).status === 400, 'missing title → 400');
    ok((await api('POST', '/projects/src/tasks', { title: 'x'.repeat(501) })).status === 400, 'title > 500 chars → 400');
    const trimmed = await api('POST', '/projects/src/tasks', { title: '  Trimmed me  ' });
    ok(trimmed.status === 200 && trimmed.body.task.title === 'Trimmed me', 'title is trimmed before save');

    // --- T-130: manual order rank round-trips (drag-to-reorder persistence) ---
    const ot = (await api('POST', '/projects/src/tasks', { title: 'Order me' })).body.task.id;
    ok((await api('POST', '/projects/src/tasks', { title: 'no-order check' })).body.task.order === null, 'new task has order=null by default');
    const setOrd = await api('PUT', `/projects/src/tasks/${ot}`, { order: 50 });
    ok(setOrd.status === 200 && setOrd.body.task.order === 50, 'order persists via PUT');
    const gotList = (await api('GET', '/projects/src/tasks')).body.tasks;
    ok(gotList.find(t => t.id === ot)?.order === 50, 'order round-trips on GET');
    const clr = await api('PUT', `/projects/src/tasks/${ot}`, { order: null });
    ok(clr.status === 200 && clr.body.task.order === null, 'order clears to null');
    ok((await api('PUT', `/projects/src/tasks/${ot}`, { order: 'nope' })).status === 400, 'non-numeric order → 400');

    // --- move with subtasks ---
    let r = await api('POST', '/projects/src/tasks/T-001/move', { toProject: 'dst' });
    ok(r.status === 200, `move returns 200 (got ${r.status})`);
    const movedId = r.body?.task?.id;
    ok(movedId === 'T-002', `moved task gets a fresh id in the target project (got ${movedId})`);

    let dst = (await api('GET', '/projects/dst/tasks')).body.tasks;
    const moved = dst.find(t => t.id === movedId);
    ok(Boolean(moved) && moved.subtaskIds.length === 2, 'subtasks moved with the parent');
    ok(dst.some(t => t.id === `${movedId}-1` && t.parentId === movedId), 'subtask ids and parent link remapped');

    let src = (await api('GET', '/projects/src/tasks')).body.tasks;
    ok(!src.some(t => t.title === 'Epic with children'), 'task left the source project');

    const comments = (await api('GET', `/projects/dst/tasks/${movedId}/comments`)).body;
    const list = comments?.comments || comments || [];
    ok(JSON.stringify(list).includes('Moved from project'), 'audit comment records the old reference');

    // move validations
    r = await api('POST', `/projects/dst/tasks/${movedId}-1/move`, { toProject: 'src' });
    ok(r.status === 400, 'moving a subtask directly is rejected');
    r = await api('POST', `/projects/dst/tasks/${movedId}/move`, { toProject: 'nope' });
    ok(r.status === 404, 'unknown target project is a 404');

    // --- re-parent ---
    const standalone = (await api('POST', '/projects/src/tasks', { title: 'Standalone' })).body.task.id;
    r = await api('POST', `/projects/src/tasks/${standalone}/parent`, { parentId: 'T-999' });
    ok(r.status === 404, 'unknown parent is a 404');

    const newParent = (await api('POST', '/projects/src/tasks', { title: 'New parent' })).body.task.id;
    r = await api('POST', `/projects/src/tasks/${standalone}/parent`, { parentId: newParent });
    ok(r.status === 200, `re-parent returns 200 (got ${r.status})`);
    const childId = r.body?.task?.id;
    ok(childId === `${newParent}-1` && r.body.task.parentId === newParent, `task became a subtask with a child id (got ${childId})`);

    // promote back to top-level
    r = await api('POST', `/projects/src/tasks/${childId}/parent`, { parentId: null });
    ok(r.status === 200 && r.body?.task?.parentId === null, 'subtask promoted back to top-level');
    ok(/^T-\d+$/.test(r.body?.task?.id || ''), `promoted task got a top-level id (got ${r.body?.task?.id})`);

    // depth guard: a parent with children cannot become a subtask
    const kid = (await api('POST', '/projects/src/tasks', { title: 'kid', parentId: newParent })).body.task.id;
    ok(Boolean(kid), 'guard setup: parent has a child again');
    r = await api('POST', `/projects/src/tasks/${newParent}/parent`, { parentId: r.body.task.id });
    ok(r.status === 409, `parent with subtasks cannot become a subtask (got ${r.status})`);
  } catch (err) {
    fail++;
    failures.push(err.message);
    console.log(`  not ok - ${err.message}`);
  } finally {
    child.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
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
