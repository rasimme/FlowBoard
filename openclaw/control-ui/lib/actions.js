/**
 * What an operator may do to a card, and how it becomes a contract call
 * (T-498).
 *
 * The menu is the *primary* path — drag and drop is the pointer shortcut, not
 * the interface — so this module owns the whole decision: which items a card
 * offers, what each one requires from the human, and the exact
 * `{ operation, input }` that item turns into. Keeping that here means the
 * rule "a reject without a reason is never sent" is a unit test rather than a
 * DOM test, and that the board cannot invent an operation the contract does
 * not declare.
 *
 * Three deliberate boundaries:
 *
 *  - **`archived` is not a move target.** The contract accepts it, but
 *    archiving hides a task from every column, and a one-click hide next to
 *    five ordinary moves is a mis-click waiting to happen. Archive stays in
 *    the dashboard until stage 3 gives it a confirmation of its own.
 *  - **Approve and reject exist only in `review`.** They are the gate
 *    (ADR-0022); offering them anywhere else would suggest the gate can be
 *    skipped. `review → done` is therefore not a move either: the server
 *    refuses that update and names the approve route, so the menu offers the
 *    gate instead, and a *drag* onto Done is routed to `task.approve` rather
 *    than sent as a move that is guaranteed to fail.
 *  - **A `done` card offers no move at all.** FlowBoard's transition guard
 *    (`dashboard/task-transition-guard.js`) refuses `done → backlog | open |
 *    in-progress | review` alike — reopening accepted work needs an explicit
 *    admin override with a reason, which is not a board gesture. Offering four
 *    items that can only ever produce an error is noise, so the card keeps its
 *    work-state menu and nothing else.
 *  - **A reason is validated before the call, never after.** `task.reject`
 *    requires one; an empty box must produce an inline message and no request
 *    at all, because a rejected request still costs a round trip and reads to
 *    the operator like a server fault.
 */

/** Bound for free-text reasons. The server bounds them too; this is the UI's. */
export const REASON_MAX_LENGTH = 500;

export const BOARD_STATUS_ORDER = ['backlog', 'open', 'in-progress', 'review', 'done'];

const STATUS_LABELS = {
  backlog: 'Backlog',
  open: 'Open',
  'in-progress': 'In Progress',
  review: 'Review',
  done: 'Done',
};

const WORK_STATE_LABELS = {
  working: 'Active',
  waiting: 'Waiting',
  blocked: 'Blocked',
  paused: 'Paused',
};

/**
 * Statuses a card can be moved to: the five columns, minus its own and minus
 * the two the server refuses outright (see the header).
 */
export function moveTargets(task) {
  const from = task?.status;
  // Everything out of `done` is a reopen, and every reopen is refused.
  if (from === 'done') return [];
  return BOARD_STATUS_ORDER.filter((status) => {
    if (status === from) return false;
    if (from === 'review' && status === 'done') return false;
    return true;
  }).map((status) => ({
    id: `move:${status}`,
    kind: 'move',
    status,
    label: STATUS_LABELS[status],
  }));
}

/**
 * The four work states. `working` clears the state and never asks for a
 * reason; the other three offer one (optional — the contract does not require
 * it, and forcing prose is how "blocked: blocked" gets typed).
 */
export function workStateChoices(task) {
  return Object.keys(WORK_STATE_LABELS).map((workState) => ({
    id: `work-state:${workState}`,
    kind: 'work-state',
    workState,
    label: WORK_STATE_LABELS[workState],
    current: (task?.workState || 'working') === workState,
    reason: workState === 'working' ? 'none' : 'optional',
  }));
}

/** The approve gate — only in the review lane. */
export function reviewActions(task) {
  if (task?.status !== 'review') return [];
  return [
    { id: 'approve', kind: 'approve', label: 'Approve', reason: 'optional' },
    { id: 'reject', kind: 'reject', label: 'Reject', reason: 'required' },
  ];
}

/**
 * The whole menu for one card, as groups. Empty groups are dropped so a
 * non-review card has no dangling "Review gate" heading.
 */
export function menuModel(task) {
  const groups = [
    { id: 'review', label: 'Review gate', items: reviewActions(task) },
    { id: 'move', label: 'Move to', items: moveTargets(task) },
    { id: 'work-state', label: 'Work state', items: workStateChoices(task) },
  ];
  return groups.filter((group) => group.items.length > 0);
}

/** Every item, flattened — what keyboard navigation walks. */
export function menuItems(task) {
  return menuModel(task).flatMap((group) => group.items);
}

export function findMenuItem(task, id) {
  return menuItems(task).find((item) => item.id === id) || null;
}

function trimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * `task.reject` needs a reason. Returns the bounded text, or the message the
 * field shows — the caller must not send anything when `ok` is false.
 */
export function validateRejectReason(value) {
  const text = trimmed(value);
  if (!text) return { ok: false, error: 'A reason is required to reject.' };
  if (text.length > REASON_MAX_LENGTH) {
    return { ok: false, error: `Keep the reason under ${REASON_MAX_LENGTH} characters.` };
  }
  return { ok: true, value: text };
}

/** Optional reasons: blank means "send no reason", not "send an empty one". */
export function validateOptionalReason(value) {
  const text = trimmed(value);
  if (!text) return { ok: true, value: undefined };
  if (text.length > REASON_MAX_LENGTH) {
    return { ok: false, error: `Keep the reason under ${REASON_MAX_LENGTH} characters.` };
  }
  return { ok: true, value: text };
}

