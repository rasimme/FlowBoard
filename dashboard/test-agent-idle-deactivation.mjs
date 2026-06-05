/**
 * T-231: unit tests for the pure idle-expiry decision used to auto-deactivate
 * stale agent activations. No DB / no server — exercises isAgentIdleExpired
 * across TTL boundary, lease protection, and the null guards.
 * Run: node test-agent-idle-deactivation.mjs
 */
import meta from './flowboard-metadata.js';

const { isAgentIdleExpired } = meta;

let passed = 0;
let failed = 0;
function check(cond, msg) {
  if (cond) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); }
}

const HOUR = 3600 * 1000;
const NOW = Date.parse('2026-06-05T12:00:00.000Z');
const TTL = 48;
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

// helper to build a row
const row = (over = {}) => ({ agent_id: 'a', active_project: 'flowboard', last_seen: iso(0), ...over });

check(typeof isAgentIdleExpired === 'function', 'isAgentIdleExpired is exported');

// fresh heartbeat → not expired
check(
  isAgentIdleExpired(row({ last_seen: iso(1 * HOUR) }), { nowMs: NOW, ttlHours: TTL, claimCount: 0 }) === false,
  'recent heartbeat (1h) is not expired',
);

// past TTL, no claims → expired
check(
  isAgentIdleExpired(row({ last_seen: iso(49 * HOUR) }), { nowMs: NOW, ttlHours: TTL, claimCount: 0 }) === true,
  'idle 49h with no claims is expired',
);

// past TTL but holds a claim → lease protection, NOT expired
check(
  isAgentIdleExpired(row({ last_seen: iso(100 * HOUR) }), { nowMs: NOW, ttlHours: TTL, claimCount: 2 }) === false,
  'lease protection: active claim is never auto-deactivated',
);

// no active project → nothing to clear
check(
  isAgentIdleExpired(row({ active_project: null, last_seen: iso(100 * HOUR) }), { nowMs: NOW, ttlHours: TTL, claimCount: 0 }) === false,
  'no active project → not eligible',
);

// null/missing last_seen → defensive, never expire blindly
check(
  isAgentIdleExpired(row({ last_seen: null }), { nowMs: NOW, ttlHours: TTL, claimCount: 0 }) === false,
  'null last_seen → not eligible (defensive)',
);

// TTL boundary: just under (47h59m) not expired, just over (48h01m) expired
check(
  isAgentIdleExpired(row({ last_seen: iso(48 * HOUR - 60 * 1000) }), { nowMs: NOW, ttlHours: TTL, claimCount: 0 }) === false,
  'just under TTL is not expired',
);
check(
  isAgentIdleExpired(row({ last_seen: iso(48 * HOUR + 60 * 1000) }), { nowMs: NOW, ttlHours: TTL, claimCount: 0 }) === true,
  'just over TTL is expired',
);

// ---------------------------------------------------------------------------
// DB-glue tests against an in-memory node:sqlite DB (built-in, no dependency).
// Validates the SQL in touch/clear/setActive against real SQLite; production
// uses better-sqlite3 via hzl-core, but the statements are standard SQLite.
// ---------------------------------------------------------------------------
import { DatabaseSync } from 'node:sqlite';
{
  const db = new DatabaseSync(':memory:');
  meta.init(db);

  const hasCol = db.prepare("SELECT COUNT(*) AS c FROM pragma_table_info('flowboard_agents') WHERE name='last_seen'").get().c;
  check(hasCol > 0, 'flowboard_agents schema includes last_seen');

  meta.touchAgentLastSeen('probe');
  let row = meta.getAgentRow('probe');
  check(row && row.active_project === null && !!row.last_seen, 'touchAgentLastSeen creates row with last_seen, no project');

  meta.setAgentActiveProject('probe', 'flowboard');
  row = meta.getAgentRow('probe');
  check(row && row.active_project === 'flowboard' && !!row.last_seen, 'setAgentActiveProject sets project + last_seen');

  // make it stale, confirm the decision fires and clear works + keeps the row
  db.prepare('UPDATE flowboard_agents SET last_seen = ? WHERE agent_id = ?').run(new Date(Date.now() - 100 * HOUR).toISOString(), 'probe');
  row = meta.getAgentRow('probe');
  check(meta.isAgentIdleExpired(row, { nowMs: Date.now(), ttlHours: 48, claimCount: 0 }) === true, 'stale row (100h) is expired');
  check(meta.clearAgentActiveProject('probe') === true, 'clearAgentActiveProject reports a change');
  row = meta.getAgentRow('probe');
  check(row && row.active_project === null && !!row.last_seen, 'cleared row keeps row + last_seen, active_project null');
  check(meta.clearAgentActiveProject('probe') === false, 'clearing an already-cleared agent is a no-op');

  // fresh heartbeat un-stales
  meta.setAgentActiveProject('probe', 'flowboard');
  meta.touchAgentLastSeen('probe');
  row = meta.getAgentRow('probe');
  check(meta.isAgentIdleExpired(row, { nowMs: Date.now(), ttlHours: 48, claimCount: 0 }) === false, 'fresh heartbeat un-expires the agent');

  db.close();
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
