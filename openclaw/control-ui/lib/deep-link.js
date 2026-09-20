/**
 * Deep links into the FlowBoard page (T-487-8, retargeted in T-498).
 *
 * Two halves, and stage 2 changed which of them is the destination:
 *
 *  - **Control UI page params** — `host.navigation.openPage({ id, params })`
 *    puts `?p.project=…&p.task=…` in the Control UI's own URL and hands them
 *    back as the view's `props`. Since T-498 those params open the **native**
 *    board and its detail panel, so a shared link now lands on the task
 *    itself; the back button and a reloaded page restore the same view.
 *  - **The frame URL** — the dashboard URL for the framed *Ideas* and *Files*
 *    tabs, and for the "Open in FlowBoard" links. The SPA still has no URL
 *    routing for a project or a task (`src/utils/projectSelection.mjs`
 *    resolves the viewed project from the agent binding), so those two values
 *    are passed for a future SPA and the *agent* is what actually steers it:
 *    `agentId` is a parameter the SPA does read, so framing it with the agent
 *    the rail follows opens the same project the rail switched to.
 *
 * `fbFocus` is a cache-busting nonce: without it, assigning the same `src`
 * does not reload the frame, so re-opening the same target would do nothing
 * visible.
 */

export const PROJECT_PARAM = 'project';
export const TASK_PARAM = 'task';
export const AGENT_PARAM = 'agentId';

const MAX_PARAM_LENGTH = 128;

function boundedParam(value) {
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
 * The dashboard URL for a selection. With nothing to say it returns the
 * configured URL unchanged, so the ordinary page load carries no
 * FlowBoard-specific noise and the iframe is never re-pointed for nothing.
 */
export function buildFrameUrl(dashboardUrl, { project, task, focus, agentId } = {}) {
  if (typeof dashboardUrl !== 'string' || !dashboardUrl) return '';
  const params = buildPageParams({ project, task });
  const agent = boundedParam(agentId);
  if (!Object.keys(params).length && !agent) return dashboardUrl;
  let url;
  try {
    url = new URL(dashboardUrl);
  } catch {
    return dashboardUrl;
  }
  if (params[PROJECT_PARAM]) url.searchParams.set(PROJECT_PARAM, params[PROJECT_PARAM]);
  if (params[TASK_PARAM]) url.searchParams.set(TASK_PARAM, params[TASK_PARAM]);
  if (agent) url.searchParams.set(AGENT_PARAM, agent);
  if (focus) url.searchParams.set('fbFocus', String(focus).slice(0, 32));
  return url.toString();
}
