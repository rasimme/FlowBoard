'use strict';

/**
 * Unit tests for hzl-integrity.js — boot-time watermark check that detects
 * when the events table has shrunk against its last known size. Catches
 * filesystem-level rollbacks of `flowboard.db` (e.g. a restore script
 * overwriting the live file) which the SQL triggers cannot guard against.
 *
 * Tests use in-memory stubs so they run without a real SQLite dependency.
 *
 * Run: node test-hzl-integrity.js
 */

const integrity = require('./hzl-integrity.js');

let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✅ ${msg}`); }
  else      { fail++; failures.push(msg); console.log(`  ❌ ${msg}`); }
}

function section(title) {
  console.log(`\n## ${title}\n`);
}

// ---------------------------------------------------------------------------
// In-memory stubs
// ---------------------------------------------------------------------------

function makeKvStub(initial = {}) {
  const store = new Map(Object.entries(initial));
  const calls = { get: 0, run: 0 };
  return {
    prepare: (sql) => ({
      get: (key) => {
        calls.get++;
        if (!/SELECT.+hzl_local_meta/i.test(sql)) return undefined;
        return store.has(key) ? { value: store.get(key) } : undefined;
      },
      run: (key, value) => {
        calls.run++;
        if (!/INSERT.+hzl_local_meta/i.test(sql)) return;
        store.set(key, value);
      },
    }),
    _store: store,
    _calls: calls,
  };
}

function makeEventsStub(row) {
  return {
    prepare: () => ({ get: () => row }),
  };
}

// ---------------------------------------------------------------------------
// getCurrentWatermark
// ---------------------------------------------------------------------------

function testGetCurrentFromPopulatedEvents() {
  section('getCurrentWatermark — reads from events');
  const eventsDb = makeEventsStub({
    max_id: 4887, count: 4887, last_event_at: '2026-05-22T16:51:50.536Z',
  });
  const wm = integrity.getCurrentWatermark(eventsDb);
  ok(wm.max_id === 4887, 'max_id read from row');
  ok(wm.count === 4887, 'count read from row');
  ok(wm.last_event_at === '2026-05-22T16:51:50.536Z', 'last_event_at read from row');
}

function testGetCurrentFromEmptyEvents() {
  section('getCurrentWatermark — empty events table');
  const eventsDb = makeEventsStub({ max_id: null, count: 0, last_event_at: null });
  const wm = integrity.getCurrentWatermark(eventsDb);
  ok(wm.max_id === 0, 'null max_id normalised to 0');
  ok(wm.count === 0, 'count is 0');
  ok(wm.last_event_at === null, 'last_event_at is null');
}

// ---------------------------------------------------------------------------
// getStoredWatermark / storeWatermark
// ---------------------------------------------------------------------------

function testStoredNullOnFirstRun() {
  section('getStoredWatermark — first run returns null');
  const cacheDb = makeKvStub();
  ok(integrity.getStoredWatermark(cacheDb) === null, 'empty kv → null');
}

function testStoreAndReadBack() {
  section('storeWatermark + getStoredWatermark round-trip');
  const cacheDb = makeKvStub();
  integrity.storeWatermark(cacheDb, { max_id: 4887, count: 4887 });
  const stored = integrity.getStoredWatermark(cacheDb);
  ok(stored !== null, 'stored watermark exists after write');
  ok(stored.max_id === 4887, 'max_id preserved');
  ok(stored.count === 4887, 'count preserved');
  ok(typeof stored.last_check_at === 'string', 'last_check_at is set');
  ok(/^\d{4}-\d{2}-\d{2}T/.test(stored.last_check_at), 'last_check_at is ISO-8601');
}

function testStoreOverwrites() {
  section('storeWatermark — overwrites previous value');
  const cacheDb = makeKvStub();
  integrity.storeWatermark(cacheDb, { max_id: 100, count: 100 });
  integrity.storeWatermark(cacheDb, { max_id: 200, count: 200 });
  const stored = integrity.getStoredWatermark(cacheDb);
  ok(stored.max_id === 200, 'max_id reflects latest write');
  ok(stored.count === 200, 'count reflects latest write');
}

// ---------------------------------------------------------------------------
// checkRegression
// ---------------------------------------------------------------------------

function testNoRegressionFirstRun() {
  section('checkRegression — first run (no stored) returns null');
  ok(integrity.checkRegression(null, { max_id: 100, count: 100 }) === null,
    'null stored → null result');
}

function testNoRegressionEqual() {
  section('checkRegression — equal values');
  const r = integrity.checkRegression({ max_id: 100, count: 100 }, { max_id: 100, count: 100 });
  ok(r === null, 'unchanged → null');
}

