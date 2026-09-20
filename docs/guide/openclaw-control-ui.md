# FlowBoard inside OpenClaw (native Control UI page)

FlowBoard can appear as its own page in the OpenClaw **Control UI** — the
Gateway's own web interface — instead of only as a separate dashboard tab. The
page adds a compact **rail**: the projects you can switch between, the tasks
waiting on you, and one status line, with the full FlowBoard board below it.

This is an opt-in lab feature of OpenClaw and a staged FlowBoard surface. The
standalone dashboard is unchanged and remains the complete product; the
`agent:bootstrap` hook works on every supported OpenClaw version regardless of
what this page does.

## Requirements

| You need | Why |
|---|---|
| OpenClaw **2026.9.2 or newer** | Feature plugins and native Control UI pages do not exist before that. |
| The **Custom plugin UI** lab, enabled | OpenClaw does not load plugin-provided browser code unless you turn it on. |
| The Control UI opened over **HTTPS or `http://127.0.0.1:<port>`** | Native plugin assets need a secure context; plain HTTP on a LAN address cannot load them. |
| FlowBoard's `dashboardBaseUrl` plugin option | The page frames your running dashboard, so it has to know where it is. |
| `FLOWBOARD_SERVICE_TOKEN` (recommended) | Attributes what you do here to *you* rather than to an anonymous local caller. |

On an older OpenClaw, or with the lab off, nothing breaks: the sidebar entry
simply is not there, FlowBoard keeps running as the hook plus the standalone
dashboard, and the plugin's backend operations stay available.

## Turn it on

1. In the Control UI, open **Settings → Labs** and enable **Custom plugin UI**.
   The config equivalent is:

   ```json5
   { gateway: { controlUi: { experimental: { customPlugins: true } } } }
   ```

2. Restart the Gateway and reload the browser tab. (New plugin Gateway methods
   need the restart; a plugin reload is not enough.)
3. Point FlowBoard at your dashboard and give it the service credential, for
   example:

   ```bash
   openclaw config set plugins.entries.flowboard.config.dashboardBaseUrl http://127.0.0.1:18790
   ```

   Store `serviceToken` as a secret reference, never inline — it is the same
   value as the dashboard's `FLOWBOARD_SERVICE_TOKEN`.
4. Open **FlowBoard** in the Control UI sidebar.

## What the rail does

**Projects.** Every FlowBoard project, with the active one marked. A badge
counts what is waiting there (tasks in review plus blocked tasks). Clicking a
project **switches the agent's active project** — the same action as activating
a project in the dashboard, so the next agent run is bootstrapped into it.

The switch is deliberately *agent-level*: it changes the binding that all of
that agent's sessions fall back to, and never a single session's binding. To
scope a project to one session, use the dashboard or the API with a
`sessionKey` (see [session-scoped binding](../concepts/agent-identity.md)).

**Tasks needing me.** FlowBoard's core question — "I come back, what needs me?"
— answered inside the Gateway, in two groups:

- **Needs approval** — tasks an agent moved to `review`. That lane is your
  approve gate; only a human closes it.
- **Blocked or stuck** — tasks whose canonical work state is `blocked`, plus
  work FlowBoard's stall detection flagged: no checkpoint for too long, an
  expired work lease, a task routed to an agent that never claimed it, or a due
  re-check. Each row states the evidence ("no checkpoint for 42 min").

Clicking a row selects that task: the selection goes into the Control UI's own
URL, so it survives a reload and can be shared.

**Status line.** Which agent the rail is following, its active project, which
binding layer answered (`session` or `agent`), whether the project's context is
ready for a bootstrap, when the data last refreshed, and whether the Gateway
connection is live.

**Collapse.** The toggle in the rail header hides everything but the board; the
choice is remembered in this browser.

## The agent setting

The rail follows one agent — `main` unless you change it. The field in the rail
header sets it and remembers it in this browser only, under
`flowboard.controlUi.agentId`. An id FlowBoard would reject (it must be
lowercase kebab-case, like `claude-code`) is refused instead of stored, so a
typo cannot quietly detach the rail from every board.

The setting is a *view* preference. It decides whose binding you see and
change; it never changes who you are. Everything you do from this page is
attributed to your signed-in OpenClaw profile.

## Known limitation: the board below does not follow the link yet

Clicking a task updates the Control UI URL and tells the framed dashboard which
project and task you picked. **The dashboard SPA does not read those parameters
yet** — it has no URL routing and opens the project bound to its own agent. So:

- If the task is in the active project, the board below is already showing it
  and you can find the task there.
- If it is in another project, the board stays where it was. The status line
  says so explicitly ("the board below still opens *x*"), and you can switch to
  that project in the rail first.

This is a stage-1 limitation, not a bug in the link: the deep-link contract
(`?p.project=…&p.task=…` on the Control UI page) is already in place. Stage 2
replaces the framed board with native views that honour it.

## Other things worth knowing

- **Refreshing.** The two lists refresh when something changes, not on a timer
  in your browser. FlowBoard checks the board about every 10 seconds while a
  FlowBoard page is open in the Control UI, and pushes an update only when a
  project's lifecycle status or its review/blocked counts actually moved. A
  change that moves neither — a retitled task, or a stall indicator appearing on
  work that was already in progress — appears at the next refresh rather than
  immediately. Switching projects or reconnecting always refetches.
- **Nothing is polled when nobody is watching.** The check runs only while a
  Control UI client has the plugin loaded.
- **Permissions.** Reading uses your `operator.read` scope, switching a project
  your `operator.write` scope. FlowBoard applies its own rules on top; the
  Gateway scope is a ceiling, not a FlowBoard role.
- **Trust.** Native plugin UI is *not* sandboxed: it runs with your Control UI
  authority. That is why the lab exists and why it is off by default. See
  [SECURITY.md](../../SECURITY.md) and
  [ADR-0037](../adr/0037-trusted-collaborators-and-native-control-ui.md).

## Turn it off

- **Just this page:** disable **Settings → Labs → Custom plugin UI**, then
  reload the tab. FlowBoard's backend operations, tools, the hook and the
  standalone dashboard keep working.
- **The whole integration:** `openclaw plugins disable flowboard` (or
  `uninstall`). The dashboard is a separate service and keeps running either
  way.
- **Just the framed board:** clear
  `plugins.entries.flowboard.config.dashboardBaseUrl`. The rail then explains
  that FlowBoard is not configured instead of framing a dead URL.

## See also

- [OpenClaw Integration](../concepts/openclaw-integration.md) — how the hook,
  the dashboard and this page fit together
- [Troubleshooting](how-to/troubleshooting.md) — hook not registered, context
  not ready, remote auth
- [Manage projects](how-to/manage-projects.md) — what activating a project does
