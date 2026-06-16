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

## Testing & local verification

- **Run the gate:** `cd dashboard && npm test` runs the full suite (unit + API
  integration + browser E2E). Keep it green before committing. A few
  Edge/puppeteer canvas tests are timing-flaky — re-run a failing browser test
  once in isolation before treating it as a real failure.
- **Browser render tests (does the React app actually render it?):** use the
  shared harness `dashboard/test-support/browser-harness.js`. It boots the built
  dashboard on a temp DB + headless Microsoft Edge and hands you `{ api, page,
  base }`. Reference: `dashboard/test-kanban-sort-e2e.js`.
  ```js
  const { withDashboard, reporter } = require('./test-support/browser-harness.js');
  const r = reporter('My feature');
  const res = await withDashboard(async ({ api, page, base }) => {
    await api('POST', '/projects', { name: 'p' });
    await page.goto(`${base}/?agentId=e2e`, { waitUntil: 'networkidle2' });
    r.ok(await page.$('.app'), 'app shell mounts');
  });
  if (res?.skipped) r.skip(res.reason); // Edge/dist missing → skip, exit 0
  r.done();
  ```
  Requires a prior `npx vite build` (dist/). Name new render tests
  `test-<feature>-e2e.js` and wire them into the `npm test` script. Prefer this
  harness for any UI-behaviour claim — logic/unit tests alone don't prove what
  the board renders.

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
