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
- [Idea Canvas](idea-canvas.md) — visual brainstorm, notes/connections/clusters, promote pipeline via Specify session
- [HZL Event Sourcing](hzl-event-sourcing.md) — event log + projections, brain/muscle split, `tasks_current` materialization, single-writer constraint

## Coverage Matrix

Single source of truth for documentation completeness. Each row is a major surface of FlowBoard. The matrix is updated whenever a doc is written, an ADR is accepted, or a new surface is identified.

Legend: ✅ done · 🔲 planned (tracked task) · ⬜ not yet considered · `—` not applicable

| Surface | Scope | Concept doc | Foundation ADR | Tracked tasks |
|---|---|:---:|:---:|---|
| Lazy Loading | Rule sections served on demand; manifest/section split | ✅ [lazy-loading.md](lazy-loading.md) | ✅ ADR-0005, ADR-0006 | — |
| Agent Identity | agent-id string contract; OpenClaw vs FlowBoard layers | ✅ [agent-identity.md](agent-identity.md) | ✅ ADR-0002, ADR-0003 | — |
| Hook Architecture | `agent:bootstrap` subscription; live-inject; no on-disk writes | ✅ [hook-architecture.md](hook-architecture.md) | ✅ ADR-0001, ADR-0004 | — |
| Multi-Agent Model | `flowboard_agents` + task ownership; collaboration; handoff | ✅ [multi-agent-model.md](multi-agent-model.md) | 🔲 needed | [T-199-1](../../) (HZL Task-Bridge ADR) |
| Kanban | Status workflow; subtask model; lease semantics from user POV | ✅ [kanban.md](kanban.md) | 🔲 needed | [T-199-1](../../) (HZL Task-Bridge ADR) |
| Idea Canvas | Notes/connections/clusters; promote-to-task; webhook path | ✅ [idea-canvas.md](idea-canvas.md) | 🔲 needed | — |
| HZL Event Sourcing | Event store + `tasks_current` materialization; why event-sourced | ✅ [hzl-event-sourcing.md](hzl-event-sourcing.md) | 🔲 needed | [T-199-1](../../) (HZL Task-Bridge ADR) |
| Specify Workflow | Spec generation lifecycle; sessions; abort/complete | 🔲 [specify-workflow.md](specify-workflow.md) | ⬜ TBD after concept | T-200-5 |
| Auth Model | Telegram init-data; JWT; loopback bypass; `ALLOWED_USER_IDS` | 🔲 [auth-model.md](auth-model.md) | ⬜ TBD after concept | T-200-6 |
| External-Agent Discovery | `/api/info`; self-onboarding snippet; lazy registration | ⬜ partial in [agent-identity.md](agent-identity.md) | 🔲 needed | [T-199-2](../../) |
| Snippet / Doctor | Drift detection; install-trigger marker injection; legacy advisory | ⬜ partial in ADR-0006 | ✅ ADR-0006 (covers fingerprinting) | — |
| Project File Structure | `PROJECT.md`, `tasks.json`, `specs/`, `context/` roles | ⬜ not yet | ⬜ TBD | — |
| Telegram Mini App | Mobile UI shell; HMAC-SHA256 verification; tunnel options | ⬜ not yet | ⬜ TBD | — |

**Adding a row:** when you identify a new major surface (anything that has its own subsystem, its own user-facing concept, or its own architectural footprint), add a row here even if both columns are ⬜. That makes the gap visible.

**Adding a concept doc:** flip the cell to ✅ with a link, and add the entry to the *Available concepts* section above.

**Adding a foundation ADR:** flip the cell to ✅ with the ADR number(s). Foundation ADRs are decisions that established the surface, distinct from later hardening ADRs. A surface can have one foundation ADR and many hardening ADRs.

**Removing a row:** only when the surface itself has been removed from FlowBoard. Documentation gaps are not closed by deleting rows.

## Pending ADR Candidates

Decisions surfaced while writing concept docs that may warrant their own ADR. Each entry stays here until triage decides `keep` (a tracked task is created) or `drop` (with a brief reason). This list is the durable record between concept-doc writing and the T-199 backlog triage.

Status legend: `proposed` — surfaced, not yet triaged · `tasked` — accepted, tracked task exists · `dropped` — explicitly rejected (reason in line)

| Surface | Candidate decision | Source | Status |
|---|---|---|---|
| Multi-Agent Model | HZL Task-Bridge: claim/release/complete API contract, lease, `tasks_current` | [multi-agent-model.md](multi-agent-model.md) | `tasked` → T-199-1 |
| Agent Identity | External-Agent Discovery: `/api/info` + self-onboarding + lazy registration | [agent-identity.md](agent-identity.md) | `tasked` → T-199-2 |
| Agent Identity | `x-openclaw-agent-id` header dual-acceptance on `/api/status` | [api/agents.md](../reference/api/agents.md) | `tasked` → T-199-3 |
| (cross-cutting) | Bug-fix: `hzl-service.js` reads `process.env.PORT` instead of `FLOWBOARD_PORT` | T-197-8 drift test | `tasked` → T-199-4 (bug, not ADR) |
| Kanban | `blocked` is a boolean flag, not a status | [kanban.md](kanban.md) | `proposed` |
| Kanban | Subtask depth hard-capped at 1 level | [kanban.md](kanban.md) | `proposed` |
| Idea Canvas | Canvas stays vanilla JS — no React migration | [idea-canvas.md](idea-canvas.md) | `proposed` |
| Idea Canvas | Canvas state in `canvas.json` per project — not HZL event-sourced | [idea-canvas.md](idea-canvas.md) | `proposed` |
| Idea Canvas | Connections undirected in storage, directed in rendering | [idea-canvas.md](idea-canvas.md) | `proposed` (likely too small for own ADR; absorb into concept doc) |
| Idea Canvas | Specify-session concurrency: max 1 active per `agentId` | [idea-canvas.md](idea-canvas.md) | `proposed` (may belong to a Specify ADR instead) |
| HZL Event Sourcing | Brain/muscle split: FlowBoard owns specs/canvas/UI, HZL owns tasks/events | [hzl-event-sourcing.md](hzl-event-sourcing.md) | `proposed` (could be the umbrella for T-199-1) |
| HZL Event Sourcing | FlowBoard is the *only* writer to the HZL DB — hard constraint | [hzl-event-sourcing.md](hzl-event-sourcing.md) | `proposed` |
| HZL Event Sourcing | FlowBoard `T-NNN` ids retire on delete, never reused | [hzl-event-sourcing.md](hzl-event-sourcing.md) | `proposed` (likely too small for own ADR) |
| HZL Event Sourcing | FlowBoard status (`review`, `open`) lives in `metadata.flowboard.status`, separate from HZL native status | [hzl-event-sourcing.md](hzl-event-sourcing.md) | `proposed` |

## See also

- [Architecture Decision Records](../adr/) — the *what was decided* layer (chronologically numbered, immutable)
- [Reference](../reference/) — the *facts and tables* layer
