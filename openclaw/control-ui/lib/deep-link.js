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

const MAX_PARAM_LENGTH = 128;

/** An identifier (project name, task id) or null. */
export function boundedParam(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > MAX_PARAM_LENGTH) return null;
  // Project names and task ids are identifiers; anything else is not a link.
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(text) ? text : null;
}

/** Page params for `host.navigation.openPage`; only defined values survive. */
export function buildPageParams({ project, task } = {}) {
  const params = {};
  const name = boundedParam(project);
  if (name) params[PROJECT_PARAM] = name;
  const id = boundedParam(task);
  if (id && name) params[TASK_PARAM] = id;
  return params;
}

/** Read the selection back out of the view's props. */
export function readPageParams(props) {
  const project = boundedParam(props?.[PROJECT_PARAM]);
  const task = project ? boundedParam(props?.[TASK_PARAM]) : null;
  return { project: project || null, task: task || null };
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
