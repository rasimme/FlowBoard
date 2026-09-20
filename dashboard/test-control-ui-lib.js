'use strict';

/**
 * T-487-8 — the pure logic behind the native Control UI rail.
 *
 * `openclaw/control-ui/index.js` is DOM code that only runs inside the
 * Gateway's Control UI, so everything that can be decided without a DOM lives
 * in `openclaw/control-ui/lib/*.js` and is tested here instead:
 *
 *   1. needs-me grouping — the review lane and the blocked/stuck lane never
 *      mix, and an unknown reason is dropped rather than rendered in a lane
 *      whose meaning it may not share.
 *   2. deep links — what the rail puts in the Control UI URL and in the frame
 *      URL, including the degradation the SPA cannot honour yet.
 *   3. the agent-id guard — an id the server would reject is never persisted.
 *   4. the watch reducer — a refresh failure never blanks a list that already
 *      has data.
 *
 * Run: node test-control-ui-lib.js
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const LIB_DIR = path.resolve(__dirname, '..', 'openclaw', 'control-ui', 'lib');

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ❌ ${name}\n     ${error.message}`);
  }
}

function section(title) {
  console.log(`\n## ${title}`);
}

function load(file) {
  return import(pathToFileURL(path.join(LIB_DIR, file)).href);
}

/** A localStorage stand-in, optionally one that throws like a private window. */
function fakeStorage({ throws = false, initial = {} } = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem(key) {
      if (throws) throw new Error('access denied');
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      if (throws) throw new Error('access denied');
      map.set(key, String(value));
    },
    removeItem(key) {
      if (throws) throw new Error('access denied');
      map.delete(key);
    },
    get size() {
      return map.size;
    },
  };
}

const ITEMS = [
  { project: 'alpha', id: 'T-001', title: 'Approve me', status: 'review', workState: 'working', reason: 'review', agent: 'codex', note: null },
  { project: 'alpha', id: 'T-002', title: 'Blocked one', status: 'open', workState: 'blocked', reason: 'blocked', agent: null, note: 'waiting for design' },
  { project: 'beta', id: 'T-003', title: 'Stalled', status: 'in-progress', workState: 'working', reason: 'stuck', agent: 'main', note: 'no checkpoint for 42 min' },
];

async function needsMeTests() {
  section('needs-me grouping');
  const { groupNeedsMe, countNeedsMe, describeNeedsMe, reasonLabel, NEEDS_ME_GROUPS } = await load('needs-me.js');

  check('the approve gate and the stalled lane stay separate', () => {
    const groups = groupNeedsMe(ITEMS);
    assert.deepEqual(groups.map((group) => group.id), ['review', 'attention']);
    assert.deepEqual(groups[0].items.map((item) => item.id), ['T-001']);
    assert.deepEqual(groups[1].items.map((item) => item.id), ['T-002', 'T-003']);
  });

  check('backend order is preserved inside a group', () => {
    const reversed = groupNeedsMe([ITEMS[2], ITEMS[1]]);
    assert.deepEqual(reversed[1].items.map((item) => item.id), ['T-003', 'T-002']);
  });

  check('an unknown reason is dropped, not guessed into a lane', () => {
    const groups = groupNeedsMe([...ITEMS, { project: 'x', id: 'T-9', reason: 'escalated', title: 'new' }]);
    assert.equal(countNeedsMe([...ITEMS, { project: 'x', id: 'T-9', reason: 'escalated' }]), 3);
    assert.equal(groups.every((group) => group.items.every((item) => item.reason !== 'escalated')), true);
  });

  check('a malformed answer renders as empty instead of throwing', () => {
    assert.equal(countNeedsMe(null), 0);
    assert.equal(countNeedsMe([null, undefined]), 0);
    assert.deepEqual(groupNeedsMe(undefined).map((group) => group.items.length), [0, 0]);
  });

  check('every declared group reason is one the contract can emit', () => {
    const reasons = NEEDS_ME_GROUPS.flatMap((group) => group.reasons);
    assert.deepEqual([...reasons].sort(), ['blocked', 'review', 'stuck']);
  });

  check('the row badge names the precise reason, not the group', () => {
    assert.equal(reasonLabel(ITEMS[0]), 'review');
    assert.equal(reasonLabel(ITEMS[1]), 'blocked');
    assert.equal(reasonLabel(ITEMS[2]), 'stuck');
  });

  check('the row description carries evidence and the owner', () => {
    assert.equal(describeNeedsMe(ITEMS[2]), 'no checkpoint for 42 min · @main');
    assert.equal(describeNeedsMe(ITEMS[0]), '@codex');
    // The badge already says "review"; the line must not repeat it.
    assert.equal(describeNeedsMe({ status: 'review', reason: 'review' }), '');
    assert.equal(describeNeedsMe({ status: 'in-progress', reason: 'stuck' }), 'in-progress');
  });
}

