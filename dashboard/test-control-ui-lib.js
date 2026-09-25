'use strict';

/**
 * T-487-8 / T-498 / T-499 — the pure logic behind the native Control UI page.
 *
 * `openclaw/control-ui/index.js` is DOM code that only runs inside the
 * Gateway's Control UI, so everything that can be decided without a DOM lives
 * in `openclaw/control-ui/lib/*.js` and is tested here instead:
 *
 *   1. needs-me grouping — the review lane and the blocked/stuck lane never
 *      mix, and an unknown reason is dropped rather than rendered in a lane
 *      whose meaning it may not share.
 *   2. deep links — what the page puts in the Control UI URL and in the frame
 *      URL.
 *   3. the agent-id guard — an id the server would reject is never persisted.
 *   4. the watch reducer — a refresh failure never blanks a list that already
 *      has data.
 *   5. board grouping and sorting — five columns, archived dropped, `order`
 *      then a natural id compare, and the lease/stale computation.
 *   6. the action menu — which items a card offers, and the exact contract
 *      call each one becomes. A reject without a reason is never sent.
 *   7. the detail panel reducer — a late answer for a closed task is dropped
 *      and a failed refresh never blanks a panel that has content.
 *   8. the view reducer — project, tab and open task, and the `ui.focus`
 *      project derived from them.
 *   9. T-499: the embed protocol (URL, message acceptance, context, ready
 *      timeout), framed tabs + transient Specify, position/archive/trash menu
 *      items with their exact requests and undo, order ranks, the panel
 *      editors' diff rules, and the comment bounds.
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
  const { buildPageParams, readPageParams, buildDashboardUrl } = await load('deep-link.js');

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

  check('without an agent the dashboard link is the configured URL byte-identical', () => {
    assert.equal(buildDashboardUrl('http://127.0.0.1:18870', {}), 'http://127.0.0.1:18870');
    assert.equal(buildDashboardUrl('', { agentId: 'main' }), '');
  });

  check('the dashboard link carries the agent the rail follows, and keeps an existing query', () => {
    const url = new URL(buildDashboardUrl('http://127.0.0.1:18870/?x=1', { agentId: 'claude-code' }));
    assert.equal(url.searchParams.get('agentId'), 'claude-code');
    assert.equal(url.searchParams.get('x'), '1');
    assert.equal(url.searchParams.get('embed'), null, 'the standalone link is never an embed URL');
  });

  check('a URL the browser cannot parse is returned untouched', () => {
    assert.equal(buildDashboardUrl('not a url', { agentId: 'main' }), 'not a url');
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


/* ------------------------------------------------------------------ T-498 */

/** A contract-shaped task with only the fields a test cares about spelled out. */
function task(overrides = {}) {
  return {
    id: 'T-001',
    title: 'A task',
    status: 'open',
    workState: 'working',
    workStateDetails: null,
    stuckIndicator: null,
    priority: 'medium',
    agent: null,
    parentId: null,
    subtaskCount: 0,
    tags: [],
    order: null,
    enteredStatusAt: null,
    created: null,
    leaseUntil: null,
    specExists: false,
    ...overrides,
  };
}

async function boardTests() {
  section('board grouping, sorting and lease health');
  const {
    BOARD_COLUMNS,
    BOARD_STATUSES,
    compareIds,
    compareTasks,
    countBoardTasks,
    groupTasksByStatus,
    leaseState,
    relationLabel,
    showsWorkState,
    statusLabel,
    stuckLabel,
    workStateDetail,
    workStateLabel,
  } = await load('board.js');

  check('the board is the five lifecycle columns, in order, without archived', () => {
    assert.deepEqual(BOARD_STATUSES, ['backlog', 'open', 'in-progress', 'review', 'done']);
    assert.deepEqual(BOARD_COLUMNS.map((column) => column.label), [
      'Backlog',
      'Open',
      'In Progress',
      'Review',
      'Done',
    ]);
    assert.equal(BOARD_STATUSES.includes('archived'), false);
  });

  check('tasks land in their own column and archived ones are dropped', () => {
    const columns = groupTasksByStatus([
      task({ id: 'T-1', status: 'backlog' }),
      task({ id: 'T-2', status: 'review' }),
      task({ id: 'T-3', status: 'archived' }),
      task({ id: 'T-4', status: 'review' }),
    ]);
    assert.deepEqual(columns.map((column) => column.count), [1, 0, 0, 2, 0]);
    assert.equal(countBoardTasks([task({ status: 'archived' })]), 0);
  });

  check('a status the board has no column for is dropped, never guessed into one', () => {
    const columns = groupTasksByStatus([task({ id: 'T-9', status: 'icebox' })]);
    assert.equal(countBoardTasks([task({ id: 'T-9', status: 'icebox' })]), 0);
    assert.equal(columns.every((column) => column.tasks.length === 0), true);
  });

  check('sorting is order first, unranked last, then a natural id compare', () => {
    const rows = [
      task({ id: 'T-10', order: null }),
      task({ id: 'T-2', order: null }),
      task({ id: 'T-7', order: 5 }),
      task({ id: 'T-8', order: 1 }),
    ];
    const sorted = [...rows].sort(compareTasks).map((row) => row.id);
    assert.deepEqual(sorted, ['T-8', 'T-7', 'T-2', 'T-10']);
    assert.ok(compareIds('T-9', 'T-10') < 0);
    assert.ok(compareIds('T-128-2', 'T-128-10') < 0);
    assert.equal(compareIds('T-1', 'T-1'), 0);
  });

  check('grouping does not mutate the list it was given', () => {
    const rows = [task({ id: 'T-3', status: 'open', order: 2 }), task({ id: 'T-1', status: 'open', order: 1 })];
    groupTasksByStatus(rows);
    assert.deepEqual(rows.map((row) => row.id), ['T-3', 'T-1']);
  });

  check('a garbage answer renders an empty board instead of throwing', () => {
    assert.equal(countBoardTasks(null), 0);
    assert.equal(countBoardTasks([null, 'nope', 7]), 0);
  });

  check('working is invisible, every other work state is shown', () => {
    assert.equal(showsWorkState(task({ workState: 'working' })), false);
    assert.equal(showsWorkState(task({ workState: 'blocked' })), true);
    assert.equal(workStateLabel('working'), 'Active');
    assert.equal(workStateLabel('blocked'), 'Blocked');
    // A state this bundle does not know is shown as itself, not as Active.
    assert.equal(workStateLabel('hibernating'), 'hibernating');
    assert.equal(statusLabel('in-progress'), 'In Progress');
    assert.equal(statusLabel('icebox'), 'icebox');
  });

  check('a lease in the past is stale, a live one is held, none is neither', () => {
    const now = Date.parse('2026-09-20T12:00:00Z');
    assert.equal(leaseState(task({ leaseUntil: null }), now).state, 'none');
    assert.equal(leaseState(task({ leaseUntil: 'not a date' }), now).state, 'none');
    const held = leaseState(task({ leaseUntil: '2026-09-20T12:30:00Z' }), now);
    assert.equal(held.state, 'held');
    assert.match(held.label, /30 min left/);
    const stale = leaseState(task({ leaseUntil: '2026-09-20T11:15:00Z' }), now);
    assert.equal(stale.state, 'stale');
    assert.match(stale.label, /expired 45 min ago/);
    // Durations roll up rather than printing three-digit minutes.
    assert.match(leaseState(task({ leaseUntil: '2026-09-19T12:00:00Z' }), now).label, /expired 24 h ago/);
  });

  check('relation, stuck and work-state detail degrade instead of printing objects', () => {
    assert.equal(relationLabel(task({ subtaskCount: 1 })), '1 subtask');
    assert.equal(relationLabel(task({ subtaskCount: 3 })), '3 subtasks');
    assert.equal(relationLabel(task({ parentId: 'T-128' })), 'subtask of T-128');
    assert.equal(relationLabel(task()), '');
    assert.equal(stuckLabel(task()), '');
    assert.equal(stuckLabel(task({ stuckIndicator: { active: true, reason: 'no checkpoint for 42 min' } })), 'no checkpoint for 42 min');
    assert.equal(stuckLabel(task({ stuckIndicator: { active: true, reason: null, message: 'lease expired' } })), 'lease expired');
    // A cleared incident must not put a warning back on the card.
    assert.equal(stuckLabel(task({ stuckIndicator: { active: false, reason: 'was stuck' } })), '');
    // An indicator whose shape this bundle does not know still says something.
    assert.equal(stuckLabel(task({ stuckIndicator: { active: true, detectedAt: 'x' } })), 'needs attention');
    assert.equal(workStateDetail(task({ workState: 'blocked', workStateDetails: { reason: 'waiting on review' } })), 'waiting on review');
    assert.equal(workStateDetail(task({ workState: 'waiting', workStateDetails: { waitingFor: 'design' } })), 'design');
    assert.equal(workStateDetail(task()), '');
  });
}

