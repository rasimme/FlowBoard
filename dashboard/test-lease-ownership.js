'use strict';

/**
 * T-417-13: Lease-ownership enforcement regression test.
 *
 * Pins the server-side guarantee that the ClawHub audit's #1 finding
 * ("agent field is trusted, a caller can act as another agent / bypass lease
 * ownership / falsify audit trails") does NOT hold: a caller asserting one
 * agent-id cannot mutate the lifecycle of a task that another agent currently
 * holds. Identity itself is self-asserted (trust-on-write, see
 * docs/concepts/agent-identity.md) — but LEASE OWNERSHIP of complete /
 * checkpoint / release, and stealing an actively-held claim, ARE enforced in
 * hzl-service.js. This test is the regression guard for that distinction.
 */

const hzl = require('./hzl-service.js');
const fs = require('fs');

const DB_PATH = '/tmp/hzl-lease-ownership-test.db';
const CACHE_PATH = DB_PATH.replace(/\.db$/, '-cache.db');
const PROJECT = 'lease-ownership-test';

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); }
}

function assertEqual(actual, expected, msg) {
  if (actual === expected) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg} — expected: ${JSON.stringify(expected)}, got: ${JSON.stringify(actual)}`); }
}

function expectCode(fn, code, msg) {
  try {
    fn();
    failed++;
    console.error(`  ❌ ${msg} — expected throw ${code}, but call succeeded`);
  } catch (e) {
    if (e.code === code) { passed++; console.log(`  ✅ ${msg} (${code})`); }
    else { failed++; console.error(`  ❌ ${msg} — expected code ${code}, got ${e.code || '(none)'}: ${e.message}`); }
  }
}

function cleanDb() {
  for (const f of [DB_PATH, CACHE_PATH]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

async function run() {
  cleanDb();
  await hzl.init(DB_PATH);

  console.log('\n═══ Non-owner cannot mutate an actively-leased task ═══');
  const t1 = hzl.createTask(PROJECT, { title: 'Owned by alice', status: 'open' });
  const claim = hzl.claimTask(PROJECT, t1.id, { agent: 'agent-alice', lease: 30 });
  assertEqual(claim.agent, 'agent-alice', 'alice claims the task');
  assertEqual(claim.status, 'in-progress', 'task is in-progress after claim');

  // A caller asserting "agent-bob" must not be able to act on alice's lease.
  expectCode(() => hzl.claimTask(PROJECT, t1.id, { agent: 'agent-bob', lease: 30 }),
    'ALREADY_CLAIMED', 'bob cannot steal an actively-leased task');
  expectCode(() => hzl.completeTask(PROJECT, t1.id, { agent: 'agent-bob' }),
    'NOT_OWNER', 'bob cannot complete a task leased to alice');
  expectCode(() => hzl.addCheckpoint(PROJECT, t1.id, { agent: 'agent-bob', message: 'sneaky' }),
    'NOT_OWNER', 'bob cannot checkpoint a task leased to alice');
  expectCode(() => hzl.releaseTask(PROJECT, t1.id, { agent: 'agent-bob', force: false }),
    'NOT_OWNER', 'bob cannot release a task leased to alice');

  // alice still owns it; her own lifecycle ops work.
  const stillOwned = hzl.getTask(PROJECT, t1.id);
  assertEqual(stillOwned.agent, 'agent-alice', 'alice remains the owner after bob is rejected');
  const cp = hzl.addCheckpoint(PROJECT, t1.id, { agent: 'agent-alice', message: 'progress' });
  assert(cp, 'alice can checkpoint her own task');
  const done = hzl.completeTask(PROJECT, t1.id, { agent: 'agent-alice' });
  assertEqual(done.status, 'review', 'alice can complete her own task (→ review)');

  console.log('\n═══ Re-claim is allowed only when the claim is not active ═══');
  const t2 = hzl.createTask(PROJECT, { title: 'Reclaimable', status: 'open' });
  hzl.claimTask(PROJECT, t2.id, { agent: 'agent-alice', lease: 30 });
  // alice releases → claim no longer active → a fresh agent may pick it up.
  hzl.releaseTask(PROJECT, t2.id, { agent: 'agent-alice', force: false });
  const reclaim = hzl.claimTask(PROJECT, t2.id, { agent: 'agent-bob', lease: 30 });
  assertEqual(reclaim.agent, 'agent-bob', 'bob can claim after alice releases (no active claim)');

  console.log('\n═══ SUMMARY ═══');
  console.log(`\n✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`Total: ${passed + failed}`);

  cleanDb();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => {
  console.error('Fatal error:', e);
  cleanDb();
  process.exit(1);
});
