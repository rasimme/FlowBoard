# ADR-0027: Agent-facing docs — trigger vs project rules vs repo conventions

## Status
Accepted

## Date
2026-06-16

## Context

Three distinct kinds of guidance had accumulated in the repo's root `AGENTS.md`:

1. an **entry trigger** — how an agent that opens the repo discovers the
   FlowBoard API, activates a project, and loads context;
2. **project-specific development rules** — how *this* project is developed
   (branch/commit flow, build & test gate, where shared-file changes go,
   deploy/restart steps, multi-agent coordination in a shared checkout);
3. **repo/product conventions** — commit-message style, English-only UI strings.

Mixing them in one shipped file caused two problems. Dev-process notes that are
local to how the operator runs the project leaked into the public repo, and the
same rule risked being maintained in two places (`AGENTS.md` *and* the project's
`PROJECT.md`). `CLAUDE.md` was only a symlink to `AGENTS.md`, so there was no
real separation between "what ships" and "how we work locally".

A key constraint: `AGENTS.md` / `CLAUDE.md` is auto-read by agent runtimes when
the repo is opened — it is the bootstrap entry point. It cannot simply be
deleted, or an agent opening the repo has no way to learn that FlowBoard exists
and that it should read the project's rules.

`GET /api/projects/:name/bootstrap` already serves the project's `PROJECT.md`
(from the projects directory) to every agent — OpenClaw-managed and external
alike (ADR-0011). That makes `PROJECT.md` the natural, always-read home for
project-specific rules, without committing them to the public repo.

## Decision

Separate the three concerns by home:

1. **Root `AGENTS.md` = minimal trigger only.** Status check → activate →
   `bootstrap` (which includes `PROJECT.md`) → load rule sections on demand. It
   points to where everything else lives and carries no project rules or
   conventions itself. Mirrors `snippets/AGENTS-trigger.md` (ADR-0005/0011).
2. **Project-specific development rules live in the project's `PROJECT.md`,**
   under a `## Development rules (read before changing code)` section. Served via
   `bootstrap`, so every agent working on the project reads them; for projects
   whose `PROJECT.md` is operator-private, the rules stay out of the public repo.
3. **Repo/product conventions** (commit style, English-only UI) live in
   `CONTRIBUTING.md`, where a plain repo clone (human or agent) sees them.
4. **The new-project scaffold seeds a `## Development rules` stub** in every
   `PROJECT.md`, so the convention generalizes to all projects, not just FlowBoard.

## Consequences

- **One home per rule kind — no parallel maintenance.** Dev rules are edited only
  in `PROJECT.md`; the trigger rarely changes; conventions live in `CONTRIBUTING`.
- **Local dev process stays out of the public repo** when `PROJECT.md` is private,
  while still reaching every agent via `bootstrap`.
- **Agents opening the repo still onboard** — the trigger remains; it now also
  explicitly tells them the project's dev rules are in `PROJECT.md`.
- **Generalizes to future projects** — the scaffold stub means any project can
  carry project-specific dev rules in the same, discoverable place.
- **`project-files.md` (the `files` rule section)** documents the `PROJECT.md`
  dev-rules convention so agents discover it on demand.

## See also

- ADR-0005 — Minimal-trigger snippet for OpenClaw agents
- ADR-0011 — External-agent discovery (`/api/info`, install-trigger, bootstrap serves `PROJECT.md`)
- `docs/project-mode/project-files.md` — project file roles
- `CONTRIBUTING.md` — repo conventions