function testNoRegressionGrowth() {
  section('checkRegression — growth (normal write activity)');
  const r = integrity.checkRegression({ max_id: 100, count: 100 }, { max_id: 150, count: 150 });
  ok(r === null, 'growth → null');
}

function testRegressionMaxIdShrunk() {
  section('checkRegression — max_id regressed');
  const r = integrity.checkRegression({ max_id: 4871, count: 4871 }, { max_id: 4708, count: 4708 });
  ok(r !== null, 'shrinkage produces regression object');
  ok(r.type === 'max_id_regressed', 'type marks max_id regression');
  ok(r.before === 4871, 'before captures stored max_id');
  ok(r.after === 4708, 'after captures current max_id');
  ok(typeof r.detected_at === 'string', 'detected_at is set');
}

function testRegressionCountOnly() {
  section('checkRegression — count shrunk with same max_id (defensive)');
  const r = integrity.checkRegression({ max_id: 100, count: 100 }, { max_id: 100, count: 80 });
  ok(r !== null, 'count shrinkage produces regression');
  ok(r.type === 'count_regressed', 'type marks count regression');
  ok(r.before === 100, 'before captures stored count');
  ok(r.after === 80, 'after captures current count');
}

function testRegressionMaxIdShrunkPriority() {
  section('checkRegression — max_id wins over count when both shrink');
  const r = integrity.checkRegression({ max_id: 100, count: 100 }, { max_id: 50, count: 50 });
  ok(r.type === 'max_id_regressed', 'max_id regression reported (more informative than count)');
}

// ---------------------------------------------------------------------------
// formatRegressionMessage + buildWebhookBody
// ---------------------------------------------------------------------------

function testFormatRegressionMessageMaxId() {
  section('formatRegressionMessage — max_id regression with host');
  const msg = integrity.formatRegressionMessage(
    { type: 'max_id_regressed', before: 4871, after: 4708 },
    'example-host'
  );
  ok(msg.includes('max_id'), 'mentions max_id');
  ok(msg.includes('4871'), 'includes before value');
  ok(msg.includes('4708'), 'includes after value');
  ok(msg.includes('example-host'), 'includes host');
  ok(msg.includes('git history'), 'points operator at recovery surface');
}

function testFormatRegressionMessageCount() {
  section('formatRegressionMessage — count regression, no host');
  const msg = integrity.formatRegressionMessage(
    { type: 'count_regressed', before: 100, after: 80 },
    null
  );
  ok(msg.includes('count'), 'mentions count');
  ok(!msg.includes(' on '), 'no host suffix when host is null');
}

function testBuildWebhookBodyShape() {
  section('buildWebhookBody — shape includes message + structured fields');
  const regression = { type: 'max_id_regressed', before: 100, after: 80, detected_at: '2026-05-22T20:00:00.000Z' };
  const current = { max_id: 80, count: 80, last_event_at: '2026-05-22T19:00:00.000Z' };
  const stored = { max_id: 100, count: 100, last_check_at: '2026-05-21T01:00:00.000Z' };
  const body = integrity.buildWebhookBody(regression, current, stored, 'example-host');

  ok(typeof body.message === 'string', 'message is string (matches OpenClaw gateway contract)');
  ok(body.text === undefined, 'no legacy text field (gateway rejects bodies without `message`)');
  ok(body.regression === regression, 'regression passed through (no copy)');
  ok(body.current === current, 'current passed through');
  ok(body.stored === stored, 'stored passed through');
  ok(body.host === 'example-host', 'host preserved');
}

function testBuildWebhookBodyNullHost() {
  section('buildWebhookBody — host null is preserved as null');
  const body = integrity.buildWebhookBody(
    { type: 'max_id_regressed', before: 100, after: 80 },
    { max_id: 80 }, { max_id: 100 }, undefined
  );
  ok(body.host === null, 'undefined host becomes null in body');
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

(function main() {
  testGetCurrentFromPopulatedEvents();
  testGetCurrentFromEmptyEvents();
  testStoredNullOnFirstRun();
  testStoreAndReadBack();
  testStoreOverwrites();
  testNoRegressionFirstRun();
  testNoRegressionEqual();
  testNoRegressionGrowth();
  testRegressionMaxIdShrunk();
  testRegressionCountOnly();
  testRegressionMaxIdShrunkPriority();
  testFormatRegressionMessageMaxId();
  testFormatRegressionMessageCount();
  testBuildWebhookBodyShape();
  testBuildWebhookBodyNullHost();

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log('\nFailures:');
    failures.forEach(f => console.log(`  - ${f}`));
    process.exit(1);
  }
})();
