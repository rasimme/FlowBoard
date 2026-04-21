# Project Mode — Rules & Conventions

These rules apply whenever a project is active.

**Context loading:** Automatic via the project-context hook, which regenerates `BOOTSTRAP.md` on startup, reset, and compaction.

### TL;DR
- Active project = context loading, not access control
- Canonical project/agent state is DB-backed (FlowBoard runtime)
- `PROJECT.md` stays bootstrap-small; `SESSIONS.md` holds chronology; `DECISIONS.md` holds rationale
- FlowBoard API owns all operational mutations — never edit state files directly
- Capability docs are lazy-loaded from `context/` on demand

---

## 1. Core Semantics

### Active project = context loading, not access control

An active project determines what project context is loaded into `BOOTSTRAP.md` for the current agent.

It does **not** mean:
- the agent may only access that project
- the agent must switch projects before reading another project's files
- the agent must switch projects before creating a task in another project

Cross-project reads and quick task creation are allowed without switching. Only switch when the main focus of work changes.

### Canonical state

Project registry and per-agent active-project state are DB-backed in FlowBoard runtime.

`ACTIVE-PROJECT.md` may still exist during migration windows but is not the long-term source of truth.

---

## 2. Commands

- **"Projekt: [Name]"** → Activate via FlowBoard API
- **"Projekt beenden"** → Deactivate via FlowBoard API
- **"Projekte"** → Show project list, indicate active
- **"Neues Projekt: [Name]"** → Create via the canonical `POST /api/projects` path, then optionally activate as a separate action

Always use FlowBoard API for project lifecycle and activation state.

---

## 3. Behavior While Active

- Keep work anchored to the active project unless the user explicitly changes focus.
- Record durable architecture/product decisions in `DECISIONS.md`.
- Keep `PROJECT.md` current after meaningful progress.
- Keep significant execution visible through tasks — don't bury it in chat only.

### File Roles

| File | Purpose | Character |
|------|---------|-----------|
| `PROJECT.md` | Current state, active focus, next steps | Bootstrap-small, frequently updated |
| `SESSIONS.md` | Chronological session log | Append-only |
| `DECISIONS.md` | Architecture and design reasoning | Durable why-records |
| `context/*.md` | Detailed operational/capability docs | Lazy-loaded on demand |
| `specs/*.md` | Task/feature specs | Linked from tasks |

Do not let these roles bleed together. See `project-files.md` for full conventions.

---

## 4. Task Management

### Workflow
```
backlog → open → in-progress → review → done → (archived)
                      ↕ blocked (flag, not status)
```

- One task in-progress per agent
- Any active work counts as in-progress (design, research, code — not just commits)
- Move to review before done
- Blocked is a flag, not a lane status
- Archive only from done

### Task Execution Protocol

When actively working on a task: **claim → checkpoint → complete / release**.

This protocol is global and intentionally soft — taught through project context, not enforced as hard orchestration.

- **Claim** with optional lease duration
- **Checkpoint** at milestones (message + optional progress %)
- **Complete** when done (triggers parent recalculation for subtasks)
- **Release** if blocked or reassigning

See `tasks-api.md` for endpoints and `agent-bridge.md` for behavioral rules and multi-agent patterns.

---

## 5. API-First Rule

FlowBoard server owns all operational project/task mutations.

- Use API endpoints for project creation, activation, updates, status changes, claims, specs
- `POST /api/projects` is the canonical creation path — never create projects via manual `mkdir` / ad-hoc file scaffolding
- Project creation and project activation are separate actions
- Read from `BOOTSTRAP.md` first; pull deeper detail only when needed
- Never edit state files directly

See `tasks-api.md` for endpoint reference.

---

## 6. Canvas & Specify

Canvas notes are idea inputs, not implementation plans.

Canvas promote and chat-triggered Specify both enter the same workflow: analyze → (clarify) → generate → confirm → persist.

- **Canvas Promote:** Select notes in dashboard → agent receives webhook → Specify session
- **Chat Trigger:** "Neues Feature: X", "Spezifiziere: X", "Specify: X" → same flow without canvas notes

See `canvas-and-notes.md` for canvas data model and `specify-workflow.md` for the full Specify lifecycle.

---

## 7. Capability Index (Lazy-Load)

Use this file as the entrypoint only. Load detailed docs when the task actually needs them.

| Capability | Doc |
|------------|-----|
| Tasks, coordination, project state | `tasks-api.md` |
| Canvas notes & connections | `canvas-and-notes.md` |
| Specify workflow | `specify-workflow.md` |
| Project file structure & conventions | `project-files.md` |
| Agent execution protocol & multi-agent | `agent-bridge.md` |

If a capability doc doesn't exist yet, treat this file as the coarse-grained fallback.

---

## 8. Error Handling

- Missing active project → projectless mode, no special context
- Missing project folder → surface clearly, do not guess
- Missing spec/doc file → report and continue gracefully
- Migration leftovers → prefer canonical DB/runtime state over stale local files
