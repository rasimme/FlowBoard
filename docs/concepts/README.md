# Concepts

Conceptual docs that explain *why* FlowBoard works the way it does. One concept per file. These are the documents to read when you want to understand a part of FlowBoard's architecture without reading the code.

Each concept doc answers five questions:

1. What is this concept?
2. Why does it exist (which problem does it solve)?
3. How does it interact with the rest of FlowBoard?
4. What are the practical consequences for agents and users?
5. Where does the code live?

## Available concepts

- [Lazy Loading](lazy-loading.md) — how rule sections are loaded on demand, the manifest/section split, and the eager-load escape hatch for external agents
- [Agent Identity](agent-identity.md) — agent-id as a string contract, the OpenClaw vs. FlowBoard layers, lazy registration, attribution
- [Hook Architecture](hook-architecture.md) — the single `agent:bootstrap` subscription, what it mutates, why no other events
- [Multi-Agent Model](multi-agent-model.md) — `flowboard_agents` vs. `tasks_current.agent`, lazy registration, claim/release/handoff
- [Kanban](kanban.md) — five-column workflow, lease semantics, subtask depth, blocked-as-flag, archived-vs-trashed
- [Frontend Runtime](frontend-runtime.md) — React task-state convergence, optimistic mutations, and the `window.appState` bridge boundary
- [Idea Canvas](idea-canvas.md) — visual brainstorm, notes/connections/clusters, promote pipeline via Specify session
- [HZL Event Sourcing](hzl-event-sourcing.md) — event log + projections, brain/muscle split, `tasks_current` materialization, single-writer constraint
- [Specify Workflow](specify-workflow.md) — 6-step agent process for unstructured-to-structured work, session lifecycle, RAM-only sessions
- [Modular Project Overview](overview-widgets.md) — server-driven widget grid, trusted registry, presets, GitHub binding, milestones/questions as task conventions
- [Auth Model](auth-model.md) — middleware decision tree, Telegram init-data + JWT cookie, loopback / tunnel / LAN bypasses, fail-closed in production

## Coverage Matrix

Single source of truth for documentation completeness. Each row is a major surface of FlowBoard. The matrix is updated whenever a doc is written, an ADR is accepted, or a new surface is identified.

Legend: ✅ done · 🔲 planned (tracked task) · ⬜ not yet considered · `—` not applicable

| Surface | Scope | Concept doc | Foundation ADR | Tracked tasks |
|---|---|:---:|:---:|---|
| Lazy Loading | Rule sections served on demand; manifest/section split | ✅ [lazy-loading.md](lazy-loading.md) | ✅ ADR-0005, ADR-0006 | — |
| Agent Identity | agent-id string contract; OpenClaw vs FlowBoard layers | ✅ [agent-identity.md](agent-identity.md) | ✅ ADR-0002, ADR-0003 | — |
| Hook Architecture | `agent:bootstrap` subscription; live-inject; no on-disk writes | ✅ [hook-architecture.md](hook-architecture.md) | ✅ ADR-0001, ADR-0004 | — |
| Multi-Agent Model | `flowboard_agents` + task ownership; collaboration; handoff | ✅ [multi-agent-model.md](multi-agent-model.md) | ✅ ADR-0007 | — |
| Kanban | Status workflow; subtask model; lease semantics from user POV | ✅ [kanban.md](kanban.md) | ✅ ADR-0007 | — |
| Frontend Runtime | React task-state convergence; optimistic mutation contract; `appStateBridge`, `taskState`, `taskMutations`, `useTaskActions` | ✅ [frontend-runtime.md](frontend-runtime.md) | ✅ ADR-0019 | T-129 (Phase 6) |
| Idea Canvas | Notes/connections/clusters; promote-to-task; webhook path | ✅ [idea-canvas.md](idea-canvas.md) | ✅ ADR-0012, ADR-0014 | — |
| HZL Event Sourcing | Event store + `tasks_current` materialization; why event-sourced | ✅ [hzl-event-sourcing.md](hzl-event-sourcing.md) | ✅ ADR-0007 | — |
| Specify Workflow | Spec generation lifecycle; sessions; abort/complete | ✅ [specify-workflow.md](specify-workflow.md) | ✅ ADR-0015, ADR-0016 | — |
| Auth Model | Telegram init-data; JWT; loopback bypass; `ALLOWED_USER_IDS` | ✅ [auth-model.md](auth-model.md) | 🔲 likely needed | — |
| External-Agent Discovery | `/api/info`; self-onboarding snippet; lazy registration | ⬜ partial in [agent-identity.md](agent-identity.md) | ✅ ADR-0011 | — |
| Snippet / Doctor | Drift detection; install-trigger marker injection; legacy advisory | ⬜ partial in ADR-0006 | ✅ ADR-0006 (covers fingerprinting) | — |
| Project File Structure | `PROJECT.md`, `tasks.json`, `specs/`, `context/` roles | ⬜ not yet | ⬜ TBD | — |
| Telegram Mini App | Mobile UI shell; HMAC-SHA256 verification; tunnel options | ⬜ not yet | ⬜ TBD | — |

**Adding a row:** when you identify a new major surface (anything that has its own subsystem, its own user-facing concept, or its own architectural footprint), add a row here even if both columns are ⬜. That makes the gap visible.

**Adding a concept doc:** flip the cell to ✅ with a link, and add the entry to the *Available concepts* section above.

