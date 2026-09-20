'use strict';

/**
 * T-487-8 / T-498 — the pure logic behind the native Control UI page.
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
    assert.deepEqual(menuModel(task({ status: 'done' })).map((group) => group.id), ['work-state']);
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
    assert.deepEqual(review, ['review', 'move', 'work-state']);
    const open = menuModel(task({ status: 'open' })).map((group) => group.id);
    assert.deepEqual(open, ['move', 'work-state']);
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

  check('the tab strip is Board, Ideas and Files, and Board is native', () => {
    assert.deepEqual(TABS.map((tab) => tab.id), ['board', 'ideas', 'files']);
    assert.equal(DEFAULT_TAB, 'board');
    assert.equal(isFramedTab('board'), false);
    assert.equal(isFramedTab('ideas'), true);
    assert.equal(isFramedTab('files'), true);
    assert.equal(isFramedTab('nope'), false);
  });

  check('a deep link with a task selects its project and the board tab', () => {
    const state = viewReducer({ project: null, task: null, tab: 'ideas' }, { type: 'params', project: 'alpha', task: 'T-1' });
    assert.deepEqual(state, { project: 'alpha', task: 'T-1', tab: 'board' });
    assert.equal(showsBoard(state), true);
    assert.deepEqual(selectionOf(state), { project: 'alpha', task: 'T-1' });
  });

  check('a deep link with only a project keeps the tab it arrived on', () => {
    const state = viewReducer({ project: null, task: null, tab: 'files' }, { type: 'params', project: 'alpha', task: null });
    assert.deepEqual(state, { project: 'alpha', task: null, tab: 'files' });
  });

  check('an empty or unchanged link leaves the view exactly as it was', () => {
    const state = { project: 'alpha', task: 'T-1', tab: 'board' };
    assert.equal(viewReducer(state, { type: 'params', project: null, task: null }), state);
    assert.equal(viewReducer(state, { type: 'params', project: 'alpha', task: 'T-1' }), state);
  });

  check('switching project clears the open task', () => {
    const state = viewReducer({ project: 'alpha', task: 'T-1', tab: 'board' }, { type: 'project', project: 'beta' });
    assert.deepEqual(state, { project: 'beta', task: null, tab: 'board' });
    // Re-selecting the same project is not a change, so the task survives.
    const same = { project: 'alpha', task: 'T-1', tab: 'board' };
    assert.equal(viewReducer(same, { type: 'project', project: 'alpha' }), same);
  });

  check('opening a task from a framed tab switches to the board', () => {
    const state = viewReducer({ project: 'alpha', task: null, tab: 'ideas' }, { type: 'task', project: 'alpha', id: 'T-2' });
    assert.deepEqual(state, { project: 'alpha', task: 'T-2', tab: 'board' });
    // A rail row from another project carries its project with it.
    const cross = viewReducer({ project: 'alpha', task: null, tab: 'board' }, { type: 'task', project: 'beta', id: 'T-9' });
    assert.deepEqual(cross, { project: 'beta', task: 'T-9', tab: 'board' });
  });

  check('a task without a project or an id is not a selection', () => {
    const state = { project: null, task: null, tab: 'board' };
    assert.equal(viewReducer(state, { type: 'task', id: 'T-1' }), state);
    assert.equal(viewReducer({ ...state, project: 'alpha' }, { type: 'task', project: 'alpha' }).task, null);
  });

  check('closing the task keeps the project and the tab', () => {
    const state = viewReducer({ project: 'alpha', task: 'T-1', tab: 'board' }, { type: 'close-task' });
    assert.deepEqual(state, { project: 'alpha', task: null, tab: 'board' });
    assert.equal(viewReducer(state, { type: 'close-task' }), state);
  });

  check('a tab change keeps the selection, and an unknown tab is refused', () => {
    const state = { project: 'alpha', task: 'T-1', tab: 'board' };
    assert.deepEqual(viewReducer(state, { type: 'tab', tab: 'ideas' }), { project: 'alpha', task: 'T-1', tab: 'ideas' });
    assert.equal(viewReducer(state, { type: 'tab', tab: 'nope' }), state);
    assert.equal(viewReducer(state, { type: 'tab', tab: 'board' }), state);
    assert.equal(viewReducer(state, { type: 'unknown' }), state);
  });

  check('ui.focus follows the project, including across a framed tab', () => {
    assert.equal(focusProject({ project: 'alpha', task: null, tab: 'board' }), 'alpha');
    assert.equal(focusProject({ project: 'alpha', task: null, tab: 'files' }), 'alpha');
    assert.equal(focusProject({ project: null, task: null, tab: 'board' }), null);
    assert.equal(focusProject(null), null);
  });

  check('the initial state comes from the deep link the page was opened with', () => {
    assert.deepEqual(initialViewState({ project: 'alpha', task: 'T-1' }), { project: 'alpha', task: 'T-1', tab: 'board' });
    assert.deepEqual(initialViewState({ project: null, task: 'T-1' }), { project: null, task: null, tab: 'board' });
    assert.deepEqual(initialViewState(), { project: null, task: null, tab: 'board' });
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
  console.log(`\n${failed ? '❌' : '✅'} control UI lib: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