async function actionTests() {
  section('card actions and the contract calls they become');
  const {
    actionHint,
    actionReducer,
    actionRequest,
    describeActionError,
    dropRequest,
    errorCode,
    errorFor,
    initialActionState,
    isSaving,
    menuItems,
    menuModel,
    moveTargets,
    validateOptionalReason,
    validateRejectReason,
    workStateChoices,
  } = await load('actions.js');

  check('a card offers every column but its own, and never archive', () => {
    const targets = moveTargets(task({ status: 'open' })).map((item) => item.status);
    assert.deepEqual(targets, ['backlog', 'in-progress', 'review', 'done']);
    assert.equal(targets.includes('archived'), false);
  });

  check('the two moves FlowBoard always refuses are not offered at all', () => {
    // review -> done is the approve gate, and the server says so with a 409.
    assert.deepEqual(moveTargets(task({ status: 'review' })).map((item) => item.status), [
      'backlog',
      'open',
      'in-progress',
    ]);
    // Every way out of done is a reopen, and the server's transition guard
    // refuses all four, so a done card offers no move at all.
    assert.deepEqual(moveTargets(task({ status: 'done' })), []);
    assert.deepEqual(menuModel(task({ status: 'done' })).map((group) => group.id), ['work-state', 'manage']);
  });

  check('dragging a review card onto Done is routed to the approve gate', () => {
    const dropped = dropRequest({ project: 'alpha', task: task({ id: 'T-7', status: 'review' }), status: 'done' });
    assert.equal(dropped.operation, 'task.approve');
    assert.deepEqual(dropped.input, { project: 'alpha', id: 'T-7' });
    // Everywhere else Done stays an ordinary move.
    const moved = dropRequest({ project: 'alpha', task: task({ id: 'T-7', status: 'in-progress' }), status: 'done' });
    assert.equal(moved.operation, 'task.update');
  });

  check('approve and reject exist only in the review lane', () => {
    const review = menuModel(task({ status: 'review' })).map((group) => group.id);
    assert.deepEqual(review, ['review', 'move', 'work-state', 'manage']);
    const open = menuModel(task({ status: 'open' })).map((group) => group.id);
    assert.deepEqual(open, ['move', 'work-state', 'manage']);
    assert.equal(menuItems(task({ status: 'open' })).some((item) => item.kind === 'approve'), false);
  });

  check('the current work state is marked and not offered again', () => {
    const choices = workStateChoices(task({ workState: 'blocked' }));
    assert.deepEqual(choices.map((choice) => choice.workState), ['working', 'waiting', 'blocked', 'paused']);
    assert.equal(choices.find((choice) => choice.workState === 'blocked').current, true);
    assert.equal(choices.find((choice) => choice.workState === 'working').reason, 'none');
    assert.equal(choices.find((choice) => choice.workState === 'paused').reason, 'optional');
    // A task with no work state at all reads as Active, the default.
    assert.equal(workStateChoices(task({ workState: undefined })).find((c) => c.workState === 'working').current, true);
  });

  check('a move becomes one task.update with the new status', () => {
    const request = actionRequest({
      project: 'alpha',
      task: task({ id: 'T-7', status: 'open' }),
      item: { kind: 'move', status: 'review' },
    });
    assert.equal(request.operation, 'task.update');
    assert.deepEqual(request.input, { project: 'alpha', id: 'T-7', status: 'review' });
  });

  check('a work state with a reason carries workStateDetails, without one it does not', () => {
    const withReason = actionRequest({
      project: 'alpha',
      task: task({ id: 'T-7' }),
      item: { kind: 'work-state', workState: 'blocked', reason: 'optional' },
      reason: '  waiting on the API  ',
    });
    assert.deepEqual(withReason.input, {
      project: 'alpha',
      id: 'T-7',
      workState: 'blocked',
      workStateDetails: { reason: 'waiting on the API' },
    });
    const bare = actionRequest({
      project: 'alpha',
      task: task({ id: 'T-7' }),
      item: { kind: 'work-state', workState: 'paused', reason: 'optional' },
      reason: '   ',
    });
    assert.deepEqual(bare.input, { project: 'alpha', id: 'T-7', workState: 'paused' });
  });

  check('returning to Active never carries a stale reason with it', () => {
    const request = actionRequest({
      project: 'alpha',
      task: task({ id: 'T-7', workState: 'blocked' }),
      item: { kind: 'work-state', workState: 'working', reason: 'none' },
      reason: 'was blocked on design',
    });
    assert.deepEqual(request.input, { project: 'alpha', id: 'T-7', workState: 'working' });
  });

  check('reject without a reason produces a message and no call at all', () => {
    const empty = actionRequest({
      project: 'alpha',
      task: task({ id: 'T-7', status: 'review' }),
      item: { kind: 'reject' },
      reason: '   ',
    });
    assert.equal(empty.operation, undefined);
    assert.match(empty.error, /reason is required/i);
    assert.equal(validateRejectReason('').ok, false);
    assert.deepEqual(validateRejectReason(' not done '), { ok: true, value: 'not done' });
    assert.equal(validateRejectReason('x'.repeat(501)).ok, false);
  });

  check('reject with a reason becomes task.reject, approve may go without one', () => {
    const rejected = actionRequest({
      project: 'alpha',
      task: task({ id: 'T-7', status: 'review' }),
      item: { kind: 'reject' },
      reason: 'tests are missing',
    });
    assert.equal(rejected.operation, 'task.reject');
    assert.deepEqual(rejected.input, { project: 'alpha', id: 'T-7', reason: 'tests are missing' });
    const approved = actionRequest({
      project: 'alpha',
      task: task({ id: 'T-7', status: 'review' }),
      item: { kind: 'approve' },
      reason: '',
    });
    assert.equal(approved.operation, 'task.approve');
    assert.deepEqual(approved.input, { project: 'alpha', id: 'T-7' });
    assert.deepEqual(validateOptionalReason('  ').value, undefined);
  });

  check('an action without a project or a task is refused before it is built', () => {
    assert.match(actionRequest({ task: task(), item: { kind: 'move', status: 'open' } }).error, /Nothing to do/);
    assert.match(actionRequest({ project: 'alpha', item: { kind: 'move', status: 'open' } }).error, /Nothing to do/);
    assert.match(actionRequest({ project: 'alpha', task: task(), item: { kind: 'teleport' } }).error, /Unknown action/);
  });

  check('a drop is the same move, and a drop on its own column does nothing', () => {
    const moved = dropRequest({ project: 'alpha', task: task({ id: 'T-7', status: 'open' }), status: 'done' });
    assert.deepEqual(moved.input, { project: 'alpha', id: 'T-7', status: 'done' });
    assert.equal(dropRequest({ project: 'alpha', task: task({ status: 'open' }), status: 'open' }).noop, true);
    assert.match(dropRequest({ project: 'alpha', task: task(), status: 'archived' }).error, /Not a board column/);
  });

  check('one write at a time, and a failure belongs to the card it came from', () => {
    let state = actionReducer(initialActionState(), { type: 'start', id: 'T-1' });
    assert.equal(isSaving(state, 'T-1'), true);
    assert.equal(isSaving(state, 'T-2'), false);
    state = actionReducer(state, { type: 'failed', id: 'T-1', error: new Error('lease held by codex') });
    assert.equal(isSaving(state, 'T-1'), false);
    assert.equal(errorFor(state, 'T-1'), 'lease held by codex');
    assert.equal(errorFor(state, 'T-2'), null);
    state = actionReducer(state, { type: 'start', id: 'T-2' });
    assert.equal(errorFor(state, 'T-1'), null, 'a new write clears the previous message');
    state = actionReducer(state, { type: 'settled', id: 'T-2' });
    assert.equal(state.pending, null);
    assert.equal(state.error, null);
    assert.equal(actionReducer(state, { type: 'clear' }).savedId, null);
    assert.equal(actionReducer(state, { type: 'nope' }), state);
  });

  check('a failure message is bounded and never an object', () => {
    const state = actionReducer(initialActionState(), { type: 'failed', id: 'T-1', error: { code: 500 } });
    assert.equal(typeof state.error, 'string');
    assert.equal(actionReducer(initialActionState(), { type: 'failed', id: 'T-1', error: 'x'.repeat(400) }).error.length, 300);
  });

  check("a known code adds a sentence, an unknown one leaves FlowBoard's text alone", () => {
    const held = Object.assign(new Error('Task T-7 is claimed by another agent'), { code: 'NOT_OWNER' });
    const described = describeActionError(held);
    assert.equal(described.code, 'NOT_OWNER');
    assert.match(described.text, /claimed by another agent — Another agent is holding this task\./);
    const unknown = Object.assign(new Error('something else entirely'), { code: 'made_up_code' });
    assert.equal(describeActionError(unknown).text, 'something else entirely');
    assert.equal(actionHint('made_up_code'), '');
    // Hosts that do not forward a code still show the message.
    assert.equal(errorCode(new Error('plain')), null);
    assert.equal(describeActionError(new Error('plain')).text, 'plain');
  });

  check('the code is kept so the page can react to a task that is gone', () => {
    const gone = Object.assign(new Error('Task T-7 not found'), { code: 'flowboard_not_found' });
    const state = actionReducer(initialActionState(), { type: 'failed', id: 'T-7', error: gone });
    assert.equal(state.code, 'flowboard_not_found');
    assert.equal(actionReducer(state, { type: 'start', id: 'T-8' }).code, null);
  });
}

