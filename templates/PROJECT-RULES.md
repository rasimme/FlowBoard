# Project Mode — Rules & Conventions

These rules apply whenever a project is active.

**Context Loading:** Automatic via project-context Hook → writes BOOTSTRAP.md on startup/reset/compaction.

---

## Commands

- **"Projekt: [Name]"** → Activate: verify in `_index.md`, `PUT /api/status {"project":"name"}`, confirm
- **"Projekt beenden"** → Deactivate: append session summary to PROJECT.md Session Log, `PUT /api/status {"project":"none"}`
- **"Projekte"** → Show list from `_index.md`, mark active
- **"Neues Projekt: [Name]"** → Create folder + PROJECT.md + DECISIONS.md + tasks.json + context/, update `_index.md`, activate

---

## Behavior While Active

- All work relates to project context (unrelated questions answered normally)
- **Decisions:** Record in DECISIONS.md (date + reasoning) — load on demand only
- **Tasks:** Break work into tasks before execution (tracking + dashboard visibility). Exception: quick questions/discussions
- **PROJECT.md:** Keep "Current Status" updated after significant progress

---

## Task Management

### Workflow
```
open → in-progress → review → done
```

- ONE task in-progress at a time
- **Any active work = in-progress** (includes brainstorming, design, research — not just code)
- Complete → set "review" (user confirms → "done")
- Mention status changes briefly

### Subtasks
- Parent + subtasks: when parent moves to in-progress, update relevant subtasks too
- When subtask completes: check if parent status needs updating
- Delete modal supports checkboxes for spec + subtask deletion

### API Access (MANDATORY)
Dashboard server manages all data. **Always use API for mutations:**

| Action | Endpoint |
|--------|----------|
| Create task | `POST /api/projects/:name/tasks` `{title, priority}` |
| Update task | `PUT /api/projects/:name/tasks/:id` `{status, priority, ...}` |
| Delete task | `DELETE /api/projects/:name/tasks/:id[?mode=all\|keep-children]` |
| Create spec | `POST /api/projects/:name/specs/:taskId` `{content?}` |
| Read tasks | `GET /api/projects/:name/tasks` |
| Canvas notes | `GET/POST/PUT/DELETE /api/projects/:name/canvas/notes[/:id]` |
| Canvas connections | `GET/POST/DELETE /api/projects/:name/canvas/connections[/:id]` |
| Batch delete notes | `DELETE /api/projects/:name/canvas/notes/batch` `{noteIds:[...]}` |
| Promote notes | `POST /api/projects/:name/canvas/promote` `{notes, connections, mode}` |

**Reading tasks:** Prefer BOOTSTRAP.md (contains filtered active tasks). Only use API/file as fallback. Never read tasks.json directly — at scale (100+ tasks) it wastes context.

### Spec Files
- Live in `~/.openclaw/workspace/projects/<name>/specs/` (NOT in git repo)
- Created via Dashboard or API; `specFile` field links automatically
- Auto-load spec when task moves to in-progress
- Update checkboxes + log as work progresses
- Specs of done tasks stay (documentation value)

---

## Canvas & Ideas

The Idea Canvas is a visual brainstorming space. Notes can be promoted to tasks.

### Concepts
- **Notes:** Sticky notes with text, color, size (small/medium)
- **Connections:** Lines between notes (create by dragging between connection dots)
- **Clusters:** Connected notes get an auto-frame; click frame to select all

### Promote Flow (Agent-Assisted)
1. User selects note(s) → clicks "Task" button
2. Dashboard sends structured payload to OpenClaw webhook (`/hooks/agent`)
3. Isolated agent session decides task structure:
   - Simple idea → Task with title only
   - Detailed idea → Task + spec file
   - Complex cluster → Parent task + subtasks
4. Agent creates tasks via API, then batch-deletes promoted notes
5. Agent does NOT ask follow-up questions — decides autonomously

### When Agent Receives `[CANVAS_PROMOTE]`
- Read the notes and connections
- Assess complexity → choose appropriate task structure
- Create via FlowBoard API (localhost:18790)
- Delete promoted notes via batch-delete endpoint
- Deliver summary to user

---

## File Management

- **context/ folder:** External references only (hardware guides, API docs). NOT for code docs (git repo) or planning (specs/)
- **Project Files section:** Update in PROJECT.md when creating files in context/

---

## Error Handling

- Missing ACTIVE-PROJECT.md → no project active
- Missing project folder → notify user, offer recreate
- Missing/corrupt tasks.json → create empty `{"tasks":[]}`
- Task ID not found → notify user, show available

---

## Key Principles

- **ACTIVE-PROJECT.md** = single source of truth for project state
- **API-first** for all mutations (never edit JSON files directly)
- **BOOTSTRAP.md** = auto-generated context (PROJECT-RULES + PROJECT.md)
- **DECISIONS.md** loaded on demand only
