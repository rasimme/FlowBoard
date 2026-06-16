# File Visibility

## What it is

The rule that decides which project files the dashboard shows and lets you edit. By default the Files page shows **Markdown only**; operational files are hidden but remain reachable on demand.

## Why it exists

A project directory mixes human knowledge (`PROJECT.md`, `specs/`, `context/`) with operational artifacts (JSON state, `.bak-*` backups, indexes). Showing everything makes the tree noisy and invites editing files that are owned by conventions or the API. Hiding the operational files by default keeps the explorer focused on what a human should read and edit, without permanently locking the rest away.

## How it works

- A single predicate, `isEditorVisible(relPath)`, classifies a path as human-facing (Markdown) or operational. The file listing applies it by default.
- Hidden files stay reachable: `GET /api/projects/:name/files?includeHidden=true` returns them, and the Files page has a **Show hidden** toggle.
- Visibility is separate from the **write boundary**: even a visible file is only writable under `context/` and `specs/` (see [Project files](../project-mode/project-files.md)). Visibility controls *what you see*; the write boundary controls *what you may change*.

## Consequences

- Users see a clean, Markdown-first tree and won't accidentally hand-edit state files; power users flip **Show hidden** when inspecting.
- New file kinds inherit sensible defaults from the one predicate rather than ad-hoc per-view filtering.
- Documented for users in [Browse and edit project files](../guide/how-to/browse-and-edit-files.md).

## Where the code lives

- `dashboard/file-visibility.js` — `isEditorVisible(relPath)`.
- `dashboard/server.js` — the `/files` list honoring `?includeHidden`.
- `dashboard/src/pages/FilesView.jsx` — the Show-hidden toggle.
- Tests: `dashboard/test-file-visibility.js`, `dashboard/test-file-visibility-api.js`.
