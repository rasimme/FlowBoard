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
2. Create `projects/[name]/PROJECT.md` from template:
   ```markdown
   # [Project Name]

   ## Goal
   [What should be achieved?]

   ## Background
   [Why are we doing this? What are the prerequisites?]

   ## Architecture
   [Technical details, structure, dependencies — fill in as the project develops]

   ## Current Status
   [Updated by agent after each significant session]

   ## Session Log
   <!-- Newest on top. Max 3 entries here, older entries archived to context/session-archive.md -->

   ### [DATE]
   - Project created
   ```
3. Create `projects/[name]/DECISIONS.md`:
   ```markdown
   # Decisions — [Project Name]

   Decisions are logged here when significant choices are made. Only loaded on demand.

   <!-- Format:
   ### [DATE] — [Short Title]
   **Decision:** What was decided
   **Reasoning:** Why
   **Alternatives considered:** What else was on the table
   -->
   ```
4. Create `projects/[name]/tasks.json` with content: `{"tasks": []}`
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
- tasks.json is only read when the user asks about tasks, when working in execution mode, or when updating task status
- When the user gives you work within the active project, always break it down into tasks in tasks.json before starting execution. This ensures all work is tracked and visible on the dashboard.
- Exception: Quick questions, discussions, or work clearly unrelated to the project do not need tasks.
- When you complete a task that exists in tasks.json, update its status to "review"
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

SESSION-STATE.md is written during memory flush (pre-compaction) and loaded after gateway restarts (boot-md hook).

### Memory Flush Behavior

When writing SESSION-STATE.md (triggered by compaction):
1. Read ACTIVE-PROJECT.md to determine current project
2. If project active:
   - Update projects/[name]/PROJECT.md "Current Status" section with session summary
   - Include reminder in SESSION-STATE.md: "Read projects/PROJECT-RULES.md and projects/[name]/PROJECT.md"
3. Write session summary:
   - Active project: [name] or "none"
   - ## Current Task
   - ## Key Context
   - ## Pending Actions
   - ## Blockers

### Session Recovery

When SESSION-STATE.md is loaded (after restart or /new):
- The reminder ensures project context is re-loaded even if AGENTS.md instructions are missed
- Agent should read ACTIVE-PROJECT.md → PROJECT-RULES.md → PROJECT.md to restore full context

This creates redundancy: AGENTS.md has the mandatory trigger, SESSION-STATE.md has the recovery reminder.

## Task Management

Tasks are stored in `tasks.json` inside each project folder. This file is the single source of truth for all tasks in a project.

### Task Schema
```json
{
  "tasks": [
    {
      "id": "T-001",
      "title": "Task title",
      "status": "open|in-progress|review|done",
      "priority": "high|medium|low",
      "specFile": null,
      "created": "YYYY-MM-DD",
      "completed": null
    }
  ]
}
```

### Task Statuses
- `open` — Ready to be worked on
- `in-progress` — Currently being worked on
- `review` — Done, waiting for user confirmation
- `done` — Completed

### Reading & Writing tasks.json
- Do NOT read tasks.json on every session start. Only load it when:
  - The user asks about tasks ("Was steht an?", "Zeig mir die Tasks", etc.)
  - You complete a task and need to update the status
  - The user explicitly asks to create, change, or review tasks
  - You are working in executing mode and need to track progress
- **CRITICAL: When the dashboard server is running (port 3001), ALWAYS use the API for task operations. Never write tasks.json directly — the server manages this file and direct writes cause race conditions / data loss.**
  - Create: `POST /api/projects/:name/tasks` with `{title, priority}`
  - Update: `PUT /api/projects/:name/tasks/:id` with fields to change
  - Delete: `DELETE /api/projects/:name/tasks/:id`
  - Read: `GET /api/projects/:name/tasks`
  - Use `curl` or Node.js `http` module to call the API
- If the server is NOT running, direct file writes are acceptable as fallback
- Always preserve all existing tasks when writing — never drop tasks accidentally

### Creating Tasks
- Auto-increment the ID: read existing tasks, find highest T-number, increment
- Set `created` to current date (YYYY-MM-DD)
- Set `completed` to null
- Default priority: `medium` (unless user specifies otherwise)
- Default status: `open`
- `specFile` is optional — only set it if the user provides or requests a detailed specification

### Updating Tasks
- When completing a task: set `status` to `review` (never directly to `done`)
- When the user confirms a review task: move from `review` to `done` and set `completed` to current date
- Briefly mention the status change in your response (e.g., "T-003 ist jetzt auf Review.")

### Task Workflow During Execution

When working on tasks from tasks.json:

1. **One task at a time.** Never set multiple tasks to `in-progress` simultaneously.
2. **Before starting work:** Set the task to `in-progress` + sync dashboard-data.json.
3. **When work is complete:** Set the task to `review` (NOT `done`). Only the user moves tasks from `review` to `done`.
4. **Then move to the next task.** Repeat the cycle.
5. **Dashboard as live tracker:** Since the dashboard auto-refreshes, these status changes are immediately visible. No additional notifications needed.

Exception: Trivial batch operations (e.g., creating multiple files from a template) may be grouped — but status updates should still reflect the current focus.

### Displaying Tasks
Adapt formatting to the current channel:

**In WebChat:** Show a clear overview, e.g.:
```
📋 Tasks — Jetson Security
Open (2): T-001 SSH-Härtung dokumentieren [high], T-003 Backup-Strategie [medium]
In Progress (1): T-002 Sandbox aktivieren [high]
Review (0): —
Done (3): T-004, T-005, T-006
```

**In Telegram:** Keep it compact with emoji status:
```
📋 Jetson Security
📋 T-001 SSH-Härtung [high]
📋 T-003 Backup-Strategie
🔨 T-002 Sandbox aktivieren [high]
✅ 3 erledigt
```

### Spec-Files (optional)
- If a task needs detailed specification, create a markdown file in `context/`
- Naming: `T-{number}-{short-name}.md`
- Set the `specFile` field in tasks.json to the relative path
- Only create spec-files when the task is complex enough to warrant it

### Error Handling
- tasks.json missing → create it with empty tasks array: `{"tasks": []}`
- tasks.json invalid/corrupt → notify user, offer to recreate
- Task ID not found → notify user, show available tasks

## Dashboard Data Sync

When tasks.json is written or updated, **always** also write a copy to `canvas/dashboard-data.json` with this format:
```json
{
  "project": "[active-project-name]",
  "tasks": [ ...tasks array from tasks.json... ]
}
```
When a project is deactivated (`project: none`), write:
```json
{"project": "none", "tasks": []}
```
This powers the Kanban Dashboard at `http://127.0.0.1:18789/__openclaw__/canvas/`.

## Rules Summary

1. ACTIVE-PROJECT.md is the single source of truth for project state
2. Only explicit user commands change ACTIVE-PROJECT.md
3. PROJECT-RULES.md is read once per session, not on every message
4. PROJECT.md is read on session start when a project is active
5. DECISIONS.md and tasks.json are loaded on demand only
6. _index.md is automatically updated when projects are created or deleted
