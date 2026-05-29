# Agent Bridge & Task Execution

## Purpose

How agents interact with FlowBoard tasks at runtime - the workflow-first execution protocol, claim/lease semantics, and handoff behavior for multi-agent and ACP-spawned work.

## Task Execution Protocol

The protocol is **soft and global** - it is a convention enforced by the API, not a hard scheduler.

Agents should use the workflow endpoints for normal execution. The primitive endpoints still exist, but they are fallback/debug tools.

### Workflow-First Path

1. **Start or resume work**
   `POST /api/workflows/start` with `{ agent, project, lease?, resumePolicy? }`.
   This either refreshes/resumes the agent's in-progress task or claims the next eligible open/backlog task.
2. **Checkpoint progress**
   `POST /api/projects/:name/tasks/:id/checkpoint` with `{ agent, message, progress? }`.
3. **Finish or transfer**
   Use `POST /api/projects/:name/tasks/:id/complete` for normal completion into review.
   Use `POST /api/workflows/handoff` to complete the source and create follow-on work.
   Use `POST /api/workflows/delegate` to create delegated child work and optionally pause the parent.

Manual "list open tasks, choose one, then claim" should only be used when the workflow endpoint is unavailable or the user explicitly needs a custom selection.

### Lifecycle

```
open/backlog → [workflow start] → in-progress → [checkpoint]* → [complete] → review
                                            → [workflow handoff] → review + follow-on open
                                            → [workflow delegate] → child open, parent optionally blocked
                                            → [release] → open
```

### Behavioral Rules

For concrete endpoint shapes and request bodies, see `tasks-api.md` § Coordination Primitives.

- **Workflow start**: Default entry point. Resumes in-progress work for the agent or atomically claims the next eligible task.
- **Claim**: Primitive ownership operation. Only one agent at a time. Rejects if already claimed (409) unless lease expired. Rejects if routed to different agent (403). Rejects if dependencies incomplete.
- **Checkpoint**: Only the claiming agent can checkpoint. Progress (0–100) updates the task. Checkpoints are append-only.
- **Complete**: Only the claiming agent. Triggers parent status recalculation for subtasks.
- **Release**: Returns task to `ready`, clears agent and lease. Use when blocked or reassigning.
- **Route**: Soft-assigns to a specific agent. Does NOT auto-claim — target still needs to claim.
- **Comments**: Append-only steering signals, not chat. Agents should read comments when claiming or resuming.

## Handoff Context

The `/handoff` endpoint returns structured context for spawning a coding agent (CC, Codex, etc.): task title, description, spec content, recent checkpoints/comments, and parent context if subtask. Used to construct ACP spawn payloads.

## Stuck Detection

The `/tasks/stuck` endpoint returns cross-project tasks that are `in_progress` with no checkpoint beyond a threshold or with an expired lease. Used for monitoring and automatic intervention.

## Multi-Agent Patterns

### Sequential Handoff
Agent A completes task → follow-on task created (via workflow `handoff`) → Agent B claims.

### Delegation
Agent A creates subtask (via workflow `delegate`) → routes to Agent B → optionally pauses parent until subtask completes.

### Steal (Expired Lease)
If Agent A's lease expires, Agent B can claim the task. The original agent loses ownership.

## HZL Workflow Integration

The three hzl-core workflows (`start`, `handoff`, `delegate`) are the normal FlowBoard runtime contract:

- **start**: Find and claim the next task for an agent (with resume logic for interrupted work)
- **handoff**: Complete current task + create follow-on in one atomic operation, carrying checkpoint context
- **delegate**: Create child task + optional dependency + optional parent pause

`handoff` and `delegate` support `opId` for safe retries without double-execution. FlowBoard exposes `start` as a resumable/claim-next operation and keeps primitive endpoints available for explicit edge cases.

## Event Context

All mutations accept optional context fields:
- `author` - Human or system initiator
- `agent_id` - Agent performing the action
- `session_id` - Session identifier for tracing
- `correlation_id` / `causation_id` - Event chain tracing

These are recorded on the append-only event store and visible in the event log.
