// Selection rules shared by the Kanban exception-review filter and its tests.
// Pending delegated work remains visible even when it has a parentId: the
// review action applies to the created task, not only to top-level parents.
export function tasksForExceptionReview(tasks, enabled) {
  const source = Array.isArray(tasks) ? tasks : [];
  return enabled
    ? source.filter(task => task?.exceptionReview?.status === 'pending')
    : source;
}

export function boardTopLevelTasks(tasks, exceptionReviewEnabled) {
  const source = Array.isArray(tasks) ? tasks : [];
  return exceptionReviewEnabled ? source : source.filter(task => !task?.parentId);
}
