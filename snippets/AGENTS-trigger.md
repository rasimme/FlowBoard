## FlowBoard (API-First)
<!-- flowboard-snippet-contract: v4-injected-context-first -->

Project coordination via FlowBoard dashboard at `http://127.0.0.1:18700`.
Use a local-capable tool for this localhost API (exec/curl/node or an internal API tool), never external web-fetch/browser. If an API call fails, do not infer state; report the blocker.

### Minimal trigger

1. **Injected context first:** If your own run context contains `# Active Project:` or `# No Active Project` together with `## Identity`, use it for this run. Do not fetch `/status` or `/bootstrap` again for passive startup.
2. **Otherwise, check your status:** `GET /api/status?agentId=<resolved-agentId>&sessionKey=<current-sessionKey>` — use this run's OpenClaw session key if known; otherwise omit `sessionKey`, never invent it.
   - If `activeProject === null`: no project active. Work normally, do not ask, and do not infer state.
   - If active, wait for `contextReady`; details live in `rules/error-handling`.
   - Fetch project context lightly: `GET /api/projects/<activeProject>/rules` + `GET /api/projects/<activeProject>/files/PROJECT.md` (JSON `content`). The large `GET /api/projects/<activeProject>/bootstrap` is only a compatibility fallback.
3. **While active:** Load rules on demand via `GET /api/projects/<activeProject>/rules/<section>`; fetch current task state live via `GET /api/projects/<activeProject>/tasks`, never from context/history or `PROJECT.md`.
4. **Explicit commands:** `FlowBoard: activate project <name>` and related commands follow `rules/commands`; OpenClaw activation defaults to this session, not agent-wide. Verify the same scope; do not fetch `/bootstrap` after activation.

### Where details live

This file is only the trigger. Do not add workflow/API detail here.
Project commands: load `rules/commands`.
Task execution: load `rules/agent-bridge` and `rules/api-access`.
