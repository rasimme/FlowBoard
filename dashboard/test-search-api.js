'use strict';

// T-301 — Cross-project full-text search API.

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = __dirname;
const PORT = 18809;

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
  console.log('# Search API (T-301)');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-search-'));
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

    await api('POST', '/projects', { name: 'alpha' });
    await api('POST', '/projects', { name: 'beta' });
    await api('POST', '/projects/alpha/tasks', { title: 'Implement OAuth login flow' });
    await api('POST', '/projects/beta/tasks', { title: 'Fix login redirect bug' });
    await api('POST', '/projects/beta/tasks', { title: 'Unrelated styling work' });

    let r = await api('GET', '/search?q=login');
    ok(r.status === 200, 'search returns 200');
    ok((r.body?.tasks || []).length === 2, `cross-project match (got ${(r.body?.tasks || []).length})`);
    ok(r.body?.tasks?.every(t => t.project && t.id && t.title), 'results carry project, id and title');

    r = await api('GET', '/search?q=login&project=beta');
    ok((r.body?.tasks || []).length === 1 && r.body.tasks[0].project === 'beta', 'project filter narrows results');

    r = await api('GET', '/search?q=oau');
    ok((r.body?.tasks || []).length === 1 && r.body.tasks[0].title.includes('OAuth'), 'prefix matching works');

    r = await api('GET', '/search?q=' + encodeURIComponent('"NEAR( OR *'));
    ok(r.status === 200, 'FTS operator injection is neutralized (no 500)');

    r = await api('GET', '/search');
    ok(r.status === 400, 'missing q is a 400');

    // trashed tasks disappear from results
    const trash = await api('PUT', '/projects/beta/tasks/T-001?agentId=human', { trashedAt: new Date().toISOString() });
    ok(trash.status === 200, 'task trashed');
    r = await api('GET', '/search?q=login&project=beta');
    ok((r.body?.tasks || []).length === 0, 'trashed tasks are excluded from search');
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
