'use strict';

/**
 * T-487-2 — session-scoped project binding (ADR-0039).
 *
 * Today the active project is bound per `agent_id` only, so two OpenClaw
 * sessions of the same agent overwrite one global context. This suite pins the
 * backward-compatible session layer:
 *
 *   1. schema/CRUD on `flowboard_session_projects` (in-memory node:sqlite)
 *   2. resolution matrix session > agent > null
 *   3. `sessionKey` validation (context, never authorization)
 *   4. idle expiry of session rows (deleted, not nulled — ADR-0020 TTL)
 *   5. migration m012 on a pre-existing DB
 *   6. HTTP contract of GET/PUT /api/status and GET /api/agents
 *
 * Run: node test-session-project-binding.js
 */

const { DatabaseSync } = require('node:sqlite');
const fbMeta = require('./flowboard-metadata.js');
const migrationRegistry = require('./migrations.js');
const { withIsolatedDashboard } = require('./test-support/server-harness.js');

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; failures.push(msg); console.error(`  ❌ ${msg}`); }
}

function assertEqual(actual, expected, msg) {
  const ok = actual === expected;
  assert(ok, ok ? msg : `${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function section(name) { console.log(`\n## ${name}`); }

const HOUR = 3600 * 1000;
const SESSION_MAIN = 'agent:claude-code:main';
const SESSION_TG = 'agent:claude-code:telegram:4711';

function freshDb() {
  const db = new DatabaseSync(':memory:');
  fbMeta.init(db);
  return db;
}

// ---------------------------------------------------------------------------
section('schema — flowboard_session_projects');
// ---------------------------------------------------------------------------
{
  const db = freshDb();
  const cols = db.prepare("SELECT * FROM pragma_table_info('flowboard_session_projects')").all();
  const byName = Object.fromEntries(cols.map(c => [c.name, { notNull: c.notnull, pk: c.pk }]));

  assert(cols.length === 5, `table has 5 columns (got ${cols.length})`);
  for (const name of ['agent_id', 'session_key', 'active_project', 'activated_at', 'last_seen']) {
    assert(!!byName[name], `column ${name} exists`);
  }
  assert(byName.agent_id?.notNull === 1, 'agent_id is NOT NULL');
  assert(byName.session_key?.notNull === 1, 'session_key is NOT NULL');
  assert(byName.activated_at?.notNull === 1, 'activated_at is NOT NULL');
  assert(byName.last_seen?.notNull === 1, 'last_seen is NOT NULL');
  assert(byName.active_project?.notNull === 0, 'active_project is nullable');
  assert(byName.agent_id?.pk === 1 && byName.session_key?.pk === 2, 'PRIMARY KEY (agent_id, session_key)');

  // flowboard_agents must be untouched by this feature
  const agentCols = db.prepare("SELECT name FROM pragma_table_info('flowboard_agents')").all().map(c => c.name);
  assertEqual(agentCols.join(','), 'agent_id,active_project,activated_at,last_seen', 'flowboard_agents schema unchanged');

  db.close();
}

// ---------------------------------------------------------------------------
section('CRUD — session rows are per (agent, session)');
// ---------------------------------------------------------------------------
{
  const db = freshDb();

  assertEqual(fbMeta.getSessionProjectRow('claude-code', SESSION_MAIN), null, 'unknown session has no row');

  fbMeta.setSessionActiveProject('claude-code', SESSION_MAIN, 'flowboard');
  const row = fbMeta.getSessionProjectRow('claude-code', SESSION_MAIN);
  assertEqual(row?.active_project, 'flowboard', 'setSessionActiveProject stores the project');
  assert(!!row?.activated_at && !!row?.last_seen, 'session row carries activated_at + last_seen');

  // second session of the SAME agent is independent (the T-487-2 defect)
  fbMeta.setSessionActiveProject('claude-code', SESSION_TG, 'creon');
  assertEqual(fbMeta.getSessionProjectRow('claude-code', SESSION_MAIN)?.active_project, 'flowboard',
    'a second session does not overwrite the first');
  assertEqual(fbMeta.getSessionProjectRow('claude-code', SESSION_TG)?.active_project, 'creon',
    'the second session keeps its own project');

  // upsert on the same key
  fbMeta.setSessionActiveProject('claude-code', SESSION_MAIN, 'creon');
  assertEqual(fbMeta.getSessionProjectRow('claude-code', SESSION_MAIN)?.active_project, 'creon',
    're-activating the same session upserts in place');
  assertEqual(fbMeta.listSessionBindings('claude-code').length, 2, 'still exactly two rows for the agent');

  // same session key under a different agent is a different row
  fbMeta.setSessionActiveProject('codex', SESSION_MAIN, 'flowboard');
  assertEqual(fbMeta.listSessionBindings('codex').length, 1, 'session keys are scoped per agent');

  // delete
  assertEqual(fbMeta.deleteSessionProjectRow('claude-code', SESSION_TG), true, 'deleteSessionProjectRow reports a change');
  assertEqual(fbMeta.deleteSessionProjectRow('claude-code', SESSION_TG), false, 'deleting twice is a no-op');
  assertEqual(fbMeta.getSessionProjectRow('claude-code', SESSION_TG), null, 'deleted session row is gone');

  // touch only refreshes an existing row — GET must not lazy-create sessions
  assertEqual(fbMeta.touchSessionLastSeen('claude-code', 'agent:claude-code:never-seen'), false,
    'touchSessionLastSeen does not create a row');
  assertEqual(fbMeta.getSessionProjectRow('claude-code', 'agent:claude-code:never-seen'), null,
    'no row created by a touch');
  db.prepare('UPDATE flowboard_session_projects SET last_seen = ? WHERE agent_id = ? AND session_key = ?')
    .run(new Date(Date.now() - 10 * HOUR).toISOString(), 'claude-code', SESSION_MAIN);
  const before = fbMeta.getSessionProjectRow('claude-code', SESSION_MAIN).last_seen;
  assertEqual(fbMeta.touchSessionLastSeen('claude-code', SESSION_MAIN), true, 'touchSessionLastSeen refreshes an existing row');
  assert(fbMeta.getSessionProjectRow('claude-code', SESSION_MAIN).last_seen > before, 'last_seen moved forward');

  db.close();
}

// ---------------------------------------------------------------------------
section('resolution matrix — session > agent > null');
// ---------------------------------------------------------------------------
{
  const db = freshDb();

  let resolved = fbMeta.resolveActiveProject('claude-code', SESSION_MAIN);
  assertEqual(resolved.activeProject, null, 'no rows at all → activeProject null');
  assertEqual(resolved.binding, null, 'no rows at all → binding null');

  fbMeta.setAgentActiveProject('claude-code', 'flowboard');
  resolved = fbMeta.resolveActiveProject('claude-code', SESSION_MAIN);
  assertEqual(resolved.activeProject, 'flowboard', 'agent row answers when no session row exists');
  assertEqual(resolved.binding, 'agent', 'agent row reports binding "agent"');

  fbMeta.setSessionActiveProject('claude-code', SESSION_MAIN, 'creon');
  resolved = fbMeta.resolveActiveProject('claude-code', SESSION_MAIN);
  assertEqual(resolved.activeProject, 'creon', 'session row wins over the agent row');
  assertEqual(resolved.binding, 'session', 'session row reports binding "session"');

  resolved = fbMeta.resolveActiveProject('claude-code', SESSION_TG);
  assertEqual(resolved.activeProject, 'flowboard', 'a sibling session still falls back to the agent row');
  assertEqual(resolved.binding, 'agent', 'sibling session reports binding "agent"');

  resolved = fbMeta.resolveActiveProject('claude-code', null);
  assertEqual(resolved.activeProject, 'flowboard', 'no sessionKey → agent row (today\'s behaviour)');
  assertEqual(resolved.binding, 'agent', 'no sessionKey → binding "agent"');

  // deleting the session row falls back to the agent-level binding
  fbMeta.deleteSessionProjectRow('claude-code', SESSION_MAIN);
  resolved = fbMeta.resolveActiveProject('claude-code', SESSION_MAIN);
  assertEqual(resolved.activeProject, 'flowboard', 'deleting the session row falls back to the agent binding');
  assertEqual(resolved.binding, 'agent', 'fallback reports binding "agent"');

  // agent row cleared but session row present
  fbMeta.setSessionActiveProject('codex', SESSION_TG, 'flowboard');
  resolved = fbMeta.resolveActiveProject('codex', SESSION_TG);
  assertEqual(resolved.activeProject, 'flowboard', 'session row answers without any agent row');
  assertEqual(resolved.binding, 'session', 'session-only binding reports "session"');
  assertEqual(fbMeta.resolveActiveProject('codex', null).activeProject, null,
    'a session binding never leaks into the agent-level answer');

  db.close();
}

// ---------------------------------------------------------------------------
section('sessionKey validation — context, never authorization');
// ---------------------------------------------------------------------------
{
  assertEqual(fbMeta.validateSessionKey('agent:main:main').ok, true, 'plain OpenClaw session key accepted');
  assertEqual(fbMeta.validateSessionKey('agent:main:telegram:4711').ok, true, 'telegram session key accepted');
  assertEqual(fbMeta.validateSessionKey('  agent:main:main  ').key, 'agent:main:main', 'session key is trimmed');
  assertEqual(fbMeta.validateSessionKey('a'.repeat(256)).ok, true, '256-char key accepted');
  assertEqual(fbMeta.validateSessionKey('a'.repeat(257)).ok, false, '257-char key rejected');
  assertEqual(fbMeta.validateSessionKey('').ok, false, 'empty key rejected');
  assertEqual(fbMeta.validateSessionKey('   ').ok, false, 'whitespace-only key rejected');
  assertEqual(fbMeta.validateSessionKey(null).ok, false, 'null rejected');
  assertEqual(fbMeta.validateSessionKey(42).ok, false, 'non-string rejected');
  assertEqual(fbMeta.validateSessionKey(['a', 'b']).ok, false, 'array (repeated query param) rejected');
  assertEqual(fbMeta.validateSessionKey('agent:main:ma\nin').ok, false, 'newline rejected');
  assertEqual(fbMeta.validateSessionKey('agent:main:ma\u0000in').ok, false, 'NUL byte rejected');
  assertEqual(fbMeta.validateSessionKey('agent:main:ma\u007Fin').ok, false, 'DEL rejected');
  assert(!!fbMeta.validateSessionKey('').error, 'rejection carries an error message');
}

// ---------------------------------------------------------------------------
section('idle expiry — session rows are deleted, not nulled (ADR-0020 TTL)');
// ---------------------------------------------------------------------------
{
  const NOW = Date.parse('2026-09-20T12:00:00.000Z');
  const TTL = 48;
  const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
  const row = (over = {}) => ({ agent_id: 'claude-code', session_key: SESSION_MAIN, active_project: 'flowboard', last_seen: iso(0), ...over });

  assertEqual(fbMeta.isSessionBindingExpired(row({ last_seen: iso(1 * HOUR) }), { nowMs: NOW, ttlHours: TTL, claimCount: 0 }), false,
    'recent session heartbeat (1h) is not expired');
  assertEqual(fbMeta.isSessionBindingExpired(row({ last_seen: iso(49 * HOUR) }), { nowMs: NOW, ttlHours: TTL, claimCount: 0 }), true,
    'session idle 49h with no claims is expired');
  assertEqual(fbMeta.isSessionBindingExpired(row({ last_seen: iso(100 * HOUR) }), { nowMs: NOW, ttlHours: TTL, claimCount: 2 }), false,
    'lease protection applies to session rows too');
  assertEqual(fbMeta.isSessionBindingExpired(row({ last_seen: iso(48 * HOUR - 60 * 1000) }), { nowMs: NOW, ttlHours: TTL, claimCount: 0 }), false,
    'just under TTL is not expired');
  assertEqual(fbMeta.isSessionBindingExpired(row({ last_seen: iso(48 * HOUR + 60 * 1000) }), { nowMs: NOW, ttlHours: TTL, claimCount: 0 }), true,
    'just over TTL is expired');
  assertEqual(fbMeta.isSessionBindingExpired(row({ last_seen: null }), { nowMs: NOW, ttlHours: TTL, claimCount: 0 }), false,
    'null last_seen → not eligible (defensive)');
  assertEqual(fbMeta.isSessionBindingExpired(null, { nowMs: NOW, ttlHours: TTL, claimCount: 0 }), false,
    'missing row → not eligible');

  // TTL is the ADR-0020 agent TTL — one knob, not two
  assertEqual(typeof fbMeta.AGENT_IDLE_TTL_HOURS, 'number', 'session expiry reuses AGENT_IDLE_TTL_HOURS');
}

// ---------------------------------------------------------------------------
section('expiry sweep — deleting expired rows restores the agent fallback');
// ---------------------------------------------------------------------------
{
  const db = freshDb();
  fbMeta.setAgentActiveProject('claude-code', 'flowboard');
  fbMeta.setSessionActiveProject('claude-code', SESSION_MAIN, 'creon');
  db.prepare('UPDATE flowboard_session_projects SET last_seen = ? WHERE agent_id = ?')
    .run(new Date(Date.now() - 100 * HOUR).toISOString(), 'claude-code');

  const expired = fbMeta.listSessionBindings('claude-code')
    .filter(r => fbMeta.isSessionBindingExpired(r, { nowMs: Date.now(), ttlHours: 48, claimCount: 0 }));
  assertEqual(expired.length, 1, 'the stale session row is detected as expired');
  assertEqual(fbMeta.deleteSessionProjectRow('claude-code', SESSION_MAIN), true, 'expired session row is deleted');

  const resolved = fbMeta.resolveActiveProject('claude-code', SESSION_MAIN);
  assertEqual(resolved.activeProject, 'flowboard', 'after expiry the agent-level binding answers again');
  assertEqual(resolved.binding, 'agent', 'after expiry the binding is "agent" (not nulled)');
  db.close();
}

// ---------------------------------------------------------------------------
section('cascade — agent delete and project hard-delete clear session rows');
// ---------------------------------------------------------------------------
{
  const db = freshDb();
  fbMeta.setSessionActiveProject('claude-code', SESSION_MAIN, 'flowboard');
  fbMeta.setSessionActiveProject('claude-code', SESSION_TG, 'creon');
  fbMeta.setSessionActiveProject('codex', SESSION_MAIN, 'flowboard');
  fbMeta.setAgentActiveProject('claude-code', 'flowboard');

  assertEqual(fbMeta.deleteSessionBindingsForProject('flowboard'), 2, 'project delete clears every session row for that project');
  assertEqual(fbMeta.listSessionBindings('claude-code').length, 1, 'other projects keep their session rows');

  fbMeta.deleteAgentRow('claude-code');
  assertEqual(fbMeta.listSessionBindings('claude-code').length, 0, 'deleting an agent removes its session rows');
  db.close();
}

// ---------------------------------------------------------------------------
section('migration — m012 adds the table to a pre-existing DB');
// ---------------------------------------------------------------------------
{
  const db = freshDb();
  // Production runs better-sqlite3 (via hzl-core); node:sqlite has no
  // .transaction() helper, so shim the one method runPending() needs.
  db.transaction = (fn) => (...args) => {
    db.exec('BEGIN');
    try { const out = fn(...args); db.exec('COMMIT'); return out; }
    catch (err) { db.exec('ROLLBACK'); throw err; }
  };
  // Simulate a DB created before T-487-2: every earlier migration applied,
  // the session table absent.
  db.exec('DROP TABLE flowboard_session_projects');
  const target = migrationRegistry.migrations.find(m => m.id.startsWith('m012-'));
  assert(!!target, 'registry contains an m012 migration');
  const insert = db.prepare('INSERT INTO flowboard_migrations (id, name, applied_at) VALUES (?, ?, ?)');
  for (const m of migrationRegistry.migrations) {
    if (m.id !== target.id) insert.run(m.id, m.name, new Date().toISOString());
  }

  migrationRegistry.runPending(db, { fbMeta });
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='flowboard_session_projects'").all();
  assertEqual(tables.length, 1, 'm012 creates flowboard_session_projects on a pre-existing DB');
  const applied = db.prepare('SELECT id FROM flowboard_migrations WHERE id = ?').get(target.id);
  assert(!!applied, 'm012 is recorded in the migration registry');

  // idempotent: a second run is a no-op and the data survives
  fbMeta.setSessionActiveProject('claude-code', SESSION_MAIN, 'flowboard');
  migrationRegistry.runPending(db, { fbMeta });
  assertEqual(fbMeta.getSessionProjectRow('claude-code', SESSION_MAIN)?.active_project, 'flowboard',
    're-running migrations preserves session rows');
  db.close();
}

// ---------------------------------------------------------------------------
// HTTP contract
// ---------------------------------------------------------------------------
async function httpSuite() {
  await withIsolatedDashboard(async ({ base }) => {
    const call = async (method, path, body) => {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return { status: res.status, body: json, text };
    };

    section('HTTP — setup');
    for (const name of ['alpha-project', 'beta-project']) {
      const created = await call('POST', '/api/projects', { name });
      assertEqual(created.status, 201, `project ${name} created`);
    }

    section('HTTP — GET /api/status without sessionKey (today\'s behaviour + binding)');
    {
      let got = await call('GET', '/api/status?agentId=claude-code');
      assertEqual(got.status, 200, 'status without sessionKey is 200');
      assertEqual(got.body.activeProject, null, 'unknown agent has no active project');
      assertEqual(got.body.binding, null, 'no binding for an unbound agent');
      assert(!('sessionKey' in got.body), 'sessionKey is not echoed when not supplied');

      await call('PUT', '/api/status', { project: 'alpha-project', agentId: 'claude-code' });
      got = await call('GET', '/api/status?agentId=claude-code');
      assertEqual(got.body.activeProject, 'alpha-project', 'agent-level activation is unchanged');
      assertEqual(got.body.binding, 'agent', 'agent-level activation reports binding "agent"');
    }

    section('HTTP — PUT /api/status with sessionKey binds one session only');
    {
      const put = await call('PUT', '/api/status', {
        project: 'beta-project', agentId: 'claude-code', sessionKey: SESSION_TG,
      });
      assertEqual(put.status, 200, 'session-scoped activation is 200');
      assertEqual(put.body.activeProject, 'beta-project', 'PUT echoes the session-scoped project');
      assertEqual(put.body.binding, 'session', 'PUT reports binding "session"');
      assertEqual(put.body.sessionKey, SESSION_TG, 'PUT echoes the sessionKey');

      const inSession = await call('GET', `/api/status?agentId=claude-code&sessionKey=${encodeURIComponent(SESSION_TG)}`);
      assertEqual(inSession.body.activeProject, 'beta-project', 'the bound session sees its own project');
      assertEqual(inSession.body.binding, 'session', 'the bound session reports binding "session"');
      assertEqual(inSession.body.sessionKey, SESSION_TG, 'GET echoes the sessionKey');

      const otherSession = await call('GET', `/api/status?agentId=claude-code&sessionKey=${encodeURIComponent(SESSION_MAIN)}`);
      assertEqual(otherSession.body.activeProject, 'alpha-project', 'a sibling session keeps the agent-level project');
      assertEqual(otherSession.body.binding, 'agent', 'the sibling session reports binding "agent"');

      const noSession = await call('GET', '/api/status?agentId=claude-code');
      assertEqual(noSession.body.activeProject, 'alpha-project', 'the agent-level row was not overwritten');
      assertEqual(noSession.body.binding, 'agent', 'agent-level binding still reports "agent"');
    }

    section('HTTP — display name resolution and rules pointer stay intact');
    {
      const got = await call('GET', `/api/status?agentId=claude-code&sessionKey=${encodeURIComponent(SESSION_TG)}`);
      assert(!!got.body.rules, 'session-scoped status carries the rules pointer');
      assertEqual(got.body.agentId, 'claude-code', 'agentId is echoed');
    }

    section('HTTP — PUT { project: null, sessionKey } deletes the session row');
    {
      const cleared = await call('PUT', '/api/status', {
        project: null, agentId: 'claude-code', sessionKey: SESSION_TG,
      });
      assertEqual(cleared.status, 200, 'session deactivation is 200');
      assertEqual(cleared.body.activeProject, 'alpha-project', 'deactivation falls back to the agent-level binding');
      assertEqual(cleared.body.binding, 'agent', 'deactivation reports the fallback binding');

      const got = await call('GET', `/api/status?agentId=claude-code&sessionKey=${encodeURIComponent(SESSION_TG)}`);
      assertEqual(got.body.activeProject, 'alpha-project', 'the session now resolves to the agent binding');
      assertEqual(got.body.binding, 'agent', 'the session binding is gone');

      const stillAgent = await call('GET', '/api/status?agentId=claude-code');
      assertEqual(stillAgent.body.activeProject, 'alpha-project', 'agent-level binding survived the session deactivation');
    }

    section('HTTP — sessionKey validation returns 400');
    {
      const tooLong = 'a'.repeat(257);
      const bad = [
        ['GET', `/api/status?agentId=claude-code&sessionKey=${encodeURIComponent(tooLong)}`, undefined, 'GET: 257-char key'],
        ['GET', '/api/status?agentId=claude-code&sessionKey=', undefined, 'GET: empty key'],
        ['GET', `/api/status?agentId=claude-code&sessionKey=${encodeURIComponent('a\u0000b')}`, undefined, 'GET: control character'],
        ['GET', '/api/status?agentId=claude-code&sessionKey=a&sessionKey=b', undefined, 'GET: repeated query param'],
        ['PUT', '/api/status', { project: 'alpha-project', agentId: 'claude-code', sessionKey: tooLong }, 'PUT: 257-char key'],
        ['PUT', '/api/status', { project: 'alpha-project', agentId: 'claude-code', sessionKey: '' }, 'PUT: empty key'],
        ['PUT', '/api/status', { project: 'alpha-project', agentId: 'claude-code', sessionKey: 42 }, 'PUT: non-string key'],
        ['PUT', '/api/status', { project: 'alpha-project', agentId: 'claude-code', sessionKey: 'a\u0007b' }, 'PUT: control character'],
      ];
      for (const [method, path, body, label] of bad) {
        const res = await call(method, path, body);
        assertEqual(res.status, 400, `${label} → 400`);
        assert(typeof res.body?.error === 'string' && /sessionKey/i.test(res.body.error), `${label} → error names sessionKey`);
      }

      // a rejected request must not have written anything
      const untouched = await call('GET', '/api/status?agentId=claude-code');
      assertEqual(untouched.body.activeProject, 'alpha-project', 'rejected requests leave state untouched');
    }

    section('HTTP — unknown project is still rejected in session scope');
    {
      const res = await call('PUT', '/api/status', {
        project: 'does-not-exist', agentId: 'claude-code', sessionKey: SESSION_MAIN,
      });
      assertEqual(res.status, 400, 'unknown project in session scope → 400');
      const got = await call('GET', `/api/status?agentId=claude-code&sessionKey=${encodeURIComponent(SESSION_MAIN)}`);
      assertEqual(got.body.binding, 'agent', 'no session row was created by the rejected activation');
    }

    section('HTTP — GET /api/agents exposes sessions additively');
    {
      await call('PUT', '/api/status', { project: 'beta-project', agentId: 'claude-code', sessionKey: SESSION_TG });
      await call('PUT', '/api/status', { project: 'alpha-project', agentId: 'claude-code', sessionKey: SESSION_MAIN });

      const res = await call('GET', '/api/agents');
      assertEqual(res.status, 200, 'GET /api/agents is 200');
      const agent = (res.body.agents || []).find(a => a.agent_id === 'claude-code');
      assert(!!agent, 'the agent is listed');
      assertEqual(agent.active_project, 'alpha-project', 'the legacy agent fields are unchanged');
      assert(Array.isArray(agent.sessions), 'the agent carries a sessions array');
      assertEqual(agent.sessions.length, 2, 'both session bindings are listed');
      const tg = agent.sessions.find(s => s.sessionKey === SESSION_TG);
      assert(!!tg, 'the telegram session is listed by sessionKey');
      assertEqual(tg.activeProject, 'beta-project', 'the session entry carries its own activeProject');
      assert(typeof tg.activatedAt === 'string' && typeof tg.lastSeen === 'string',
        'the session entry carries activatedAt + lastSeen');

      const other = (res.body.agents || []).find(a => a.agent_id !== 'claude-code');
      if (other) assert(Array.isArray(other.sessions), 'agents without sessions still carry an empty array');
    }

    section('HTTP — hard-deleting a project clears its session bindings');
    {
      await call('PUT', '/api/projects/beta-project', { archived: true });
      const del = await call('DELETE', '/api/projects/beta-project?confirm=beta-project&hardDelete=true');
      assertEqual(del.status, 200, 'project hard-delete accepted');

      const got = await call('GET', `/api/status?agentId=claude-code&sessionKey=${encodeURIComponent(SESSION_TG)}`);
      assertEqual(got.body.activeProject, 'alpha-project', 'the orphaned session binding fell back to the agent binding');
      assertEqual(got.body.binding, 'agent', 'the orphaned session row is gone');
    }
  }, { prefix: 'flowboard-session-binding-' });
}

httpSuite()
  .catch(err => {
    failed++;
    failures.push(`HTTP suite threw: ${err.message}`);
    console.error(`  ❌ HTTP suite threw: ${err.stack || err.message}`);
  })
  .then(() => {
    console.log(`\n=== ${passed} passed, ${failed} failed ===`);
    if (failed > 0) failures.forEach(f => console.log(`  - ${f}`));
    process.exit(failed === 0 ? 0 : 1);
  });