async function panelTests() {
  section('detail panel state');
  const {
    MAX_CHECKPOINTS,
    MAX_COMMENTS,
    descriptionLines,
    descriptionText,
    descriptionTruncated,
    specFile,
    initialPanelState,
    panelReducer,
    panelTask,
    visibleCheckpoints,
    visibleComments,
  } = await load('panel.js');

  /**
   * `task.get` carries the description, its truncation flag and the spec path
   * inside `task`, beside the card fields — the same object the board already
   * knows how to read.
   */
  const detail = ({ description = '', descriptionTruncated: cut = false, spec = null, ...overrides } = {}) => ({
    task: { ...task(), description, descriptionTruncated: cut, specFile: spec },
    comments: [],
    checkpoints: [],
    ...overrides,
  });

  check('opening a task loads, opening the same one again keeps what is on screen', () => {
    let state = panelReducer(initialPanelState(), { type: 'open', project: 'alpha', id: 'T-1' });
    assert.equal(state.open, true);
    assert.equal(state.phase, 'loading');
    state = panelReducer(state, { type: 'data', for: { project: 'alpha', id: 'T-1' }, data: detail(), at: 5 });
    assert.equal(state.phase, 'ready');
    const reopened = panelReducer(state, { type: 'open', project: 'alpha', id: 'T-1' });
    assert.equal(reopened.phase, 'ready');
    assert.equal(reopened.data, state.data);
  });

  check('opening a different task starts empty instead of showing the previous one', () => {
    const first = panelReducer(
      panelReducer(initialPanelState(), { type: 'open', project: 'alpha', id: 'T-1' }),
      { type: 'data', for: { project: 'alpha', id: 'T-1' }, data: detail({ description: 'first' }), at: 5 },
    );
    const second = panelReducer(first, { type: 'open', project: 'alpha', id: 'T-2' });
    assert.equal(second.data, null);
    assert.equal(second.phase, 'loading');
  });

  check('a late answer for a task nobody is looking at any more is dropped', () => {
    const state = panelReducer(initialPanelState(), { type: 'open', project: 'alpha', id: 'T-2' });
    const late = panelReducer(state, { type: 'data', for: { project: 'alpha', id: 'T-1' }, data: detail({ description: 'stale' }), at: 9 });
    assert.equal(late, state);
    const other = panelReducer(state, { type: 'error', for: { project: 'beta', id: 'T-2' }, error: 'boom' });
    assert.equal(other, state);
  });

  check('a failed refresh never blanks a panel that already has content', () => {
    const ready = panelReducer(
      panelReducer(initialPanelState(), { type: 'open', project: 'alpha', id: 'T-1' }),
      { type: 'data', for: { project: 'alpha', id: 'T-1' }, data: detail({ description: 'kept' }), at: 5 },
    );
    const stale = panelReducer(ready, { type: 'error', for: { project: 'alpha', id: 'T-1' }, error: new Error('gone') });
    assert.equal(stale.phase, 'stale');
    assert.equal(stale.data.task.description, 'kept');
    const empty = panelReducer(
      panelReducer(initialPanelState(), { type: 'open', project: 'alpha', id: 'T-1' }),
      { type: 'error', for: { project: 'alpha', id: 'T-1' }, error: 'gone' },
    );
    assert.equal(empty.phase, 'error');
  });

  check('a closed panel ignores everything, and closing resets', () => {
    const closed = panelReducer(initialPanelState(), { type: 'data', data: detail(), at: 1 });
    assert.deepEqual(closed, initialPanelState());
    const open = panelReducer(initialPanelState(), { type: 'open', project: 'alpha', id: 'T-1' });
    assert.deepEqual(panelReducer(open, { type: 'close' }), initialPanelState());
    // An incomplete open is not an open: half a target would fetch nothing.
    const fresh = initialPanelState();
    assert.equal(panelReducer(fresh, { type: 'open', project: 'alpha' }), fresh);
    assert.equal(panelReducer(fresh, { type: 'open', id: 'T-1' }), fresh);
    assert.equal(panelTask(open), null);
  });

  check('comments are newest first and bounded, checkpoints too', () => {
    const comments = Array.from({ length: 25 }, (_, index) => ({
      id: `c${index}`,
      author: 'codex',
      message: `m${index}`,
      kind: 'comment',
      timestamp: new Date(Date.UTC(2026, 8, 1, 0, index)).toISOString(),
    }));
    const shown = visibleComments(detail({ comments }));
    assert.equal(shown.length, MAX_COMMENTS);
    assert.equal(shown[0].message, 'm24');
    assert.equal(shown.at(-1).message, 'm5');
    const checkpoints = Array.from({ length: 14 }, (_, index) => ({
      message: `cp${index}`,
      agent: 'main',
      progress: null,
      timestamp: new Date(Date.UTC(2026, 8, 1, 0, index)).toISOString(),
    }));
    assert.equal(visibleCheckpoints(detail({ checkpoints })).length, MAX_CHECKPOINTS);
    assert.equal(visibleCheckpoints(detail({ checkpoints }))[0].message, 'cp13');
  });

  check('missing or malformed lists read as empty, and sorting does not mutate', () => {
    assert.deepEqual(visibleComments(null), []);
    assert.deepEqual(visibleComments(detail({ comments: 'nope' })), []);
    assert.deepEqual(visibleCheckpoints(detail({ checkpoints: null })), []);
    const comments = [
      { id: 'a', timestamp: '2026-09-01T00:00:00Z', message: 'a' },
      { id: 'b', timestamp: '2026-09-02T00:00:00Z', message: 'b' },
    ];
    visibleComments(detail({ comments }));
    assert.deepEqual(comments.map((row) => row.id), ['a', 'b']);
  });

  check('the description is read out of the task, as plain lines, never markup', () => {
    assert.deepEqual(descriptionLines(detail({ description: 'one\r\ntwo\n\nthree' })), ['one', 'two', '', 'three']);
    assert.equal(descriptionText(detail({ description: 'a\r\nb' })), 'a\nb');
    assert.deepEqual(descriptionLines(detail({ description: '' })), []);
    assert.deepEqual(descriptionLines(null), []);
    // An older answer with the text at the top level still renders.
    assert.equal(descriptionText({ task: { id: 'T-1' }, description: 'legacy' }), 'legacy');
    assert.equal(descriptionTruncated({ task: { id: 'T-1' }, descriptionTruncated: true }), true);
    assert.equal(specFile(detail({ spec: 'specs/T-1.md' })), 'specs/T-1.md');
    assert.equal(specFile(detail()), '');
    // The panel renders these with textContent; the point is that the module
    // hands over text and never a tag the caller might be tempted to inject.
    assert.deepEqual(descriptionLines(detail({ description: '<img src=x onerror=alert(1)>' })), [
      '<img src=x onerror=alert(1)>',
    ]);
    assert.equal(descriptionTruncated(detail({ descriptionTruncated: true })), true);
    assert.equal(descriptionTruncated(detail()), false);
  });
}