**Adding a foundation ADR:** flip the cell to ✅ with the ADR number(s). Foundation ADRs are decisions that established the surface, distinct from later hardening ADRs. A surface can have one foundation ADR and many hardening ADRs.

**Removing a row:** only when the surface itself has been removed from FlowBoard. Documentation gaps are not closed by deleting rows.

## Pending ADR Candidates

Decisions surfaced while writing concept docs that may warrant their own ADR. Each entry stays here until triage decides `keep` (a tracked task is created) or `drop` (with a brief reason). This list is the durable record between concept-doc writing and the T-199 backlog triage.

Status legend: `proposed` — surfaced, not yet triaged · `tasked` — accepted, tracked task exists · `dropped` — explicitly rejected (reason in line) · `merged` — folded into a broader tracked task

**Triage round 1 (2026-05-03):** all candidates from T-200 concept-doc round resolved. 7 new ADRs queued (T-199-5..11), 4 merged into T-199-1's umbrella, 9 dropped with reasons.

| Surface | Candidate decision | Source | Status |
|---|---|---|---|
| Multi-Agent Model + HZL | Umbrella: HZL Task-Bridge + Brain/Muscle split — event sourcing, claim/release/complete contract, status-in-metadata, `tasks_current` materialization | [multi-agent-model.md](multi-agent-model.md), [hzl-event-sourcing.md](hzl-event-sourcing.md) | `tasked` → T-199-1 (umbrella) |
| Agent Identity | External-Agent Discovery: `/api/info` + self-onboarding + lazy registration | [agent-identity.md](agent-identity.md) | `tasked` → T-199-2 |
| Agent Identity | `x-openclaw-agent-id` header dual-acceptance on `/api/status` | [api/agents.md](../reference/api/agents.md) | `tasked` → T-199-3 |
| (cross-cutting) | Bug-fix: `hzl-service.js` reads `process.env.PORT` instead of `FLOWBOARD_PORT` | T-197-8 drift test | `tasked` → T-199-4 (bug, not ADR) |
| Kanban | `blocked` is a boolean flag, not a status | [kanban.md](kanban.md) | `tasked` → T-199-5 |
| Kanban | Subtask depth hard-capped at 1 level | [kanban.md](kanban.md) | `tasked` → T-199-6 |
| Idea Canvas | Canvas migration deferred — vanilla retained pending scope review | [idea-canvas.md](idea-canvas.md) | `tasked` → T-199-7 → ADR-0012 |
| Idea Canvas | Canvas state in `canvas.json` per project — not HZL event-sourced | [idea-canvas.md](idea-canvas.md) | `tasked` → T-199-8 |
| Idea Canvas | Connections undirected in storage, directed in rendering | [idea-canvas.md](idea-canvas.md) | `dropped` — too small for own ADR; documented in concept doc |
| Idea Canvas | Specify-session concurrency: max 1 active per `agentId` | [idea-canvas.md](idea-canvas.md) | `merged` → T-199-10 (covered by RAM-only-sessions ADR) |
| HZL Event Sourcing | Brain/muscle split: FlowBoard owns specs/canvas/UI, HZL owns tasks/events | [hzl-event-sourcing.md](hzl-event-sourcing.md) | `merged` → T-199-1 (umbrella headline) |
| HZL Event Sourcing | FlowBoard is the *only* writer to the HZL DB — hard constraint | [hzl-event-sourcing.md](hzl-event-sourcing.md) | `tasked` → T-199-9 |
| HZL Event Sourcing | FlowBoard `T-NNN` ids retire on delete, never reused | [hzl-event-sourcing.md](hzl-event-sourcing.md) | `dropped` — too small for own ADR; documented in concept doc |
| HZL Event Sourcing | FlowBoard status lives in `metadata.flowboard.status`, separate from HZL native | [hzl-event-sourcing.md](hzl-event-sourcing.md) | `merged` → T-199-1 (umbrella) |
| Specify Workflow | Specify sessions are RAM-only — no DB persistence, no resume across restarts | [specify-workflow.md](specify-workflow.md) | `tasked` → T-199-10 |
| Specify Workflow | Strict step ordering on PERSIST: spec → tasks → canvas-delete (rollback contract) | [specify-workflow.md](specify-workflow.md) | `tasked` → T-199-11 |
| Specify Workflow | 6-step protocol is content (`context/specify-prompt.md`), not server-enforced code | [specify-workflow.md](specify-workflow.md) | `dropped` — convention, documented in concept doc |
| Specify Workflow | Agent — not user — decides task structure in step 3 | [specify-workflow.md](specify-workflow.md) | `dropped` — variant of persist-ordering (T-199-11), documented in concept doc |
| Auth Model | Trust-on-write of `agentId`: agent is attribution, not authentication | [auth-model.md](auth-model.md) | `dropped` — already covered by ADR-0003 |
| Auth Model | Localhost trusted by default; production fails closed without full auth config | [auth-model.md](auth-model.md) | `dropped` — Reference-layer fact, documented in env-vars.md and concept doc |
| Auth Model | Cloudflare Tunnel detection via `cf-ray` is hard-coded | [auth-model.md](auth-model.md) | `dropped` — too small for own ADR; documented in concept doc |
| Auth Model | JWT cookies cannot be revoked except by rotating `JWT_SECRET` | [auth-model.md](auth-model.md) | `dropped` — operational gotcha, belongs in Reference or operator runbook |

## See also

- [Architecture Decision Records](../adr/) — the *what was decided* layer (chronologically numbered, immutable)
- [Reference](../reference/) — the *facts and tables* layer
