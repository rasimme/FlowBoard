# ADR-0005: Minimal-trigger snippet + lazy rule loading

## Status
Accepted — **amended 2026-06-11** (T-296)

> **Amendment (T-296):** the manifest now carries an action→section mapping
> ("read `api-access` before mutating tasks; `files`+`specify` before touching
> specs — spec files are never written by hand, use `POST .../specs/:taskId`;
> `canvas` before promote; `error-handling` on errors"). This keeps the
> contract minimal (still manifest, never inlined rule content) while making
> it actionable — a bare external activation previously gave no signal of
> *which* section mattered, and an agent created a spec file by hand instead
> of via the API. Two delivery fixes accompany it: (1) `buildBootstrapDocument`
> now prepends the manifest (it had regressed to embedding sections *without*
> the manifest, contradicting the "manifest + every section" model in
> `docs/concepts/lazy-loading.md`); (2) the `PUT`/`GET /api/status` activation
> responses now include a `rules` pointer (manifest URL, section URL template,
> sections, directive), because an external agent that activates a project
> without fetching a per-task handoff otherwise never received the directive —
> it was only emitted to the OpenClaw wake channel. The minimal-trigger snippet
> itself is unchanged; the mapping lives in the server-rendered manifest, not
> the installed snippet.

## Date
2026-05-02

## Source
- private spec `specs/T-188-minimal-trigger-architecture.md` in operator's local FlowBoard project
- public commit `4471207` — `feat(snippet): minimal-trigger architecture + structural fingerprinting + BOOT cleanup`

## Context

`AGENTS-trigger.md` had grown to 72 lines of always-on API-workflow rules, included in every agent's context whether or not a project was active. Most of the content (task workflow, claim/release semantics, comment endpoints) is irrelevant noise when `flowboard_agents.active_project` is `null`. The snippet was also doing two unrelated jobs: announcing FlowBoard's existence (the trigger) and prescribing how to use it (the rules). Conflating them meant any rule change cost every consumer a snippet upgrade, and `BOOT-extension.md` reinforced the same wording in a duplicate location.

## Decision

`AGENTS-trigger.md` is stripped to a ~20-line **minimal trigger**: on every session start the agent calls `GET /api/status?agentId=<id>` and short-circuits if `activeProject === null`. When a project is active, the agent fetches `GET /api/projects/<name>/bootstrap` for context and `GET /api/projects/<name>/rules/<section>` for any operational rule it actually needs. The available sections (`commands`, `api-access`, `hzl`, `canvas`, `files`, `specify`, `agent-bridge`, `error-handling`, `key-principles`) are listed by `GET /api/projects/<name>/rules/`.

`BOOT-extension.md` and its legacy variants are deleted. The doctor's `TARGETS` no longer includes BOOT.md (see ADR-0006). The dashboard's wake-event message is reworded to match: *check status, then lazy-load*.

## Consequences

- **Positive:** Zero-project sessions carry roughly 20 lines of FlowBoard context instead of 72 plus the BOOT extension.
- **Positive:** Rules and trigger are now decoupled. The trigger is stable; rules can be evolved per section without touching every consumer.
- **Positive:** The same minimal trigger works for OpenClaw-managed agents (with live-inject ADR-0001) and external agents (which fetch `/bootstrap` on demand per ADR-0003).
- **Negative:** First-turn latency increases for active projects: a session-start `/api/status` call plus, when active, two more API calls (bootstrap + at least one rule section). Local API on the same host — typically tens of milliseconds total.
- **Operational:** Existing workspaces need migration via `snippets-doctor --apply` to swap the long snippet for the minimal trigger. ADR-0006 covers the drift detection that drives the doctor.

## Regression guardrails

The trigger must stay minimal. It may contain only the FlowBoard URL, local-tool/no-inference warning, status check, project-context fetch, rule-section list, and pointers to the rule sections that hold details.

Do not add workflow endpoints, task checkpoint/complete steps, HTTP content-type parsing, full identity policy, or retry/blocker detail to `snippets/AGENTS-trigger.md`. Put those contracts in `docs/project-mode/commands.md`, `api-access`, `agent-bridge`, or `error-handling`.

The snippet-doctor test suite enforces this decision with a maximum line count and forbidden-detail phrases. If a future runtime fix needs new mandatory behavior, update the appropriate rule section first and only change the trigger when the trigger itself changes.
