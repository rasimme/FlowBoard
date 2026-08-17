# Work the Kanban board

The board is the operational heart of a project. Tasks flow left to right through five columns: **backlog → open → in-progress → review → done**.

## Move and reorder tasks

- **Change status:** drag a card to another column, or change it from the card's detail panel.
- **Reorder within a column:** drag a card up or down. The order sticks while you're in the **Custom** sort mode.
- **Sort modes:** the column toolbar offers **Custom** (your manual order), **Newest first**, and **Oldest first**. The choice is remembered. Recently moved cards float to the top of their column until you re-sort.

## Subtasks

Break a task into subtasks (one level deep — a subtask can't have its own subtasks). Each subtask shows progress, and **the parent's status is recalculated automatically** as subtasks move; a parent never auto-completes — it waits for review like any other task.

## Claim, checkpoint, review

- **Claim** a task to take ownership (this adds a lease and moves it to *in-progress*).
- Write **checkpoints** as you progress — short notes, optionally with a progress percentage.
- **Complete** sends the task to **review**. A human (or another reviewer) then **approves** it to *done* or **rejects** it back. Owners don't approve their own work.
- Set the task's **work state** separately from its lifecycle status in the detail panel: *Working*, *Waiting*, *Blocked*, or *Paused*. Waiting/blocked/paused states can include a reason, who/what is next, a responsible person, and a check-again time. The legacy `blocked` flag shown on cards is a read-only projection of the canonical *Blocked* state.
- If monitoring needs attention, the detail panel shows one **live stuck indicator** above Activity/Checkpoints, including its detected time. It is updated in place rather than added as a comment. Retry/Clear appear only when the backend provides explicit non-destructive action descriptors; they never change work state/details through a client fallback. During backend rollout, the controls may be absent until that contract is available.

## Trash, restore, archive

- **Trash** a task to soft-delete it — an **Undo** toast appears immediately, and trashed tasks collect in the **Trash** panel where you can restore them or **Empty Trash** to clear them.
- **Archive** a task (or restore it) from the card or its detail panel when you want it off the board without deleting it.

## See also

- [Search and filter tasks](search-and-filter.md)
- [Customize the project overview](customize-overview.md)
