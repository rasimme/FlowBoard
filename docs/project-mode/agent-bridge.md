# Agent Bridge & Task Execution

## Purpose

How agents interact with FlowBoard tasks at runtime - the workflow-first execution protocol, claim/lease semantics, and handoff behavior for multi-agent and ACP-spawned work.

## Asking the human (T-307)

When you need a decision or information only the human has, post a typed
comment on the task instead of stalling or guessing:

```
POST /api/projects/:name/tasks/:id/comment
{ "agent": "<you>", "message": "<the question>", "kind": "question" }
```

Open questions surface on the project overview (agent-questions widget)
and are answered with `{ kind: "answer", questionId: <comment id> }` —
the answer lands on the task's activity feed; poll the comments or just
continue when your next session picks the task back up. Don't re-ask:
one open question per decision.

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

### Delegating FlowBoard Task Work

When you spawn or delegate another agent for FlowBoard project work, do not create a free-form prompt from memory. First fetch the task handoff package:

`GET /api/projects/:name/tasks/:id/handoff?agentId=<target-agent-id>`

The markdown handoff package is the official spawn preamble. It contains the audit marker `flowboard-handoff-contract: v1` and a mandatory startup contract for the spawned agent:

1. activate/check the project with `PUT /api/status { project, agentId }`
2. fetch bootstrap and lazy-load required rules
3. claim the exact task
4. write a first checkpoint
5. only then inspect or edit repository files
6. when complete, set the task to review and deactivate the project context unless explicitly configured as a persistent worker

All localhost FlowBoard API calls must use a local-capable tool such as shell/curl/node. Do not use external web-fetch/browser tools for `127.0.0.1` or `localhost`.

Git and external-action behavior is policy-driven. The handoff package first looks for a project-level `## Agent Git Policy` / `## Git Policy` section, then falls back to the conservative default: no `git commit`, `git push`, release, publish, or external delivery commands unless the user explicitly asked for that action in the current task. This keeps FlowBoard safe by default without forcing one installation's workflow onto every project.

Short-lived delegated task agents should deactivate after completion:

```json
PUT /api/status
{
  "project": null,
  "agentId": "<target-agent-id>"
}
```

Do not delete the agent row for normal completion; deactivation preserves attribution/history while removing the agent from the active project context. Persistent orchestrators or long-lived workers may stay active only when the handoff or user explicitly says so.

#### Minimal-Snippet Contract

AGENTS.md snippets stay minimal and only tell agents to consult FlowBoard when a project is active. This rule section and the handoff package carry the delegation details.

**The Contract:**
- AGENTS.md trigger is ≤30 lines total
- **Trigger only**: status check, active-project detection, bootstrap fetch, rule pointers
- **Never embed**: delegation endpoints, workflow details, HTTP protocol, error handling, retry logic
- **All details in rules/**: agent-bridge (task execution), api-access (endpoint reference), error-handling (recovery)
- **Detection**: `snippets-doctor` validates constraint violations at lint/CI time

**Why Minimal:**
- Smaller footprint for agents to parse at startup
- Clear separation: snippets are shallow triggers, rules are deep operational detail
- Safer to iterate rules without agents carrying stale instructions
- Easier to detect contract drift if the snippet grows

### Spawn-Wrapper Utility (T-263)

The `buildSpawnPrompt()` function (in `dashboard/hzl-service.js`) combines a handoff package with custom spawn instructions. Use it when programmatically building prompts for agent delegation:

```js
const hzlService = require('./hzl-service.js');

// Simple: handoff only (no custom instructions)
const spawnPrompt = hzlService.buildSpawnPrompt('flowboard', 'T-262-5');

// With custom task instructions
const spawnPrompt = hzlService.buildSpawnPrompt(
  'flowboard',
  'T-262-5',
  'Implement the session handoff endpoint and add error handling for invalid project names',
  { targetAgentId: 'agent-xyz' }
);
```

The function always returns the handoff package followed by custom instructions (if provided). The handoff contract marker `flowboard-handoff-contract: v1` is always at the start so spawned agents can detect and follow the startup contract.

**Parameters:**
- `project` — project name (e.g., `'flowboard'`)
- `taskId` — task ID (e.g., `'T-262-5'`)
- `customPrompt` — optional spawn instructions; whitespace-only treated as empty (default: `''`)
- `options` — optional: `{ apiBase, targetAgentId, maxSpecSize, ... }`; forwarded to `buildHandoffMarkdown()`

**Returns:** Markdown string with handoff prepended to custom instructions.

## Stuck Detection & Compliance (T-263-4)

The `/tasks/stuck` endpoint returns cross-project tasks that are:
- `in_progress` with no checkpoint beyond a threshold (stale)
- with an expired lease (expired)
- **routed to an agent but not yet claimed** (routed-unclaimed) — indicates handoff contract violation

See `compliance.md` for detailed compliance monitoring, health metrics, and troubleshooting.

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

## Frontend Runtime Bridge (`appStateBridge`)

Since Phase 6 (T-129), the legacy Vanilla JS runtime (`app.js`) coexists with the React shell via a **bridge boundary** — `dashboard/src/state/appStateBridge.mjs`. This is the *only* module allowed to read or write `window.appState.tasks`, and the only place that owns:

- **`getTasks()` / `setTasks()` / `replaceTasks()`** — task state access from React
- **`getCurrentProject()`** — project context from the legacy runtime
- **`notify()`** — signals React to re-render (dispatches `appstate:change` event or calls `window._notifyReact`)
- **`refreshTasks()`** — fetches current tasks from the API and pushes them into `appState`, then notifies React

**Contract:**

| Access | Owner | Path |
|---|---|---|
| Read `appState.tasks` | React components through `appStateBridge` only | `getTasks()` / `replaceTasks()` / `refreshTasks()` |
| Write `appState.tasks` | `taskMutations` (via `setTasks`) or legacy `app.js` (direct) | `appStateBridge.setTasks()` → `window.appState.tasks = [...]` |
| Trigger React re-render | `appStateBridge.notify()` | `window._notifyReact()` or `CustomEvent('appstate:change')` |
| Read current project | React components through `appStateBridge` only | `getCurrentProject()` |

**Why it exists:**

1. The legacy `app.js` still owns `window.appState` — React cannot mutate it directly.
2. `taskMutations.mjs` is browser-independent — all `window` access goes through the bridge.
3. `notify()` abstracts two notification paths (direct callback + custom event) so React state stays in sync regardless of how the API response arrives.
4. The bridge makes it safe to migrate individual components incrementally — a component never knows whether the task data came from an API call by the legacy runtime or by React itself.

**Code:** `dashboard/src/state/appStateBridge.mjs` — see also [ADR-0019](../adr/0019-frontend-runtime-foundation.md) and [Frontend Runtime concept](../concepts/frontend-runtime.md).
