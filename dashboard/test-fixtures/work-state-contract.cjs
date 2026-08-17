'use strict';

// Frontend-only expected contract for the backend T-443 stuck-indicator
// action endpoints. This fixture intentionally does not imply that the
// backend route is present: clients must hide actions until a response carries
// these exact descriptors and a complete canonical task.

const TRANSIENT_INDICATOR_ACTIONS = Object.freeze(['clear', 'retry']);

function expectedStuckIndicatorActionPath(project, taskId, action) {
  if (!TRANSIENT_INDICATOR_ACTIONS.includes(action)) return null;
  return `/api/projects/${encodeURIComponent(project)}/tasks/${encodeURIComponent(taskId)}`
    + `/stuck-indicator/${action}`;
}

function expectedStuckIndicatorAction(project, taskId, action, body = {}) {
  const path = expectedStuckIndicatorActionPath(project, taskId, action);
  if (!path) return null;
  return { action, method: 'POST', path, body };
}

module.exports = {
  TRANSIENT_INDICATOR_ACTIONS,
  expectedStuckIndicatorActionPath,
  expectedStuckIndicatorAction,
};
