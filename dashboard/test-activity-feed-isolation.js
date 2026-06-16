'use strict';

// T-390 — the project activity feed (GET /api/projects/:name/activity, the
// Timeline widget's source) must return a project's OWN events, scoped to that
// project — never empty just because another project is busier. Regression
// guard for the global-scan bug where a quiet project's events sat beyond the
// scan cap behind a high-volume project and the feed returned nothing.

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = __dirname;
const PORT = 18841;
let pass = 0, fail = 0; const failures = [];
function ok(c, m) { if (c) { pass++; console.log(`  ok - ${m}`); } else { fail++; failures.push(m); console.log(`  not ok - ${m}`); } }

async function run() {
  console.log('# Activity feed project isolation (T-390)');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-actfeed-'));
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
  const mkTask = async (proj, title) => (await api('POST', `/projects/${proj}/tasks`, { title })).body?.task?.id;

  try {
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(300) })).ok) break; } catch {}
      await new Promise(r => setTimeout(r, 150));
    }
    await api('POST', '/projects', { name: 'quiet' });
    await api('POST', '/projects', { name: 'busy' });

    // quiet: a few events (status change + a comment), created FIRST (older).
    const q1 = await mkTask('quiet', 'quiet task one');
    await api('PUT', `/projects/quiet/tasks/${q1}`, { status: 'open' });
    await api('POST', `/projects/quiet/tasks/${q1}/comment`, { author: 'tester', message: 'a note' });

    // busy: many tasks + many status changes AFTER quiet's events (more recent,
    // higher volume — the condition that used to bury quiet's feed).
    for (let i = 0; i < 12; i++) {
      const t = await mkTask('busy', `busy task ${i}`);
      await api('PUT', `/projects/busy/tasks/${t}`, { status: 'open' });
      await api('PUT', `/projects/busy/tasks/${t}`, { status: 'in-progress' });
    }

    // quiet's feed must still surface quiet's own events — and only those.
    const qf = (await api('GET', '/projects/quiet/activity?limit=25')).body?.activity || [];
    ok(qf.length > 0, `quiet project feed is not empty despite a busier neighbour (${qf.length} items)`);
    ok(qf.every(e => e.taskId === q1), 'quiet feed contains only quiet\'s own task events');
    ok(qf.some(e => e.event === 'status_changed') && qf.some(e => e.event === 'comment_added'),
       'quiet feed includes the status change and the comment');

    // busy's feed returns busy's events and none of quiet's content. (Task ids
    // are per-project, so isolate by content: quiet's distinctive comment must
    // not appear in busy's feed.)
    const bf = (await api('GET', '/projects/busy/activity?limit=50')).body?.activity || [];
    ok(bf.length > 0, `busy feed is populated (${bf.length} items)`);
    ok(!bf.some(e => e.event === 'comment_added' && (e.message || '').includes('a note')),
       'busy feed does not leak quiet\'s comment');
  } catch (err) {
    fail++; failures.push(err.message); console.log(`  not ok - ${err.message}`);
  } finally {
    child.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (fail === 0) console.log(`\n✅ All ${pass} checks passed`);
  else { console.log(`\n❌ ${fail} failed, ${pass} passed`); failures.forEach(f => console.log(`  - ${f}`)); }
  process.exit(fail > 0 ? 1 : 0);
}
run().catch(e => { console.error(e); process.exit(1); });
