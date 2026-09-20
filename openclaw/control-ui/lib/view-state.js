/**
 * What the page is looking at: project, tab, and the open task (T-498).
 *
 * One reducer owns all three because they are not independent, and the
 * invariants between them are exactly where a board UI goes wrong:
 *
 *  - A task selection only means something inside its project, so choosing a
 *    task sets the project too, and switching project clears the task.
 *  - A task is shown on the **Board** tab. Opening one from the rail while the
 *    framed Ideas tab is up must switch to the board, or the click appears to
 *    do nothing.
 *  - The deep link is the same state, so `?p.project=…&p.task=…` arriving from
 *    the host is just another action — a reopened page, a shared link and a
 *    click inside the page all land in one place.
 *
 * `ui.focus` is derived from this state (`focusProject`): FlowBoard polls for
 * changes per focused project, so the page tells the backend which project it
 * is on and clears it on dispose rather than letting a poll outlive the view.
 */

export const TABS = [
  { id: 'board', label: 'Board', kind: 'native' },
  { id: 'ideas', label: 'Ideas', kind: 'framed' },
  { id: 'files', label: 'Files', kind: 'framed' },
];

export const DEFAULT_TAB = 'board';

const TAB_IDS = new Set(TABS.map((tab) => tab.id));

/** Framed tabs share the one iframe; the board tab hides it instead of unmounting it. */
export function isFramedTab(tab) {
  return TABS.some((entry) => entry.id === tab && entry.kind === 'framed');
}

export function initialViewState(selection = {}) {
  return {
    project: selection.project || null,
    task: (selection.project && selection.task) || null,
    tab: DEFAULT_TAB,
  };
}

export function viewReducer(state = initialViewState(), action = {}) {
  switch (action.type) {
    case 'params': {
      // The host handed us a link. A task in it implies its project and the
      // board tab; a link with neither leaves the view alone.
      const project = action.project || null;
      const task = project ? action.task || null : null;
      if (!project) return state;
      if (project === state.project && task === state.task) return state;
      return { project, task, tab: task ? DEFAULT_TAB : state.tab };
    }
    case 'project': {
      const project = action.project || null;
      if (project === state.project) return state;
      return { project, task: null, tab: state.tab };
    }
    case 'task': {
      const project = action.project || state.project;
      if (!project || !action.id) return state;
      return { project, task: action.id, tab: DEFAULT_TAB };
    }
    case 'close-task':
      return state.task === null ? state : { ...state, task: null };
    case 'tab': {
      if (!TAB_IDS.has(action.tab) || action.tab === state.tab) return state;
      // Leaving the board keeps the selection: coming back must not lose the
      // open task, and the deep link in the URL stays truthful either way.
      return { ...state, tab: action.tab };
    }
    default:
      return state;
  }
}

/**
 * The project FlowBoard should watch for this page, or null. Kept while a
 * framed tab is up: the rail still reads the same project's counts, and a
 * re-focus on every tab click would restart the backend's poll for nothing.
 */
export function focusProject(state) {
  return state?.project || null;
}

/** The deep-link values for `buildPageParams` — the URL mirrors the view. */
export function selectionOf(state) {
  return { project: state?.project || null, task: state?.task || null };
}

/** True when the native board is the visible main view. */
export function showsBoard(state) {
  return state?.tab === DEFAULT_TAB;
}
