# Browse and edit project files

The Files page lets you read and edit a project's knowledge without dropping to a shell.

## Browse

The file tree shows the project's Markdown by default — `PROJECT.md`, `SESSIONS.md`, `DECISIONS.md`, and the `specs/` and `context/` folders. Select a file to preview it (Markdown is rendered). The view auto-refreshes; if a file changed underneath you while editing, a conflict banner warns you before you overwrite.

### Show hidden / operational files

Non-Markdown and operational files (JSON, `.bak-*` backups, etc.) are **hidden by default** so the tree stays readable. Use the **Show hidden** toggle to reveal them — handy when you're inspecting state, but you usually don't need them.

## Edit

The built-in CodeMirror editor opens on a file's preview. A few rules:

- **Only `context/` and `specs/` are editable.** Writing elsewhere (e.g. `PROJECT.md`) is rejected — those files are owned by their conventions.
- **Save** with `Cmd/Ctrl+S`, cancel with `Esc`. You can also download a file.
- **Spec files are not hand-written** — they're created by the Specify flow / the API (`POST /api/projects/:name/specs/:taskId`), which names and links them. Edit an existing spec's prose freely; just don't create specs by hand.

## Add files

Create a new `.md` file or drag-and-drop uploads into `context/` from the Files page.

## See also

- [Brainstorm on the canvas](canvas-and-promote.md)
- [Manage projects](manage-projects.md)
