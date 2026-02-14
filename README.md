# Project Mode for OpenClaw

> **v2.1.0** — File-based project management with Kanban dashboard for OpenClaw agents.

Work on multiple projects with persistent context, structured task management, and a live Kanban dashboard — without needing separate agents.

## What's New in v2.0

- **Task Management** — Structured `tasks.json` with status workflow (open → in-progress → review → done)
- **Kanban Dashboard** — Interactive web UI with drag & drop, inline editing, priority popover, live auto-refresh
- **Task Workflow Rules** — Agent updates task status in real-time as it works (one task at a time, visible on dashboard)
- **Auto-task Creation** — Agent automatically breaks down work into tasks before execution
- **Dashboard Data Sync** — Task changes sync to dashboard automatically

## The Problem

When working on different projects with an OpenClaw agent, context gets lost between sessions. The agent doesn't know which project you're working on, what decisions were made, or what's next. You end up re-explaining context every time.

Separate agents per project would solve this, but they're heavyweight: each needs its own config, workspace, memory store, and API profile. For most projects, that's overkill.

## The Solution

Project Mode uses a **lazy-loading, file-based approach**:

- A tiny trigger block in `AGENTS.md` (~10 lines) checks for an active project on every session start
- Full project rules live in a separate file, loaded only when needed
- Each project gets its own folder with structured context files
- Project state survives gateway restarts, compaction, and session resets

**Zero overhead when no project is active.** The agent works normally until you say "Projekt: [Name]".

### How It Works

```
1. Session starts
2. Agent reads ACTIVE-PROJECT.md (mandatory, <100 bytes)
3. If project active → reads PROJECT-RULES.md + project's PROJECT.md
4. Agent works with full project context
5. Tasks are tracked in tasks.json, visible on Kanban dashboard
6. On deactivation → writes session summary, clears active project
```

## Components

