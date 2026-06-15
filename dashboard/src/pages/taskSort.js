// Kanban column sort (T-130, T-376). Extracted from TasksView so the ordering
// logic is unit-testable without a DOM.
//
// Modes:
//  - 'newest' / 'oldest': purely by task number; manual drag ranks ignored.
//  - 'custom': manual drag order. Tasks carry a numeric `order` once they have
//    been dropped (handleDrop assigns sparse ranks to the whole column). A
//    freshly created task has no `order` yet — it must appear at the TOP of the
//    column (T-376), so unranked tasks sort ABOVE ranked ones (newest-first
//    among themselves); ranked tasks follow in ascending rank.

export function parseTaskNum(id) {
  return parseInt(id.replace('T-', ''));
}

export function sortTasks(tasks, sortMode) {
  const byNum = (a, b, dir) => dir * (parseTaskNum(a.id) - parseTaskNum(b.id));
  if (sortMode === 'newest') return [...tasks].sort((a, b) => byNum(a, b, -1));
  if (sortMode === 'oldest') return [...tasks].sort((a, b) => byNum(a, b, 1));
  return [...tasks].sort((a, b) => {
    const ao = typeof a.order === 'number';
    const bo = typeof b.order === 'number';
    if (ao && bo) return a.order - b.order;
    // Unranked (freshly created) tasks come first so new tasks land at the top.
    if (ao) return 1;
    if (bo) return -1;
    return byNum(a, b, -1);
  });
}
