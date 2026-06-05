# Project Mode — Rules & Conventions

These rules apply whenever a project is active.

**Context Loading:** API-first. On startup, call `GET /api/status?agentId=<agentId>`. If a project is active and `contextReady === true`, fetch `GET /api/projects/<activeProject>/bootstrap` and lazy-load deeper rule sections via `GET /api/projects/<activeProject>/rules/<section>`. `flowboard_agents.active_project` in the FlowBoard DB is the single source of truth; on-disk `BOOTSTRAP.md`, `ACTIVE-PROJECT.md`, and `SESSION-STATE.md` are not authoritative.

---

## Commands

- **"Projekt: [Name]"** → Activate via `PUT /api/status {"project":"name","agentId":"<agentId>"}`, verify with `GET /api/status?agentId=<agentId>`
- **"Projekt beenden"** → Deactivate via `PUT /api/status {"project":null,"agentId":"<agentId>"}`, verify with `GET /api/status?agentId=<agentId>`
- **"Projekte"** → Show `GET /api/projects` plus current agent state from `GET /api/status?agentId=<agentId>`
- **"Neues Projekt: [Name]"** → Create via `POST /api/projects`; creation does not imply activation

---

## Behavior While Active

- All work relates to project context (unrelated questions answered normally)
- **Decisions:** Record in DECISIONS.md (date + reasoning) — load on demand only
- **Tasks:** Break work into tasks before execution (tracking + dashboard visibility). Exception: quick questions/discussions
- **PROJECT.md:** Keep stable project knowledge only. Never write current task focus, claims, priorities, status, or next implementation steps there.

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

**Reading tasks:** Use `GET /api/projects/:name/tasks`. Bootstrap may include an `Operational Task State` section from the same API, but the API is canonical. Never read `tasks.json` directly and never derive current task work from `PROJECT.md` or `SESSIONS.md`.

### Spec Files
- Live in `~/.openclaw/projects/<name>/specs/` (NOT in git repo)
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
- **Project Files section:** Update in PROJECT.md only when creating stable reference files in context/. Do not record task progress or next work there.

---

## Error Handling

- Missing active project from `/api/status` → no project active
- Missing project folder → notify user; repair via project APIs, never by hand-scaffolding
- Missing/corrupt legacy `tasks.json` → ignore when HZL/API is available
- Task ID not found → notify user, show available

---

## Key Principles

- **flowboard_agents.active_project** = single source of truth for per-agent active project state
- **API-first** for all mutations (never edit JSON/state files directly)
- **HZL/Tasks API** = single source of truth for task state, claims, priorities, and next work
- **Bootstrap endpoint** = current project context; on-disk `BOOTSTRAP.md` is legacy/stale unless injected by runtime
- **DECISIONS.md** loaded on demand only