| Component | Type | Description |
|-----------|------|-------------|
| [AGENTS.md trigger](#agentsmd-trigger) | Convention | Mandatory project check on session start |
| [ACTIVE-PROJECT.md](#active-projectmd) | State file | Single source of truth for current project |
| [PROJECT-RULES.md](#project-rulesmd) | Rules | Full project mode conventions (loaded on demand) |
| [tasks.json](#task-management) | Data | Structured task tracking per project |
| [Kanban Dashboard](#kanban-dashboard) | Web UI | Interactive project dashboard with live updates |
| [Project folder structure](#project-folder-structure) | Convention | Per-project files: PROJECT.md, DECISIONS.md, tasks.json |

## Installation

### 1. Add trigger block to AGENTS.md

Add this at the **top** of your `AGENTS.md`, before other rules (top position = highest instruction adherence):

```markdown
## Projects (MANDATORY)
MANDATORY on EVERY first message of a conversation: read `ACTIVE-PROJECT.md`.
- If an active project exists: read `projects/PROJECT-RULES.md`, then read the project's `PROJECT.md`. Follow all rules in PROJECT-RULES.md.
- If no active project or file is empty/missing: work normally without project context.

Commands — always read `projects/PROJECT-RULES.md` first before executing:
- "Projekt: [Name]" → activate project
- "Projekt beenden" → deactivate project
- "Projekte" → show project overview
- "Neues Projekt: [Name]" → create new project

Only explicit user commands may change ACTIVE-PROJECT.md. Never modify it automatically via cron, sub-agents, or other automation.
```

### 2. Create workspace files

```bash
# From your workspace root (e.g. ~/.openclaw/workspace)
cp project-mode/files/ACTIVE-PROJECT.md .
cp -r project-mode/files/projects .
```

Or create manually:

```bash
echo "project: none" > ACTIVE-PROJECT.md
mkdir -p projects
cp project-mode/files/projects/PROJECT-RULES.md projects/
cp project-mode/files/projects/_index.md projects/
```

### 3. Set up Kanban Dashboard (optional)

```bash
# Copy dashboard files
mkdir -p canvas
cp project-mode/dashboard/* canvas/

# Install dependency
cd canvas && npm install express

# Start server
./start-dashboard.sh
# Dashboard available at http://localhost:18790
```

The dashboard auto-refreshes every 5 seconds and shows task changes in real-time.

## Usage

### Commands

| Command | Action |
|---------|--------|
| `Projekt: [Name]` | Activate an existing project |
| `Neues Projekt: [Name]` | Create and activate a new project |
| `Projekt beenden` | Deactivate current project (writes session summary) |
| `Projekte` | Show all projects and which is active |

### Task Workflow

When the agent works on tasks, it follows this workflow:

1. **Auto-create tasks** — When you give work, the agent breaks it into tasks in `tasks.json`
2. **One at a time** — Agent sets a task to `in-progress` before starting work
3. **Live updates** — Dashboard shows which task is being worked on in real-time
4. **Review, not done** — When finished, agent sets task to `review` (you move it to `done`)
5. **Next task** — Agent moves to the next task and repeats

### Task Statuses

| Status | Meaning | Set by |
|--------|---------|--------|
| `open` | Ready to work on | Agent (on creation) |
| `in-progress` | Currently being worked on | Agent (before starting) |
| `review` | Work complete, awaiting confirmation | Agent (when finished) |
| `done` | Confirmed complete | User (manual) |

## Task Management

Tasks are stored in `tasks.json` inside each project folder:

```json
{
  "tasks": [
    {
      "id": "T-001",
      "title": "Implement user authentication",
      "status": "in-progress",
      "priority": "high",
      "specFile": null,
      "created": "2026-02-12",
      "completed": null
    }
  ]
}
```

### Task Schema

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Auto-incremented (T-001, T-002, ...) |
| `title` | string | Short task description |
| `status` | enum | `open`, `in-progress`, `review`, `done` |
| `priority` | enum | `high`, `medium`, `low` |
| `specFile` | string/null | Path to detailed spec in `context/` |
| `created` | date | Creation date (YYYY-MM-DD) |
| `completed` | date/null | Completion date |

## Kanban Dashboard

Interactive web UI built with vanilla HTML/JS/CSS. Matches the OpenClaw Gateway design system.

### Features

- **Drag & drop** — Move tasks between columns
- **Inline editing** — Double-click title to edit
- **Priority popover** — Click priority badge to change (low/medium/high)
- **Sort toggle** — Newest or oldest first (persisted in localStorage)
- **Auto-refresh** — 5-second polling with diff-based DOM updates (no flicker)
- **Multi-project** — Sidebar with project list, click to switch
- **Delete modal** — Confirmation dialog for destructive actions
- **Toast notifications** — Status change feedback

### Architecture

- **Single HTML file** — No framework, no build step
- **Express API server** — REST endpoints for CRUD operations on port 18790
- **Design tokens** — Uses identical CSS variables as OpenClaw Gateway UI
- **Dashboard data sync** — `dashboard-data.json` auto-updated on every task change

### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/status` | Gateway status |
| GET | `/api/projects` | List all projects |
| GET | `/api/projects/:name/tasks` | Get tasks for project |
| POST | `/api/projects/:name/tasks` | Create task |
| PUT | `/api/projects/:name/tasks/:id` | Update task |
| DELETE | `/api/projects/:name/tasks/:id` | Delete task |

## Project Folder Structure

```
workspace/
├── ACTIVE-PROJECT.md          ← "project: none" or "project: [name]"
├── projects/
│   ├── PROJECT-RULES.md       ← Full rules (loaded on demand)
│   ├── _index.md              ← Overview table of all projects
│   └── my-project/
│       ├── PROJECT.md          ← Goals, status, architecture, session log
│       ├── DECISIONS.md        ← Decision archive (loaded on demand)
│       ├── tasks.json          ← Structured task tracking
│       └── context/            ← Reference files, specs, docs
├── canvas/
│   ├── index.html             ← Kanban Dashboard UI
│   ├── server.js              ← Express API server
│   ├── dashboard-data.json    ← Auto-synced task data
│   └── start-dashboard.sh     ← Server start script
```

## Design Decisions

| Decision | Reasoning |
|----------|-----------|
| Vanilla JS (no framework) | No build step, instant edit-refresh cycle, single file ~40KB |
| Express on port 18790 | Adjacent to OpenClaw Gateway (18789), single SSH tunnel for remote access |
| `tasks.json` over `todo.md` | Structured data enables API, dashboard, automation |
| Diff-based refresh | Prevents flicker, preserves form state during auto-refresh |
| Review before Done | Human confirms completion — agent never marks tasks as done |

## Design Principles

### Lazy loading
Only load what's needed. `ACTIVE-PROJECT.md` is tiny (<100 bytes) and always read. Everything else is loaded on demand. No project active = zero overhead.

### Convention over code
Project Mode is entirely file-based and convention-based. No custom hooks or plugins required. The agent follows rules written in markdown.

### Graceful degradation
Every failure mode degrades to "no project active, work normally":
- Missing file → no project
- Deleted project folder → notify user, deactivate
- Corrupt content → treat as inactive, notify user

### Context economy
PROJECT.md has a 4KB size limit. Old session logs are archived to `context/session-archive.md`. DECISIONS.md and tasks.json are only loaded when actually needed.

## Integration

### Memory Management
Project Mode integrates with OpenClaw's memory flush system:

**Memory Flush (pre-compaction):**
- Automatically reads ACTIVE-PROJECT.md
- Updates PROJECT.md "Current Status" if project is active
- Writes project context reminder to SESSION-STATE.md: "Read projects/PROJECT-RULES.md and projects/[name]/PROJECT.md"
- Includes current task summary (Current Task, Key Context, Pending Actions, Blockers)

**Session Recovery (boot-md hook):**
- SESSION-STATE.md is loaded after gateway restart
- Reminder ensures project context is restored even if AGENTS.md instructions are missed
- Creates redundancy: AGENTS.md has mandatory trigger, SESSION-STATE.md has recovery reminder

Configure via `agents.defaults.compaction.memoryFlush` in openclaw.json. See [memory-management](../memory-management/) for details.

### Dashboard Data Sync
When tasks.json changes, `dashboard-data.json` is auto-synced to `canvas/`. Rule defined in PROJECT-RULES.md.

## Requirements

- OpenClaw 2026.2.x or later
- Node.js 18+ (for dashboard server)
- Writable workspace (not sandboxed)

## Version History

| Version | Date | Changes |
|---------|------|---------|
| v2.1.1 | 2026-02-14 | Memory-flush integration — PROJECT.md updates + SESSION-STATE.md project context reminder on compaction |
| v2.1.0 | 2026-02-13 | Port 3001→18790, systemd auto-start service, UI polish (hover states, click-to-edit, display name formatting, sidebar styling) |
| v2.0.0 | 2026-02-12 | Task management (tasks.json), Kanban Dashboard, task workflow rules, auto-task creation, priority popover, sort toggle |
| v1.0.0 | 2026-02-10 | Initial release — project switching, structure, rules |
