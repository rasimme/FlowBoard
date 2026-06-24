'use strict';

// File-endpoint hardening (T-355): PUT is restricted to context/ and specs/
// (no overwriting agent-consumed control files), and write/delete never follow
// a symlink while reads may not resolve outside the allowed roots — but a
// legitimate in-repo symlink (the PROJECT-RULES.md pattern) still reads fine.

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = __dirname;
const PORT = 18835;
const PROJECT = 'file-sec';

let pass = 0, fail = 0;
const failures = [];
function ok(c, m) { if (c) { pass++; console.log(`  ok - ${m}`); } else { fail++; failures.push(m); console.log(`  not ok - ${m}`); } }

async function api(base, method, urlPath, body) {
  const res = await fetch(base + urlPath, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
}
async function waitForServer(base, child) {
  const t = Date.now();
  while (Date.now() - t < 10000) {
    if (child.exitCode !== null) throw new Error(`dashboard exited early with ${child.exitCode}`);
    try { if ((await fetch(base + '/api/health', { signal: AbortSignal.timeout(300) })).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('dashboard did not become ready');
}

async function run() {
  console.log('# file-endpoint security (T-355)');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-filesec-'));
  fs.mkdirSync(path.join(tmp, 'workspace/projects'), { recursive: true });
  const projectsDir = path.join(tmp, 'projects');
  fs.mkdirSync(projectsDir, { recursive: true });
  const base = `http://127.0.0.1:${PORT}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, FLOWBOARD_PORT: String(PORT), FLOWBOARD_HOST: '127.0.0.1',
      OPENCLAW_WORKSPACE: path.join(tmp, 'workspace'), FLOWBOARD_PROJECTS_DIR: projectsDir,
      HZL_DB_PATH: path.join(tmp, 'fb.db'), NODE_ENV: 'test', TELEGRAM_BOT_TOKEN: '', TELEGRAM_BOT_TOKENS: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await waitForServer(base, child);
    await api(base, 'POST', '/api/projects', { name: PROJECT });
    const pdir = path.join(projectsDir, PROJECT);
    const enc = (p) => p.split('/').map(encodeURIComponent).join('/');

    // --- PUT allow-list ---
    ok((await api(base, 'PUT', `/api/projects/${PROJECT}/files/${enc('context/note.md')}`, { content: '# ok' })).status === 200,
      'PUT context/note.md → 200 (allowed)');
    ok((await api(base, 'PUT', `/api/projects/${PROJECT}/files/${enc('specs/s.md')}`, { content: '# ok' })).status === 200,
      'PUT specs/s.md → 200 (allowed)');
    const agents = await api(base, 'PUT', `/api/projects/${PROJECT}/files/AGENTS.md`, { content: 'pwn' });
    ok(agents.status === 403, 'PUT AGENTS.md (root control file) → 403 (allow-list)');
    ok(!fs.existsSync(path.join(pdir, 'AGENTS.md')), 'AGENTS.md was NOT written');
    // A ../ path must never write outside the project (the client normalizes
    // the URL, so the exact status varies; what matters is nothing escapes).
    const trav = await api(base, 'PUT', `/api/projects/${PROJECT}/files/${enc('context/../../escape.md')}`, { content: 'x' });
    ok(trav.status !== 200, `PUT with ../ traversal is blocked (status ${trav.status})`);
    ok(!fs.existsSync(path.join(projectsDir, 'escape.md')), 'traversal target not created outside the project');

    // --- read: traversal + symlink escape ---
    ok((await api(base, 'GET', `/api/projects/${PROJECT}/files/note.md`)).status !== 200 ? true : true, 'sanity');
    ok((await api(base, 'GET', `/api/projects/${PROJECT}/files/${enc('context/note.md')}`)).status === 200,
      'GET context/note.md → 200');

    // Symlink that escapes the allowed roots (→ /etc/hosts) must not be read.
    fs.symlinkSync('/etc/hosts', path.join(pdir, 'escape-link'));
    ok((await api(base, 'GET', `/api/projects/${PROJECT}/files/escape-link`)).status === 403,
      'GET symlink escaping allowed roots → 403');

    // --- read allow-list (T-417-14, ClawHub #2): the read route honors the
    // editor knowledge-layer visibility contract, not just path containment.
    // Non-knowledge files (operational JSON, *.pre-db.bak backups, in-repo
    // symlinks to non-.md files) are readable only with ?includeHidden=true,
    // mirroring the tree listing (buildFileTree) so a read cannot leak what
    // the tree hides by default.
    fs.writeFileSync(path.join(pdir, 'secret.pre-db.bak'), 'leaked backup');
    ok((await api(base, 'GET', `/api/projects/${PROJECT}/files/${enc('secret.pre-db.bak')}`)).status === 403,
      'GET non-knowledge backup file without includeHidden → 403 (read allow-list)');
    ok((await api(base, 'GET', `/api/projects/${PROJECT}/files/${enc('secret.pre-db.bak')}?includeHidden=true`)).status === 200,
      'GET non-knowledge backup file with ?includeHidden=true → 200');
    ok((await api(base, 'GET', `/api/projects/${PROJECT}/files/${enc('context/note.md')}`)).status === 200,
      'GET knowledge-layer .md still → 200 without includeHidden');
    // A traversal that ends in a visible-looking name must NOT slip the allow-list
    // (isEditorVisible runs on the raw path before resolution). Both plain and
    // %2f-encoded forms must be rejected even without includeHidden.
    ok((await api(base, 'GET', `/api/projects/${PROJECT}/files/${enc('context/../overview.json')}`)).status !== 200,
      'GET traversal context/../overview.json → not 200 (allow-list not slipped)');
    ok((await api(base, 'GET', `/api/projects/${PROJECT}/files/context%2f..%2foverview.json`)).status !== 200,
      'GET %2f-encoded traversal → not 200 (allow-list not slipped)');

    // Legit in-repo symlink (PROJECT-RULES.md pattern) is non-knowledge → it now
    // requires includeHidden, but remains reachable (read capability preserved).
    fs.symlinkSync(path.join(ROOT, 'package.json'), path.join(pdir, 'repo-link'));
    ok((await api(base, 'GET', `/api/projects/${PROJECT}/files/repo-link`)).status === 403,
      'GET in-repo symlink (non-knowledge) without includeHidden → 403 (read allow-list)');
    ok((await api(base, 'GET', `/api/projects/${PROJECT}/files/repo-link?includeHidden=true`)).status === 200,
      'GET in-repo symlink with ?includeHidden=true → 200 (PROJECT-RULES.md pattern preserved)');

    // --- write/delete never follow a symlink ---
    fs.mkdirSync(path.join(pdir, 'context'), { recursive: true });
    fs.symlinkSync('/tmp/fb-sec-outside-target.md', path.join(pdir, 'context', 'link.md'));
    ok((await api(base, 'PUT', `/api/projects/${PROJECT}/files/${enc('context/link.md')}`, { content: 'pwn' })).status === 403,
      'PUT through a symlink → 403 (no write-through-symlink)');
    ok(!fs.existsSync('/tmp/fb-sec-outside-target.md'), 'symlink target was NOT created by the write');
    ok((await api(base, 'DELETE', `/api/projects/${PROJECT}/files/${enc('context/link.md')}`)).status === 403,
      'DELETE through a symlink → 403');
    ok(fs.lstatSync(path.join(pdir, 'context', 'link.md')).isSymbolicLink(), 'symlink itself was not deleted');
  } finally {
    child.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 300));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n# results: ${pass} passed, ${fail} failed`);
  if (fail > 0) { console.log('# failures:'); failures.forEach(f => console.log(`#   - ${f}`)); process.exitCode = 1; }
}
run().catch(e => { console.error('# fatal:', e.message); process.exitCode = 1; });
