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

    // Seed two valid specs so the rejected PUT can prove that the spec link
    // (and an unrelated title) remains unchanged when work-state validation
    // fails.  This is the adversarial regression for validate-before-mutate.
    const specsDir = path.join(tmp, 'projects', 'work-state-api', 'specs');
    fs.mkdirSync(specsDir, { recursive: true });
    fs.writeFileSync(path.join(specsDir, 'before.md'), '# before\n');
    fs.writeFileSync(path.join(specsDir, 'after.md'), '# after\n');
    const linked = await api('PUT', `/projects/work-state-api/tasks/${id}`, { specFile: 'specs/before.md' });
    if (linked.status !== 200 || linked.body.task.specFile !== 'specs/before.md') {
      throw new Error('valid spec link setup failed');
    }
    const beforeContradiction = await api('GET', '/projects/work-state-api/tasks');
    const beforeTask = beforeContradiction.body.tasks.find(task => task.id === id);

    const contradiction = await api('PUT', `/projects/work-state-api/tasks/${id}`, {
      title: 'must-not-partially-update',
      specFile: 'specs/after.md',
      blocked: true,
      workState: 'waiting',
    });
    if (contradiction.status !== 400 || contradiction.body?.code !== 'WORK_STATE_CONTRADICTION') {
      throw new Error('contradictory dual-write was not rejected with machine-readable 400');
    }
    const afterContradiction = await api('GET', '/projects/work-state-api/tasks');
    const afterTask = afterContradiction.body.tasks.find(task => task.id === id);
    if (afterContradiction.status !== 200 || !beforeTask || !afterTask
        || afterTask.title !== beforeTask.title
        || afterTask.specFile !== 'specs/before.md') {
      throw new Error('contradictory PUT mutated specFile or another field');
    }

    for (const checkAgainAt of [
      '2026-08-17T17:00:00',
      '2026-02-29T17:00:00.000Z',
      '2026-08-17T17:00:00+14:01',
      '2026-08-17T17:00:00+15',
      '2026-08-17T17:00:00+23',
      '2026-08-17T17:00:00+15:00',
      '2026-08-17T17:00:00+23:00',
    ]) {
      const invalidDatetime = await api('PUT', `/projects/work-state-api/tasks/${id}`, {
        workState: 'waiting',
        workStateDetails: { checkAgainAt },
      });
      if (invalidDatetime.status !== 400 || invalidDatetime.body?.code !== 'WORK_STATE_DETAILS_INVALID') {
        throw new Error(`invalid checkAgainAt was not rejected: ${checkAgainAt}`);
      }
    }

    for (const checkAgainAt of ['2026-08-17T17:00:00+14:00', '2026-08-17T17:00:00-14:00']) {
      const boundaryDatetime = await api('PUT', `/projects/work-state-api/tasks/${id}`, {
        workState: 'waiting',
        workStateDetails: { checkAgainAt },
      });
      if (boundaryDatetime.status !== 200 || boundaryDatetime.body?.task?.workStateDetails?.checkAgainAt !== checkAgainAt) {
        throw new Error(`maximum valid checkAgainAt offset was rejected: ${checkAgainAt}`);
      }
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
