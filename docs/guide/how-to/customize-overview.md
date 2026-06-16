# Customize the project overview

Each project's overview is a widget grid you (and your agents) can shape. It's the project's landing page: what needs attention, live activity, direction, GitHub, and knowledge.

## Edit the layout

1. Enter **edit mode** from the overview toolbar.
2. **Move** a widget by dragging its title bar.
3. **Resize** by dragging a widget's edges; the width×height is shown as you drag.
4. **Remove** a widget with its ✕ button.
5. **Add** a widget from the picker — widgets are grouped by cluster (*Needs you*, *Live*, *Direction*, *GitHub*, *Knowledge & actions*).
6. **Save** to keep the layout, or cancel to discard.

## Presets

Instead of hand-placing widgets, apply a **preset** (e.g. *default*, *coding*, *knowledge*, *mission*). The picker previews each layout before you commit. Agents can apply the same presets or a full custom layout via `PUT /api/projects/:name/overview`.

## GitHub widgets

Bind **one repository per project** (repo status, CI history, PRs, releases, issues). A token is optional and only needed for private repos. Set the binding from any GitHub widget or via `PUT /api/projects/:name/github`.

## Milestones & open questions

- **Milestones** are just tasks tagged `milestone:<name>` — the milestones widget turns them into a definition-of-done checklist.
- **Open questions** an agent raises (typed `question` comments) surface in the agent-questions widget, where you answer them inline.

## See also

- [Work the Kanban board](work-the-kanban.md)
- [Getting started](../getting-started.md)
