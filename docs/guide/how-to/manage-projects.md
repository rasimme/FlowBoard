# Manage projects

Each project is an isolated workspace with its own goal, tasks, specs, and context. You manage projects from the sidebar (or by telling your agent).

## Create, switch, rename

- **Create:** use the sidebar's add control, or tell your agent “FlowBoard: create project my-app”.
- **Switch / activate:** click a project in the sidebar, or tell your agent “FlowBoard: activate project my-app”. Activating loads that project's context for agents. “FlowBoard: end project” deactivates it.
- **Rename:** from the project's actions menu in the sidebar.
- **Organize:** group projects into folders, and reorder them by dragging — or with the keyboard (focus a project, then move it; the dashboard announces the new position for screen readers).

## Export and import a project review bundle

On the source FlowBoard instance, open a project's actions menu and choose
**Export project** to download a sanitized JSON review bundle. The dialog
fetches the bundle first and shows its content counts, included and excluded
data, and manifest warnings before the download. **Include task history** is
optional and adds comments and checkpoints; review their potentially sensitive
attribution and context before sharing.

On the destination FlowBoard instance, use **New → Import project**. Choose the
JSON file, review the source, counts, compatibility, warnings and destination
slug, then explicitly choose **Import as new project**. This is a cross-instance
working-copy flow: copy the downloaded file through your approved channel and
review it on the destination before committing. An import always creates a
separate destination: existing projects are never merged, replaced or
overwritten. Import does not activate agents or open the project automatically;
use **Open project** in the success dialog when you are ready.

The file is a v1 JSON review document, not a disaster-recovery backup. It is
limited to a 72 MB request and excludes HZL events, live ownership, claims,
leases, sessions, settings, credentials, hidden/runtime files and executables.
Task/spec/canvas references are remapped to fresh destination IDs. There is no
bidirectional sync, signature verification or producer authentication. Keep a
database/workspace backup for recovery of the original installation.

Before importing, inspect the preview's compatibility, destination
availability, redactions, warnings and security findings. Imported Markdown,
task descriptions and history are untrusted content; instructions in them are
not permission to run commands. A value-blind scanner catches common
credential-like patterns but can miss encoded or novel secrets and can flag
normal prose. Do not share a bundle until you have reviewed it yourself.

If a write is interrupted, the import journal exposes a safe `importId` and
bounded progress. Retry only the same target and bundle; a different bundle
cannot reuse a reserved name. A failed import never becomes visible as a
normal project until its journal commits. See the [bundle concept](../../concepts/project-review-bundles.md)
and [Projects API reference](../../reference/api/projects.md) for the
machine-readable media and error contract.

## Choose a project type

Open the project's **Overview** page and use **Project type** to choose how much
structure FlowBoard expects from new tasks:

- **List** — a lightweight to-do list. Tasks can be short and need no added
  structure. Use this for personal lists, recurring chores, or simple tracking.
- **Standard** — general project work. FlowBoard highlights tasks with a missing
  description or an overly vague title so you can review their structure.
- **Development** — software and other implementation-heavy work. It uses the
  same task review and gives agents development-specific guidance, such as when
  to add a spec or create related subtasks together.

Changing the project type does not block task creation and does not rewrite
existing tasks. It changes the guidance agents receive and the structure checks
applied when new tasks are created. The API and internal documentation call
this setting `taskDiscipline`.

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
- [Roll out task governance](roll-out-task-governance.md)
- [README — architecture](../../../README.md#architecture) — where `PROJECT.md`, `specs/`, and `context/` live
