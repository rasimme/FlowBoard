/**
 * A request to show one project (and optionally open one task), made from
 * outside the React tree (T-515-6): the host page's `project` / `task`
 * parameters, or a click in the native widget or session panel.
 *
 * The request is held here until the dashboard shell can act on it, so it may
 * arrive before the first snapshot has loaded.
 */
let pending = null;
const listeners = new Set();

export function requestDeepLink(link) {
  const project = typeof link?.project === 'string' ? link.project.trim() : '';
  if (!project) return;
  const task = typeof link?.task === 'string' && link.task.trim() ? link.task.trim() : null;
  pending = { project, task };
  listeners.forEach((listener) => listener());
}

/** The pending request, consumed. */
export function takeDeepLink() {
  const link = pending;
  pending = null;
  return link;
}

export function subscribeDeepLink(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
