# Manage projects

Each project is an isolated workspace with its own goal, tasks, specs, and context. You manage projects from the sidebar (or by telling your agent).

## Create, switch, rename

- **Create:** use the sidebar's add control, or tell your agent “New project: my-app”.
- **Switch / activate:** click a project in the sidebar, or say “Project: my-app”. Activating loads that project's context for agents. “End project” deactivates it.
- **Rename:** from the project's actions menu in the sidebar.
- **Organize:** group projects into folders, and reorder them by dragging — or with the keyboard (focus a project, then move it; the dashboard announces the new position for screen readers).

## Archive vs. delete — know the difference

These look similar in the menu but do very different things. Read this before clicking.

| Action | What it does | Reversible? |
|---|---|---|
| **Archive (deactivate)** | Hides the project from the active list and deactivates it. All tasks, specs, and files are kept untouched. | **Yes** — unarchive any time. |
| **Delete** | Removes the project from your board into *Deleted projects*. | Restorable from there — until it is permanently removed. |
| **Permanent delete** | Destroys the project and its data for good. Requires typing the project name to confirm, plus an explicit acknowledgement. | **No** — cannot be undone. |

> ⚠️ **Use Archive when you just want a project out of the way.** Reach for Delete only when you truly mean to remove it. Permanent deletion is irreversible and is intentionally harder to trigger (name confirmation + explicit acknowledgement) so it can't be done by reflex.

## Restore a deleted project

Open **Deleted projects** in the sidebar, find the project, and **Restore** it. This brings back the project and its data — as long as it hasn't been permanently deleted.

## See also

- [Getting started](../getting-started.md)
- [README — architecture](../../../README.md#architecture) — where `PROJECT.md`, `specs/`, and `context/` live
