# ADR-0009: `blocked` is a flag, not a status

## Status
Accepted

## Date
2026-04-01

## Source
- private spec `specs/T-126-tasksjson-hzl-migration.md` (decision AD-3 status mapping)
- code-comment invariant in `dashboard/hzl-service.js:34`: *"Note: 'blocked' is NOT a status — it's a boolean flag on metadata.flowboard.blocked"*
- public commit `88acb9f` — `feat(T-126-4): add Backlog column, Blocked flag, and Archived toggle to Kanban board`

## Context

Classical Kanban boards model `Blocked` as either a column (cards live there until unblocked) or a swim-lane modifier. Both choices have problems for FlowBoard's use case:

- **Blocked-as-column** moves the card away from the work it actually belongs to. A task that was 80% through `In Progress` and becomes blocked moves to `Blocked`; when unblocked, the holder must remember it should go back to `In Progress`, not start over in `Open`. Information about *where the work was* is lost in the column transition.
- **Blocked-as-swimlane** preserves the column but adds another axis (rows = blocked / not-blocked). Doubles the visual surface and complicates drag interactions — a card move now has two free dimensions.

A third option emerged from observing how the team actually used "blocked": it was a *reason for not progressing*, attached to a card in whatever column it currently lived in, not a destination state. That's a flag, not a status.

T-126's spec made this explicit in the status enum: `blocked` was added to the FlowBoard status vocabulary in early drafts but excluded from the final `VALID_STATUSES` set in favor of `metadata.flowboard.blocked` as a boolean.

## Decision

`blocked` is modeled as a **boolean flag** on a task, not a status. The flag is stored in `metadata.flowboard.blocked` (HZL metadata layer) and surfaced as `task.blocked` in the dashboard task object. It is orthogonal to status — any task in any column can be blocked or not.

The Kanban board renders blocked cards with a visual indicator (a strike-through-style overlay or icon) that overlays the card in whatever column it currently sits. The card does not move when blocked or unblocked.

The status enum (`VALID_STATUSES` in `dashboard/hzl-service.js`) deliberately excludes `blocked`: `open`, `in-progress`, `review`, `done`, `backlog`, `archived`. The HZL native status table includes `blocked` for legacy compatibility, but FlowBoard's mapping (`HZL_TO_FB`) translates HZL's `blocked` to `open` — meaning if HZL ever sets a task to its native `blocked` state, FlowBoard interprets that as "ready to work, just flagged."

## Consequences

- **Information about where the work was is preserved.** A blocked task in `In Progress` stays in `In Progress`; when unblocked, the holder picks up where they left off. There is no column transition to remember.
- **Drag interactions are simpler.** Moving a card is one-dimensional (between status columns); blocking is a separate toggle (button or context menu), not a drag.
- **Filter / search must consider both axes.** "Show me everything blocked" is a query on `task.blocked === true`, not a column projection. The UI exposes this as a filter rather than a tab.
- **Counterintuitive for newcomers.** Anyone familiar with Trello-style Kanban will look for a Blocked column. A short note in the Kanban concept doc and the in-app filter UI makes the pattern discoverable. New contributors should be referred to this ADR if they propose adding a Blocked column.
- **Counts on per-project task summaries are two-axis.** "5 in-progress" and "2 blocked" can overlap (a task can be both). UIs and reports must clarify whether "in-progress" includes blocked or excludes it. The task-status-summary in the bootstrap document lists them separately.
- **Migration from Blocked-as-column would be schema work.** If a future redesign decides to reverse this (e.g. for compliance reasons), the migration path is well-defined: enumerate all `task.blocked === true` rows, set their status to a new `blocked` value, and clear the flag. No data is lost.

## See also

- [Kanban concept doc](../concepts/kanban.md)
- ADR-0007 (umbrella for the HZL Task-Bridge that defines the status enum)
