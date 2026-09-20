/**
 * The task detail panel's state (T-498).
 *
 * The panel is opened from a card, from a rail row, or straight from a deep
 * link, and its content comes from a `task.get` watch that re-runs on every
 * `tasks-changed`. That makes two races real, and both are decided here:
 *
 *  1. **A late answer for a task nobody is looking at any more.** Open T-1,
 *     open T-2 before T-1's answer lands, and the panel must not flash T-1's
 *     description into T-2's frame. Every incoming answer names the task it is
 *     for and is dropped unless it is still the open one.
 *  2. **A refresh that fails.** The same rule as the rail's watch reducer: a
 *     failed refresh never blanks a panel that already has content. It marks
 *     it stale and keeps the last good answer, because the alternative is an
 *     empty drawer every time the Gateway blips.
 *
 * Comments and checkpoints are bounded here rather than in the DOM so the
 * caps are testable and identical wherever they are rendered: the newest 20
 * comments, the newest 10 checkpoints (a panel, not an archive — the
 * "Open in FlowBoard" link is the full history).
 */

export const MAX_COMMENTS = 20;
export const MAX_CHECKPOINTS = 10;

export function initialPanelState() {
  return { open: false, project: null, id: null, phase: 'idle', data: null, error: null, updatedAt: null };
}

function sameTask(state, target) {
  return Boolean(target) && state.project === target.project && state.id === target.id;
}

export function panelReducer(state = initialPanelState(), action = {}) {
  switch (action.type) {
    case 'open': {
      if (!action.project || !action.id) return state;
      // Reopening the same task keeps what is on screen and refreshes under
      // it; opening a different one starts empty so nothing is mistaken for
      // the new task's data.
      const same = state.open && state.project === action.project && state.id === action.id;
      return {
        open: true,
        project: action.project,
        id: action.id,
        phase: same && state.data ? 'ready' : 'loading',
        data: same ? state.data : null,
        error: null,
        updatedAt: same ? state.updatedAt : null,
      };
    }
    case 'data': {
      if (!state.open) return state;
      if (action.for && !sameTask(state, action.for)) return state;
      return {
        ...state,
        phase: 'ready',
        data: action.data ?? null,
        error: null,
        updatedAt: action.at ?? state.updatedAt,
      };
    }
    case 'error': {
      if (!state.open) return state;
      if (action.for && !sameTask(state, action.for)) return state;
      const message = action.error instanceof Error ? action.error.message : String(action.error ?? 'unknown error');
      return {
        ...state,
        phase: state.data ? 'stale' : 'error',
        error: message.slice(0, 300),
      };
    }
    case 'close':
      return initialPanelState();
    default:
      return state;
  }
}

/** The task the panel is showing, once it has one. */
export function panelTask(state) {
  return state?.data?.task ?? null;
}

function timeOf(row) {
  const value = Date.parse(row?.timestamp ?? '');
  return Number.isFinite(value) ? value : 0;
}

/** Newest first, bounded. A missing or malformed list reads as empty. */
export function visibleComments(detail, limit = MAX_COMMENTS) {
  const rows = Array.isArray(detail?.comments) ? detail.comments.filter(Boolean) : [];
  return [...rows].sort((a, b) => timeOf(b) - timeOf(a)).slice(0, Math.max(0, limit));
}

export function visibleCheckpoints(detail, limit = MAX_CHECKPOINTS) {
  const rows = Array.isArray(detail?.checkpoints) ? detail.checkpoints.filter(Boolean) : [];
  return [...rows].sort((a, b) => timeOf(b) - timeOf(a)).slice(0, Math.max(0, limit));
}

/**
 * The description as plain text.
 *
 * `task.get` carries it *inside* the task, beside the card fields; the older
 * shape had it at the top level, and reading both costs one `??` and means a
 * mixed-version install shows the text instead of nothing.
 *
 * The panel renders this with `textContent`, never `innerHTML`: a FlowBoard
 * description is operator- and agent-written Markdown, and the Control UI runs
 * with the operator's full Gateway authority (ADR-0037), so rendering it as
 * markup would hand any agent that can write a task a script injection into
 * the Gateway's own UI. Line breaks are the only formatting kept, by CSS.
 */
export function descriptionText(detail) {
  const text = detail?.task?.description ?? detail?.description;
  return typeof text === 'string' ? text.replace(/\r\n?/gu, '\n') : '';
}

/** The same description, split — what a test can assert without a DOM. */
export function descriptionLines(detail) {
  const text = descriptionText(detail);
  return text ? text.split('\n') : [];
}

/** Whether the server told us it cut the description short. */
export function descriptionTruncated(detail) {
  return Boolean(detail?.task?.descriptionTruncated ?? detail?.descriptionTruncated);
}

/** The linked spec path, wherever the answer carries it. */
export function specFile(detail) {
  const value = detail?.task?.specFile ?? detail?.specFile;
  return typeof value === 'string' && value ? value : '';
}
