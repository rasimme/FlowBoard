# FlowBoard

[![GitHub](https://img.shields.io/badge/GitHub-FlowBoard-blue?logo=github)](https://github.com/rasimme/FlowBoard)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-v2.3.0-orange.svg)](https://github.com/rasimme/FlowBoard/releases)

> **File-based project management with Kanban dashboard for OpenClaw agents.**

Work on multiple projects with persistent context, structured task tracking, and a live Kanban dashboard — without needing separate agents.

## Features

- 📋 **Task Management** — Structured `tasks.json` with status workflow (open → in-progress → review → done)
- 🎯 **Kanban Dashboard** — Interactive web UI with drag & drop, inline editing, priority popover, auto-refresh
- 📁 **File Explorer** — Browse, preview, and edit project files directly in the dashboard
- 🔄 **Task Workflow** — Agent updates task status in real-time as it works
- ✨ **Auto-task Creation** — Agent breaks down work into tasks automatically
- 🔗 **API-Based Switching** — Dashboard + chat use same API, instant context loading via wake events
- 🪝 **Hook-Based Loading** — Automatic BOOTSTRAP.md generation on /new, /reset, gateway startup
- 💾 **Session Persistence** — Project context survives gateway restarts, no session reset needed
- 🚀 **Zero Overhead** — Lazy-loading, only active when needed

---

## Quick Start

```bash
# 1. Clone into your OpenClaw workspace
cd ~/.openclaw/workspace
git clone https://github.com/rasimme/FlowBoard.git projects/project-mode

# 2. Set up AGENTS.md trigger (one-time)
# Add to your ~/.openclaw/workspace/AGENTS.md:

## Projects (MANDATORY)
MANDATORY on EVERY first message of a conversation: read `ACTIVE-PROJECT.md`.
- If an active project exists: read `projects/PROJECT-RULES.md`, then read the project's `PROJECT.md`. Follow all rules in PROJECT-RULES.md.
- If no active project or file is empty/missing: work normally without project context.

Commands:
- "Projekt: [Name]" → activate project
- "Projekt beenden" → deactivate project
- "Projekte" → show project overview
- "Neues Projekt: [Name]" → create new project

Only explicit user commands may change ACTIVE-PROJECT.md.

# 3. Create project structure
mkdir -p ~/.openclaw/workspace/projects
cp -r projects/project-mode/templates/* ~/.openclaw/workspace/projects/

# 4. Enable webhooks (required for v2.3.0+)
# Add to your openclaw.json:
{
  "hooks": {
    "enabled": true,
    "token": "<generate-with-openssl-rand-hex-16>",
    "path": "/hooks"
  }
}

# 5. Set up project-context hook (optional, for auto context loading)
# Copy hook to ~/.openclaw/hooks/project-context/
# Enable in openclaw.json under hooks.internal.entries

# 6. Start dashboard (optional, for Kanban UI)
cd ~/.openclaw/workspace/canvas
cp -r ../projects/project-mode/dashboard/* .

# Set environment variables for wake events
export OPENCLAW_HOOKS_TOKEN="<your-hooks-token>"
export OPENCLAW_GATEWAY_PORT=18789

node server.js &
```

Then open http://localhost:18790 in your browser.

**Note:** For production use, set up a systemd service for auto-start (see implementation notes).

---

## Related Projects

- **[ContextVault](https://github.com/rasimme/ContextVault)** — Advanced memory management with session persistence (integrates with Project Mode)
- **[openclaw-skills](https://github.com/rasimme/openclaw-skills)** — Collection of OpenClaw skills and plugins

---

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

---

## Components

| Component | Type | Description |
|-----------|------|-------------|
| [AGENTS.md trigger](#setup) | Convention | Mandatory project check on session start (fallback) |
| **project-context Hook** | **OpenClaw Hook** | **Auto-generates BOOTSTRAP.md on startup/new/reset** |
| **PUT /api/status** | **REST API** | **Single endpoint for project activation (Dashboard + Chat)** |
| [ACTIVE-PROJECT.md](#active-projectmd) | State file | Single source of truth for current project |
| **BOOTSTRAP.md** | **Generated** | **PROJECT-RULES + PROJECT.md (loaded by boot-md hook)** |
| [PROJECT-RULES.md](#project-rulesmd) | Rules | Full project mode conventions (loaded on demand) |
| [tasks.json](#task-management) | Data | Structured task tracking per project |
| [Kanban Dashboard](#dashboard) | Web UI | Live task board with drag & drop, file explorer |

---

## Task Management

Each project gets a `tasks.json`:

```json
{
  "tasks": [
    {
      "id": "T-001",
      "title": "Set up authentication",
      "status": "in-progress",
      "priority": "high",
      "created": "2026-02-10",
      "completed": null
    }
  ]
}
```

**Task Workflow:**
```
open → in-progress → review → done
```

**Task Workflow Rules:**
- Agent can only work on ONE task at a time
- Before starting work, agent updates task to "in-progress"
- After completing work, agent updates task to "review"
- Manual confirmation moves task to "done"
- Agent creates new tasks for unplanned work (auto-task creation)

---

## Dashboard

The Kanban dashboard provides:

- **Tasks View:** Drag & drop kanban board with 4 columns (Open, In Progress, Review, Done)
- **Files View:** File tree with loading badges, Markdown/JSON preview, inline editing
- **Live Updates:** Auto-refresh every 5 seconds
- **Inline Editing:** Click to edit task titles, drag to change status
- **Priority Management:** Visual priority indicators with popover selector
- **Context Health:** File size tracking (4KB limit warning)

**Access:** http://localhost:18790 (after starting `server.js`)

---

## Memory Integration

For project context persistence across sessions, integrate with [ContextVault](https://github.com/rasimme/ContextVault):

**Memory flush config** (in OpenClaw config):

```json
{
  "memoryFlush": {
    "enabled": true,
    "prompt": "...\n\nREAD ACTIVE-PROJECT.md. If project active: Update PROJECT.md with session progress + write SESSION-STATE.md reminder."
  }
}
```

This ensures project context survives compaction and gateway restarts.

---

## Architecture

**File Structure:**

```
~/.openclaw/workspace/
├── AGENTS.md                          # Trigger (mandatory)
├── ACTIVE-PROJECT.md                  # Current project state
├── projects/
│   ├── PROJECT-RULES.md               # System rules (loaded on demand)
│   ├── my-project/
│   │   ├── PROJECT.md                 # Project context
│   │   ├── DECISIONS.md               # Key decisions
│   │   ├── tasks.json                 # Task tracking
│   │   ├── SESSION-STATE.md           # Recovery context (optional)
│   │   └── context/                   # Specs, docs, etc.
│   └── another-project/
│       └── ...
└── canvas/                            # Dashboard files
    ├── index.html
    ├── server.js
    └── dashboard-data.json
```

**Key Principles:**

1. **Lazy Loading** — Only load what's needed
2. **File-based Conventions** — No custom hooks or plugins required
3. **Single Source of Truth** — ACTIVE-PROJECT.md + tasks.json
4. **Graceful Degradation** — Error = "no project active"
5. **Proper Data Formats** — Markdown for humans, JSON for operations

---

## Commands

- `Projekt: [Name]` — Activate project (loads context)
- `Neues Projekt: [Name]` — Create new project
- `Projekt beenden` — Deactivate project (writes summary)
- `Projekte` — List all projects

---

## Changelog

See [project-mode/README.md#changelog](https://github.com/rasimme/FlowBoard/blob/main/README.md#changelog) for version history.

### v2.3.0 (2026-02-14) — Production Ready
- **API-based project switching** — Dashboard + chat use same API endpoint
- **Wake events** — Instant context switching in running session (no /new required)
- **project-context Hook** — Automatic BOOTSTRAP.md generation on gateway:startup, /new, /reset
- **Webhook integration** — POST /hooks/wake sends System Events to agent
- **systemd environment** — OPENCLAW_HOOKS_TOKEN for secure webhook auth
- **End-to-end tested** — Dashboard + chat project activation verified
- **Documentation complete** — architecture.md, implementation notes, test logs

### v2.2.0 (2026-02-14)
- File Explorer with tab system (Tasks/Files)
- File tree with loading badges (always/lazy/optional)
- Markdown & JSON preview with syntax highlighting
- Inline file editing with unsaved state indicator
- Context health tracking (4KB size warnings)
- Custom scrollbar UX (16px margin, view-specific visibility)

### v2.1.1 (2026-02-14)
- Memory-flush integration for session persistence
- SESSION-STATE.md reminder after compaction

### v2.1.0 (2026-02-13)
- Dashboard systemd auto-start service
- Port 18790 (was 3001)
- UI polish (hover states, click-to-edit, display name formatting)

### v2.0.0 (2026-02-12)
- Task management system with tasks.json
- Kanban Dashboard with drag & drop
- Task workflow rules (one task at a time, status tracking)
- Auto-task creation
- Priority popover, sort toggle

---

## Philosophy

- 🎯 **Simplicity** — No unnecessary complexity
- 💰 **Low cost** — Haiku for background tasks, Sonnet for daily use
- 🔒 **Privacy** — Everything runs locally via your Gateway
- ⚡ **Automatic** — Self-maintaining where possible

---

## License

MIT
