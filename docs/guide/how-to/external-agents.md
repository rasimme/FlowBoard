# Use FlowBoard with external agents

Codex, Cursor, Claude Code and other runtimes that talk to the API directly.


FlowBoard is designed for OpenClaw-managed agents *and* for external
runtimes that talk to the API directly. External agents are first-class:
they self-register on the first `PUT /api/status`, appear in the dashboard
agent list, and use the same task workflow as OpenClaw agents.

What's different for external agents: there is no live-injected
`FLOWBOARD.md` in your run context (that mechanism is OpenClaw-runtime
specific). Instead, fetch the project context on demand via
`GET /api/projects/<project>/bootstrap`.

## Install the trigger snippet in your project repo

Run once per repo where you want an external agent to use FlowBoard:

```bash
node ~/repos/FlowBoard/dashboard/install-trigger.mjs --repo ~/myrepo
```

This adds the FlowBoard external-trigger block to `myrepo/AGENTS.md`
(idempotent — re-run anytime to refresh) and creates `myrepo/CLAUDE.md`
as a symlink to `AGENTS.md` so Claude Code reads the same content.
Use `--no-symlink` on filesystems without symlink support (Windows,
sync-mounted drives); the installer falls back to a copy.

To remove the block later:

```bash
node ~/repos/FlowBoard/dashboard/install-trigger.mjs --repo ~/myrepo --uninstall
```

## Discovery without the installer

The same content is served by the dashboard for tooling or quick
inspection:

```bash
curl http://localhost:18700/api/info
```

Returns service metadata, the API endpoint list, and the trigger
snippet as `trigger_snippet`. No auth is required — discovery happens
before identity. Suitable for users who prefer to copy-paste into a
specific config file (`.cursorrules`, `CONVENTIONS.md`, etc.) instead
of `AGENTS.md`.

## Identity convention

Pick a stable agent-id for your runtime:

| Runtime | Suggested agent-id |
|---|---|
| Claude Code | `claude-code` |
| Codex | `codex` |
| Cursor | `cursor` |
| Aider | `aider` |
| Custom script | a stable string of your choice |

Add a host suffix (`codex-laptop`, `claude-code-jetson`) if you run
multiple parallel instances. The agent-id is a freeform string —
auto-registered in `flowboard_agents` on the first `PUT /api/status`.
Keep it stable across the session so the dashboard shows clean
attribution.
