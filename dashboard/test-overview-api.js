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
    ok((r.body?.presets || []).map(p => p.name).sort().join(',') === 'agent,context,status', 'manifest lists the three presets');
    ok(r.body?.gridColumns === 12 && r.body?.rowHeight === 88, 'manifest carries the grid contract');

    // default when no file exists
    r = await api('GET', '/projects/ov/overview');
    ok(r.status === 200 && r.body?.overview?.source === 'default', 'missing file serves the default');
    ok(r.body?.overview?.preset === 'agent' && r.body.overview.widgets.length === 5, 'default is the agent preset');

    // materialize a preset
    r = await api('PUT', '/projects/ov/overview', { preset: 'context' });
    ok(r.status === 200 && r.body?.overview?.preset === 'context', 'PUT preset materializes it');
    r = await api('GET', '/projects/ov/overview');
    ok(r.body?.overview?.source === 'file' && r.body.overview.preset === 'context', 'persisted preset is served from file');

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
    ok(r.status === 400 && (r.body?.presets || []).includes('agent'), 'unknown preset is rejected with the preset list');

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
