# ADR-0010: Subtask depth hard-capped at one level

## Status
Accepted

## Date
2026-04-01

## Source
- private spec `specs/T-126-tasksjson-hzl-migration.md` (subtask model)
- code enforcement at `dashboard/server.js:1098,1135`: *"Cannot nest subtasks (max 1 level)"*
- code enforcement at task creation in HZL service layer (parent lookup rejects already-subtask parents)

## Context

Hierarchical task systems naturally invite arbitrary depth — a parent task with subtasks, where each subtask can have its own subtasks, recursively. Some tools (Asana, Linear) allow this; others (GitHub Issues, simple Trello) flatten everything to a single level.

For FlowBoard's use case — agent-driven task creation from canvas promotes, claim/handoff between agents, Kanban visualization — arbitrary depth has three concrete problems:

- **Visual surface.** A nested tree on a Kanban column either becomes a tiny indented list (unreadable past 2-3 levels) or expands the row vertically without bound (breaks the column metaphor). Both lose the at-a-glance signal of "how much work is in this column."
- **Claim semantics.** When `dev-botti` claims a parent task, what happens to subtasks? When it claims a subtask, does that imply claim of the parent? With one level of nesting, the rules are simple (parent and subtasks are independently claimable; parent's status auto-rolls-up from subtasks). With arbitrary depth, the rules multiply combinatorially.
- **Mental model for navigation.** "Where is task X?" becomes "find ancestor chain → click through each level." With one level of nesting, a parent's id is a prefix of every subtask's id (`T-128` → `T-128-1`, `T-128-2`); the structure is visible in the id alone.

The Specify Workflow (per ADR-0007 / concept doc) compounds this: when an agent creates work from canvas notes, it picks among "1 task / parent + subtasks (shared spec) / parent + subtasks (each with own spec)." A fourth option ("parent + subtasks + sub-subtasks") would not improve task structure for any realistic input — it would just defer the structuring decision down a level.

## Decision

A task can have **at most one level of nesting**. Concretely:

- A task with `parentId == null` is a *top-level task*. It can have any number of subtasks.
- A task with `parentId != null` is a *subtask*. It cannot have its own subtasks.

The constraint is enforced at task creation: `POST /api/projects/:name/tasks` with a `parentId` whose target is itself a subtask returns `400 Bad Request: "Cannot nest subtasks (max 1 level)"`. The check runs both in the HZL-enabled path (`dashboard/server.js:1098`) and in the legacy file-based path (`dashboard/server.js:1135`).

Subtask ids follow the parent: subtasks of `T-128` are `T-128-1`, `T-128-2`, etc. Subtask numbering is per-parent and gaps from deletions are not reused (consistent with the parent-id retention rule from ADR-0007 § decision 3).

## Consequences

- **Kanban visualization stays simple.** A column shows top-level cards plus an inline subtask-progress indicator (e.g. `3/5 subtasks done`). Clicking a parent expands to its subtasks one level deep. No tree view, no nested expanders.
- **Claim semantics are tractable.** Parent and subtasks are independently claimable. The auto-roll-up rule (parent → review when all subtasks `done`) is well-defined because there are no sub-sub-children to propagate through.
- **Ids are self-describing.** `T-128-3` is unambiguous: subtask 3 of T-128. No ancestor chain needed.
- **Forces structuring discipline.** Agents (in the Specify Workflow) and users (in manual task creation) must commit to a structure at the point of creation. Refining structure later means deleting and recreating, not adding a layer of nesting. This is friction by design — it discourages indefinite restructuring.
- **No support for "epic of epics" patterns.** A team that wants to model a multi-quarter initiative as a top-level task with multi-week sub-initiatives, each with their own tasks, cannot do that in FlowBoard. They model it as a flat list of top-level tasks tagged or prefixed by initiative. The trade-off is intentional: FlowBoard targets day-to-week work, not quarter-to-year planning.
- **Migration from arbitrary depth would require a flattening pass.** If a future redesign lifts the constraint, existing data is trivially compatible (no level-2 subtasks exist). The reverse — collapsing arbitrary depth to one level — would be a lossy operation requiring user input. Keeping the constraint preserves the option to lift it cheaply.

## See also

- [Kanban concept doc](../concepts/kanban.md)
- [Specify Workflow concept doc](../concepts/specify-workflow.md) — the four task-structure options the Specify agent can choose from
- ADR-0007 (umbrella) — establishes the parent-id retention rule that pairs with this constraint
