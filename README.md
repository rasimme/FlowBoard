# Project Mode for OpenClaw

> **v1.0.0** — File-based project context management for OpenClaw agents.

Work on multiple projects with persistent context, structured planning, and session continuity — without needing separate agents.

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
5. On deactivation → writes session summary, clears active project
```

## Components

| Component | Type | Description |
|-----------|------|-------------|
| [AGENTS.md trigger](#agentsmd-trigger) | Convention | Mandatory project check on session start |
| [ACTIVE-PROJECT.md](#active-projectmd) | State file | Single source of truth for current project |
| [PROJECT-RULES.md](#project-rulesmd) | Rules | Full project mode conventions (loaded on demand) |
| [BOOT.md extension](#bootmd-extension) | Hook integration | Project state recovery after gateway restart |
| [Project folder structure](#project-folder-structure) | Convention | Per-project files: PROJECT.md, DECISIONS.md, todo.md |

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

Copy the files from this package to your workspace:

```bash
# From your workspace root (e.g. ~/.openclaw/workspace)
cp project-mode/files/ACTIVE-PROJECT.md .
cp -r project-mode/files/projects .
```

Or create them manually:

```bash
# Active project pointer
echo "project: none" > ACTIVE-PROJECT.md

# Project rules and index
mkdir -p projects
cp project-mode/files/projects/PROJECT-RULES.md projects/
cp project-mode/files/projects/_index.md projects/
```

### 3. Extend BOOT.md (optional, recommended)

If you use the `boot-md` hook, add project state recovery to your `BOOT.md`:

```markdown
## Project State Recovery
After a gateway restart:
1. Read `ACTIVE-PROJECT.md`
2. If active project exists: mention it in the boot notification
3. If active project with pending actions: include what was in progress
```

## Usage

### Commands

| Command | Action |
|---------|--------|
| `Projekt: [Name]` | Activate an existing project |
| `Neues Projekt: [Name]` | Create and activate a new project |
| `Projekt beenden` | Deactivate current project (writes session summary) |
| `Projekte` | Show all projects and which is active |

### Example workflow

```
You:    Neues Projekt: website-redesign
Agent:  [Creates folder structure, asks for goal/background, activates project]

You:    Let's plan the navigation structure
Agent:  [Works in project context, updates PROJECT.md]

You:    Projekt beenden
Agent:  [Writes session summary to PROJECT.md, deactivates]

--- next day ---

You:    Projekt: website-redesign
Agent:  [Loads project context, shows current status, continues where you left off]
```

## Project Folder Structure

When you create a new project, this structure is generated:

```
workspace/
├── ACTIVE-PROJECT.md          ← "project: none" or "project: [name]"
├── projects/
│   ├── PROJECT-RULES.md       ← Full rules (loaded on demand)
│   ├── _index.md              ← Overview table of all projects
│   └── website-redesign/      ← Example project
│       ├── PROJECT.md          ← Goals, status, architecture, session log
│       ├── DECISIONS.md        ← Decision archive (loaded on demand)
│       ├── todo.md             ← Task list (loaded on demand)
│       └── context/            ← Reference files, specs, docs
```

### File descriptions

| File | Loaded | Purpose |
|------|--------|---------|
| `ACTIVE-PROJECT.md` | Every session start | Pointer to current project (~100 bytes) |
| `PROJECT-RULES.md` | When project is active | Full conventions and rules (~4KB) |
| `_index.md` | On "Projekte" command | Overview of all projects |
| `PROJECT.md` | When project is active | Project goals, status, session log (<4KB) |
| `DECISIONS.md` | On demand only | Decision archive with reasoning |
| `todo.md` | On demand only | Task tracking |

## Design Principles

### Lazy loading
Only load what's needed. `ACTIVE-PROJECT.md` is tiny (<100 bytes) and always read. Everything else is loaded on demand. No project active = zero overhead.

### Convention over code
Project Mode is entirely file-based and convention-based. No custom hooks, plugins, or code required. The agent follows rules written in markdown. This makes it portable, debuggable, and easy to modify.

### Graceful degradation
Every failure mode degrades to "no project active, work normally":
- Missing file → no project
- Deleted project folder → notify user, deactivate
- Corrupt content → treat as inactive, notify user

### Context economy
PROJECT.md has a 4KB size limit. Old session logs are archived to `context/session-archive.md`. DECISIONS.md and todo.md are only loaded when actually needed.

## Integration with Other Systems

### Session Handoff (memory-management)
Works seamlessly with the [Session Handoff](../memory-management/hooks/session-handoff/) hook. SESSION-STATE.md includes the active project reference, so context survives compaction.

### boot-md Hook
The BOOT.md extension ensures project state is recovered after gateway restarts. Requires the `boot-md` hook to be enabled.

### Sub-agents & Cron
Sub-agents run sandboxed (`workspaceAccess: "ro"`) — they can read but not modify `ACTIVE-PROJECT.md`. Only explicit user commands in the main session can change project state.

## Edge Cases & Reliability

| Scenario | What happens | Severity |
|----------|-------------|----------|
| Gateway restart | boot-md reads ACTIVE-PROJECT.md, recovers state | 🟢 Safe |
| Compaction | AGENTS.md rule survives (injected file), SESSION-STATE.md has project ref | 🟢 Safe |
| Concurrent sessions | Runs serialized per session key, no race conditions | 🟢 Safe |
| Agent crash mid-write | ACTIVE-PROJECT.md is <100 bytes (practically atomic), degrades to "no project" | 🟢 Safe |
| Deleted project folder | Agent detects, notifies user, sets to inactive | 🟢 Safe |
| Sub-agent interference | Sandbox prevents writes to ACTIVE-PROJECT.md | 🟢 Safe |

## Modular Roadmap

Project Mode is designed to be extended:

1. **✅ Module 1: Project structure & switching** (this package)
2. **Module 2: Todo integration** — Structured task management per project via `todo.md`
3. **Module 3: Planning mode** — `PLAN.md` with planning vs. execution status flag
4. **Module 4: External sync** — Optional Kanban sync with Notion or similar

## Requirements

- OpenClaw 2026.2.x or later
- `boot-md` hook enabled (for gateway restart recovery)
- Writable workspace (not sandboxed)

## Version History

| Version | Date | Changes |
|---------|------|---------|
| v1.0.0 | 2026-02-10 | Initial release — project switching, structure, rules |
