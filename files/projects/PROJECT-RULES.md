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
backlog → open → in-progress → review → done → (archived)
                      ↕ blocked (flag, not status)
```

- ONE task in-progress at a time per agent
- **Any active work = in-progress** (includes brainstorming, design, research — not just code)
- Complete → set "review" (user confirms → "done")
- Mention status changes briefly
- **Backlog:** Planned but not actively scheduled. New tasks default here.
- **Blocked:** Flag on any active task (not a status). Set/unset via API.
- **Archived:** Only from done. Parent archive cascades to all children.

### Subtasks
- Parent + subtasks: when parent moves to in-progress, update relevant subtasks too
- When subtask completes: check if parent status needs updating
- Delete modal supports checkboxes for spec + subtask deletion

### Task Execution Protocol
When working on a task:
1. **Claim** the task: `POST /api/projects/:name/tasks/:id/claim {"agent":"<your-id>","lease":60}`
2. **Checkpoint** at milestones: `POST /api/projects/:name/tasks/:id/checkpoint {"message":"...","agent":"<your-id>"}`
3. **Complete** when done: `POST /api/projects/:name/tasks/:id/complete {"agent":"<your-id>"}`
4. If you need to stop mid-task: `POST /api/projects/:name/tasks/:id/release {"agent":"<your-id>"}`

**Safety nets (automatic):**
- Stale detection: no checkpoint for 30min → warning notification
- Lease expiry: time exceeded → task eligible for recovery
- Completion notification: gateway alert on task complete

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
| Claim task | `POST /api/projects/:name/tasks/:id/claim` `{agent, lease}` |
| Release task | `POST /api/projects/:name/tasks/:id/release` `{agent}` |
| Complete task | `POST /api/projects/:name/tasks/:id/complete` `{agent}` |
| Checkpoint | `POST /api/projects/:name/tasks/:id/checkpoint` `{message, agent}` |
| Comment | `POST /api/projects/:name/tasks/:id/comment` `{message, author}` |
| Get checkpoints | `GET /api/projects/:name/tasks/:id/checkpoints` |
| Get comments | `GET /api/projects/:name/tasks/:id/comments` |
| Stuck tasks | `GET /api/tasks/stuck[?staleThreshold=30]` |
| Handoff context | `GET /api/projects/:name/tasks/:id/handoff` |
| Route task | `POST /api/projects/:name/tasks/:id/route` `{agent}` |

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

### Promote Flow → Specify Session
1. User selects note(s) → clicks "Task" button
2. Dashboard creates a Specify session, sends webhook to agent's main session
3. Agent runs **Specify dialog** (see `context/specify-prompt.md`):
   - Analyzes notes, assesses complexity (Simple / Medium / Complex)
   - Simple: generates spec summary, confirms with user, creates 1 Task + 1 Spec
   - Complex: asks 1-3 clarifying questions, then generates Full Spec with User Stories + FRs
4. Agent creates tasks + specs via API, then batch-deletes promoted notes
5. Agent completes the Specify session via `POST /api/specify/sessions/:id/complete`

### Manual Specify (Chat-Triggered)
Trigger phrases: "Neues Feature: X", "Spezifiziere: X", "Specify: X"
→ Same flow as Canvas Promote, but without canvas notes. Uses active project from ACTIVE-PROJECT.md.

### Specify Session API
| Action | Endpoint |
|--------|----------|
| List sessions | `GET /api/specify/sessions` |
| Get session | `GET /api/specify/sessions/:id` |
| Abort session | `POST /api/specify/sessions/:id/abort` |
| Complete session | `POST /api/specify/sessions/:id/complete` |

---

## File Management

- **context/ folder:** External references only (hardware guides, API docs). NOT for code docs (git repo) or planning (specs/)
- **Project Files section:** Update in PROJECT.md when creating files in context/

---

## Error Handling

- Missing ACTIVE-PROJECT.md → no project active
- Missing project folder → notify user, offer recreate
- Missing/corrupt tasks.json → auto-migrated to HZL on startup
- Task ID not found → notify user, show available

---

## Key Principles

- **ACTIVE-PROJECT.md** = single source of truth for project state
- **API-first** for all mutations (never edit JSON files directly)
- **BOOTSTRAP.md** = auto-generated context (PROJECT-RULES + PROJECT.md)
- **DECISIONS.md** loaded on demand only