async function viewStateTests() {
  section('view state: project, tab and the open task');
  const { DEFAULT_TAB, TABS, focusProject, initialViewState, isFramedTab, selectionOf, showsBoard, viewReducer } =
    await load('view-state.js');
  /** A view state with the T-499 fields at their defaults. */
  const v = (fields) => ({ file: null, specify: null, ...fields });

  check('the tab strip is Board, Ideas, Files and Projects, and Board is native', () => {
    assert.deepEqual(TABS.map((tab) => tab.id), ['board', 'ideas', 'files', 'projects']);
    assert.equal(isFramedTab('projects'), true);
    assert.equal(DEFAULT_TAB, 'board');
    assert.equal(isFramedTab('board'), false);
    assert.equal(isFramedTab('ideas'), true);
    assert.equal(isFramedTab('files'), true);
    assert.equal(isFramedTab('nope'), false);
  });

  check('a deep link with a task selects its project and the board tab', () => {
    const state = viewReducer(v({ project: null, task: null, tab: 'ideas' }), { type: 'params', project: 'alpha', task: 'T-1' });
    assert.deepEqual(state, v({ project: 'alpha', task: 'T-1', tab: 'board' }));
    assert.equal(showsBoard(state), true);
    assert.deepEqual(selectionOf(state), { project: 'alpha', task: 'T-1' });
  });

  check('a deep link with only a project keeps the tab it arrived on', () => {
    const state = viewReducer(v({ project: null, task: null, tab: 'files' }), { type: 'params', project: 'alpha', task: null });
    assert.deepEqual(state, v({ project: 'alpha', task: null, tab: 'files' }));
  });

  check('an empty or unchanged link leaves the view exactly as it was', () => {
    const state = v({ project: 'alpha', task: 'T-1', tab: 'board' });
    assert.equal(viewReducer(state, { type: 'params', project: null, task: null }), state);
    assert.equal(viewReducer(state, { type: 'params', project: 'alpha', task: 'T-1' }), state);
  });

  check('switching project clears the open task', () => {
    const state = viewReducer(v({ project: 'alpha', task: 'T-1', tab: 'board' }), { type: 'project', project: 'beta' });
    assert.deepEqual(state, v({ project: 'beta', task: null, tab: 'board' }));
    // Re-selecting the same project is not a change, so the task survives.
    const same = v({ project: 'alpha', task: 'T-1', tab: 'board' });
    assert.equal(viewReducer(same, { type: 'project', project: 'alpha' }), same);
  });

  check('opening a task from a framed tab switches to the board', () => {
    const state = viewReducer(v({ project: 'alpha', task: null, tab: 'ideas' }), { type: 'task', project: 'alpha', id: 'T-2' });
    assert.deepEqual(state, v({ project: 'alpha', task: 'T-2', tab: 'board' }));
    // A rail row from another project carries its project with it.
    const cross = viewReducer(v({ project: 'alpha', task: null, tab: 'board' }), { type: 'task', project: 'beta', id: 'T-9' });
    assert.deepEqual(cross, v({ project: 'beta', task: 'T-9', tab: 'board' }));
  });

  check('a task without a project or an id is not a selection', () => {
    const state = v({ project: null, task: null, tab: 'board' });
    assert.equal(viewReducer(state, { type: 'task', id: 'T-1' }), state);
    assert.equal(viewReducer({ ...state, project: 'alpha' }, { type: 'task', project: 'alpha' }).task, null);
  });

  check('closing the task keeps the project and the tab', () => {
    const state = viewReducer(v({ project: 'alpha', task: 'T-1', tab: 'board' }), { type: 'close-task' });
    assert.deepEqual(state, v({ project: 'alpha', task: null, tab: 'board' }));
    assert.equal(viewReducer(state, { type: 'close-task' }), state);
  });

  check('a tab change keeps the selection, and an unknown tab is refused', () => {
    const state = v({ project: 'alpha', task: 'T-1', tab: 'board' });
    assert.deepEqual(viewReducer(state, { type: 'tab', tab: 'ideas' }), v({ project: 'alpha', task: 'T-1', tab: 'ideas' }));
    assert.equal(viewReducer(state, { type: 'tab', tab: 'nope' }), state);
    assert.equal(viewReducer(state, { type: 'tab', tab: 'board' }), state);
    assert.equal(viewReducer(state, { type: 'unknown' }), state);
  });

  check('ui.focus follows the project, including across a framed tab', () => {
    assert.equal(focusProject(v({ project: 'alpha', task: null, tab: 'board' })), 'alpha');
    assert.equal(focusProject(v({ project: 'alpha', task: null, tab: 'files' })), 'alpha');
    assert.equal(focusProject(v({ project: null, task: null, tab: 'board' })), null);
    assert.equal(focusProject(null), null);
  });

  check('the initial state comes from the deep link the page was opened with', () => {
    assert.deepEqual(initialViewState({ project: 'alpha', task: 'T-1' }), v({ project: 'alpha', task: 'T-1', tab: 'board' }));
    assert.deepEqual(initialViewState({ project: null, task: 'T-1' }), v({ project: null, task: null, tab: 'board' }));
    assert.deepEqual(initialViewState(), v({ project: null, task: null, tab: 'board' }));
  });

  check('a remount restores the persisted tab and Files file, never Specify (T-499)', () => {
    assert.deepEqual(initialViewState({ project: 'alpha', task: null, tab: 'ideas', file: null }), v({ project: 'alpha', task: null, tab: 'ideas' }));
    assert.deepEqual(
      initialViewState({ project: 'alpha', task: null, tab: 'files', file: 'specs/a.md' }),
      v({ project: 'alpha', task: null, tab: 'files', file: 'specs/a.md' }),
    );
    assert.deepEqual(initialViewState({ project: 'alpha', tab: 'ideas', file: 'specs/a.md' }), v({ project: 'alpha', task: null, tab: 'ideas' }));
    assert.deepEqual(initialViewState({ project: 'alpha', tab: 'specify' }), v({ project: 'alpha', task: null, tab: 'board' }));
    assert.deepEqual(initialViewState({ project: 'alpha', tab: 'nope' }), v({ project: 'alpha', task: null, tab: 'board' }));
  });

  check('selectionOf persists framed tabs and the Files file, and never Specify', () => {
    assert.deepEqual(selectionOf(v({ project: 'alpha', task: null, tab: 'board' })), { project: 'alpha', task: null });
    assert.deepEqual(selectionOf(v({ project: 'alpha', task: null, tab: 'projects' })), { project: 'alpha', task: null, tab: 'projects' });
    assert.deepEqual(
      selectionOf(v({ project: 'alpha', task: null, tab: 'files', file: 'specs/a.md' })),
      { project: 'alpha', task: null, tab: 'files', file: 'specs/a.md' },
    );
    // Specify records the tab it returns to, without a file.
    const specify = viewReducer(v({ project: 'alpha', task: null, tab: 'ideas' }), { type: 'specify', title: 'x' });
    assert.equal(specify.tab, 'specify');
    assert.deepEqual(selectionOf(specify), { project: 'alpha', task: null, tab: 'ideas' });
    const fromBoard = viewReducer(v({ project: 'alpha', task: null, tab: 'board' }), { type: 'specify', title: 'x' });
    assert.deepEqual(selectionOf(fromBoard), { project: 'alpha', task: null });
    const fromFiles = viewReducer(v({ project: 'alpha', task: null, tab: 'files', file: 'a.md' }), { type: 'specify' });
    assert.deepEqual(selectionOf(fromFiles), { project: 'alpha', task: null, tab: 'files' });
  });
}

