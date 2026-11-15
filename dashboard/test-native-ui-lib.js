'use strict';

/**
 * The pure logic behind the native Control UI views (T-487-8, T-515-7).
 *
 * The views themselves are React and only run inside the Gateway's Control UI;
 * what can be decided without a DOM lives in `openclaw/native-ui/lib/*.js`:
 *
 *   1. needs-me grouping — the review lane and the blocked/stuck lane never
 *      mix, and an unknown reason is dropped rather than rendered in a lane
 *      whose meaning it may not share.
 *   2. deep links — what the page reads from the Control UI URL.
 *
 * Run: node test-native-ui-lib.js
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const LIB_DIR = path.resolve(__dirname, '..', 'openclaw', 'native-ui', 'lib');

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
  const { buildPageParams, readPageParams } = await load('deep-link.js');

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
    assert.deepEqual(readPageParams({ project: 'alpha', task: 'T-001' }), { project: 'alpha', task: 'T-001', tab: 'board', file: null });
    assert.deepEqual(readPageParams({ task: 'T-001' }), { project: null, task: null, tab: 'board', file: null });
    assert.deepEqual(readPageParams(undefined), { project: null, task: null, tab: 'board', file: null });
  });

  check('the tab and the Files file round-trip through the page params (T-499)', () => {
    const files = buildPageParams({ project: 'alpha', tab: 'files', file: 'specs/T-1-plan.md' });
    assert.deepEqual(files, { project: 'alpha', tab: 'files', file: 'specs/T-1-plan.md' });
    assert.deepEqual(readPageParams(files), { project: 'alpha', task: null, tab: 'files', file: 'specs/T-1-plan.md' });
    for (const tab of ['ideas', 'projects']) {
      const params = buildPageParams({ project: 'alpha', task: 'T-1', tab });
      assert.deepEqual(params, { project: 'alpha', task: 'T-1', tab });
      assert.deepEqual(readPageParams(params), { project: 'alpha', task: 'T-1', tab, file: null });
    }
    // Projects needs no project to be restored.
    assert.deepEqual(readPageParams(buildPageParams({ tab: 'projects' })), { project: null, task: null, tab: 'projects', file: null });
  });

  check('a link without a tab is the board, and the board is never written', () => {
    assert.deepEqual(buildPageParams({ project: 'alpha', tab: 'board' }), { project: 'alpha' });
    assert.equal(readPageParams({ project: 'alpha' }).tab, 'board');
  });

  check('an invalid tab or file in the params is ignored', () => {
    for (const tab of ['nope', 'specify', 'BOARD', '', 7, null]) {
      assert.deepEqual(buildPageParams({ project: 'alpha', tab }), { project: 'alpha' });
      assert.equal(readPageParams({ project: 'alpha', tab }).tab, 'board');
    }
    for (const file of ['../secret.md', '/etc/passwd', 'a/../../b', 'x\u0000y', 'x'.repeat(600), '', 42]) {
      assert.deepEqual(buildPageParams({ project: 'alpha', tab: 'files', file }), { project: 'alpha', tab: 'files' });
      assert.equal(readPageParams({ project: 'alpha', tab: 'files', file }).file, null);
    }
    // A file belongs to Files only, and to a project.
    assert.deepEqual(buildPageParams({ project: 'alpha', tab: 'ideas', file: 'a.md' }), { project: 'alpha', tab: 'ideas' });
    assert.equal(readPageParams({ project: 'alpha', tab: 'ideas', file: 'a.md' }).file, null);
    assert.equal(readPageParams({ tab: 'files', file: 'a.md' }).file, null);
  });
}

async function main() {
  await needsMeTests();
  await deepLinkTests();
  console.log(`\n${failed ? '❌' : '✅'} native UI lib: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
