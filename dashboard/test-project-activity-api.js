'use strict';

/**
 * T-529 (ADR-0044): HTTP contract of the derived project activity.
 *
 *   - GET /api/projects carries `activity` on every project
 *   - a live claim, a session binding and a legacy agent-wide binding each
 *     make a project active; an old binding and an archived project do not
 *   - the dashboard snapshot carries the same objects, opens the most
 *     recently active project on a fresh load, keeps an explicit view, and
 *     keeps its ETag stable while nothing changes
 *
 * Runs an isolated server (own port, temp DBs). Run: node test-project-activity-api.js
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { withIsolatedDashboard } = require('./test-support/server-harness.js');

let passed = 0;
function ok(name) {
  passed++;
  console.log(`  ✅ ${name}`);
}

async function main() {
  await withIsolatedDashboard(async ({ base, api, tempRoot }) => {
    const projectsByName = async () => {
      const res = await api('GET', '/projects');
      assert.equal(res.status, 200);
      return Object.fromEntries(res.body.projects.map(p => [p.name, p]));
    };
    const snapshot = async (query = '', headers = {}) => {
      const res = await fetch(`${base}/api/dashboard/snapshot/v1${query}`, { headers });
      const text = await res.text();
      return { status: res.status, etag: res.headers.get('etag'), body: text ? JSON.parse(text) : null };
    };

    for (const name of ['alpha', 'beta', 'gamma']) {
      const created = await api('POST', '/projects', { name });
      assert.equal(created.status, 201, `project ${name} created`);
    }

    let projects = await projectsByName();
    for (const name of ['alpha', 'beta', 'gamma']) {
      assert.deepEqual(projects[name].activity,
        { active: false, lastActivityAt: null, claims: 0, sessions: 0, agents: [] },
        `${name} starts inactive`);
    }
    ok('GET /api/projects carries an inactive activity object for idle projects');

    // Fresh load without any activity keeps the old fallback (first project).
    let snap = await snapshot();
    assert.equal(snap.status, 200);
    assert.equal(snap.body.viewedProject, 'alpha');
    ok('snapshot without activity falls back to the first project');

    // Live claim in beta.
    const task = await api('POST', '/projects/beta/tasks', { title: 'Activity probe', status: 'open' });
    assert.ok(task.status === 200 || task.status === 201, `task created (${task.status})`);
    const taskId = task.body.task?.id || task.body.id;
    const claim = await api('POST', `/projects/beta/tasks/${taskId}/claim`, { agent: 'codex' });
    assert.equal(claim.status, 200, `claim ok (${JSON.stringify(claim.body)})`);

    projects = await projectsByName();
    assert.equal(projects.beta.activity.active, true);
    assert.equal(projects.beta.activity.claims, 1);
    assert.equal(projects.beta.activity.sessions, 0);
    assert.deepEqual(projects.beta.activity.agents, ['codex']);
    assert.ok(projects.beta.activity.lastActivityAt, 'claim sets lastActivityAt');
    assert.equal(projects.alpha.activity.active, false);
    ok('a live claim makes its project active');

    snap = await snapshot();
    assert.equal(snap.body.viewedProject, 'beta');
    assert.deepEqual(snap.body.projects.find(p => p.name === 'beta').activity, projects.beta.activity);
    ok('snapshot carries the same activity and opens the active project on a fresh load');

    // Session binding in gamma (newer than the claim) → gamma is the start project.
    await new Promise(resolve => setTimeout(resolve, 20));
    const bind = await api('PUT', '/status', { project: 'gamma', agentId: 'dev-agent', sessionKey: 'agent:dev-agent:main' });
    assert.equal(bind.status, 200);
    projects = await projectsByName();
    assert.deepEqual(
      { ...projects.gamma.activity, lastActivityAt: undefined },
      { active: true, lastActivityAt: undefined, claims: 0, sessions: 1, agents: ['dev-agent'] },
    );
    ok('a fresh session binding makes its project active');

    snap = await snapshot();
    assert.equal(snap.body.viewedProject, 'gamma');
    ok('the most recently active project wins on a fresh load');

    snap = await snapshot('?project=alpha');
    assert.equal(snap.body.viewedProject, 'alpha');
    ok('an explicit view is kept even when other projects are active');

    // ETag stays stable while nothing changes.
    const first = await snapshot('?project=alpha');
    const second = await snapshot('?project=alpha', { 'If-None-Match': first.etag });
    assert.equal(second.status, 304, 'unchanged snapshot answers 304');
    ok('snapshot ETag is stable between polls without changes');

    // Age the session binding beyond the 30-minute window.
    const metaDb = new DatabaseSync(path.join(tempRoot, 'flowboard-cache.db'));
    try {
      const old = new Date(Date.now() - 31 * 60 * 1000).toISOString();
      const changed = metaDb.prepare('UPDATE flowboard_session_projects SET last_seen = ? WHERE agent_id = ?')
        .run(old, 'dev-agent').changes;
      assert.equal(changed, 1, 'session row backdated');
    } finally {
      metaDb.close();
    }
    projects = await projectsByName();
    assert.equal(projects.gamma.activity.active, false);
    ok('a session binding older than the window is not active');

    const afterAgeing = await snapshot('?project=alpha', { 'If-None-Match': first.etag });
    assert.equal(afterAgeing.status, 200, 'the activity transition changes the snapshot');
    assert.notEqual(afterAgeing.etag, first.etag);
    ok('an activity transition gets a new snapshot ETag');

    // Legacy agent-wide binding.
    await api('PUT', '/status', { project: 'alpha', agentId: 'legacy-agent' });
    projects = await projectsByName();
    assert.equal(projects.alpha.activity.active, true);
    assert.equal(projects.alpha.activity.sessions, 1);
    assert.deepEqual(projects.alpha.activity.agents, ['legacy-agent']);
    ok('a recently seen agent-wide (legacy) binding makes its project active');

    // Archived projects are never active, even with a live claim.
    const archive = await api('PUT', '/projects/beta', { archived: true });
    assert.equal(archive.status, 200, `archive ok (${JSON.stringify(archive.body)})`);
    projects = await projectsByName();
    assert.equal(projects.beta.activity.active, false);
    ok('an archived project is never active');
  }, { prefix: 'flowboard-t529-activity-' });

  console.log(`\n✅ project-activity API tests passed (${passed})`);
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