/* ------------------------------------------------------------------ T-499 */

const DASHBOARD = 'http://127.0.0.1:18870';
const HOST = 'http://127.0.0.1:18875';

async function embedTests() {
  section('embed protocol: framed single surfaces (T-499)');
  const {
    buildEmbedUrl,
    parseFrameMessage,
    contextMessage,
    initialFrameState,
    frameReducer,
    planFrame,
    showsTimeoutNotice,
    dashboardOrigin,
    READY_TIMEOUT_MS,
    EMBED_MESSAGE_TYPE,
  } = await load('embed.js');

  check('an embed URL names the surface, the project and the Control UI origin', () => {
    const url = new URL(buildEmbedUrl(DASHBOARD, { surface: 'ideas', project: 'alpha', host: `${HOST}/control/flowboard?p.project=x` }));
    assert.equal(url.origin, DASHBOARD);
    assert.equal(url.searchParams.get('embed'), 'ideas');
    assert.equal(url.searchParams.get('project'), 'alpha');
    assert.equal(url.searchParams.get('host'), HOST, 'host is an origin, never a path or query');
  });

  check('file only on Files, title and priority only on Specify', () => {
    const files = new URL(buildEmbedUrl(DASHBOARD, { surface: 'files', project: 'alpha', file: 'specs/T-1.md', host: HOST }));
    assert.equal(files.searchParams.get('file'), 'specs/T-1.md');
    const ideas = new URL(buildEmbedUrl(DASHBOARD, { surface: 'ideas', project: 'alpha', file: 'specs/T-1.md', title: 'x' }));
    assert.equal(ideas.searchParams.get('file'), null);
    assert.equal(ideas.searchParams.get('title'), null);
    const specify = new URL(
      buildEmbedUrl(DASHBOARD, { surface: 'specify', project: 'alpha', title: '  Ship\nit ', priority: 'high' }),
    );
    assert.equal(specify.searchParams.get('embed'), 'specify');
    assert.equal(specify.searchParams.get('title'), 'Ship it');
    assert.equal(specify.searchParams.get('priority'), 'high');
    const bad = new URL(buildEmbedUrl(DASHBOARD, { surface: 'specify', project: 'alpha', priority: 'urgent' }));
    assert.equal(bad.searchParams.get('priority'), null);
  });

  check('unknown surfaces, bad URLs and traversal paths frame nothing unsafe', () => {
    assert.equal(buildEmbedUrl(DASHBOARD, { surface: 'overview' }), '');
    assert.equal(buildEmbedUrl(DASHBOARD, { surface: 'board' }), '');
    assert.equal(buildEmbedUrl('not a url', { surface: 'ideas' }), '');
    assert.equal(buildEmbedUrl('', { surface: 'ideas' }), '');
    for (const file of ['../secrets', '/etc/passwd', 'a/../../b', 'x\u0000y', 'x'.repeat(600)]) {
      const url = new URL(buildEmbedUrl(DASHBOARD, { surface: 'files', project: 'alpha', file }));
      assert.equal(url.searchParams.get('file'), null, `accepted ${JSON.stringify(file)}`);
    }
    const url = new URL(buildEmbedUrl(DASHBOARD, { surface: 'ideas', project: '../x', task: 'T-1' }));
    assert.equal(url.searchParams.get('project'), null);
    assert.equal(url.searchParams.get('task'), null, 'a task without a project is not context');
  });

  const frameWindow = { name: 'frame' };
  const origin = dashboardOrigin(DASHBOARD);
  const opts = { expectedSource: frameWindow, expectedOrigin: origin };
  const msg = (data, overrides = {}) => ({ source: frameWindow, origin, data: { type: EMBED_MESSAGE_TYPE, v: 1, ...data }, ...overrides });

  check('messages from the frame at the dashboard origin are accepted', () => {
    assert.deepEqual(parseFrameMessage(msg({ kind: 'ready', surface: 'ideas' }), opts), { kind: 'ready', surface: 'ideas' });
    assert.deepEqual(parseFrameMessage(msg({ kind: 'open-task', project: 'alpha', task: 'T-7' }), opts), {
      kind: 'open-task',
      project: 'alpha',
      task: 'T-7',
    });
    assert.deepEqual(parseFrameMessage(msg({ kind: 'open-project', project: 'beta' }), opts), {
      kind: 'open-project',
      project: 'beta',
    });
    assert.deepEqual(parseFrameMessage(msg({ kind: 'open-surface', surface: 'files', file: 'specs/a.md' }), opts), {
      kind: 'open-surface',
      surface: 'files',
      project: null,
      file: 'specs/a.md',
    });
    assert.deepEqual(parseFrameMessage(msg({ kind: 'open-surface', surface: 'tasks' }), opts).surface, 'board');
    assert.deepEqual(parseFrameMessage(msg({ kind: 'specify-closed', project: 'alpha', task: 'T-9' }), opts), {
      kind: 'specify-closed',
      project: 'alpha',
      task: 'T-9',
    });
    // The dashboard's shape (T-499 F1): the first created task is opened.
    assert.deepEqual(
      parseFrameMessage(msg({ kind: 'specify-closed', project: 'alpha', completed: true, tasks: ['T-10', 'T-11'] }), opts),
      { kind: 'specify-closed', project: 'alpha', task: 'T-10' },
    );
    assert.equal(parseFrameMessage(msg({ kind: 'specify-closed', project: 'alpha', completed: false, tasks: [] }), opts).task, null);
    // Telegram's WebApp SDK posts JSON strings to any parent frame.
    assert.equal(parseFrameMessage(msg('{"eventType":"iframe_ready"}'), opts), null);
  });

  check('a forged message is ignored: wrong source, wrong origin, wrong envelope', () => {
    assert.equal(parseFrameMessage(msg({ kind: 'ready' }, { source: { name: 'other' } }), opts), null);
    assert.equal(parseFrameMessage(msg({ kind: 'ready' }, { origin: 'https://evil.example' }), opts), null);
    assert.equal(parseFrameMessage(msg({ kind: 'ready' }, { origin: HOST }), opts), null, 'not even the host itself');
    assert.equal(parseFrameMessage({ source: frameWindow, origin, data: { type: 'other', v: 1, kind: 'ready' } }, opts), null);
    assert.equal(parseFrameMessage({ source: frameWindow, origin, data: { type: EMBED_MESSAGE_TYPE, v: 2, kind: 'ready' } }, opts), null);
    assert.equal(parseFrameMessage({ source: frameWindow, origin, data: 'flowboard:embed' }, opts), null);
    assert.equal(parseFrameMessage(msg({ kind: 'context', surface: 'ideas' }), opts), null, 'host → frame kinds are not accepted back');
    assert.equal(parseFrameMessage(msg({ kind: 'ready' }), {}), null, 'no expectations, no trust');
  });

  check('payloads are identifiers: bad ids and unknown surfaces drop the message', () => {
    assert.equal(parseFrameMessage(msg({ kind: 'open-task', project: 'alpha', task: '<img src=x>' }), opts), null);
    assert.equal(parseFrameMessage(msg({ kind: 'open-project', project: 'a b' }), opts), null);
    assert.equal(parseFrameMessage(msg({ kind: 'open-surface', surface: 'overview' }), opts), null);
    assert.equal(parseFrameMessage(msg({ kind: 'open-surface', surface: 'files', file: '../x' }), opts).file, null);
    assert.equal(parseFrameMessage(msg({ kind: 'open-task', project: 'bad name', task: 'T-1' }), opts).project, null);
  });

  check('the context message is the frozen v1 shape', () => {
    assert.deepEqual(contextMessage({ surface: 'files', project: 'alpha', file: 'specs/a.md' }), {
      type: 'flowboard:embed',
      v: 1,
      kind: 'context',
      surface: 'files',
      project: 'alpha',
      file: 'specs/a.md',
    });
    assert.equal('file' in contextMessage({ surface: 'ideas', project: 'alpha', file: 'specs/a.md' }), false);
  });

  const cfg = { dashboardUrl: DASHBOARD, host: HOST };
  const ideas = { surface: 'ideas', project: 'alpha', file: null };

  check('the first framed tab loads the frame; the same target does nothing', () => {
    const plan = planFrame(initialFrameState(), ideas, cfg);
    assert.equal(plan.kind, 'load');
    assert.equal(new URL(plan.url).searchParams.get('embed'), 'ideas');
    const loading = frameReducer(initialFrameState(), { type: 'load', url: plan.url, target: ideas });
    assert.equal(loading.phase, 'loading');
    assert.deepEqual(planFrame(loading, ideas, cfg), { kind: 'none' });
    assert.deepEqual(planFrame(initialFrameState(), null, cfg), { kind: 'none' });
  });

  check('a ready frame is steered by context, never reloaded', () => {
    let state = frameReducer(initialFrameState(), { type: 'load', url: 'u', target: ideas });
    state = frameReducer(state, { type: 'ready' });
    const files = { surface: 'files', project: 'alpha', file: 'specs/a.md' };
    const plan = planFrame(state, files, cfg);
    assert.equal(plan.kind, 'post');
    assert.deepEqual(plan.message, contextMessage(files));
    state = frameReducer(state, { type: 'posted', target: files });
    assert.deepEqual(planFrame(state, files, cfg), { kind: 'none' });
    assert.equal(planFrame(state, { ...files, project: 'beta', file: null }, cfg).kind, 'post', 'project switch = context');
  });

  check('a frame that never said ready is re-pointed instead (version skew fallback)', () => {
    const state = frameReducer(initialFrameState(), { type: 'load', url: 'u', target: ideas });
    const plan = planFrame(state, { ...ideas, project: 'beta' }, cfg);
    assert.equal(plan.kind, 'load');
    assert.equal(new URL(plan.url).searchParams.get('project'), 'beta');
  });

  check('Specify is always a fresh load, and leaving it reloads the surface', () => {
    let state = frameReducer(frameReducer(initialFrameState(), { type: 'load', url: 'u', target: ideas }), { type: 'ready' });
    const specify = { surface: 'specify', project: 'alpha', file: null, title: 'New', priority: null };
    const plan = planFrame(state, specify, cfg);
    assert.equal(plan.kind, 'load');
    assert.equal(new URL(plan.url).searchParams.get('title'), 'New');
    state = frameReducer(frameReducer(state, { type: 'load', url: plan.url, target: specify }), { type: 'ready' });
    assert.equal(planFrame(state, ideas, cfg).kind, 'load');
  });

  check('8 s without ready shows the notice; a stale timer or a late ready is handled', () => {
    assert.equal(READY_TIMEOUT_MS, 8000);
    const first = frameReducer(initialFrameState(), { type: 'load', url: 'u', target: ideas });
    const second = frameReducer(first, { type: 'load', url: 'v', target: { ...ideas, project: 'beta' } });
    assert.equal(frameReducer(second, { type: 'timeout', token: first.token }), second, "an old load's timer is ignored");
    const timedOut = frameReducer(second, { type: 'timeout', token: second.token });
    assert.equal(showsTimeoutNotice(timedOut), true);
    const late = frameReducer(timedOut, { type: 'ready' });
    assert.equal(showsTimeoutNotice(late), false);
    assert.equal(late.phase, 'ready');
    assert.equal(frameReducer(late, { type: 'timeout', token: late.token }), late, 'a ready frame never times out');
    assert.equal(frameReducer(initialFrameState(), { type: 'ready' }).phase, 'idle', 'ready before any load is noise');
  });
}

