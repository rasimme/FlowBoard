# FlowBoard — agent entry point

FlowBoard coordinates work through the dashboard API at
`http://127.0.0.1:18700` (the install's `FLOWBOARD_PORT`; installs set up before
T-495 may still run on `18790`). Use a local-capable tool (exec / curl / node) for
this localhost API — never an external web-fetch/browser. If an API call
fails, report the blocker; do not infer state.

This file is **only the trigger**. Everything else is fetched on demand.

## Start here

1. **Injected context first:** If your own run context contains `# Active Project:` or `# No Active Project` together with `## Identity`, use it for this run. Do not fetch `/status` or `/bootstrap` again for passive startup.
2. **Otherwise, check your status:** `GET /api/status?agentId=<resolved-agentId>&sessionKey=<current-sessionKey>` — use this run's OpenClaw session key if known; otherwise omit `sessionKey`, never invent it.
   - If `activeProject === null`: no project active. Work normally, do not ask, and do not infer state.
   - If active, wait for `contextReady`; details live in `rules/error-handling`.
   - Fetch project context lightly: `GET /api/projects/<activeProject>/rules` + `GET /api/projects/<activeProject>/files/PROJECT.md` (JSON `content`). The large `GET /api/projects/<activeProject>/bootstrap` is only a compatibility fallback.
3. **While active:** Load rules on demand via `GET /api/projects/<activeProject>/rules/<section>`; fetch current task state live via `GET /api/projects/<activeProject>/tasks`, never from context/history or `PROJECT.md`.
4. **Explicit commands:** `FlowBoard: activate project <name>` and related commands follow `rules/commands`; OpenClaw activation defaults to this session, not agent-wide. Verify the same scope; do not fetch `/bootstrap` after activation.

## Where things live

- **Project-specific development rules** (how to develop *this* project): the project's
  `PROJECT.md`, injected or read via `files/PROJECT.md` (JSON `content`).
- **Repo / product conventions** (commit style, English-only UI strings): `CONTRIBUTING.md`.
- **Task execution & delegation:** `rules/agent-bridge` + `rules/api-access`. Build spawn
  prompts with `dashboard/hzl-service.js:buildSpawnPrompt()` — do not hand-write them.
- **External agents** (Codex, Cursor, Claude Code, …): see README §
  "Using FlowBoard with external agents" and `node dashboard/install-trigger.mjs`.
