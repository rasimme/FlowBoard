/**
 * Deep links into the FlowBoard page (T-487-8, retargeted in T-498 and T-499).
 *
 *  - **Control UI page params** — `host.navigation.openPage({ id, params })`
 *    puts `?p.project=…&p.task=…` in the Control UI's own URL and hands them
 *    back as the view's `props`. They open the **native** board and its
 *    detail panel, so a shared link lands on the task itself; the back button
 *    and a reloaded page restore the same view.
 *  - **The standalone dashboard link** — "Open in FlowBoard ↗". The whole SPA
 *    is no longer framed (T-499 retired `buildFrameUrl`); framed surfaces are
 *    built by `embed.js`. The standalone SPA has no URL routing for a project
 *    or a task, so the link carries only the agent the rail follows, which
 *    the SPA does read (`agentId`).
 */

export const PROJECT_PARAM = 'project';
export const TASK_PARAM = 'task';
export const AGENT_PARAM = 'agentId';
export const TAB_PARAM = 'tab';
export const FILE_PARAM = 'file';

const MAX_PARAM_LENGTH = 128;
const MAX_FILE_LENGTH = 512;

/*
 * The tabs a link may name. Repeated from view-state.js `TABS` (and the file
 * rule from embed.js `boundedFile`) rather than imported: the lib modules stay
 * import-free for the unit tests. `board` is the default and never written;
 * the transient `specify` view is never a link.
 */
const LINK_TABS = new Set(['ideas', 'files', 'projects']);

/** A workspace-relative file path: bounded, no control characters, no traversal. */
function boundedFile(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > MAX_FILE_LENGTH) return null;
  if (/[\u0000-\u001f\u007f]/u.test(text)) return null;
  if (text.startsWith('/') || text.split(/[\\/]/u).includes('..')) return null;
  return text;
}

/** An identifier (project name, task id) or null. */
export function boundedParam(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > MAX_PARAM_LENGTH) return null;
  // Project names and task ids are identifiers; anything else is not a link.
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(text) ? text : null;
}

/**
 * Page params for `host.navigation.openPage`; only defined values survive.
 * `tab` is written only for a framed tab (a link without it is the board, as
 * every link before T-499 was) and `file` only with the Files tab.
 */
export function buildPageParams({ project, task, tab, file } = {}) {
  const params = {};
  const name = boundedParam(project);
  if (name) params[PROJECT_PARAM] = name;
  const id = boundedParam(task);
  if (id && name) params[TASK_PARAM] = id;
  if (LINK_TABS.has(tab)) {
    params[TAB_PARAM] = tab;
    const path = tab === 'files' && name ? boundedFile(file) : null;
    if (path) params[FILE_PARAM] = path;
  }
  return params;
}

/** Read the selection (and the tab / file, T-499) back out of the view's props. */
export function readPageParams(props) {
  const project = boundedParam(props?.[PROJECT_PARAM]);
  const task = project ? boundedParam(props?.[TASK_PARAM]) : null;
  const tab = LINK_TABS.has(props?.[TAB_PARAM]) ? props[TAB_PARAM] : 'board';
  const file = tab === 'files' && project ? boundedFile(props?.[FILE_PARAM]) : null;
  return { project: project || null, task: task || null, tab, file: file || null };
}

/**
 * The full dashboard in a new tab. Without an agent the configured URL is
 * returned unchanged; a URL the browser cannot parse is returned untouched.
 */
export function buildDashboardUrl(dashboardUrl, { agentId } = {}) {
  if (typeof dashboardUrl !== 'string' || !dashboardUrl) return '';
  const agent = boundedParam(agentId);
  if (!agent) return dashboardUrl;
  let url;
  try {
    url = new URL(dashboardUrl);
  } catch {
    return dashboardUrl;
  }
  url.searchParams.set(AGENT_PARAM, agent);
  return url.toString();
}
