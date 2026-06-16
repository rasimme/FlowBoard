'use strict';

// T-375-1 — /api/projects/:name/files visibility allowlist (integration).

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = __dirname;
const PORT = 18811;

let pass = 0, fail = 0;
const failures = [];
function ok(c, m) { if (c) { pass++; console.log(`  ok - ${m}`); } else { fail++; failures.push(m); console.log(`  not ok - ${m}`); } }

// flatten the nested file tree into a list of {path, type, hidden}
function flatten(nodes, acc = []) {
  for (const n of nodes) {
    acc.push(n);
    if (n.type === 'directory' && Array.isArray(n.children)) flatten(n.children, acc);
  }
  return acc;
}

async function run() {
  console.log('# File visibility API (T-375-1)');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-filevis-'));
  fs.mkdirSync(path.join(tmp, 'ws', 'projects'), { recursive: true });
  const projectsDir = path.join(tmp, 'projects');
  fs.mkdirSync(projectsDir, { recursive: true });

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      FLOWBOARD_PORT: String(PORT),
      FLOWBOARD_HOST: '127.0.0.1',
      OPENCLAW_WORKSPACE: path.join(tmp, 'ws'),
      FLOWBOARD_PROJECTS_DIR: projectsDir,
      HZL_DB_PATH: path.join(tmp, 'fb.db'),
      NODE_ENV: 'test',
      TELEGRAM_BOT_TOKEN: '',
      TELEGRAM_BOT_TOKENS: '',
    },
    stdio: 'ignore',
  });

  const api = async (p) => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api${p}`);
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  try {
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(300) }); if (r.ok) break; } catch {}
      await new Promise(r => setTimeout(r, 150));
    }

    await fetch(`http://127.0.0.1:${PORT}/api/projects`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'alpha' }),
    });

    // Seed a mixed file set directly in the project dir.
    const dir = path.join(projectsDir, 'alpha');
    fs.mkdirSync(path.join(dir, 'context'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'specs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'PROJECT.md'), '# alpha');
    fs.writeFileSync(path.join(dir, 'overview.json'), '{}');
    fs.writeFileSync(path.join(dir, 'tasks.tmp'), '');
    fs.writeFileSync(path.join(dir, 'tasks.json.migrated'), '{}');
    fs.writeFileSync(path.join(dir, 'canvas.json.pre-db.bak'), '{}');
    fs.writeFileSync(path.join(dir, 'context', 'note.md'), 'note');
    fs.writeFileSync(path.join(dir, 'specs', '_index.json'), '{}');
    fs.writeFileSync(path.join(dir, 'specs', 'T-1-x.md'), 'spec');

    let r = await api('/projects/alpha/files');
    ok(r.status === 200, 'files endpoint 200');
    let names = flatten((r.body && r.body.tree) || []).filter(n => n.type === 'file').map(n => n.path);
    ok(names.includes('PROJECT.md'), 'PROJECT.md visible');
    ok(names.includes('context/note.md'), 'context/note.md visible');
    ok(names.includes('specs/T-1-x.md'), 'specs/T-1-x.md visible');
    ok(!names.includes('overview.json'), 'overview.json hidden by default');
    ok(!names.includes('tasks.tmp'), 'tasks.tmp hidden by default');
    ok(!names.includes('tasks.json.migrated'), 'tasks.json.migrated hidden');
    ok(!names.includes('canvas.json.pre-db.bak'), 'canvas backup hidden');
    ok(!names.includes('specs/_index.json'), 'specs/_index.json hidden');

    r = await api('/projects/alpha/files?includeHidden=true');
    const all = flatten((r.body && r.body.tree) || []).filter(n => n.type === 'file');
    const byPath = Object.fromEntries(all.map(n => [n.path, n]));
    ok(!!byPath['overview.json'] && byPath['overview.json'].hidden === true, 'includeHidden reveals overview.json with hidden:true');
    ok(!!byPath['PROJECT.md'] && byPath['PROJECT.md'].hidden === false, 'PROJECT.md flagged hidden:false');
    ok(!!byPath['specs/_index.json'] && byPath['specs/_index.json'].hidden === true, 'includeHidden reveals specs/_index.json');
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
