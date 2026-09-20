# ADR-0038: Workboard coexistence — FlowBoard stays the canonical task store

## Status

Accepted (2026-09-20, T-487-6)

## Date

2026-09-20

## Source

- Private spec `specs/T-487-make-flowboard-first-class-on-openclaw-2.md` (v3 — "Mandatory sequence"
  step 4, "Done when": *"Workboard ownership/linking contract prevents dual canonical task stores"*)
  in the operator's local FlowBoard project, and the surface survey it cites.
- OpenClaw documentation: [/plugins/workboard](https://docs.openclaw.ai/plugins/workboard) and the
  generated [Workboard plugin reference](https://docs.openclaw.ai/plugins/reference/workboard),
  both as of OpenClaw 2026.9.5.
- Builds on [ADR-0007](0007-hzl-task-bridge-and-brain-muscle-split.md) (HZL owns task state),
  [ADR-0008](0008-hzl-single-writer-constraint.md) (single writer) and
  [ADR-0037](0037-trusted-collaborators-and-native-control-ui.md) (the integration's trust model).
- Concept: [OpenClaw Integration](../concepts/openclaw-integration.md) § *Workboard coexistence*.

## Context

OpenClaw bundles a **Workboard** plugin: a Kanban-style board in the Control UI for agent-sized
work cards, disabled by default, enabled per Gateway, reached at `/workboard`. It keeps its own
plugin-owned store, exposes `workboard.*` Gateway methods (`operator.read` to read,
`operator.write` to mutate) and has optimistic concurrency on card updates. Its own documentation
sets its scope narrowly:

> "Workboard is intentionally small: it tracks local operating work for one OpenClaw Gateway. It is
> not a replacement for GitHub Issues, Linear, Jira, or other team project management systems."
> — [/plugins/workboard](https://docs.openclaw.ai/plugins/workboard)

FlowBoard is also Kanban-shaped, and once FlowBoard has a native page in the same Control UI the two
boards sit one sidebar entry apart. The obvious-looking move — mirror FlowBoard tasks into Workboard
cards so everything is visible in one place — is the classic way to end up with two stores that each
believe they are right, and no rule for which wins when they disagree.

**The decisive fact is a gap, not a preference.** As of OpenClaw 2026.9.5 there is **no external
card source, provider interface, importer, webhook or synchronisation contract** for Workboard.
A card's only outward-facing hook is its optional *linked refs* — "task, run, session, or source
URL" — and those are Workboard-owned fields: Workboard stores a reference, it does not adopt a
foreign object, and nothing in the contract defines what happens when the referenced thing changes.
There is therefore nothing to synchronise *against*: any mirroring would be FlowBoard inventing a
private protocol on top of a surface whose owner has not defined one, and rewriting it on every
Workboard release.

## Decision

1. **FlowBoard is the canonical store for FlowBoard projects and tasks.** Task identity, status,
   claims, leases, checkpoints, comments and history live in FlowBoard/HZL and nowhere else
   ([ADR-0007](0007-hzl-task-bridge-and-brain-muscle-split.md),
   [ADR-0008](0008-hzl-single-writer-constraint.md)). FlowBoard is the state of record.
2. **Workboard keeps two legitimate roles.** It may hold *stable links* to FlowBoard tasks, and it
   may act as a *bounded OpenClaw-native execution view* for Gateway-local operating work that is
   not FlowBoard work at all. Both are fine. Neither makes it a second task store.
3. **No status mirroring and no bidirectional synchronisation** — not now, and not as a "small
   convenience". This holds until OpenClaw exposes a **stable external source/provider contract with
   defined conflict semantics**: who wins on a concurrent edit, what a deleted source means, how a
   failed write is retried, and how a card that has drifted is reconciled. Until those questions
   have documented answers, copying status between the boards is a data-loss feature.
4. **One canonical owner per task.** A unit of work is owned by FlowBoard *or* by Workboard, decided
   when it is created and never both. A FlowBoard task that also exists as a Workboard card is one
   task with a pointer, not two tasks.
5. **Agents must not auto-create Workboard cards for FlowBoard tasks.** No hook, no sweeper, no
   helpful background job. A human may create a card and paste a link; automation may not
   manufacture the second copy that rule 4 forbids.
6. **A Workboard card that references a FlowBoard task carries the link and defers.** Its column and
   any status-like field on it are a local note for the Gateway's own board, never evidence about
   the task. FlowBoard does not read Workboard state back, and nothing in FlowBoard changes because
   a card moved. A card's session reference is context in the sense of **ADR-0039**, not ownership.
7. **The FlowBoard task link contract** (intent; implemented in T-487-8) is one canonical shape so a
   link stays valid as the native UI matures:
   - **Control UI deep link**, when the native page is available:
     `/plugin?plugin=flowboard&id=flowboard&p.project=<name>&p.task=<id>` — the host passes per-tab
     `p.*` parameters through to the plugin page.
   - **Standalone URL**, always valid and the fallback everywhere else: the FlowBoard dashboard's
     own base URL for the operator's install.
   - **Known limitation:** FlowBoard's SPA has no URL routing today, so `p.project` / `p.task` are
     not yet consumed. Interpreting them is the native page's job (T-487-8); until then a deep link
     opens FlowBoard without preselecting the task, which is a degradation and not a broken link.
     The parameter names are fixed here so links created now keep working later.

## Consequences

- **There is always one answer to "what is the state of this task?"** — FlowBoard. An operator who
  enables Workboard gets a second board with a different job, not a competing copy of the first.
- **The integration does not depend on an undocumented surface.** FlowBoard builds nothing on
  Workboard's storage, card schema or linked-ref semantics, so a Workboard release cannot break
  FlowBoard, and enabling or disabling Workboard has no effect on FlowBoard data.
- **The cost is honest and small:** no "all my work in one board" view. Cross-board visibility, if it
  is ever wanted, is a *link-following* problem, not a replication problem.
- **Revisit when either trigger fires:** (a) OpenClaw publishes a stable external source/provider
  contract for Workboard cards *with* conflict semantics; or (b) users actually ask for two-way sync
  rather than for links. Either one reopens this ADR; neither is a reason to prototype mirroring in
  the meantime.
