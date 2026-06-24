# Manage projects

Each project is an isolated workspace with its own goal, tasks, specs, and context. You manage projects from the sidebar (or by telling your agent).

## Create, switch, rename

- **Create:** use the sidebar's add control, or tell your agent “FlowBoard: create project my-app”.
- **Switch / activate:** click a project in the sidebar, or tell your agent “FlowBoard: activate project my-app”. Activating loads that project's context for agents. “FlowBoard: end project” deactivates it.
- **Rename:** from the project's actions menu in the sidebar.
- **Organize:** group projects into folders, and reorder them by dragging — or with the keyboard (focus a project, then move it; the dashboard announces the new position for screen readers).

## Archive vs. delete — know the difference

Deletion is a deliberate **two-step** flow, and both steps are reversible — by design, so a project can't be destroyed by reflex.

| Step | What it does | Reversible? |
|---|---|---|
| **1. Deactivate (archive)** | Hides and deactivates the project; all tasks, specs, and files are kept. This is a **required first step** — a project must be deactivated before it can be deleted. | **Yes** — reactivate any time. |
| **2. Delete** | Allowed only on an already-deactivated project, and only with an explicit confirmation (typing the project name) plus a separate delete acknowledgement. Moves the project folder into a server-side trash and tombstones it. | **Yes** — see *Restore* below. |

> ⚠️ **Archive and Delete are intentionally hard to confuse.** Delete won't run on an active project, and won't run on the project name alone — it needs the extra acknowledgement. Even after deleting, the data isn't gone: it sits in the server-side trash until an operator clears it manually.

## Restore a deleted project

Open **Deleted projects**, find the project, and **Restore** it — this brings the project and its tasks back from the trash. A deleted project stays restorable until the server's trash is emptied manually on disk; that final cleanup is the only step that can't be undone from the dashboard.

## See also

- [Getting started](../getting-started.md)
- [README — architecture](../../../README.md#architecture) — where `PROJECT.md`, `specs/`, and `context/` live
