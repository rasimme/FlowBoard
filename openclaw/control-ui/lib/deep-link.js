/**
 * Deep links from the native rail into the framed FlowBoard SPA (T-487-8).
 *
 * Two halves, and only one of them works end to end today:
 *
 *  - **Control UI page params** — `host.navigation.openPage({ id, params })`
 *    puts `?p.project=…&p.task=…` in the Control UI's own URL and hands them
 *    back as the view's `props`. That part is real: the link is shareable, the
 *    back button works, and a reopened page restores its selection.
 *  - **The frame URL** — the same values are appended to the dashboard URL.
 *    The FlowBoard SPA has no URL routing yet (it resolves the viewed project
 *    from the agent binding, `src/utils/projectSelection.mjs`), so it ignores
 *    them and opens its own default project. The rail therefore states which
 *    task it focused instead of pretending the frame followed. Stage 2
 *    replaces the frame with native views and removes the degradation.
 *
 * `fbFocus` is a cache-busting nonce: without it, assigning the same `src`
 * does not reload the frame, so re-clicking a row would do nothing visible.
 */

export const PROJECT_PARAM = 'project';
export const TASK_PARAM = 'task';

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
 * The dashboard URL for a selection. Without one it returns the configured URL
 * unchanged, so the ordinary page load carries no FlowBoard-specific noise.
 */
export function buildFrameUrl(dashboardUrl, { project, task, focus } = {}) {
  if (typeof dashboardUrl !== 'string' || !dashboardUrl) return '';
  const params = buildPageParams({ project, task });
  if (!Object.keys(params).length) return dashboardUrl;
  let url;
  try {
    url = new URL(dashboardUrl);
  } catch {
    return dashboardUrl;
  }
  url.searchParams.set(PROJECT_PARAM, params[PROJECT_PARAM]);
  if (params[TASK_PARAM]) url.searchParams.set(TASK_PARAM, params[TASK_PARAM]);
  if (focus) url.searchParams.set('fbFocus', String(focus).slice(0, 32));
  return url.toString();
}
