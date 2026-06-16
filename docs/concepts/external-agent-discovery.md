# External-Agent Discovery

## What it is

How a non-OpenClaw coding agent (Codex, Cursor, Claude Code, a custom script) finds a running FlowBoard and starts using it — without being provisioned in advance.

## Why it exists

OpenClaw-managed agents get FlowBoard context live-injected by the hook (see [Hook Architecture](hook-architecture.md)). External runtimes have no such hook: they need a way to *discover* the service and *self-onboard* using only the API. FlowBoard treats external agents as first-class rather than second-class integrations.

## How it works

- **Discovery before identity:** `GET /api/info` requires no auth and returns service metadata, the endpoint list, the agent-id convention, and the `external-trigger.md` snippet as `trigger_snippet` — enough to bootstrap from a single curl.
- **Trigger install:** `install-trigger.mjs --repo <path>` writes the external-trigger block into the repo's `AGENTS.md` (wrapped in idempotent markers, re-runnable) and symlinks `CLAUDE.md → AGENTS.md` so Claude Code reads the same content.
- **Lazy registration:** an external agent picks a stable id and is auto-registered in `flowboard_agents` on its first `PUT /api/status` — no pre-registration ([Agent Identity](agent-identity.md)).
- **No live inject:** external agents fetch context on demand via `GET /api/projects/<name>/bootstrap` instead of receiving an injected `BOOTSTRAP.md`.

## Consequences

- Any agent that can make HTTP calls can join the board; identity is a stable string, not an account.
- The trigger snippet stays minimal (a pointer, not a manual) — operational detail lives in the rule sections.

## Where the code lives

- `GET /api/info` in `dashboard/server.js`.
- `dashboard/install-trigger.mjs` — the trigger installer.
- `snippets/external-trigger.md` — the installed block.
- Foundation: [ADR-0011](../adr/0011-external-agent-discovery.md).