async function viewStateT499Tests() {
  section('view state: framed tabs, files and transient Specify (T-499)');
  const { viewReducer, frameTarget, isFramedTab, SPECIFY_TAB } = await load('view-state.js');
  const base = { project: 'alpha', task: null, tab: 'board', file: null, specify: null };

  check('Specify is framed but has no tab of its own', () => {
    assert.equal(isFramedTab(SPECIFY_TAB), true);
    assert.equal(viewReducer(base, { type: 'tab', tab: SPECIFY_TAB }), base);
  });

  check('a spec link opens Files at that file, a Files click opens the browser', () => {
    const state = viewReducer({ ...base, task: 'T-1' }, { type: 'open-file', file: 'specs/T-1.md' });
    assert.deepEqual(state, { ...base, task: 'T-1', tab: 'files', file: 'specs/T-1.md' });
    assert.deepEqual(frameTarget(state), { surface: 'files', project: 'alpha', file: 'specs/T-1.md' });
    const clicked = viewReducer(viewReducer(state, { type: 'tab', tab: 'ideas' }), { type: 'tab', tab: 'files' });
    assert.equal(clicked.file, null);
    assert.equal(viewReducer(state, { type: 'open-file', file: 'specs/T-1.md' }), state);
    assert.equal(viewReducer(base, { type: 'open-file' }), base);
  });

  check('a file from another project switches the project and drops the task', () => {
    const state = viewReducer({ ...base, task: 'T-1' }, { type: 'open-file', project: 'beta', file: 'x.md' });
    assert.deepEqual(state, { ...base, project: 'beta', tab: 'files', file: 'x.md' });
  });

  check('Specify remembers the tab it replaced and returns to it', () => {
    const fromIdeas = viewReducer({ ...base, tab: 'ideas' }, { type: 'specify', title: ' New thing ', priority: 'high' });
    assert.equal(fromIdeas.tab, SPECIFY_TAB);
    assert.deepEqual(fromIdeas.specify, { title: 'New thing', priority: 'high', returnTab: 'ideas' });
    assert.deepEqual(frameTarget(fromIdeas), {
      surface: 'specify',
      project: 'alpha',
      file: null,
      title: 'New thing',
      priority: 'high',
    });
    const closed = viewReducer(fromIdeas, { type: 'specify-closed' });
    assert.deepEqual(closed, { ...base, tab: 'ideas' });
    assert.equal(viewReducer(base, { type: 'specify-closed' }), base, 'nothing to close');
    assert.equal(viewReducer({ ...base, project: null }, { type: 'specify', title: 'x' }).tab, 'board', 'needs a project');
  });

  check('Specify that created a task opens it on the board', () => {
    const state = viewReducer(viewReducer(base, { type: 'specify', title: 'x' }), { type: 'specify-closed', task: 'T-42' });
    assert.deepEqual(state, { ...base, task: 'T-42' });
  });

  check('switching project leaves Specify and drops the file', () => {
    const inSpecify = viewReducer({ ...base, tab: 'files', file: 'a.md' }, { type: 'specify', title: 'x' });
    const switched = viewReducer(inSpecify, { type: 'project', project: 'beta' });
    assert.deepEqual(switched, { ...base, project: 'beta', tab: 'files' });
  });

  check('open-task from a frame lands on the board with the panel, in the right project', () => {
    const state = viewReducer({ ...base, tab: 'projects' }, { type: 'task', project: 'beta', id: 'T-3' });
    assert.deepEqual(state, { ...base, project: 'beta', task: 'T-3' });
    assert.equal(frameTarget(state), null, 'the board has no frame target');
    assert.deepEqual(frameTarget({ ...base, tab: 'projects' }), { surface: 'projects', project: 'alpha', file: null });
  });
}

