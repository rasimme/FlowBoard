# Agent Delegation & FlowBoard Tasks

This file documents minimal agent-related guidance. For detailed delegation information, see:

- **Handoff Contract & Startup**: `/docs/project-mode/agent-bridge.md` — mandatory startup steps for spawned agents
- **Spawn Wrapper Utility**: `dashboard/hzl-service.js:buildSpawnPrompt()` — build complete spawn prompts
- **Task Execution Protocol**: `/docs/project-mode/agent-bridge.md` § Task Execution Protocol

## When FlowBoard is Active

If this repository's git context is active (your agent is working within FlowBoard), always:

1. **Fetch the official handoff package** before starting work:
   ```
   GET http://127.0.0.1:18790/api/projects/flowboard/tasks/:id/handoff?agentId=<YOUR_AGENT_ID>
   ```

2. **Follow the startup contract** in the handoff package (5 mandatory steps)

3. **Check project context** at any time:
   ```
   GET http://127.0.0.1:18790/api/projects/flowboard/bootstrap
   GET http://127.0.0.1:18790/api/projects/flowboard/rules/<section>
   ```

## UI language

All user-facing interface text (labels, buttons, empty states, toasts,
preset names, notifications) is **English** — no German strings in shipped
UI or agent-facing API messages.

## Commit conventions

Do **not** add AI co-author trailers (`Co-Authored-By: Claude ...` or
similar) to commit messages in this repository.

## Shared checkout / parallel agents

Multiple agents may work in the **same** checkout at the same time. A blanket
`git add -A` / `git add .` / `git commit -a` will sweep another agent's
unstaged or new files into your commit — often under a misleading message.

- Stage only **your own** files explicitly (`git add <path> …`) — never
  `-A`, `.`, or `commit -a`.
- Run `git status` before committing; do not stage changes you did not make.
- Commit your work promptly and atomically — don't leave loose WIP in the tree.
- For larger changes that touch shared files (`server.js`, `hzl-service.js`,
  `package.json`), build in your own `git worktree` and fast-forward onto the
  target branch instead of editing the shared checkout.

## Delegation (for parent agents)

When you spawn a child agent for FlowBoard work, do not write a custom prompt from memory. Use `buildSpawnPrompt()` in `dashboard/hzl-service.js`:

```js
const prompt = hzlService.buildSpawnPrompt(
  'flowboard',
  'T-123-4',
  'Your custom spawn instructions here',
  { targetAgentId: 'agent-target-id' }
);
// Spawn agent with prompt
```

The function returns a complete prompt with the official handoff package prepended.
