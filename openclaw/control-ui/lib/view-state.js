/**
 * What the page is looking at: project, tab, and the open task (T-498), plus
 * the file a Files link opened and a transient Specify view (T-499).
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
 *  - A file path and a pending Specify belong to one project and one visit:
 *    switching project or clicking a tab drops them.
 *
 * `ui.focus` is derived from this state (`focusProject`): FlowBoard polls for
 * changes per focused project, so the page tells the backend which project it
 * is on and clears it on dispose rather than letting a poll outlive the view.
 */

export const TABS = [
  { id: 'board', label: 'Board', kind: 'native' },
  { id: 'ideas', label: 'Ideas', kind: 'framed' },
  { id: 'files', label: 'Files', kind: 'framed' },
  { id: 'projects', label: 'Projects', kind: 'framed' },
];

/**
 * Specify is a modal in the dashboard, not a surface (T-499): it is framed
 * only transiently, when a native "New task" hits a project that enforces it,
 * and it has no tab of its own. Closing it returns to the tab it replaced.
 */
export const SPECIFY_TAB = 'specify';

export const DEFAULT_TAB = 'board';

const TAB_IDS = new Set(TABS.map((tab) => tab.id));
const PRIORITIES = new Set(['low', 'medium', 'high']);

/** Framed tabs share the one iframe; the board tab hides it instead of unmounting it. */
export function isFramedTab(tab) {
  return tab === SPECIFY_TAB || TABS.some((entry) => entry.id === tab && entry.kind === 'framed');
}

/**
 * The view a page (re)mount starts from. Besides the selection, the page
 * params carry the tab and — on Files — the open file (T-499): the Control UI
 * may remount the page on a params navigation, and a remount must land on the
 * same surface instead of dropping the operator back on the board. Specify is
 * transient and never restored; an unknown tab means the board.
 */
export function initialViewState(selection = {}) {
  const tab = TAB_IDS.has(selection.tab) ? selection.tab : DEFAULT_TAB;
  return {
    project: selection.project || null,
    task: (selection.project && selection.task) || null,
    tab,
    file: tab === 'files' && typeof selection.file === 'string' && selection.file ? selection.file : null,
    specify: null,
  };
}

function leaveSpecify(state) {
  return state.tab === SPECIFY_TAB ? { tab: state.specify?.returnTab || DEFAULT_TAB, specify: null } : {};
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
      if (task) return { ...state, project, task, tab: DEFAULT_TAB, file: null, specify: null };
      return { ...state, ...leaveSpecify(state), project, task: null, file: null };
    }
    case 'project': {
      const project = action.project || null;
      if (project === state.project) return state;
      // A file path and a pending Specify belong to the project they came from.
      return { ...state, ...leaveSpecify(state), project, task: null, file: null };
    }
    case 'task': {
      const project = action.project || state.project;
      if (!project || !action.id) return state;
      return {
        ...state,
        project,
        task: action.id,
        tab: DEFAULT_TAB,
        file: project === state.project ? state.file : null,
        specify: null,
      };
    }
    case 'close-task':
      return state.task === null ? state : { ...state, task: null };
    case 'tab': {
      if (!TAB_IDS.has(action.tab) || action.tab === state.tab) return state;
      // Leaving the board keeps the selection: coming back must not lose the
      // open task, and the deep link in the URL stays truthful either way. A
      // click on Files opens the browser, not the last file a link opened.
      return { ...state, tab: action.tab, file: null, specify: null };
    }
    case 'open-file': {
      // The panel's spec link and a framed surface's "open spec" land here.
      if (!action.file) return state;
      const project = action.project || state.project;
      if (!project) return state;
      if (project === state.project && state.tab === 'files' && state.file === action.file) return state;
      return {
        ...state,
        project,
        task: project === state.project ? state.task : null,
        tab: 'files',
        file: action.file,
        specify: null,
      };
    }
    case 'specify': {
      if (!state.project) return state;
      const title = typeof action.title === 'string' ? action.title.trim() : '';
      return {
        ...state,
        tab: SPECIFY_TAB,
        specify: {
          title: title || null,
          priority: PRIORITIES.has(action.priority) ? action.priority : null,
          returnTab: state.tab === SPECIFY_TAB ? state.specify?.returnTab || DEFAULT_TAB : state.tab,
        },
      };
    }
    case 'specify-closed': {
      if (state.tab !== SPECIFY_TAB) return state;
      const back = leaveSpecify(state);
      // Specify that created a task hands its id back: open it.
      if (action.task) return { ...state, ...back, tab: DEFAULT_TAB, task: action.task };
      return { ...state, ...back };
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

/**
 * The deep-link values for `buildPageParams` — the URL mirrors the view. The
 * board (the default) adds nothing, so board links stay exactly what they were
 * before tabs were persisted. The transient Specify view is recorded as the
 * tab it will return to, never as itself.
 */
export function selectionOf(state) {
  const selection = { project: state?.project || null, task: state?.task || null };
  const tab = state?.tab === SPECIFY_TAB ? state.specify?.returnTab : state?.tab;
  if (TAB_IDS.has(tab) && tab !== DEFAULT_TAB) {
    selection.tab = tab;
    if (tab === 'files' && state.tab === 'files' && state.file) selection.file = state.file;
  }
  return selection;
}

/** True when the native board is the visible main view. */
export function showsBoard(state) {
  return state?.tab === DEFAULT_TAB;
}

/**
 * Where the one iframe should be for this view, or null on the board. Fed to
 * `planFrame` (embed.js).
 */
export function frameTarget(state) {
  if (!state || !isFramedTab(state.tab)) return null;
  if (state.tab === SPECIFY_TAB) {
    return {
      surface: SPECIFY_TAB,
      project: state.project,
      file: null,
      title: state.specify?.title || null,
      priority: state.specify?.priority || null,
    };
  }
  return { surface: state.tab, project: state.project, file: state.tab === 'files' ? state.file : null };
}
