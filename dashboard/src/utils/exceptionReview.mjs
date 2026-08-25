// Selection rules shared by the Kanban exception-review filter and its tests.
// Pending delegated work remains visible even when it has a parentId: the
// review action applies to the created task, not only to top-level parents.
export function tasksForExceptionReview(tasks, enabled) {
  const source = Array.isArray(tasks) ? tasks : [];
  return enabled
    ? source.filter(task => task?.exceptionReview?.status === 'pending')
    : source;
}

// T-449-5: structureReview (see dashboard/task-discipline.js /
// hzl-service.js reviewStructure) mirrors exceptionReview's shape and its
// one-way pending -> reviewed action exactly, so it gets its own filter
// with identical selection logic. Kept as a sibling function rather than a
// parameterized version of tasksForExceptionReview: the two flags describe
// genuinely different facts about a task (a validated creation-policy
// exception vs. a task-discipline form check), and a caller may want to
// ask for either independently — collapsing them into one filter would
// make "show me only the structurally-flagged tasks" impossible to
// express as its own board view.
export function tasksForStructureReview(tasks, enabled) {
  const source = Array.isArray(tasks) ? tasks : [];
  return enabled
    ? source.filter(task => task?.structureReview?.status === 'pending')
    : source;
}

// Union of the two review filters, used to build the Kanban source list
// when either (or both) toggle is active. With neither active this is the
// identity — the normal board.
export function pendingReviewTasks(tasks, { exceptionReview = false, structureReview = false } = {}) {
  const source = Array.isArray(tasks) ? tasks : [];
  if (!exceptionReview && !structureReview) return source;
  return source.filter(task => (
    (exceptionReview && task?.exceptionReview?.status === 'pending')
    || (structureReview && task?.structureReview?.status === 'pending')
  ));
}

// `reviewFilterEnabled` covers either review toggle: same rule as before
// (a review-pending subtask must stay visible even though a normal board
// hides non-top-level cards), now shared by both review kinds.
export function boardTopLevelTasks(tasks, reviewFilterEnabled) {
  const source = Array.isArray(tasks) ? tasks : [];
  return reviewFilterEnabled ? source : source.filter(task => !task?.parentId);
}

// Human-readable labels for the structureReview reason codes emitted by
// dashboard/task-discipline.js:reasonsFor(). Kept next to the review
// selection helpers so the Kanban badge and the DetailPanel block share one
// vocabulary instead of duplicating it.
const STRUCTURE_REASON_LABELS = {
  flat_batch: 'flat batch of tasks',
  missing_description: 'missing description',
  title_pattern: 'generic title',
  missing_spec_link: 'no spec link',
};
export function describeStructureReasons(reasons) {
  const list = Array.isArray(reasons) ? reasons : [];
  if (!list.length) return 'form check';
  return list.map(reason => STRUCTURE_REASON_LABELS[reason] || reason).join(', ');
}
