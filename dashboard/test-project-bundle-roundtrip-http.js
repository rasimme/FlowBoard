'use strict';

// T-468-6 — real two-server HTTP round trip.  The source and destination
// harnesses deliberately have separate ports, workspaces, projects roots and
// HZL databases so this proves transport and isolation, not just importer
// wiring inside one process.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('libsql');
const { withIsolatedDashboard } = require('./test-support/server-harness.js');
const {
  canonicalJson,
  toPortableCanvas,
  toPortableOverview,
  toPortableTask,
} = require('./project-bundle-schema.js');
const { validateBundle } = require('./project-bundle-validator.js');

const SOURCE = 'portable-http-source';
const UNRELATED = 'portable-http-unrelated';
const TARGET = 'portable-http-copy';
const SOURCE_AGENT = 'bundle-roundtrip-fast';
const FAKE_SECRET = 'ghp_fake_source_global_secret_1234567890';
const FAKE_RUNTIME = 'source-runtime-agent-field';

async function bundleRequest(ctx, endpoint, bundle) {
  const response = await fetch(`${ctx.base}/api/projects/import/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/vnd.flowboard.project+json' },
    body: JSON.stringify(bundle),
  });
  return {
    status: response.status,
    body: await response.json().catch(() => null),
  };
}

function taskIds(dbPath, project) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT task_id FROM tasks_current WHERE project = ? ORDER BY task_id')
      .all(project).map((row) => row.task_id);
  } finally {
    db.close();
  }
}

function portableTasks(tasks) {
  return tasks.map((task) => toPortableTask(task)).sort((a, b) => a.id.localeCompare(b.id));
}

function portableProject(project) {
  // Import creates a fresh project record, so createdAt/updatedAt are
  // intentionally new runtime timestamps.  These are the portable metadata
  // fields whose parity is part of the bundle contract.
  return {
    slug: project.name,
    displayName: project.displayName,
    description: project.description,
    group: project.group,
    taskDiscipline: project.taskDiscipline,
    github: project.github,
  };
}

async function createSourceFixture(ctx) {
  for (const [name, displayName, description] of [
    [SOURCE, 'Portable HTTP Prüfung 🚀', 'Unicode source project metadata.'],
    [UNRELATED, 'Unrelated Project', 'Must never cross the project boundary.'],
  ]) {
    const created = await ctx.api('POST', '/projects', {
      name, displayName, description, group: 'portable-review', taskDiscipline: 'development',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
  }
  const github = await ctx.api('PUT', `/projects/${SOURCE}/github`, {
    repo: 'example/portable-http', branch: 'main',
  });
  assert.equal(github.status, 200, JSON.stringify(github.body));

  const context = await ctx.api('PUT', `/projects/${SOURCE}/files/context/PORTABLE.md`, {
    content: 'Kontext mit Unicode: Prüfung ✓ — safe to review.\n',
  });
  assert.equal(context.status, 200, JSON.stringify(context.body));

  // These are intentionally outside the portable knowledge allow-list.  Their
  // values prove the export never serializes global/runtime state accidentally.
  const sourceDir = path.join(ctx.projectsDir, SOURCE);
  fs.writeFileSync(path.join(sourceDir, 'AGENTS.md'), `agent: ${FAKE_RUNTIME}\nsecret: ${FAKE_SECRET}\n`);
  fs.writeFileSync(path.join(sourceDir, 'runtime.json'), JSON.stringify({ agent: FAKE_RUNTIME, secret: FAKE_SECRET }));
  fs.writeFileSync(path.join(sourceDir, 'flowboard.db-wal'), `/tmp/source-host/${FAKE_RUNTIME}\n`);
  fs.writeFileSync(path.join(sourceDir, 'host-path.txt'), ctx.tempRoot);

  const parentResponse = await ctx.api('POST', `/projects/${SOURCE}/tasks`, {
    title: 'Übergeordnete Prüfung 🚀',
    description: 'Parent task with Unicode and portable hierarchy.',
    priority: 'high',
    status: 'open',
    workState: 'waiting',
    workStateDetails: {
      reason: 'Waiting for review', waitingFor: 'operator', responsible: 'review-role',
      checkAgainAt: '2026-08-27T10:00:00.000Z',
    },
    spec: '# Portable HTTP review\n\n## Done When\n- [ ] Round trip is verified\n',
  });
  assert.equal(parentResponse.status, 200, JSON.stringify(parentResponse.body));
  const parentId = parentResponse.body.task.id;

  const childResponse = await ctx.api('POST', `/projects/${SOURCE}/tasks`, {
    title: 'Unteraufgabe ✓', description: 'Child keeps the parent relationship.',
    parentId, status: 'done', workState: 'working',
  });
  assert.equal(childResponse.status, 200, JSON.stringify(childResponse.body));

  const mediumResponse = await ctx.api('POST', `/projects/${SOURCE}/tasks`, {
    title: 'Mittlere Priorität', description: 'Review task with blocked work state.',
    priority: 'medium', status: 'review', workState: 'blocked',
    workStateDetails: { reason: 'Needs a decision', responsible: 'operator' },
  });
  assert.equal(mediumResponse.status, 200, JSON.stringify(mediumResponse.body));

  const lowResponse = await ctx.api('POST', `/projects/${SOURCE}/tasks`, {
    title: 'Niedrige Priorität', description: 'Paused low-priority task.',
    priority: 'low', status: 'backlog', workState: 'paused',
  });
  assert.equal(lowResponse.status, 200, JSON.stringify(lowResponse.body));

  const claimedResponse = await ctx.api('POST', `/projects/${SOURCE}/tasks`, {
    title: 'Claimed route state', description: 'Runtime ownership must not travel.',
    priority: 'medium', status: 'open', workState: 'working',
  });
  assert.equal(claimedResponse.status, 200, JSON.stringify(claimedResponse.body));
  const claimedId = claimedResponse.body.task.id;
  const routed = await ctx.api('POST', `/projects/${SOURCE}/tasks/${claimedId}/route`, { agent: SOURCE_AGENT });
  assert.equal(routed.status, 200, JSON.stringify(routed.body));
  const claimed = await ctx.api('POST', `/projects/${SOURCE}/tasks/${claimedId}/claim`, { agent: SOURCE_AGENT, lease: 60 });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));

  const unrelatedTask = await ctx.api('POST', `/projects/${UNRELATED}/tasks`, {
    title: 'Unrelated secret task', description: `Do not export ${FAKE_SECRET}.`, status: 'done',
  });
  assert.equal(unrelatedTask.status, 200, JSON.stringify(unrelatedTask.body));

  const noteA = await ctx.api('POST', `/projects/${SOURCE}/canvas/notes`, {
    text: 'Canvas Start – Prüfung', x: 12, y: 24, color: 'yellow', size: 'small',
  });
  const noteB = await ctx.api('POST', `/projects/${SOURCE}/canvas/notes`, {
    text: 'Canvas Ziel ✓', x: 240, y: 24, color: 'blue', size: 'medium',
  });
  assert.equal(noteA.status, 200, JSON.stringify(noteA.body));
  assert.equal(noteB.status, 200, JSON.stringify(noteB.body));
  const connection = await ctx.api('POST', `/projects/${SOURCE}/canvas/connections`, {
    from: noteA.body.note.id, to: noteB.body.note.id, fromPort: 'right', toPort: 'left',
  });
  assert.equal(connection.status, 200, JSON.stringify(connection.body));

  const overview = await ctx.api('PUT', `/projects/${SOURCE}/overview`, {
    version: 1, layout: 'grid',
    widgets: [
      { id: 'w-tasks', type: 'task-stats', title: 'Aufgaben', grid: { x: 0, y: 0, w: 6, h: 2 } },
      { id: 'w-notes', type: 'notes', title: 'Notizen', grid: { x: 6, y: 0, w: 6, h: 2 } },
    ],
  });
  assert.equal(overview.status, 200, JSON.stringify(overview.body));
}

async function main() {
  await withIsolatedDashboard(async (source) => {
    await createSourceFixture(source);
    const sourceTasks = await source.api('GET', `/projects/${SOURCE}/tasks?includeArchived=true`);
    const sourceProjectList = await source.api('GET', '/projects');
    const sourceProject = sourceProjectList.body.projects.find((project) => project.name === SOURCE);
    const sourceCanvas = await source.api('GET', `/projects/${SOURCE}/canvas`);
    const sourceOverview = await source.api('GET', `/projects/${SOURCE}/overview`);
    assert.equal(sourceTasks.status, 200);
    assert.ok(sourceProject);
    assert.equal(sourceCanvas.status, 200);
    assert.equal(sourceOverview.status, 200);

    const exported = await source.api('GET', `/projects/${SOURCE}/export`);
    assert.equal(exported.status, 200, JSON.stringify(exported.body));
    const bundle = exported.body;
    const valid = validateBundle(bundle);
    assert.equal(valid.ok, true, JSON.stringify(valid.errors));
    assert.equal(bundle.project.slug, SOURCE);
    assert.equal(bundle.tasks.length, 5);
    assert.ok(bundle.tasks.some((task) => task.title.includes('Übergeordnete')));
    assert.ok(bundle.tasks.some((task) => task.parentId));
    assert.ok(bundle.specs.some((spec) => spec.taskId === bundle.tasks.find((task) => task.title.includes('Übergeordnete')).id));
    assert.ok(bundle.files.some((file) => file.path === 'context/PORTABLE.md'));
    assert.equal(bundle.canvas.connections.length, 1);
    assert.equal(bundle.overview.widgets.length, 2);

    const serialized = JSON.stringify(bundle);
    const sourceInternalIds = taskIds(source.cacheDbPath, SOURCE);
    assert.equal(sourceInternalIds.length, sourceTasks.body.tasks.length);
    for (const id of sourceInternalIds) assert.equal(serialized.includes(id), false, `internal ULID leaked: ${id}`);
    for (const forbidden of [
      'Unrelated secret task', FAKE_SECRET, FAKE_RUNTIME, 'AGENTS.md', 'runtime.json',
      'flowboard.db-wal', source.tempRoot,
    ]) assert.equal(serialized.includes(forbidden), false, `forbidden source text leaked: ${forbidden}`);
    for (const forbiddenKey of ['"agent":', '"leaseUntil":', '"claimedAt":', '"routedAgent":', '"runtime":']) {
      assert.equal(serialized.includes(forbiddenKey), false, `runtime field leaked: ${forbiddenKey}`);
    }

    // A nested harness gives the destination a genuinely different HTTP
    // origin and database while the source server remains alive.
    await withIsolatedDashboard(async (destination) => {
      const unrelatedProject = await destination.api('POST', '/projects', {
        name: 'destination-unrelated', displayName: 'Destination Unrelated', description: 'Must remain unchanged.',
      });
      assert.equal(unrelatedProject.status, 201, JSON.stringify(unrelatedProject.body));
      const unrelatedTask = await destination.api('POST', '/projects/destination-unrelated/tasks', {
        title: 'Destination-only task', description: 'Keep this state.', priority: 'low', status: 'open',
      });
      assert.equal(unrelatedTask.status, 200, JSON.stringify(unrelatedTask.body));
      const beforeUnrelated = {
        projects: (await destination.api('GET', '/projects')).body.projects
          .filter((project) => project.name === 'destination-unrelated'),
        tasks: (await destination.api('GET', '/projects/destination-unrelated/tasks?includeArchived=true')).body.tasks,
      };

      const preview = await bundleRequest(destination, `preview?targetName=${TARGET}`, bundle);
      assert.equal(preview.status, 200, JSON.stringify(preview.body));
      assert.equal(preview.body.canImport, true);
      assert.equal(preview.body.target.name, TARGET);
      assert.equal(preview.body.counts.tasks, bundle.tasks.length);

      const imported = await bundleRequest(destination, `?targetName=${TARGET}`, bundle);
      assert.equal(imported.status, 201, JSON.stringify(imported.body));
      assert.equal(imported.body.state, 'committed');
      assert.equal(imported.body.counts.tasks, bundle.tasks.length);

      const destinationProjects = await destination.api('GET', '/projects');
      const destinationProject = destinationProjects.body.projects.find((project) => project.name === TARGET);
      assert.ok(destinationProject);
      const expectedProject = {
        slug: TARGET,
        displayName: bundle.project.displayName,
        description: bundle.project.description,
        group: bundle.project.group,
        taskDiscipline: bundle.project.taskDiscipline,
        github: bundle.project.github,
      };
      assert.deepEqual(
        portableProject(destinationProject),
        expectedProject,
        'portable project metadata survives import (with the requested target slug)',
      );

      const destinationTasks = await destination.api('GET', `/projects/${TARGET}/tasks?includeArchived=true`);
      assert.equal(destinationTasks.status, 200, JSON.stringify(destinationTasks.body));
      assert.deepEqual(portableTasks(destinationTasks.body.tasks), bundle.tasks.slice().sort((a, b) => a.id.localeCompare(b.id)));
      const importedChild = destinationTasks.body.tasks.find((task) => task.parentId);
      assert.equal(importedChild.parentId, bundle.tasks.find((task) => task.parentId).parentId);
      for (const task of destinationTasks.body.tasks) {
        assert.equal(task.agent, null);
        assert.equal(task.claimedAt, null);
        assert.equal(task.leaseUntil, null);
        assert.equal(task.routedAgent, null);
        assert.equal(task.checkpointCount, 0);
        assert.equal(task.stuckIndicator, null);
      }
      const destinationAgents = await destination.api('GET', '/agents');
      assert.equal(destinationAgents.status, 200, JSON.stringify(destinationAgents.body));
      assert.equal(
        destinationAgents.body.agents.some((agent) => agent.id === SOURCE_AGENT && agent.active_project === TARGET),
        false,
        'source agent activation is not imported',
      );

      const destinationInternalIds = taskIds(destination.cacheDbPath, TARGET);
      assert.deepEqual(destinationInternalIds.sort(), destinationInternalIds.slice().sort());
      assert.equal(destinationInternalIds.length, sourceInternalIds.length);
      assert.ok(destinationInternalIds.every((id) => !sourceInternalIds.includes(id)), 'destination must use fresh HZL ids');
      assert.ok(destinationInternalIds.every((id) => /^[0-9A-Z]{26}$/.test(id)), 'destination ids are internal ULIDs');

      const destinationCanvas = await destination.api('GET', `/projects/${TARGET}/canvas`);
      assert.equal(destinationCanvas.status, 200);
      assert.equal(canonicalJson(toPortableCanvas(destinationCanvas.body)), canonicalJson(bundle.canvas));
      const destinationOverview = await destination.api('GET', `/projects/${TARGET}/overview`);
      assert.equal(destinationOverview.status, 200);
      assert.equal(canonicalJson(toPortableOverview(destinationOverview.body.overview)), canonicalJson(bundle.overview));

      for (const file of bundle.files) {
        const response = await destination.api('GET', `/projects/${TARGET}/files/${file.path}?includeHidden=true`);
        assert.equal(response.status, 200, `${file.path}: ${JSON.stringify(response.body)}`);
        assert.equal(response.body.content, file.content);
      }
      for (const spec of bundle.specs) {
        const response = await destination.api('GET', `/projects/${TARGET}/files/${spec.path}?includeHidden=true`);
        assert.equal(response.status, 200, `${spec.path}: ${JSON.stringify(response.body)}`);
        assert.equal(response.body.content, spec.content);
      }

      const conflict = await bundleRequest(destination, `?targetName=${TARGET}`, bundle);
      assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
      assert.equal(conflict.body.code, 'IMPORT_TARGET_CONFLICT');
      const afterUnrelated = {
        projects: (await destination.api('GET', '/projects')).body.projects
          .filter((project) => project.name === 'destination-unrelated'),
        tasks: (await destination.api('GET', '/projects/destination-unrelated/tasks?includeArchived=true')).body.tasks,
      };
      assert.deepEqual(afterUnrelated, beforeUnrelated, 'conflicting import leaves unrelated destination state untouched');
    }, { prefix: 'flowboard-t468-roundtrip-destination-' });
  }, { prefix: 'flowboard-t468-roundtrip-source-' });
  console.log('T-468-6 project bundle HTTP roundtrip test passed');
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