async function deepLinkTests() {
  section('deep links');
  const { buildPageParams, readPageParams, buildFrameUrl } = await load('deep-link.js');

  check('a selection becomes Control UI page params', () => {
    assert.deepEqual(buildPageParams({ project: 'alpha', task: 'T-001' }), { project: 'alpha', task: 'T-001' });
  });

  check('a task without a project is not a link', () => {
    assert.deepEqual(buildPageParams({ task: 'T-001' }), {});
  });

  check('params that are not identifiers are refused', () => {
    assert.deepEqual(buildPageParams({ project: '../../etc/passwd', task: 'T-1' }), {});
    assert.deepEqual(buildPageParams({ project: 'a b', task: 'T-1' }), {});
    assert.deepEqual(buildPageParams({ project: 'x'.repeat(200), task: 'T-1' }), {});
  });

  check('props round-trip back into a selection', () => {
    assert.deepEqual(readPageParams({ project: 'alpha', task: 'T-001' }), { project: 'alpha', task: 'T-001' });
    assert.deepEqual(readPageParams({ task: 'T-001' }), { project: null, task: null });
    assert.deepEqual(readPageParams(undefined), { project: null, task: null });
  });

  check('without a selection the frame keeps the configured URL byte-identical', () => {
    assert.equal(buildFrameUrl('http://127.0.0.1:18870', {}), 'http://127.0.0.1:18870');
    assert.equal(buildFrameUrl('', { project: 'alpha' }), '');
  });

  check('a selection is appended to the frame URL', () => {
    const url = new URL(buildFrameUrl('http://127.0.0.1:18870', { project: 'alpha', task: 'T-001', focus: '17' }));
    assert.equal(url.searchParams.get('project'), 'alpha');
    assert.equal(url.searchParams.get('task'), 'T-001');
    assert.equal(url.searchParams.get('fbFocus'), '17');
  });

  check('an existing query on the configured URL survives', () => {
    const url = new URL(buildFrameUrl('http://127.0.0.1:18870/?agentId=main', { project: 'alpha' }));
    assert.equal(url.searchParams.get('agentId'), 'main');
    assert.equal(url.searchParams.get('project'), 'alpha');
  });

  check('a URL the browser cannot parse is returned untouched', () => {
    assert.equal(buildFrameUrl('not a url', { project: 'alpha' }), 'not a url');
  });
}

