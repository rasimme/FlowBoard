# Agent Bridge & Task Execution

## Purpose

How agents interact with FlowBoard tasks at runtime - the claim/execute/complete protocol and handoff semantics for multi-agent and ACP-spawned work.

## Task Execution Protocol

The protocol is **soft and global** - it's a convention enforced by the API, not a hard scheduler.

### Lifecycle

```
ready → [claim] → in_progress → [checkpoint]* → [complete] → done
                              → [release] → ready
                              → [block] → blocked → [unblock] → ready
```

### Behavioral Rules

For concrete endpoint shapes and request bodies, see `tasks-api.md` § Coordination Primitives.

- **Claim**: Only one agent at a time. Rejects if already claimed (409) unless lease expired. Rejects if routed to different agent (403). Rejects if dependencies incomplete.
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

The three hzl-core workflows (`start`, `handoff`, `delegate`) provide atomic multi-step operations:

- **start**: Find and claim the next task for an agent (with resume logic for interrupted work)
- **handoff**: Complete current task + create follow-on in one atomic operation, carrying checkpoint context
- **delegate**: Create child task + optional dependency + optional parent pause

All support idempotency via `op_id` to safely retry without double-execution.

## Event Context

All mutations accept optional context fields:
- `author` - Human or system initiator
- `agent_id` - Agent performing the action
- `session_id` - Session identifier for tracing
- `correlation_id` / `causation_id` - Event chain tracing

These are recorded on the append-only event store and visible in the event log.
