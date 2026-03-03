# Subtasks — Design Document

**Goal:** Enable breaking large features into parent tasks with subtasks, displayed as collapsible groups in the Kanban board with automatic progress tracking.
**Date:** 2026-03-03
**Architecture:** Flat task array with `parentId` field. Server-side parent status auto-calculation. Kanban renders collapsible groups with progress bars.
**Tech Stack:** Express 5 (server.js), Vanilla JS (kanban.js, utils.js), no new dependencies.

## Problem
Large features (e.g. "Canvas Redesign" with 12 steps) are tracked as individual unrelated tasks. There's no way to see they belong together, track overall progress, or delegate subtasks to CC individually while maintaining the big picture.

## Lösung
Add subtask support: flat data model with `parentId`, server-side parent status auto-calculation, collapsible Kanban groups with progress bars. Max one level deep (no nested subtasks).

## Komponenten

### 1. Data Model (tasks.json)

Existing task schema gets two new optional fields:

```json
{
  "id": "T-024",
  "title": "Canvas → Task Promote",
  "status": "in-progress",
  "priority": "high",
  "parentId": null,
  "subtaskIds": ["T-024-1", "T-024-2", "T-024-3"]
}
```

- **`parentId`** (string|null) — If set, this task is a subtask of the given ID
- **`subtaskIds`** (string[]|undefined) — Convenience array on parent, auto-maintained by server

Subtask ID format: `T-{parentNum}-{seq}` (e.g. T-024-1, T-024-2). This makes hierarchy immediately visible.

### 2. API Changes (server.js)

**POST /api/projects/:name/tasks** — Extended:
- Accepts optional `parentId` in body
- If `parentId` given: validates parent exists, validates parent is not itself a subtask (max 1 level)
- Generates subtask ID: `{parentId}-{next seq number}`
- Adds subtask ID to parent's `subtaskIds` array
- Returns reminder as usual

**PUT /api/projects/:name/tasks/:id** — Extended:
- On status change of a subtask: recalculate parent status via `recalcParentStatus()`
- Returns updated parent in response: `{ ok, task, parentUpdated: { id, status, progress } }`

**DELETE /api/projects/:name/tasks/:id** — Extended:
- If task has `subtaskIds`: require `mode` query param
  - `mode=all` → delete parent + all subtasks + their specs
  - `mode=keep-children` → delete parent, remove `parentId` from subtasks (promote to top-level)
  - No mode → return 400 with `{ error: "Task has subtasks", subtaskCount: N }` (let client show dialog)
- If task is a subtask: delete normally, remove from parent's `subtaskIds`, recalculate parent status

**GET /api/projects/:name/tasks** — Extended:
- Add computed `progress` field to parent tasks: `{ done: 2, total: 5 }`
- taskContext nudge includes parent info for subtasks

### 3. Parent Status Auto-Calculation

Pure function `recalcParentStatus(tasks, parentId)`:

```
Rules:
- Any subtask moves to in-progress → parent becomes in-progress (if was open)
- ALL subtasks done → parent becomes review
- Parent set to done → only manually by user/agent (never auto)
- Subtask reopened → parent reverts to in-progress (if was review)
```

Never overrides a manually-set `done` status on the parent.

### 4. Kanban UI (kanban.js)

**Parent card rendering:**
- Normal card appearance + progress bar at bottom (thin, colored segments: green=done, blue=in-progress, grey=open)
- Expand/collapse chevron (▶/▼) on the left
- Text: "3/5 subtasks" next to progress bar
- Default: **collapsed**

**Expanded subtask cards:**
- Appear directly below parent card, within the same column
- Left indent (~12px) + thin colored left border (matches parent priority color)
- Slightly smaller font (0.9em) or subtler background
- Show: ID badge, title, priority dot, status dot (● colored by status)
- Subtasks stay under their parent regardless of subtask status — they do NOT move between columns
- Status shown as colored dot: 🟢 done, 🔵 in-progress, ⚪ open, 🟡 review

**Filtering:**
- Top-level view (default): only show tasks where `parentId` is null
- Subtasks only visible when parent is expanded

### 5. Subtask ID Generation

