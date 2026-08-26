'use strict';

const assert = require('node:assert/strict');
const { withIsolatedDashboard } = require('./test-support/server-harness.js');
const { validateBundle } = require('./project-bundle-validator.js');

async function bundleRequest(ctx, path, bundle, failure = null) {
  const response = await fetch(`${ctx.base}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/vnd.flowboard.project+json',
      ...(failure ? { 'X-FlowBoard-Test-Import-Failure': failure } : {}),
    },
    body: JSON.stringify(bundle),
  });
  return { status: response.status, body: await response.json() };
}

async function main() {
  await withIsolatedDashboard(async (source) => {
    assert.equal((await source.api('POST', '/projects', {
      name: 'history-source', displayName: 'History Source', taskDiscipline: 'development',
    })).status, 201);
    const task = await source.api('POST', '/projects/history-source/tasks', {
      title: 'History task', description: 'Portable history fixture.', status: 'open',
    });
    assert.equal(task.status, 200, JSON.stringify(task.body));
    const taskId = task.body.task.id;
    const question = await source.api('POST', `/projects/history-source/tasks/${taskId}/comment`, {
      message: 'What should we review?', kind: 'question', author: 'reviewer',
    });
    assert.equal(question.status, 200, JSON.stringify(question.body));
    const checkpoint = await source.api('POST', `/projects/history-source/tasks/${taskId}/checkpoint`, {
      message: 'Review started', agent: 'history-worker', progress: 25,
    });
    assert.equal(checkpoint.status, 200, JSON.stringify(checkpoint.body));
    const answer = await source.api('POST', `/projects/history-source/tasks/${taskId}/comment`, {
      message: 'Review the import boundary.', kind: 'answer', questionId: question.body.comment.id, author: 'reviewer',
    });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));

    const safe = await source.api('GET', '/projects/history-source/export');
    assert.equal(safe.status, 200, JSON.stringify(safe.body));
    assert.equal(safe.body.history, undefined);
    assert.equal(safe.body.manifest.options.includeHistory, false);

    const exported = await source.api('GET', '/projects/history-source/export?includeHistory=true');
    assert.equal(exported.status, 200, JSON.stringify(exported.body));
    const valid = validateBundle(exported.body);
    assert.equal(valid.ok, true, JSON.stringify(valid.errors));
    assert.equal(exported.body.manifest.options.includeHistory, true);
    assert.equal(exported.body.manifest.counts.historyComments, 2);
    assert.equal(exported.body.manifest.counts.historyCheckpoints, 1);
    assert.deepEqual(exported.body.history.comments.map(item => item.sequence), [0, 2]);
    assert.equal(exported.body.history.comments[1].questionId, exported.body.history.comments[0].id);
    assert.equal(exported.body.history.checkpoints[0].progress, 25);
    assert.equal(exported.body.history.comments[0].authorLabel, 'reviewer');
    assert.equal(JSON.stringify(exported.body).includes('event_rowid'), false);

    await withIsolatedDashboard(async (destination) => {
      const preview = await bundleRequest(destination, '/api/projects/import/preview?targetName=history-copy', exported.body);
      assert.equal(preview.status, 200, JSON.stringify(preview.body));
      assert.equal(preview.body.options.includeHistory, true);
      assert.equal(preview.body.counts.historyComments, 2);
      const failed = await bundleRequest(destination, '/api/projects/import?targetName=history-recovery', exported.body, 'canvas');
      assert.equal(failed.status, 500, JSON.stringify(failed.body));
      assert.equal(failed.body.recoverable, true);
      const resumed = await bundleRequest(destination, '/api/projects/import?targetName=history-recovery', exported.body);
      assert.equal(resumed.status, 201, JSON.stringify(resumed.body));
      const resumedComments = await destination.api('GET', `/projects/history-recovery/tasks/${taskId}/comments`);
      const resumedCheckpoints = await destination.api('GET', `/projects/history-recovery/tasks/${taskId}/checkpoints`);
      assert.equal(resumedComments.body.comments.length, 2);
      assert.equal(resumedCheckpoints.body.checkpoints.length, 1);
      const imported = await bundleRequest(destination, '/api/projects/import?targetName=history-copy', exported.body);
      assert.equal(imported.status, 201, JSON.stringify(imported.body));
      assert.equal(imported.body.counts.historyComments, 2);
      assert.equal(imported.body.counts.historyCheckpoints, 1);
      const importedComments = await destination.api('GET', `/projects/history-copy/tasks/${taskId}/comments`);
      const importedCheckpoints = await destination.api('GET', `/projects/history-copy/tasks/${taskId}/checkpoints`);
      assert.equal(importedComments.body.comments.length, 2);
      assert.equal(importedCheckpoints.body.checkpoints.length, 1);
      assert.equal(importedComments.body.comments[0].timestamp, exported.body.history.comments[0].createdAt);
      assert.equal(importedComments.body.comments[1].questionId, importedComments.body.comments[0].id);
      assert.equal(importedCheckpoints.body.checkpoints[0].timestamp, exported.body.history.checkpoints[0].createdAt);
      assert.equal(importedCheckpoints.body.checkpoints[0].agent, null);
      const retry = await bundleRequest(destination, '/api/projects/import?targetName=history-copy', exported.body);
      assert.equal(retry.status, 409);
    }, { prefix: 'flowboard-t468-history-destination-' });
  }, { prefix: 'flowboard-t468-history-source-' });
  console.log('T-468-9 project bundle history tests passed');
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
