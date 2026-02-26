# Project Mode — Rules & Conventions

These rules apply whenever a project is active.

**Context Loading:** Happens automatically via project-context Hook (writes BOOTSTRAP.md on gateway:startup, /new, /reset).

---

## Activating a Project

When the user says "Projekt: [Name]":
1. Verify project exists in `projects/_index.md`
2. Call API to activate:
   ```bash
   curl -X PUT http://localhost:18790/api/status \
     -H "Content-Type: application/json" \
     -d '{"project": "[name]"}'
   ```
   → API updates ACTIVE-PROJECT.md, BOOTSTRAP.md, sends wake event
3. Confirm to user with brief summary from PROJECT.md

---

## Deactivating a Project

When the user says "Projekt beenden":
1. Write session summary to PROJECT.md Session Log:
   - **ALWAYS APPEND** a new entry — NEVER try to find/edit existing text (brittle, fails when file changed)
   - Use Write tool to read full file, then rewrite with new entry prepended under `## Session Log`
   - Or append directly after `## Session Log` header using a unique marker
   - Format: `### YYYY-MM-DD\n- **Was wurde gemacht:** ...\n- **Was ist als Nächstes dran:** ...\n- **Offene Fragen:** ...`
2. Call API to deactivate:
   ```bash
   curl -X PUT http://localhost:18790/api/status \
     -H "Content-Type: application/json" \
     -d '{"project": "none"}'
   ```
   → API clears ACTIVE-PROJECT.md, BOOTSTRAP.md, sends wake event
3. Confirm deactivation

---

## Creating a New Project

When the user says "Neues Projekt: [Name]":
1. Create `projects/[name]/` folder
2. Create `PROJECT.md`:
   ```markdown
   # [Project Name]
   
   ## Goal
   [What should be achieved?]
   
   ## Scope
   - **Dazu gehört:** [Was ist Teil des Projekts]
   - **Nicht dazu:** [Was explizit ausgeschlossen ist]
   - **Appetite:** [Klein/Mittel/Groß — wie viel Aufwand investieren wir?]
   
   ## Background
   [Why? Prerequisites?]
   
   ## Architecture
   [Technical details — for projects with a Git repo, reference `docs/` in the repo instead of duplicating here. Optional for small/non-technical projects.]
   
   ## Project Files
   [List non-standard files when they are created. specs/ are linked via tasks.json and don't need entries here.]
   - `context/example.md` — Description of what this file contains
   
   ## Current Status
   [Updated after each significant session]
   
   ## Session Log
   ### [DATE]
   - Project created
   ```
3. Create `DECISIONS.md`:
   ```markdown
   # Decisions — [Project Name]
   
   ### [DATE] — [Title]
   **Decision:** What was decided
   **Reasoning:** Why
   **Alternatives:** What else was considered
   ```
4. Create `tasks.json`: `{"tasks": []}`
5. Create `context/` folder (empty)
6. Update `projects/_index.md` with new project row
7. Ask for: goal, background, architecture notes → fill PROJECT.md
8. Activate via API (same as "Projekt: [name]")

---

## Showing Projects

When the user says "Projekte":
1. Read `projects/_index.md`
2. Read `ACTIVE-PROJECT.md` (which is active)
3. Present list, mark active project

---

## Behavior While a Project Is Active

- All work relates to project context unless user asks something unrelated
- Unrelated questions answered normally (project context is additive, not restrictive)
- **Decisions:** Important decisions go into DECISIONS.md (date + reasoning) — load only when recording/referencing
- **Tasks:** Break down work into tasks.json before execution (ensures tracking + dashboard visibility)
  - Exception: Quick questions, discussions, or work unrelated to project
- **Task updates:** Update task status to "review" when completing work
- **PROJECT.md:** Keep "Current Status" updated after significant progress
- **Project Files:** When creating new files in `context/`, update `## Project Files` in PROJECT.md (path + one-line description)
- **context/ folder:** Only for external references (hardware guides, API docs, research). NOT for code documentation (belongs in Git repo `docs/`) or task-specific planning (belongs in `specs/`)

---

## Task Management

### Task Schema
```json
{
  "id": "T-001",
  "title": "Task title",
  "status": "open|in-progress|review|done",
  "priority": "high|medium|low",
  "specFile": "specs/T-001-feature.md",
  "created": "2026-02-11",
  "completed": null
}
```

### Task Workflow
```
open → in-progress → review → done
```

**Rules:**
- ONE task at a time (never multiple in-progress)
- Before starting: set status to "in-progress"
- When complete: set status to "review" (NOT "done")
- User moves from "review" → "done" (confirmation required)
- Mention status changes briefly (e.g., "T-003 ist jetzt auf Review")

### API Access
**CRITICAL:** Dashboard server manages tasks.json. ALWAYS use API for mutations:
- Create: `POST /api/projects/:name/tasks` with `{title, priority}`
- Update: `PUT /api/projects/:name/tasks/:id` with fields to change
- Delete: `DELETE /api/projects/:name/tasks/:id`
- Read: `GET /api/projects/:name/tasks` (or read file directly)

### Spec Files (optional)
- Complex tasks can have a spec file in `specs/T-{id}-{slug}.md`
- Created via Dashboard ("+ 📋" on task card) or API: `POST /api/projects/:name/specs/:taskId` with optional `{"content": "..."}` body (falls back to empty template if omitted)
- `specFile` field in tasks.json links to the relative path (set automatically)
- `specs/` folder is created lazily on first spec

⚠️ **Planning files always live in `~/.openclaw/workspace/projects/<name>/`** — NOT in the project's git repo.
The dashboard reads/writes from this directory. When writing spec content with the Write tool, always use the `.openclaw` path:
- ✅ `~/.openclaw/workspace/projects/<name>/specs/T-xxx-....md`
- ❌ `~/workspace/projects/<name>/specs/T-xxx-....md` (git repo — wrong!)

**When to create a spec:**
- Task requires planning or multiple steps before execution
- Task has acceptance criteria that need to be tracked
- Task context is too complex for a title alone
- When in doubt: a title is enough for simple tasks, create a spec for anything non-trivial

**Auto-load:** When a task moves to in-progress and has a specFile, read it for context.

**Spec maintenance:**
- Update "Done When" checkboxes as criteria are completed
- Add entries to "Log" section for significant progress or decisions
- When task moves to review/done: update spec (check remaining boxes, final log entry)
- Specs of done tasks stay in `specs/` (documentation value, no archiving needed)

**Template:**
  ```markdown
  # T-{id}: {Title}
  
  ## Goal
  What should be achieved and why?
  
  ## Done When
  - [ ] Concrete acceptance criteria
  
  ## Approach
  Technical plan (filled in while working)
  
  ## Log
  - YYYY-MM-DD: Spec created
  ```

---

## Error Handling

- `ACTIVE-PROJECT.md` missing/empty → no project active, work normally
- Project folder doesn't exist → notify user, ask to recreate or set to "none"
- `PROJECT.md` missing → notify user, offer to recreate
- `tasks.json` missing → create with empty array: `{"tasks": []}`
- `tasks.json` corrupt → notify user, offer to recreate
- Task ID not found → notify user, show available tasks

---

## Rules Summary

- **ACTIVE-PROJECT.md** = single source of truth for project state
- **API-first:** Use `PUT /api/status` for activation/deactivation (not direct file writes)
- **BOOTSTRAP.md** = auto-generated by project-context Hook (PROJECT-RULES + PROJECT.md)
- **PROJECT.md** updated by agent (Current Status + Session Log)
- **DECISIONS.md** loaded on demand only
- **tasks.json** managed exclusively via API (prevents race conditions)
