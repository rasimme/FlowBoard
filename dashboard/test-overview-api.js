'use strict';

// T-305-1 — Overview API: registry manifest, default preset, validation, presets.

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = __dirname;
const PORT = 18811;

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
  console.log('# Overview API (T-305-1)');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-overview-'));
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

    await api('POST', '/projects', { name: 'ov' });

    // registry manifest
    let r = await api('GET', '/overview/widgets');
    ok(r.status === 200 && Array.isArray(r.body?.widgets) && r.body.widgets.length >= 7, 'manifest lists the widget catalog');
    ok((r.body?.presets || []).map(p => p.name).sort().join(',') === 'coding,default,knowledge,mission', 'manifest lists the four presets');
    ok(r.body?.gridColumns === 12 && r.body?.rowHeight === 88, 'manifest carries the grid contract');

    // T-307: question/answer comments drive the questions feed
    r = await api('POST', '/projects/ov/tasks', { title: 'question host' });
    const qTask = r.body?.task?.id;
    ok(r.status === 200 && qTask, 'task for question flow created');
    r = await api('POST', `/projects/ov/tasks/${qTask}/comment`, { author: 'a1', message: 'q?', kind: 'question' });
    const qid = r.body?.comment?.id;
    ok(r.status === 200 && Number.isInteger(qid), 'question comment returns its event id');
    r = await api('GET', '/projects/ov/questions');
    ok(r.status === 200 && r.body?.questions?.length === 1 && r.body.questions[0].id === qid, 'open question surfaces in the feed');
    r = await api('POST', `/projects/ov/tasks/${qTask}/comment`, { author: 'human', message: 'a.', kind: 'answer', questionId: qid });
    ok(r.status === 200, 'answer accepted');
    r = await api('GET', '/projects/ov/questions');
    ok(r.status === 200 && r.body?.questions?.length === 0, 'answer resolves the question');
    r = await api('POST', `/projects/ov/tasks/${qTask}/comment`, { author: 'human', message: 'x', kind: 'answer' });
    ok(r.status === 400, 'answer without questionId is rejected');

    // repo-status endpoint validates input without touching the network
    r = await api('GET', '/github/repo-status');
    ok(r.status === 400, 'repo-status without repo is rejected');
    r = await api('GET', '/github/repo-status?repo=' + encodeURIComponent('../etc/passwd'));
    ok(r.status === 400, 'repo-status rejects non owner/name input');
    // path-traversal hardening: a `..` segment must never reach the GitHub API with the token
    r = await api('GET', '/github/repo-status?repo=' + encodeURIComponent('owner/..'));
    ok(r.status === 400, 'repo-status rejects a ".." path segment');

    // insight endpoint validation (all reject BEFORE any network call)
    r = await api('GET', '/github/insight?repo=rasimme/FlowBoard');
    ok(r.status === 400, 'insight without view is rejected');
    r = await api('GET', '/github/insight?repo=rasimme/FlowBoard&view=bogus');
    ok(r.status === 400, 'insight rejects an unknown view');
    r = await api('GET', '/github/insight?repo=owner/..&view=pulls');
    ok(r.status === 400, 'insight rejects a traversal repo');
    r = await api('GET', '/github/insight?repo=rasimme/FlowBoard&view=ci&branch=' + encodeURIComponent('../x'));
    ok(r.status === 400, 'insight rejects a traversal branch');

    // GitHub token store — WRITE-ONLY: the value must never be echoed back
    r = await api('GET', '/settings/github-token');
    ok(r.status === 200 && r.body?.set === false, 'token store starts empty');
    r = await api('PUT', '/settings/github-token', { token: 'short' });
    ok(r.status === 400, 'token store rejects a malformed token');
    const secret = 'ghp_' + 'x'.repeat(36);
    r = await api('PUT', '/settings/github-token', { token: secret });
    ok(r.status === 200, 'token store accepts a valid PAT');
    r = await api('GET', '/settings/github-token');
    ok(r.status === 200 && r.body?.set === true && r.body?.source === 'settings', 'token store reports set without the value');
    ok(JSON.stringify(r.body).indexOf(secret) === -1, 'token value is NEVER returned by GET');
    r = await api('DELETE', '/settings/github-token');
    ok(r.status === 200, 'token store clears on DELETE');
    r = await api('GET', '/settings/github-token');
    ok(r.body?.set === false, 'token store is empty after DELETE');

    // project-level GitHub binding (T-328)
    r = await api('GET', '/projects/ov/github');
    ok(r.status === 200 && r.body?.github === null, 'project github binding starts null');
    r = await api('PUT', '/projects/ov/github', { repo: 'owner/..' });
    ok(r.status === 400, 'binding rejects a traversal repo');
    r = await api('PUT', '/projects/ov/github', { repo: 'rasimme/FlowBoard', branch: 'dev' });
    ok(r.status === 200 && r.body?.github?.repo === 'rasimme/FlowBoard' && r.body?.github?.branch === 'dev', 'binding persists repo + branch');
    r = await api('GET', '/projects/ov/github');
    ok(r.body?.github?.repo === 'rasimme/FlowBoard', 'binding is read back');
    r = await api('PUT', '/projects/ov/github', { repo: null });
    ok(r.status === 200 && r.body?.github === null, 'binding clears with {repo:null}');
    r = await api('PUT', '/projects/nope/github', { repo: 'a/b' });
    ok(r.status === 404, 'binding on a missing project is 404');

    // project stats endpoint (T-303)
    r = await api('GET', '/projects/ov/stats');
    ok(r.status === 200 && r.body?.stats && typeof r.body.stats.total === 'number'
       && r.body.stats.counts && typeof r.body.stats.throughput7d === 'number',
       'stats endpoint returns the metric shape');
    r = await api('GET', '/projects/nope/stats');
    ok(r.status === 404, 'stats on a missing project is 404');

    // an answer may not resolve a question that does not exist in this project
    r = await api('POST', `/projects/ov/tasks/${qTask}/comment`, { author: 'human', message: 'x', kind: 'answer', questionId: 999999 });
    ok(r.status === 400, 'answer with a bogus questionId is rejected');

    // default when no file exists
    r = await api('GET', '/projects/ov/overview');
    ok(r.status === 200 && r.body?.overview?.source === 'default', 'missing file serves the default');
    ok(r.body?.overview?.preset === 'default' && r.body.overview.widgets.length === 10, 'default is the standard preset (T-327)');

    // materialize a preset
    r = await api('PUT', '/projects/ov/overview', { preset: 'knowledge' });
    ok(r.status === 200 && r.body?.overview?.preset === 'knowledge', 'PUT preset materializes it');
    r = await api('GET', '/projects/ov/overview');
    ok(r.body?.overview?.source === 'file' && r.body.overview.preset === 'knowledge', 'persisted preset is served from file');

    // custom config (the agent path)
    r = await api('PUT', '/projects/ov/overview', {
      version: 1,
      layout: 'grid',
      widgets: [
        { id: 'a', type: 'active-agents', grid: { x: 0, y: 0, w: 12, h: 3 } },
        { id: 's', type: 'task-stats', title: 'Zahlen', grid: { x: 0, y: 3, w: 6, h: 2 } },
      ],
    });
    ok(r.status === 200 && r.body?.overview?.widgets?.length === 2, 'custom config accepted');

    // validation failures
    r = await api('PUT', '/projects/ov/overview', { version: 1, widgets: [{ id: 'x', type: 'evil-widget', grid: { x: 0, y: 0, w: 4, h: 2 } }] });
    ok(r.status === 400 && JSON.stringify(r.body?.errors).includes('not a registered widget'), 'unknown widget type is rejected (trusted registry)');
    r = await api('PUT', '/projects/ov/overview', { version: 1, widgets: [{ id: 'x', type: 'next-up', grid: { x: 10, y: 0, w: 6, h: 2 } }] });
    ok(r.status === 400 && JSON.stringify(r.body?.errors).includes('exceeds 12'), 'grid overflow is rejected');
    r = await api('PUT', '/projects/ov/overview', { version: 2, widgets: [] });
    ok(r.status === 400, 'wrong version is rejected');
    r = await api('PUT', '/projects/ov/overview', { preset: 'nope' });
    ok(r.status === 400 && (r.body?.presets || []).includes('coding'), 'unknown preset is rejected with the preset list');

    // corrupt file degrades gracefully to the default
    fs.writeFileSync(path.join(tmp, 'projects', 'ov', 'overview.json'), '{not json');
    r = await api('GET', '/projects/ov/overview');
    ok(r.status === 200 && r.body?.overview?.source === 'default', 'corrupt overview.json falls back to the default');

    r = await api('GET', '/projects/nope/overview');
    ok(r.status === 404, 'unknown project is a 404');
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
