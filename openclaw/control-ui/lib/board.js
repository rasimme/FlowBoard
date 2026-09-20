/**
 * The Kanban board's pure logic (T-498).
 *
 * `openclaw/control-ui/index.js` only builds DOM; every decision that can be
 * made without one lives here and is unit-tested in
 * `dashboard/test-control-ui-lib.js`. The vocabulary is FlowBoard's own
 * (docs/concepts/kanban.md): five lifecycle columns, `archived` hidden, a work
 * state orthogonal to the column, and a claim whose lease can go stale.
 *
 * Three rules this module encodes, because each one is a real failure mode:
 *
 *  1. **Unknown values are never invented.** A status the board has no column
 *     for is dropped rather than shown in a lane whose meaning it may not
 *     share; an unknown work state falls back to its own raw text, not to
 *     "Active". A newer server must never make an older bundle lie.
 *  2. **`working` is invisible.** It is the default state of everything, so a
 *     chip for it would be noise on every card (ADR-0031 / the SPA's
 *     WorkStateChip, which renders no chip for Active either).
 *  3. **Sort is `order`, then id — never insertion order.** The contract's
 *     `order` is nullable, so a board where some cards have never been ranked
 *     must still come out in a stable, human-sensible order, which means a
 *     natural id compare (T-9 before T-10, T-128-2 before T-128-10).
 */

export const BOARD_COLUMNS = [
  { id: 'backlog', label: 'Backlog' },
  { id: 'open', label: 'Open' },
  { id: 'in-progress', label: 'In Progress' },
  { id: 'review', label: 'Review' },
  { id: 'done', label: 'Done' },
];

/** The five columns, in board order. `archived` is deliberately not one. */
export const BOARD_STATUSES = BOARD_COLUMNS.map((column) => column.id);

export const STATUS_LABELS = {
  backlog: 'Backlog',
  open: 'Open',
  'in-progress': 'In Progress',
  review: 'Review',
  done: 'Done',
  archived: 'Archived',
};

/** Canonical work states (ADR-0031). `working` is the invisible default. */
export const WORK_STATES = ['working', 'waiting', 'blocked', 'paused'];

/** The SPA's words for them, so the two surfaces read the same. */
export const WORK_STATE_LABELS = {
  working: 'Active',
  waiting: 'Waiting',
  blocked: 'Blocked',
  paused: 'Paused',
};

export const PRIORITIES = ['low', 'medium', 'high'];

export function statusLabel(status) {
  return STATUS_LABELS[status] || String(status ?? '');
}

export function workStateLabel(workState) {
  return WORK_STATE_LABELS[workState] || String(workState ?? '');
}

/** Whether a card shows a work-state chip at all — see rule 2 above. */
export function showsWorkState(task) {
  const workState = task?.workState;
  return Boolean(workState) && workState !== 'working';
}

/**
 * Compare two ids the way a human reads them: chunk by chunk, numbers
 * numerically. `T-9` sorts before `T-10`, `T-128-2` before `T-128-10`.
 */
export function compareIds(left, right) {
  const a = String(left ?? '');
  const b = String(right ?? '');
  const chunks = /(\d+|\D+)/gu;
  const as = a.match(chunks) || [];
  const bs = b.match(chunks) || [];
  for (let index = 0; index < Math.max(as.length, bs.length); index += 1) {
    const x = as[index];
    const y = bs[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/u.test(x);
    const yn = /^\d+$/u.test(y);
    if (xn && yn) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff < 0 ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Board order inside one column: `order` ascending, unranked cards last, ties
 * broken by id. Never mutates the input.
 */
export function compareTasks(left, right) {
  const a = Number.isFinite(left?.order) ? left.order : null;
  const b = Number.isFinite(right?.order) ? right.order : null;
  if (a !== null && b !== null && a !== b) return a < b ? -1 : 1;
  if (a !== null && b === null) return -1;
  if (a === null && b !== null) return 1;
  return compareIds(left?.id, right?.id);
}

/**
 * Split a `tasks.list` answer into the five columns. Archived tasks and any
 * status without a column are dropped (rule 1); each column reports its own
 * count so the header never has to re-count a filtered list.
 */
export function groupTasksByStatus(tasks) {
  const rows = Array.isArray(tasks) ? tasks.filter((task) => task && typeof task === 'object') : [];
  return BOARD_COLUMNS.map((column) => {
    const items = rows.filter((task) => task.status === column.id).sort(compareTasks);
    return { id: column.id, label: column.label, tasks: items, count: items.length };
  });
}

/** How many cards the board will actually render. */
export function countBoardTasks(tasks) {
  return groupTasksByStatus(tasks).reduce((total, column) => total + column.count, 0);
}

function parseTime(value) {
  if (typeof value !== 'string' || !value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/**
 * The claim's health. A lease that has passed means the task is *de facto*
 * released and anyone may reclaim it (docs/concepts/kanban.md), which is worth
 * a hint on the card — the card must not keep implying someone is on it.
 */
export function leaseState(task, now = Date.now()) {
  const until = parseTime(task?.leaseUntil);
  if (until === null) return { state: 'none', label: '', minutes: 0 };
  const minutes = Math.round((now - until) / 60000);
  if (until > now) {
    return { state: 'held', label: `lease ${formatDuration(until - now)} left`, minutes: -minutes };
  }
  return { state: 'stale', label: `lease expired ${formatDuration(now - until)} ago`, minutes };
}

/** Compact, locale-free duration for hints. Bounded to days. */
export function formatDuration(ms) {
  const minutes = Math.max(0, Math.round(Number(ms) / 60000));
  if (minutes < 1) return 'less than a minute';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

/** "3 subtasks" for a parent, "subtask of T-128" for a child, else ''. */
export function relationLabel(task) {
  if (task?.parentId) return `subtask of ${task.parentId}`;
  const count = Number(task?.subtaskCount);
  if (Number.isFinite(count) && count > 0) return `${count} subtask${count === 1 ? '' : 's'}`;
  return '';
}

/**
 * One short line out of the transient stuck indicator
 * (`{ active, reason, message, since, detectedAt }` or null).
 *
 * `active: false` is a cleared incident the server still carries, so it must
 * not put a warning back on a card. Anything else degrades to a neutral line
 * rather than rendering `[object Object]` — the shape is the server's and it
 * is explicitly transient.
 */
export function stuckLabel(task) {
  const indicator = task?.stuckIndicator;
  if (!indicator || typeof indicator !== 'object') return '';
  if (indicator.active === false) return '';
  for (const key of ['reason', 'message']) {
    const value = indicator[key];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 120);
  }
  return 'needs attention';
}

/**
 * The work-state detail worth one line under the chip, if any. Every key is
 * always emitted and may be null, so this picks the one that explains the
 * state rather than the first one present.
 */
export function workStateDetail(task) {
  const details = task?.workStateDetails;
  if (!details || typeof details !== 'object') return '';
  const preferred = task?.workState === 'waiting' ? details.waitingFor : details.reason;
  const value = preferred || details.reason || details.waitingFor || details.responsible;
  return typeof value === 'string' ? value.trim().slice(0, 160) : '';
}
