'use strict';

const assert = require('node:assert/strict');
const Database = require('libsql');
const { withIsolatedDashboard } = require('./test-support/server-harness.js');
const { validateBundle } = require('./project-bundle-validator.js');

function historyEventIds(ctx, project) {
  const cache = new Database(ctx.cacheDbPath, { readonly: true });
  const events = new Database(ctx.dbPath, { readonly: true });
  try {
    const taskIds = cache.prepare('SELECT task_id FROM tasks_current WHERE project = ?').all(project).map(row => row.task_id);
    if (taskIds.length === 0) return [];
    const placeholders = taskIds.map(() => '?').join(',');
    return events.prepare(`
      SELECT event_id, type FROM events
       WHERE task_id IN (${placeholders})
         AND type IN ('comment_added', 'checkpoint_recorded')
       ORDER BY id
    `).all(...taskIds);
  } finally {
    cache.close();
    events.close();
  }
}

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
    assert.equal(exported.body.history.checkpoints[0].authorLabel, 'history-worker');
    assert.equal(JSON.stringify(exported.body).includes('event_rowid'), false);

    const sourceEventIds = historyEventIds(source, 'history-source').map(event => event.event_id);
    assert.equal(sourceEventIds.length, 3);

    const secretTask = await source.api('POST', '/projects/history-source/tasks', {
      title: 'History secret fixture', description: 'Safe task metadata.', status: 'open',
    });
    assert.equal(secretTask.status, 200, JSON.stringify(secretTask.body));
    const fakeHistoryToken = 'sk-proj-history-secret-value-1234567890';
    const secretComment = await source.api('POST', `/projects/history-source/tasks/${secretTask.body.task.id}/comment`, {
      message: `Do not export this token: ${fakeHistoryToken}`, author: 'reviewer',
    });
    assert.equal(secretComment.status, 200, JSON.stringify(secretComment.body));
    const defaultWithHistoryFixture = await source.api('GET', '/projects/history-source/export');
    assert.equal(defaultWithHistoryFixture.status, 200, JSON.stringify(defaultWithHistoryFixture.body));
    const blockedHistoryExport = await source.api('GET', '/projects/history-source/export?includeHistory=true');
    assert.equal(blockedHistoryExport.status, 500, JSON.stringify(blockedHistoryExport.body));
    assert.equal(blockedHistoryExport.body.code, 'SENSITIVE_CONTENT_DETECTED');
    assert.equal(JSON.stringify(blockedHistoryExport.body).includes(fakeHistoryToken), false);
    assert.equal(source.readLogs().includes(fakeHistoryToken), false);

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
      const importedTask = await destination.api('GET', `/projects/history-copy/tasks/${taskId}`);
      assert.equal(importedComments.body.comments.length, 2);
      assert.equal(importedCheckpoints.body.checkpoints.length, 1);
      assert.deepEqual(importedComments.body.comments.map(comment => ({
        message: comment.message,
        kind: comment.kind,
        author: comment.author,
        timestamp: comment.timestamp,
      })), exported.body.history.comments.map(comment => ({
        message: comment.body,
        kind: comment.kind,
        author: comment.authorLabel,
        timestamp: comment.createdAt,
      })));
      assert.equal(importedComments.body.comments[1].questionId, importedComments.body.comments[0].id);
      assert.deepEqual(importedCheckpoints.body.checkpoints.map(checkpoint => ({
        message: checkpoint.message,
        progress: checkpoint.progress,
        author: checkpoint.author,
        timestamp: checkpoint.timestamp,
      })), exported.body.history.checkpoints.map(checkpoint => ({
        message: checkpoint.message,
        progress: checkpoint.progress,
        author: checkpoint.authorLabel,
        timestamp: checkpoint.createdAt,
      })));
      assert.equal(importedCheckpoints.body.checkpoints[0].agent, null);
      assert.equal(importedTask.body.task.agent, null);
      assert.equal(importedTask.body.task.leaseUntil, null);
      const destinationEventIds = historyEventIds(destination, 'history-copy')
        .map(event => event.event_id);
      assert.equal(destinationEventIds.length, 3);
      assert.equal(destinationEventIds.some(eventId => sourceEventIds.includes(eventId)), false);
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
