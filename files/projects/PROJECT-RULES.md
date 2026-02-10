# Project Mode — Rules & Conventions

These rules apply whenever a project is active. Read this file when activating a project or when ACTIVE-PROJECT.md indicates an active project.

## Activating a Project

When the user says "Projekt: [Name]":
1. Read `projects/_index.md` to verify the project exists
2. Read `projects/[name]/PROJECT.md`
3. Update `ACTIVE-PROJECT.md` with:
   ```
   project: [name]
   since: [current date YYYY-MM-DD]
   ```
4. Confirm to user: State the project name and a brief summary of the current status from PROJECT.md

## Deactivating a Project

When the user says "Projekt beenden":
1. Write a session summary to the Session Log section in PROJECT.md:
   - What was done in this session
   - What's next
   - Open questions or decisions
2. Update `ACTIVE-PROJECT.md` to:
   ```
   project: none
   ```
3. Confirm to user that the project has been deactivated

## Creating a New Project

When the user says "Neues Projekt: [Name]":
1. Create folder: `projects/[name]/`
2. Create `projects/[name]/PROJECT.md` from template (see templates/)
3. Create `projects/[name]/DECISIONS.md` from template
4. Create `projects/[name]/todo.md` from template
5. Create `projects/[name]/context/` folder (empty)
6. Update `projects/_index.md` — add the new project row
7. Ask the user for: project goal, background, and any initial architecture notes
8. Fill in PROJECT.md with the answers
9. Activate the project (follow activation steps above)

## Showing Projects

When the user says "Projekte":
1. Read `projects/_index.md`
2. Read `ACTIVE-PROJECT.md`
3. Present the project list, marking which one is currently active (if any)

## Behavior While a Project Is Active

- All work relates to the project context unless the user clearly asks something unrelated
- Unrelated questions are answered normally — project context is additive, not restrictive
- Important decisions go into DECISIONS.md (with date and reasoning) — but only load DECISIONS.md when a decision needs to be recorded or referenced, not on every session start
- todo.md is only read when the user asks about tasks or when working in execution mode (future module)
- Keep PROJECT.md updated: after significant progress, update the "Current Status" section

## PROJECT.md Size Management

PROJECT.md must stay under 4KB. When it exceeds this:
1. Move old session log entries to `context/session-archive.md`
2. Keep only the last 3 session log entries in PROJECT.md
3. Notify the user that logs were archived

## Error Handling

When reading ACTIVE-PROJECT.md:
- File missing or empty → no project active, work normally
- Project folder doesn't exist → notify user: "Project [name] not found. Setting to inactive." Set ACTIVE-PROJECT.md to `project: none`
- PROJECT.md missing in project folder → notify user, ask whether to recreate it
- Invalid or unreadable content → treat as no project active, notify user

## SESSION-STATE.md Integration

When writing SESSION-STATE.md (during compaction/memory flush):
- Include a line: "Active project: [name]" or "Active project: none"
- Include: "Reminder: Always check ACTIVE-PROJECT.md on session start"

## Rules Summary

1. ACTIVE-PROJECT.md is the single source of truth for project state
2. Only explicit user commands change ACTIVE-PROJECT.md
3. PROJECT-RULES.md is read once per session, not on every message
4. PROJECT.md is read on session start when a project is active
5. DECISIONS.md and todo.md are loaded on demand only
6. _index.md is automatically updated when projects are created or deleted
