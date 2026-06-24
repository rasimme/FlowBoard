# Getting started

This walks you from a running dashboard to your first project and first task. If FlowBoard isn't installed yet, do the [Quick Start](../../README.md#quick-start) first.

## 1. Open the dashboard

Go to **http://localhost:18790**. The board opens on the project overview (or an empty state if you have no projects yet).

If a **Finish setup** or **Migration required** chip appears in the header, click it and follow the modal — it wires FlowBoard into your agent workspaces. Every change writes a `.bak-<timestamp>` backup first, so it's safe to apply. The chip disappears once setup is done.

## 2. Create your first project

A *project* is a workspace with its own goal, tasks, specs, and context. Two ways to create one:

- **Tell your agent:** “FlowBoard: create project my-app”. The agent calls the API, scaffolds the project files (`PROJECT.md`, `SESSIONS.md`, `DECISIONS.md`, `specs/`, `context/`), and registers it.
- **From the dashboard:** use the project switcher in the sidebar.

Activating a project is what loads its context for an agent — see [Manage projects](how-to/manage-projects.md).

## 3. Create and run a task

Tasks move through five columns: **backlog → open → in-progress → review → done**.

1. Add a task (the quick-add in the board, or your agent creates it via the API).
2. An agent **claims** it (taking a lease), moves it to *in-progress*, and writes **checkpoints** as it works.
3. When the work is ready, it goes to **review** — *you* approve it to **done**. Agents don't self-approve.

You can drag cards between columns, reorder within a column, and open any card for its description, spec, checkpoints, and activity.

## 4. Brainstorm on the Idea Canvas

Open the **Canvas** to think visually: drop sticky notes, connect them into clusters, then select notes and click **Create Task**. The Specify stepper turns them into a task (or a parent task with subtasks and specs) right in the browser.

## 5. Shape the project overview

The overview is a widget grid you can edit: enter edit mode, drag widgets by their title bar, resize from the edges, add widgets from the picker, or apply a preset. Agents can shape the same grid via the API.

## Where to next

- [Search and filter tasks](how-to/search-and-filter.md)
- [Use FlowBoard on a phone or in Telegram](how-to/work-on-mobile.md)
- [Manage projects](how-to/manage-projects.md) — including the difference between archiving and deleting