async function settingsTests() {
  section('agent-id persistence guard');
  const { readAgentId, writeAgentId, normalizeAgentId, readRailCollapsed, writeRailCollapsed, AGENT_ID_KEY, DEFAULT_AGENT_ID } =
    await load('settings.js');

  check('the default agent is used until someone stores one', () => {
    assert.equal(readAgentId(fakeStorage()), DEFAULT_AGENT_ID);
    assert.equal(readAgentId(null), DEFAULT_AGENT_ID);
  });

  check('a valid id is normalized and persisted', () => {
    const store = fakeStorage();
    assert.equal(writeAgentId(store, '  Claude-Code '), 'claude-code');
    assert.equal(store.getItem(AGENT_ID_KEY), 'claude-code');
    assert.equal(readAgentId(store), 'claude-code');
  });

  check('an id the server would reject is never stored', () => {
    const store = fakeStorage();
    for (const bad of ['', '-lead', 'Has Space', 'x'.repeat(65), 'none', 'unknown', 'agent', 'under_score']) {
      assert.equal(writeAgentId(store, bad), null, `accepted ${JSON.stringify(bad)}`);
    }
    assert.equal(store.size, 0);
    assert.equal(readAgentId(store), DEFAULT_AGENT_ID);
  });

  check('a stored value that went bad falls back instead of poisoning requests', () => {
    assert.equal(readAgentId(fakeStorage({ initial: { [AGENT_ID_KEY]: 'NOT VALID' } })), DEFAULT_AGENT_ID);
  });

  check('normalizeAgentId accepts the ids FlowBoard itself ships', () => {
    for (const id of ['main', 'claude-code', 'codex', 'cron-nightly']) assert.equal(normalizeAgentId(id), id);
  });

  check('a storage that throws degrades to the defaults', () => {
    const store = fakeStorage({ throws: true });
    assert.equal(readAgentId(store), DEFAULT_AGENT_ID);
    assert.equal(writeAgentId(store, 'claude-code'), 'claude-code');
    assert.equal(readRailCollapsed(store), false);
    assert.equal(writeRailCollapsed(store, true), false);
  });

  check('the rail collapse state round-trips', () => {
    const store = fakeStorage();
    assert.equal(readRailCollapsed(store), false);
    writeRailCollapsed(store, true);
    assert.equal(readRailCollapsed(store), true);
    writeRailCollapsed(store, false);
    assert.equal(readRailCollapsed(store), false);
  });
}

async function watchStateTests() {
  section('watch state reducer');
  const { initialWatchState, watchReducer, isBlank } = await load('watch-state.js');

  check('a view starts blank and loading', () => {
    const state = initialWatchState();
    assert.equal(state.phase, 'loading');
    assert.equal(isBlank(state), true);
  });

  check('data makes it ready, an empty answer makes it empty', () => {
    const ready = watchReducer(initialWatchState(), { type: 'data', data: { items: [1] }, at: 5 });
    assert.equal(ready.phase, 'ready');
    assert.equal(ready.updatedAt, 5);
    const empty = watchReducer(ready, { type: 'data', data: { items: [] }, at: 6, empty: true });
    assert.equal(empty.phase, 'empty');
  });

  check('the first failure with nothing on screen is an error state', () => {
    const state = watchReducer(initialWatchState(), { type: 'error', error: new Error('gateway down') });
    assert.equal(state.phase, 'error');
    assert.equal(state.error, 'gateway down');
    assert.equal(state.data, null);
  });

  check('a later failure keeps the last good data and marks it stale', () => {
    const ready = watchReducer(initialWatchState(), { type: 'data', data: { items: [1] }, at: 5 });
    const stale = watchReducer(ready, { type: 'error', error: 'connection lost' });
    assert.equal(stale.phase, 'stale');
    assert.deepEqual(stale.data, { items: [1] });
    assert.equal(stale.updatedAt, 5, 'freshness must not advance on a failure');
  });

  check('a recovery replaces the stale answer', () => {
    const stale = watchReducer(
      watchReducer(initialWatchState(), { type: 'data', data: { items: [1] }, at: 5 }),
      { type: 'error', error: 'x' },
    );
    const recovered = watchReducer(stale, { type: 'data', data: { items: [2] }, at: 9 });
    assert.equal(recovered.phase, 'ready');
    assert.equal(recovered.error, null);
    assert.equal(recovered.updatedAt, 9);
  });

  check('error text is bounded and never an object', () => {
    const state = watchReducer(initialWatchState(), { type: 'error', error: 'x'.repeat(500) });
    assert.equal(state.error.length, 300);
    assert.equal(typeof watchReducer(initialWatchState(), { type: 'error', error: { a: 1 } }).error, 'string');
  });

  check('reset returns to the initial state, an unknown action changes nothing', () => {
    const ready = watchReducer(initialWatchState(), { type: 'data', data: { items: [1] }, at: 5 });
    assert.deepEqual(watchReducer(ready, { type: 'reset' }), initialWatchState());
    assert.equal(watchReducer(ready, { type: 'nope' }), ready);
  });
}

async function main() {
  await needsMeTests();
  await deepLinkTests();
  await settingsTests();
  await watchStateTests();
  console.log(`\n${failed ? '❌' : '✅'} control UI lib: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