```js
function nextSubtaskId(parentId, existingSubtaskIds) {
  // parentId = "T-024", existing = ["T-024-1", "T-024-2"]
  // → returns "T-024-3"
  const nums = existingSubtaskIds.map(id => {
    const parts = id.split('-');
    return parseInt(parts[parts.length - 1], 10);
  }).filter(n => !isNaN(n));
  const next = nums.length ? Math.max(...nums) + 1 : 1;
  return `${parentId}-${next}`;
}
```

## Datenfluss

### Creating a subtask:
1. Agent/UI calls `POST /tasks` with `{ title, parentId: "T-024" }`
2. Server validates: parent exists, parent has no parentId (max 1 level)
3. Server generates ID: `T-024-3`
4. Server adds `T-024-3` to parent's `subtaskIds` array
5. Server writes tasks.json
6. Response: `{ ok, task: { id: "T-024-3", parentId: "T-024", ... }, reminder: "..." }`

### Subtask status change:
1. Agent calls `PUT /tasks/T-024-3` with `{ status: "done" }`
2. Server updates subtask status
3. Server calls `recalcParentStatus()` → checks all siblings
4. If all done → parent.status = "review"
5. Server writes tasks.json
6. Response: `{ ok, task, parentUpdated: { id: "T-024", status: "review", progress: { done: 5, total: 5 } }, reminder: "..." }`

### Deleting a parent:
1. Agent/UI calls `DELETE /tasks/T-024`
2. Server detects subtaskIds → returns 400: `{ error: "Task has subtasks", subtaskCount: 3 }`
3. UI shows modal: "Subtasks behalten" / "Alles löschen"
4. UI retries with `?mode=all` or `?mode=keep-children`
5. Server executes accordingly, cleans up specs if mode=all

## Error Handling

| Fehler | Reaktion |
|--------|----------|
| parentId not found | 400 — "Parent task not found" |
| parentId is itself a subtask | 400 — "Cannot nest subtasks (max 1 level)" |
| parentId = own ID | 400 — "Task cannot be its own parent" |
| DELETE parent with subtasks (no mode) | 400 — `{ error: "Task has subtasks", subtaskCount: N }` |
| recalcParentStatus throws | catch + warn, don't block the subtask update |
| Subtask spec deletion on cascade | Delete spec file + clear specFile field for each subtask |

## Testing

Manual API testing (same approach as API Reminders):

1. **Create subtask:** POST with parentId → verify subtask ID format, parent's subtaskIds updated
2. **Status cascade:** Set subtask to in-progress → parent auto-becomes in-progress
3. **All done:** Set all subtasks to done → parent auto-becomes review
4. **Reopen:** Set one subtask back to open → parent reverts to in-progress
5. **Delete subtask:** Delete one → parent's subtaskIds updated, progress recalculated
6. **Delete parent (all):** DELETE with ?mode=all → parent + subtasks + specs gone
7. **Delete parent (keep):** DELETE with ?mode=keep-children → subtasks become top-level
8. **Nesting prevention:** Try to create subtask of subtask → 400
9. **Kanban:** Parent shows progress bar, expand shows subtasks with status dots
10. **Edge cases:** Last subtask deleted, parent with 0 subtasks, subtask without valid parent

## Decisions

| Decision | Reasoning | Alternatives |
|----------|-----------|-------------|
| Flat array with parentId | API stays uniform, reminders/nudges work automatically, no nested parsing | Nested subtasks array (complex API, breaks existing consumers) |
| Max 1 level deep | YAGNI, keeps Kanban renderable, avoids tree traversal complexity | Unlimited nesting (overengineered, UI nightmare) |
| Subtask IDs as T-{parent}-{seq} | Hierarchy visible in ID, no collision with top-level IDs | Separate ID counter (loses visual hierarchy) |
| Server-side parent status calc | Single source of truth, works for agent + UI | Client-side calc (inconsistent across consumers) |
| Subtasks don't move columns | Clean Kanban, status shown as dot badge | Subtasks as free-floating cards (cluttered, loses grouping) |
| Delete parent requires mode param | Explicit choice, no accidental data loss | Auto-cascade (dangerous), always keep (inflexible) |
| Parent→done only manual | Agent/user confirms feature is complete, not just subtasks | Auto-done (risky, might skip final review) |
