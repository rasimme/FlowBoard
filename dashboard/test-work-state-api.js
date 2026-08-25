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
      workStateDetails: {
        waitingFor: 'supplier',
        setAt: '2000-01-01T00:00:00.000Z',
      },
    });
    if (created.status !== 200) throw new Error(`task create failed: ${created.status}`);
    const id = created.body.task.id;
    if (Object.prototype.hasOwnProperty.call(created.body.task, 'blocked') || created.body.task.workState !== 'waiting') {
      throw new Error('canonical create response is inconsistent');
    }
    if (created.body.task.workStateDetails.setAt === '2000-01-01T00:00:00.000Z') {
      throw new Error('client-provided setAt was persisted instead of replaced by the server');
    }
    for (const field of ['reason', 'waitingFor', 'responsible', 'checkAgainAt', 'setAt']) {
      if (!Object.prototype.hasOwnProperty.call(created.body.task.workStateDetails, field)) {
        throw new Error(`missing normalized details field ${field}`);
      }
    }

    // The frontend-facing indicator actions are explicit, task-bound POSTs.
    // They return the complete canonical task and never become a lifecycle or
    // work-state PUT fallback.
    const indicatorCreated = await api('POST', '/projects/work-state-api/tasks', {
      title: 'indicator action task',
      status: 'open',
      workState: 'waiting',
      workStateDetails: { reason: 'supplier', waitingFor: 'external service' },
    });
    if (indicatorCreated.status !== 200) throw new Error('indicator task create failed');
    const indicatorId = indicatorCreated.body.task.id;
    const indicatorBefore = indicatorCreated.body.task;
    const indicatorCommentsBefore = await api('GET', `/projects/work-state-api/tasks/${indicatorId}/comments`);
    const retry = await api('POST', `/projects/work-state-api/tasks/${indicatorId}/stuck-indicator/retry`, {
      // Unknown fields are intentionally ignored; the action remains
      // non-destructive even if a caller attempts to smuggle a PUT payload.
      status: 'done',
      workState: 'working',
    });
    if (retry.status !== 200 || !retry.body?.task?.stuckIndicator?.active) {
      throw new Error(`indicator retry failed: ${retry.status}`);
    }
    const retriedTask = retry.body.task;
    if (JSON.stringify(retry.body.indicator) !== JSON.stringify(retriedTask.stuckIndicator)) {
      throw new Error('retry response indicator is not the current task indicator');
    }
    if (retriedTask.status !== indicatorBefore.status
        || retriedTask.workState !== indicatorBefore.workState
        || JSON.stringify(retriedTask.workStateDetails) !== JSON.stringify(indicatorBefore.workStateDetails)) {
      throw new Error('indicator retry changed lifecycle/work-state fields');
    }
    const expectedRetryPath = `/api/projects/work-state-api/tasks/${encodeURIComponent(indicatorId)}/stuck-indicator/retry`;
    const expectedClearPath = `/api/projects/work-state-api/tasks/${encodeURIComponent(indicatorId)}/stuck-indicator/clear`;
    if (JSON.stringify(retriedTask.stuckIndicator.actions) !== JSON.stringify({
      retry: { action: 'retry', method: 'POST', path: expectedRetryPath },
      clear: { action: 'clear', method: 'POST', path: expectedClearPath },
    })) {
      throw new Error('indicator action descriptors are not exact project/task-bound POST routes');
    }
    const indicatorCommentsAfterRetry = await api('GET', `/projects/work-state-api/tasks/${indicatorId}/comments`);
    if (indicatorCommentsAfterRetry.status !== 200
        || indicatorCommentsAfterRetry.body.comments.length !== indicatorCommentsBefore.body.comments.length) {
      throw new Error('indicator retry appended a comment');
    }

    const clear = await api('POST', `/projects/work-state-api/tasks/${indicatorId}/stuck-indicator/clear`);
    if (clear.status !== 200 || clear.body?.task?.stuckIndicator !== null || clear.body?.indicator !== null) {
      throw new Error(`indicator clear failed: ${clear.status}`);
    }
    if (clear.body.task.status !== indicatorBefore.status
        || clear.body.task.workState !== indicatorBefore.workState
        || JSON.stringify(clear.body.task.workStateDetails) !== JSON.stringify(indicatorBefore.workStateDetails)) {
      throw new Error('indicator clear changed lifecycle/work-state fields');
    }

    // Clear is non-destructive and retry can immediately re-evaluate the same
    // still-waiting condition without any agent-wake side effect.
    const retryAfterClear = await api('POST', `/projects/work-state-api/tasks/${indicatorId}/stuck-indicator/retry`);
    if (retryAfterClear.status !== 200 || !retryAfterClear.body?.task?.stuckIndicator?.active) {
      throw new Error('retry did not immediately re-evaluate after clear');
    }

    for (const action of ['retry', 'clear']) {
      const unknown = await api('POST', `/projects/work-state-api/tasks/T-unknown/stuck-indicator/${action}`);
      if (unknown.status !== 404) throw new Error(`unknown task ${action} did not return 404`);
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

    const afterTask = (await api('GET', '/projects/work-state-api/tasks')).body.tasks.find(task => task.id === id);
    if (!beforeTask || !afterTask || afterTask.title !== beforeTask.title || afterTask.specFile !== 'specs/before.md') {
      throw new Error('work-state validation mutated specFile or another field');
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

    const list = await api('GET', '/projects/work-state-api/tasks');
    const read = list.body.tasks.find(task => task.id === id);
    if (!read || Object.prototype.hasOwnProperty.call(read, 'blocked') || !read.workStateDetails) {
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
