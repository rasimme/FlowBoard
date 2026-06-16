'use strict';

// T-387 — the Momentum widget's per-day activity now carries a `byType`
// breakdown so the hover tooltip can show *what* happened (status changes,
// created, checkpoints, comments, archived) rather than just a raw count.
// Contract: every day has { day, count, byType }, where byType maps the same
// meaningful event types the count already includes (task_updated stays
// excluded), count === sum(byType values), and byType omits zero entries.

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = __dirname;
const PORT = 18841;
let pass = 0, fail = 0; const failures = [];
function ok(c, m) { if (c) { pass++; console.log(`  ok - ${m}`); } else { fail++; failures.push(m); console.log(`  not ok - ${m}`); } }
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function run() {
  console.log('# Momentum activity/daily byType breakdown (T-387)');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-momentum-'));
  fs.mkdirSync(path.join(tmp, 'ws', 'projects'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'projects'), { recursive: true });
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, FLOWBOARD_PORT: String(PORT), FLOWBOARD_HOST: '127.0.0.1',
      OPENCLAW_WORKSPACE: path.join(tmp, 'ws'), FLOWBOARD_PROJECTS_DIR: path.join(tmp, 'projects'),
      HZL_DB_PATH: path.join(tmp, 'fb.db'), NODE_ENV: 'test', TELEGRAM_BOT_TOKEN: '', TELEGRAM_BOT_TOKENS: '' },
    stdio: 'ignore',
  });
  const api = async (m, p, b) => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api${p}`, {
      method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  try {
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(300) })).ok) break; } catch {}
      await sleep(150);
    }
    await api('POST', '/projects', { name: 'mo' });

    // Generate a spread of meaningful event types, all dated "today".
    const created = await api('POST', '/projects/mo/tasks', { title: 'probe' }); // task_created
    const id = created.body?.task?.id;
    ok(!!id, 'task created');
    await api('PUT', '/projects/mo/tasks/' + id, { status: 'open' });            // status_changed
    await api('POST', '/projects/mo/tasks/' + id + '/comment', { agent: 'tester', message: 'hi' }); // comment_added
    await api('POST', '/projects/mo/tasks/' + id + '/checkpoint', { agent: 'tester', message: 'cp' }); // checkpoint_recorded
    await sleep(150);

    const r = await api('GET', '/projects/mo/activity/daily?days=14');
    ok(r.status === 200, 'GET activity/daily 200');
    const days = r.body?.days || [];
    ok(days.length === 14, `returns 14 days (got ${days.length})`);

    // shape: every day has a byType object
    ok(days.every(d => d && typeof d.count === 'number' && d.byType && typeof d.byType === 'object'),
       'every day has count + byType object');

    // count === sum of byType for every day (and byType has no zero entries)
    const consistent = days.every(d => {
      const vals = Object.values(d.byType);
      const sum = vals.reduce((a, b) => a + b, 0);
      return sum === d.count && vals.every(v => v > 0);
    });
    ok(consistent, 'count equals the sum of byType (no zero entries) on every day');

    const today = days[days.length - 1];
    ok(today.byType.task_created >= 1, `today counts the created task (${today.byType.task_created})`);
    ok(today.byType.status_changed >= 1, `today counts the status change (${today.byType.status_changed})`);
    ok(today.byType.comment_added >= 1, `today counts the comment (${today.byType.comment_added})`);
    ok(today.byType.checkpoint_recorded >= 1, `today counts the checkpoint (${today.byType.checkpoint_recorded})`);
    ok(!('task_updated' in today.byType), 'task_updated stays excluded from byType');
  } finally {
    child.kill('SIGTERM');
    await sleep(200);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n# results: ${pass} passed, ${fail} failed`);
  if (fail > 0) { console.log('# failures:'); failures.forEach(f => console.log(`#   - ${f}`)); process.exitCode = 1; }
}
run().catch(e => { console.error('# fatal:', e.message); process.exitCode = 1; });
