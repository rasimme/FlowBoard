'use strict';

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = __dirname;
const PORT = 18833;

let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ok - ${msg}`); }
  else { fail++; failures.push(msg); console.log(`  not ok - ${msg}`); }
}

async function run() {
  console.log('# Content hygiene API Unicode roundtrip (T-433)');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-content-api-'));
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

  const api = async (method, route, body) => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  try {
    for (let i = 0; i < 60; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(300) });
        if (res.ok) break;
      } catch {}
      await new Promise(r => setTimeout(r, 150));
    }

    await api('POST', '/projects', { name: 'unicode' });

    const title = 'Prüfung: Café, São Paulo, 東京';
    const description = 'Beschreibung mit ä/ö/ü/ß, Akzenten und typografischen Zeichen: „Text“ — bleibt erhalten.';
    const created = await api('POST', '/projects/unicode/tasks', { title, description });
    ok(created.status === 200 && created.body?.ok, 'create task accepts Unicode title and description');
    const id = created.body?.task?.id;
    ok(created.body?.task?.title === title, 'create response preserves Unicode title');
    ok(created.body?.task?.description === description, 'create response preserves Unicode description');

    const updatedDescription = 'Aktualisiert: Grüße, mañana, résumé, 中文.';
    const updated = await api('PUT', `/projects/unicode/tasks/${id}`, { description: updatedDescription });
    ok(updated.status === 200, 'update task accepts Unicode description');
    const listed = await api('GET', '/projects/unicode/tasks');
    const task = (listed.body?.tasks || []).find(t => t.id === id);
    ok(task?.title === title, 'GET /tasks preserves Unicode title');
    ok(task?.description === updatedDescription, 'GET /tasks preserves updated Unicode description');

    const fileContent = '# Notizen\n\nUmlaute: äöüß. Akzente: éñ. CJK: 日本語.\n';
    const fileWrite = await api('PUT', '/projects/unicode/files/context/NOTES.md', { content: fileContent });
    ok(fileWrite.status === 200, 'File API writes Unicode markdown');
    const fileRead = await api('GET', '/projects/unicode/files/context/NOTES.md');
    ok(fileRead.body?.content === fileContent, 'File API reads Unicode markdown byte-stably');

    const specContent = '# Spezifikation: Prüfung\n\nDone When: Café bleibt Café.\n';
    const spec = await api('POST', `/projects/unicode/specs/${id}`, { content: specContent });
    ok(spec.status === 200 && spec.body?.specFile, 'spec API creates a spec for Unicode task title');
    const specRead = await api('GET', `/projects/unicode/files/${spec.body.specFile}`);
    ok(specRead.body?.content === specContent, 'spec file content preserves Unicode');
    ok(/prfung|spec/.test(spec.body.specFile), 'spec slug stays technical/ASCII-oriented');
  } catch (err) {
    fail++;
    failures.push(err.message);
    console.log(`  not ok - ${err.message}`);
  } finally {
    child.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  if (fail === 0) console.log(`\n✅ All ${pass} checks passed`);
  else {
    console.log(`\n❌ ${fail} failed, ${pass} passed`);
    failures.forEach(f => console.log(`  - ${f}`));
  }
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(err => { console.error('Test error:', err); process.exit(1); });
