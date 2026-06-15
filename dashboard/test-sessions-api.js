'use strict';

// T-375-3 — POST /api/projects/:name/sessions (append SESSIONS.md entry).

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = __dirname;
const PORT = 18812;

let pass = 0, fail = 0;
const failures = [];
function ok(c, m) { if (c) { pass++; console.log(`  ok - ${m}`); } else { fail++; failures.push(m); console.log(`  not ok - ${m}`); } }

async function run() {
  console.log('# Sessions API (T-375-3)');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-sessions-'));
  fs.mkdirSync(path.join(tmp, 'ws', 'projects'), { recursive: true });
  const projectsDir = path.join(tmp, 'projects');
  fs.mkdirSync(projectsDir, { recursive: true });

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      FLOWBOARD_PORT: String(PORT), FLOWBOARD_HOST: '127.0.0.1',
      OPENCLAW_WORKSPACE: path.join(tmp, 'ws'), FLOWBOARD_PROJECTS_DIR: projectsDir,
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
  const readSessions = () => {
    try { return fs.readFileSync(path.join(projectsDir, 'alpha', 'SESSIONS.md'), 'utf8'); } catch { return ''; }
  };

  try {
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(300) }); if (r.ok) break; } catch {}
      await new Promise(r => setTimeout(r, 150));
    }

    await api('POST', '/projects', { name: 'alpha' });

    let r = await api('POST', '/projects/alpha/sessions', { agent: 'tester', summary: 'First entry done.' });
    ok(r.status === 200 && r.body?.ok, 'first session entry accepted');
    let md = readSessions();
    ok(/^# Sessions?/m.test(md), 'SESSIONS.md has a top-level heading');
    ok(/### \d{4}-\d{2}-\d{2} — tester/.test(md), 'entry heading has date + agent');
    ok(md.includes('First entry done.'), 'summary written');

    await api('POST', '/projects/alpha/sessions', { agent: 'tester', summary: 'Second entry done.' });
    md = readSessions();
    ok(md.indexOf('Second entry done.') < md.indexOf('First entry done.'), 'newest entry inserted above older (append-only, newest-first)');

    r = await api('POST', '/projects/alpha/sessions', { agent: 'tester', summary: 'Titled body', title: 'Closed T-1' });
    ok(r.status === 200, 'titled entry accepted');
    ok(readSessions().includes('— Closed T-1'), 'title used in heading');

    r = await api('POST', '/projects/alpha/sessions', { agent: 'tester' });
    ok(r.status === 400, 'missing summary → 400');
    r = await api('POST', '/projects/alpha/sessions', { summary: 'no agent' });
    ok(r.status === 400, 'missing/invalid agent → 400');
    r = await api('POST', '/projects/nope/sessions', { agent: 'tester', summary: 'x' });
    ok(r.status === 404, 'unknown project → 404');
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
