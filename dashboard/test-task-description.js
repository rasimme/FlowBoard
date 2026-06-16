'use strict';

// T-396 — task `description` is settable on create + update and returned on read.

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = __dirname;
const PORT = 18815;

let pass = 0, fail = 0;
const failures = [];
function ok(c, m) { if (c) { pass++; console.log(`  ok - ${m}`); } else { fail++; failures.push(m); console.log(`  not ok - ${m}`); } }

async function run() {
  console.log('# Task description (T-396)');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-desc-'));
  fs.mkdirSync(path.join(tmp, 'ws', 'projects'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'projects'), { recursive: true });

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      FLOWBOARD_PORT: String(PORT), FLOWBOARD_HOST: '127.0.0.1',
      OPENCLAW_WORKSPACE: path.join(tmp, 'ws'), FLOWBOARD_PROJECTS_DIR: path.join(tmp, 'projects'),
      HZL_DB_PATH: path.join(tmp, 'fb.db'), NODE_ENV: 'test',
      TELEGRAM_BOT_TOKEN: '', TELEGRAM_BOT_TOKENS: '',
    },
    stdio: 'ignore',
  });
  const api = async (m, p, b) => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api${p}`, {
      method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  try {
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(300) }); if (r.ok) break; } catch {}
      await new Promise(r => setTimeout(r, 150));
    }
    await api('POST', '/projects', { name: 'alpha' });

    // create with description → persisted + returned on create and on read
    const created = await api('POST', '/projects/alpha/tasks', { title: 'Has context', description: 'One paragraph of context.' });
    ok(created.status === 200 && created.body?.ok, 'create returns ok');
    const id = created.body?.task?.id;
    ok(created.body?.task?.description === 'One paragraph of context.', 'create response carries the description');

    let list = await api('GET', '/projects/alpha/tasks');
    let t = (list.body?.tasks || []).find(x => x.id === id);
    ok(t?.description === 'One paragraph of context.', 'GET /tasks returns the description');

    // update description → persisted
    const upd = await api('PUT', `/projects/alpha/tasks/${id}`, { description: 'Updated context.' });
    ok(upd.status === 200, 'update returns 200');
    list = await api('GET', '/projects/alpha/tasks');
    t = (list.body?.tasks || []).find(x => x.id === id);
    ok(t?.description === 'Updated context.', 'GET reflects the updated description');

    // clearing
    await api('PUT', `/projects/alpha/tasks/${id}`, { description: '' });
    list = await api('GET', '/projects/alpha/tasks');
    t = (list.body?.tasks || []).find(x => x.id === id);
    ok((t?.description ?? '') === '', 'description can be cleared');

    // length guard (16KB)
    const tooBig = 'x'.repeat(16 * 1024 + 1);
    const big = await api('PUT', `/projects/alpha/tasks/${id}`, { description: tooBig });
    ok(big.status === 400, 'description over 16KB is rejected (400)');

    // wrong type
    const wrong = await api('POST', '/projects/alpha/tasks', { title: 'bad', description: 123 });
    ok(wrong.status === 400, 'non-string description is rejected (400)');
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
run().catch(err => { console.error('Test error:', err); process.exit(1); });