/**
 * Turn a chosen menu item into the contract call to make. Returns
 * `{ error }` when the human still owes the form something, so the caller has
 * exactly one place to branch.
 */
export function actionRequest({ project, task, item, reason } = {}) {
  if (!project || !task?.id || !item) return { error: 'Nothing to do.' };
  const id = task.id;
  if (item.kind === 'move') {
    // Leaving review for done *is* the approve gate. The menu does not offer
    // it, but a drag onto the Done column arrives here, and the server would
    // refuse the plain update and tell us to approve instead.
    if (task.status === 'review' && item.status === 'done') {
      return { operation: 'task.approve', input: { project, id } };
    }
    return { operation: 'task.update', input: { project, id, status: item.status } };
  }
  if (item.kind === 'work-state') {
    const check = validateOptionalReason(reason);
    if (!check.ok) return { error: check.error };
    const input = { project, id, workState: item.workState };
    // `workStateDetails` replaces the stored object rather than merging into
    // it, so sending `{ reason }` is also what clears a stale `waitingFor` or
    // `checkAgainAt` — and sending nothing clears the details entirely, which
    // is what "set this state without a reason" should mean. `working` is the
    // cleared state; carrying a reason into it would leave a stale
    // explanation attached to work that is running again.
    if (item.workState !== 'working' && check.value) {
      input.workStateDetails = { reason: check.value };
    }
    return { operation: 'task.update', input };
  }
  if (item.kind === 'approve') {
    const check = validateOptionalReason(reason);
    if (!check.ok) return { error: check.error };
    return {
      operation: 'task.approve',
      input: check.value ? { project, id, reason: check.value } : { project, id },
    };
  }
  if (item.kind === 'reject') {
    const check = validateRejectReason(reason);
    if (!check.ok) return { error: check.error };
    return { operation: 'task.reject', input: { project, id, reason: check.value } };
  }
  return { error: `Unknown action ${item.kind}.` };
}

/** A drag between columns is the same move the menu makes. */
export function dropRequest({ project, task, status } = {}) {
  if (!BOARD_STATUS_ORDER.includes(status)) return { error: 'Not a board column.' };
  if (task?.status === status) return { error: null, noop: true };
  return actionRequest({ project, task, item: { kind: 'move', status } });
}

/* ------------------------------------------------------- pending / errors */

/**
 * What a FlowBoard refusal means for the board, beyond the sentence FlowBoard
 * already wrote. The message is always shown; this only adds what the operator
 * cannot see from it — that the card they are looking at is out of date, or
 * that the refusal is not about them at all.
 *
 * Unknown and missing codes deliberately add nothing: the server's own text is
 * the better explanation, and inventing one around a code this bundle does not
 * know is how a UI starts lying.
 */
const ERROR_HINTS = {
  NOT_IN_REVIEW: 'This task is no longer in review — the board is refreshing.',
  NOT_OWNER: 'Another agent is holding this task.',
  WORK_STATE_INVALID: 'That work state is not one FlowBoard accepts.',
  WORK_STATE_DETAILS_INVALID: 'FlowBoard did not accept that reason.',
  flowboard_reason_required: 'A reason is required.',
  flowboard_not_found: 'This task no longer exists.',
  flowboard_unavailable: 'FlowBoard is not reachable right now — nothing was changed.',
};

/**
 * The machine-readable code of a failure, when one reached us at all.
 *
 * The browser feature client throws a plain `Error(message)` and drops the
 * rest of the refusal envelope, so the caller may have recovered the code
 * from the transport instead and passes it in; `error.code` is read too, for
 * the hosts that do attach it.
 */
export function errorCode(error, code = null) {
  const found = code ?? error?.code ?? error?.cause?.code ?? null;
  return typeof found === 'string' && found ? found : null;
}

/** The extra sentence for a code, or '' when the message says it all. */
export function actionHint(code) {
  return ERROR_HINTS[code] ?? '';
}

/** The whole failure as the card renders it: FlowBoard's text, then the hint. */
export function describeActionError(error, knownCode = null) {
  const message = error instanceof Error ? error.message : String(error ?? 'unknown error');
  const code = errorCode(error, knownCode);
  const hint = actionHint(code);
  const text = message.slice(0, 300);
  return { code, message: text, hint, text: hint && !text.includes(hint) ? `${text} — ${hint}` : text };
}

export function initialActionState() {
  return { pending: null, error: null, errorId: null, code: null, savedId: null };
}

/**
 * One in-flight write at a time, and an error that belongs to the card it came
 * from. A second card's failure must not silently replace the first card's
 * message, and a success must clear the message it replaces.
 */
export function actionReducer(state = initialActionState(), action = {}) {
  switch (action.type) {
    case 'start':
      return { pending: action.id ?? null, error: null, errorId: null, code: null, savedId: null };
    case 'settled':
      return { pending: null, error: null, errorId: null, code: null, savedId: action.id ?? null };
    case 'failed': {
      const described = describeActionError(action.error, action.code ?? null);
      return {
        pending: null,
        error: described.text,
        errorId: action.id ?? null,
        code: described.code,
        savedId: null,
      };
    }
    case 'clear':
      return initialActionState();
    default:
      return state;
  }
}

/** True while this card is the one being written. */
export function isSaving(state, id) {
  return Boolean(id) && state?.pending === id;
}

/** The error to show on this card, if the last failure was its own. */
export function errorFor(state, id) {
  return state?.errorId && state.errorId === id ? state.error : null;
}
