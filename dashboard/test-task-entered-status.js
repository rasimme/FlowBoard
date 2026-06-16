'use strict';

// T-379 — every task exposes `enteredStatusAt`: the ISO time it entered its
// current status. Set on create, refreshed on every status change, untouched by
// non-status updates. Drives the custom-sort "most recently moved on top".

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = __dirname;
const PORT = 18839;
let pass = 0, fail = 0; const failures = [];
function ok(c, m) { if (c) { pass++; console.log(`  ok - ${m}`); } else { fail++; failures.push(m); console.log(`  not ok - ${m}`); } }
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function run() {
  console.log('# Task enteredStatusAt (T-379)');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-entered-'));
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
  const getTask = async (id) => {
    const r = await api('GET', '/projects/es/tasks');
    const list = r.body?.tasks || r.body || [];
    return list.find(t => t.id === id);
  };

  try {
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(300) })).ok) break; } catch {}
      await sleep(150);
    }
    await api('POST', '/projects', { name: 'es' });

    const created = await api('POST', '/projects/es/tasks', { title: 'entry probe' });
    const id = created.body?.task?.id;
    ok(!!id, 'task created');
    const t0 = await getTask(id);
    ok(typeof t0.enteredStatusAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(t0.enteredStatusAt),
       `new task has an ISO enteredStatusAt (${t0.enteredStatusAt})`);

    await sleep(20);
    await api('PUT', '/projects/es/tasks/' + id, { status: 'open' });
    const t1 = await getTask(id);
    ok(t1.status === 'open', 'status changed to open');
    ok(t1.enteredStatusAt && t1.enteredStatusAt > t0.enteredStatusAt,
       `enteredStatusAt advanced on status change (${t0.enteredStatusAt} -> ${t1.enteredStatusAt})`);

    await sleep(20);
    await api('PUT', '/projects/es/tasks/' + id, { status: 'in-progress' });
    const t2 = await getTask(id);
    ok(t2.enteredStatusAt > t1.enteredStatusAt, 'enteredStatusAt advances again on a second status change');

    await sleep(20);
    await api('PUT', '/projects/es/tasks/' + id, { title: 'renamed, same status' });
    const t3 = await getTask(id);
    ok(t3.enteredStatusAt === t2.enteredStatusAt, 'a non-status update does NOT change enteredStatusAt');
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