async function menuT499Tests() {
  section('card menu: position, archive, trash and undo (T-499)');
  const { menuModel, menuItems, findMenuItem, actionRequest, undoRequest, describeActionError } = await load('actions.js');
  const { orderMoves, orderUpdates } = await load('order.js');
  const col = [
    task({ id: 'T-1', order: 1000 }),
    task({ id: 'T-2', order: 2000 }),
    task({ id: 'T-3', order: 3000 }),
  ];
  const ids = (t, context) => menuItems(t, context).map((item) => item.id);
  const at = (t) => ({ moves: orderMoves(col, t.id) });

  check('archive only on done cards, trash on every card, both confirmed', () => {
    for (const status of ['backlog', 'open', 'in-progress', 'review']) {
      const items = ids(task({ status }));
      assert.equal(items.includes('archive'), false, status);
      assert.equal(items.includes('trash'), true, status);
    }
    const done = menuModel(task({ id: 'T-9', status: 'done' }));
    const manage = done.find((group) => group.id === 'manage').items;
    assert.deepEqual(manage.map((item) => item.id), ['archive', 'trash']);
    assert.ok(manage.every((item) => typeof item.confirm === 'string' && item.confirm.includes('T-9')));
    assert.equal(manage.find((item) => item.id === 'trash').danger, true);
  });

  check('position items need the column moves and follow the card position', () => {
    assert.equal(ids(col[1]).some((id) => id.startsWith('order:')), false, 'no column, no position items');
    assert.deepEqual(ids(col[0], at(col[0])).filter((id) => id.startsWith('order:')), ['order:down']);
    assert.deepEqual(ids(col[1], at(col[1])).filter((id) => id.startsWith('order:')), ['order:up', 'order:down']);
    assert.deepEqual(ids(col[2], at(col[2])).filter((id) => id.startsWith('order:')), ['order:top', 'order:up']);
    assert.deepEqual(ids(col[0], { moves: orderMoves([col[0]], 'T-1') }).filter((id) => id.startsWith('order:')), []);
    assert.deepEqual(ids(col[0], { moves: ['sideways'] }).filter((id) => id.startsWith('order:')), []);
  });

  check('archive, unarchive, trash and restore are the exact contract calls', () => {
    const doneTask = task({ id: 'T-9', status: 'done' });
    const archive = findMenuItem(doneTask, 'archive');
    assert.deepEqual(actionRequest({ project: 'alpha', task: doneTask, item: archive }), {
      operation: 'task.update',
      input: { project: 'alpha', id: 'T-9', status: 'archived' },
    });
    assert.deepEqual(undoRequest({ project: 'alpha', task: doneTask, item: archive }), {
      operation: 'task.update',
      input: { project: 'alpha', id: 'T-9', status: 'done' },
      label: 'Archived T-9.',
    });
    const trash = findMenuItem(doneTask, 'trash');
    assert.deepEqual(actionRequest({ project: 'alpha', task: doneTask, item: trash }), {
      operation: 'task.trash',
      input: { project: 'alpha', id: 'T-9' },
    });
    assert.deepEqual(undoRequest({ project: 'alpha', task: doneTask, item: trash }), {
      operation: 'task.trash',
      input: { project: 'alpha', id: 'T-9', restore: true },
      label: 'Moved T-9 to the trash.',
    });
  });

  check('archive is refused before the call for a card that is not done', () => {
    const item = { id: 'archive', kind: 'archive', label: 'Archive' };
    assert.ok(actionRequest({ project: 'alpha', task: task({ status: 'review' }), item }).error);
  });

  check('moves, work states and the gate have no undo', () => {
    const t = task({ status: 'review' });
    for (const item of menuItems(t)) {
      if (item.kind === 'trash') continue;
      assert.equal(undoRequest({ project: 'alpha', task: t, item }), null, item.id);
    }
  });

  check('a position item becomes minimal order updates', () => {
    const item = findMenuItem(col[2], 'order:up', at(col[2]));
    assert.deepEqual(actionRequest({ project: 'alpha', task: col[2], item, updates: orderUpdates(col, 'T-3', 'up') }), {
      operation: 'task.update',
      requests: [{ operation: 'task.update', input: { project: 'alpha', id: 'T-3', order: 1500 } }],
    });
    const top = findMenuItem(col[2], 'order:top', at(col[2]));
    const topUpdates = orderUpdates(col, 'T-3', 'top');
    assert.deepEqual(actionRequest({ project: 'alpha', task: col[2], item: top, updates: topUpdates }).requests, [
      { operation: 'task.update', input: { project: 'alpha', id: 'T-3', order: 0 } },
    ]);
    const item0 = { kind: 'order', move: 'up' };
    const nothing = actionRequest({ project: 'alpha', task: col[0], item: item0, updates: orderUpdates(col, 'T-1', 'up') });
    assert.deepEqual(nothing, { error: null, noop: true });
    assert.deepEqual(actionRequest({ project: 'alpha', task: col[0], item: item0 }), { error: null, noop: true });
  });

  check('SPECIFY_REQUIRED keeps FlowBoard\'s text and adds the hint once', () => {
    const described = describeActionError(new Error('Specify is required for this project'), 'SPECIFY_REQUIRED');
    assert.equal(described.code, 'SPECIFY_REQUIRED');
    assert.ok(described.text.startsWith('Specify is required for this project'));
    assert.ok(described.text.includes('This project requires Specify.'));
  });
}

async function orderTests() {
  section('order ranks (T-499)');
  const { orderUpdates, orderMoves, ORDER_STEP } = await load('order.js');
  const { columnOf, compareTasks } = await load('board.js');
  /** Apply updates and re-sort the way the board does. */
  const applyOrderUpdates = (column, updates) => {
    const byId = new Map(updates.map((update) => [update.id, update.order]));
    return column.map((row) => (byId.has(row.id) ? { ...row, order: byId.get(row.id) } : row)).sort(compareTasks);
  };
  const t = (id, order, status = 'open') => task({ id, order, status });
  const idsOf = (column) => column.map((row) => row.id);

  check('the column is the card status in board order', () => {
    const rows = [t('T-3', null), t('T-1', 2000), t('T-2', 1000), t('T-9', 5, 'done')];
    assert.deepEqual(idsOf(columnOf(rows, rows[0])), ['T-2', 'T-1', 'T-3']);
  });

  check('a midpoint between ranked neighbours is one write', () => {
    const column = [t('A', 1000), t('B', 2000), t('C', 3000)];
    assert.deepEqual(orderUpdates(column, 'C', 'up'), [{ id: 'C', order: 1500 }]);
    assert.deepEqual(orderUpdates(column, 'A', 'down'), [{ id: 'A', order: 2500 }]);
    assert.deepEqual(idsOf(applyOrderUpdates(column, orderUpdates(column, 'C', 'up'))), ['A', 'C', 'B']);
  });

  check('the edges step past the ranked neighbour', () => {
    const column = [t('A', 1000), t('B', 2000), t('C', 3000)];
    assert.deepEqual(orderUpdates(column, 'C', 'top'), [{ id: 'C', order: 1000 - ORDER_STEP }]);
    assert.deepEqual(orderUpdates(column, 'B', 'down'), [{ id: 'B', order: 3000 + ORDER_STEP }]);
  });

  check('impossible or empty moves write nothing', () => {
    const column = [t('A', 1000), t('B', 2000)];
    assert.deepEqual(orderUpdates(column, 'A', 'up'), []);
    assert.deepEqual(orderUpdates(column, 'A', 'top'), []);
    assert.deepEqual(orderUpdates(column, 'B', 'down'), []);
    assert.deepEqual(orderUpdates(column, 'Z', 'up'), []);
    assert.deepEqual(orderUpdates(column, 'A', 'sideways'), []);
    assert.deepEqual(orderUpdates(null, 'A', 'down'), []);
  });

  check('an unranked neighbour falls back to a sparse re-rank of the head only', () => {
    const column = [t('A', 1000), t('B', null), t('C', null), t('D', null)];
    // C up: between A and B, B is unranked → rank A (unchanged) and C only.
    assert.deepEqual(orderUpdates(column, 'C', 'up'), [{ id: 'C', order: 2000 }]);
    assert.deepEqual(idsOf(applyOrderUpdates(column, orderUpdates(column, 'C', 'up'))), ['A', 'C', 'B', 'D']);
    // A down into the unranked tail: B gets a rank above A's new one; C, D stay unranked.
    const down = orderUpdates(column, 'A', 'down');
    assert.deepEqual(down, [
      { id: 'B', order: 1000 },
      { id: 'A', order: 2000 },
    ]);
    assert.deepEqual(idsOf(applyOrderUpdates(column, down)), ['B', 'A', 'C', 'D']);
  });

  check('a fully unranked column ranks only what it must', () => {
    const column = [t('T-1', null), t('T-2', null), t('T-3', null)];
    const up = orderUpdates(column, 'T-3', 'up');
    assert.deepEqual(up, [
      { id: 'T-1', order: 1000 },
      { id: 'T-3', order: 2000 },
    ]);
    assert.deepEqual(idsOf(applyOrderUpdates(column, up)), ['T-1', 'T-3', 'T-2']);
  });

  check('an exhausted gap re-ranks, sending only changed values', () => {
    const column = [t('A', 1000), t('B', 1000 + 1e-9), t('C', 3000)];
    const updates = orderUpdates(column, 'C', 'up');
    assert.deepEqual(updates, [
      { id: 'C', order: 2000 },
      { id: 'B', order: 3000 },
    ]);
    assert.deepEqual(idsOf(applyOrderUpdates(column, updates)), ['A', 'C', 'B']);
    // Tied ranks are the same case.
    const tied = [t('A', 5), t('B', 5), t('C', 5)];
    assert.deepEqual(idsOf(applyOrderUpdates(tied, orderUpdates(tied, 'C', 'up'))), ['A', 'C', 'B']);
  });

  check('orderMoves hides top from second place and everything for a lone card', () => {
    const column = [t('A', 1), t('B', 2), t('C', 3), t('D', 4)];
    assert.deepEqual(orderMoves(column, 'A'), ['down']);
    assert.deepEqual(orderMoves(column, 'B'), ['up', 'down']);
    assert.deepEqual(orderMoves(column, 'C'), ['top', 'up', 'down']);
    assert.deepEqual(orderMoves(column, 'D'), ['top', 'up']);
    assert.deepEqual(orderMoves([t('A', 1)], 'A'), []);
    assert.deepEqual(orderMoves(column, 'Z'), []);
  });
}

