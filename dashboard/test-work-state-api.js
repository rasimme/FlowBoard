'use strict';

// T-443 API contract checks: canonical fields, compatibility writes and
// machine-readable contradictory dual-write validation.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PORT = 18844;

async function main() {
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'flowboard-t443-api-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: {
      ...process.env,
      FLOWBOARD_PORT: String(PORT),
      FLOWBOARD_HOST: '127.0.0.1',
      OPENCLAW_WORKSPACE: path.join(tmp, 'workspace'),
      FLOWBOARD_PROJECTS_DIR: path.join(tmp, 'projects'),
      HZL_DB_PATH: path.join(tmp, 'flowboard.db'),
      NODE_ENV: 'test',
      TELEGRAM_BOT_TOKEN: '',
      TELEGRAM_BOT_TOKENS: '',
    },
    stdio: 'ignore',
  });
  const api = async (method, route, body) => {
    const response = await fetch(`http://127.0.0.1:${PORT}/api${route}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  try {
    let healthy = false;
    for (let i = 0; i < 80; i++) {
      try {
        const response = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(300) });
        if (response.ok) { healthy = true; break; }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!healthy) throw new Error('FlowBoard API did not become healthy');

    const project = await api('POST', '/projects', { name: 'work-state-api' });
    if (project.status !== 201) throw new Error(`project create failed: ${project.status}`);

    const created = await api('POST', '/projects/work-state-api/tasks', {
      title: 'waiting task',
      status: 'open',
      workState: 'waiting',
      workStateDetails: { waitingFor: 'supplier' },
    });
    if (created.status !== 200) throw new Error(`task create failed: ${created.status}`);
    const id = created.body.task.id;
    if (created.body.task.blocked !== false || created.body.task.workState !== 'waiting') {
      throw new Error('canonical create response is inconsistent');
    }
    for (const field of ['reason', 'waitingFor', 'responsible', 'checkAgainAt', 'setAt']) {
      if (!Object.prototype.hasOwnProperty.call(created.body.task.workStateDetails, field)) {
        throw new Error(`missing normalized details field ${field}`);
      }
    }

    const contradiction = await api('PUT', `/projects/work-state-api/tasks/${id}`, {
      blocked: true,
      workState: 'waiting',
    });
    if (contradiction.status !== 400 || contradiction.body?.code !== 'WORK_STATE_CONTRADICTION') {
      throw new Error('contradictory dual-write was not rejected with machine-readable 400');
    }

    const legacyBlock = await api('PUT', `/projects/work-state-api/tasks/${id}`, { blocked: true });
    if (legacyBlock.status !== 200 || legacyBlock.body.task.workState !== 'blocked' || legacyBlock.body.task.blocked !== true) {
      throw new Error('legacy blocked=true translation failed');
    }
    const legacyUnblock = await api('PUT', `/projects/work-state-api/tasks/${id}`, { blocked: false });
    if (legacyUnblock.status !== 200 || legacyUnblock.body.task.workState !== 'working' || legacyUnblock.body.task.blocked !== false) {
      throw new Error('legacy blocked=false translation failed');
    }

    const list = await api('GET', '/projects/work-state-api/tasks');
    const read = list.body.tasks.find(task => task.id === id);
    if (!read || read.blocked !== (read.workState === 'blocked') || !read.workStateDetails) {
      throw new Error('canonical read normalization failed');
    }
    console.log('✅ T-443 work-state API tests');
  } finally {
    child.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