async function editorTests() {
  section('panel editors and the comment box (T-499)');
  const editor = await load('editor.js');
  const panelLib = await load('panel.js');
  const t = task({ id: 'T-5', title: 'Old title', priority: 'medium', tags: ['ui', 'api'] });
  const detail = (description, truncated = false) => ({ task: { ...t, description, descriptionTruncated: truncated } });

  check('title: trimmed, required, bounded, unchanged is a no-op', () => {
    assert.deepEqual(editor.titleEdit({ project: 'alpha', task: t, value: '  New   title ' }), {
      operation: 'task.update',
      input: { project: 'alpha', id: 'T-5', title: 'New title' },
    });
    assert.deepEqual(editor.titleEdit({ project: 'alpha', task: t, value: ' Old title ' }), { noop: true });
    assert.ok(editor.titleEdit({ project: 'alpha', task: t, value: '   ' }).error);
    assert.ok(editor.titleEdit({ project: 'alpha', task: t, value: 'x'.repeat(201) }).error);
    assert.equal(editor.titleEdit({ project: 'alpha', task: t, value: 'x'.repeat(200) }).input.title.length, 200);
    assert.ok(editor.titleEdit({ task: t, value: 'x' }).error, 'no project, no request');
  });

  check('description: lossless plain text, only when changed', () => {
    const current = detail('line 1\nline 2\n');
    assert.deepEqual(editor.descriptionEdit({ project: 'alpha', detail: current, value: 'line 1\r\nline 2\r\n' }), {
      noop: true,
    });
    const long = 'x'.repeat(5000);
    assert.deepEqual(editor.descriptionEdit({ project: 'alpha', detail: current, value: `  ${long}\n\n` }), {
      operation: 'task.update',
      input: { project: 'alpha', id: 'T-5', description: `  ${long}\n\n` },
    });
    assert.deepEqual(editor.descriptionEdit({ project: 'alpha', detail: current, value: '' }).input.description, '');
    assert.ok(editor.descriptionEdit({ project: 'alpha', detail: current, value: 'x'.repeat(16385) }).error);
  });

  check("the editor's description rules agree with the panel's readers", () => {
    // editor.js repeats panel.js' two readers (lib modules are import-free);
    // this pins the copies together.
    for (const sample of ['a\r\nb', 'a\rb', '', 'plain']) {
      const d = detail(sample);
      assert.equal(editor.descriptionEdit({ project: 'alpha', detail: d, value: panelLib.descriptionText(d) }).noop, true);
    }
    const cut = detail('x', true);
    assert.equal(panelLib.descriptionTruncated(cut), true);
    assert.equal(editor.canEditDescription(cut), !panelLib.descriptionTruncated(cut));
  });

  check('a truncated description is never written back', () => {
    const cut = detail('head only', true);
    assert.equal(editor.canEditDescription(cut), false);
    assert.equal(editor.canEditDescription(detail('whole')), true);
    const refused = editor.descriptionEdit({ project: 'alpha', detail: cut, value: 'head only, edited' });
    assert.ok(refused.error);
    assert.equal('operation' in refused, false);
  });

  check('priority: enum only, unchanged is a no-op', () => {
    assert.deepEqual(editor.priorityEdit({ project: 'alpha', task: t, value: 'high' }), {
      operation: 'task.update',
      input: { project: 'alpha', id: 'T-5', priority: 'high' },
    });
    assert.deepEqual(editor.priorityEdit({ project: 'alpha', task: t, value: 'medium' }), { noop: true });
    assert.deepEqual(editor.priorityEdit({ project: 'alpha', task: { ...t, priority: undefined }, value: 'medium' }), {
      noop: true,
    });
    assert.ok(editor.priorityEdit({ project: 'alpha', task: t, value: 'urgent' }).error);
  });

  check('tags: parsed, deduplicated, bounded, order-sensitive diff', () => {
    assert.deepEqual(editor.parseTags(' #ui, api,, ui , #docs '), ['ui', 'api', 'docs']);
    assert.equal(editor.formatTags(['ui', 'api']), 'ui, api');
    assert.deepEqual(editor.tagsEdit({ project: 'alpha', task: t, value: 'ui, api' }), { noop: true });
    assert.deepEqual(editor.tagsEdit({ project: 'alpha', task: t, value: 'api, ui' }).input.tags, ['api', 'ui']);
    assert.deepEqual(editor.tagsEdit({ project: 'alpha', task: t, value: '' }).input.tags, []);
    const many = Array.from({ length: 21 }, (_, i) => `t${i}`).join(',');
    assert.ok(editor.tagsEdit({ project: 'alpha', task: t, value: many }).error);
    assert.ok(editor.tagsEdit({ project: 'alpha', task: t, value: 'x'.repeat(41) }).error);
  });

  check('comment: 1..2000 after trimming, blank sends nothing', () => {
    assert.deepEqual(editor.commentRequest({ project: 'alpha', task: t, value: '  Looks good\r\n' }), {
      operation: 'task.comment',
      input: { project: 'alpha', id: 'T-5', message: 'Looks good' },
    });
    assert.deepEqual(editor.commentRequest({ project: 'alpha', task: t, value: '   \n ' }), { noop: true });
    assert.equal(editor.commentRequest({ project: 'alpha', task: t, value: 'x'.repeat(2000) }).input.message.length, 2000);
    assert.ok(editor.commentRequest({ project: 'alpha', task: t, value: 'x'.repeat(2001) }).error);
    assert.equal(editor.commentRemaining('x'.repeat(1990)), 10);
    assert.equal(editor.commentRemaining(null), 2000);
    assert.equal(editor.MAX_COMMENT, 2000);
  });

  check('new task: a bounded title and the project, nothing else', () => {
    assert.deepEqual(editor.createRequest({ project: 'alpha', title: '  Ship   it ' }), {
      operation: 'task.create',
      input: { project: 'alpha', title: 'Ship it' },
    });
    assert.ok(editor.createRequest({ project: 'alpha', title: ' ' }).error);
    assert.ok(editor.createRequest({ title: 'x' }).error);
    assert.ok(editor.createRequest({ project: 'alpha', title: 'x'.repeat(129) }).error);
    assert.equal(editor.SPECIFY_REQUIRED, 'SPECIFY_REQUIRED');
  });
}

async function main() {
  await needsMeTests();
  await deepLinkTests();
  await settingsTests();
  await watchStateTests();
  await boardTests();
  await actionTests();
  await panelTests();
  await viewStateTests();
  await embedTests();
  await viewStateT499Tests();
  await menuT499Tests();
  await orderTests();
  await editorTests();
  console.log(`\n${failed ? '❌' : '✅'} control UI lib: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
