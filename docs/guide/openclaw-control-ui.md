# FlowBoard inside OpenClaw (native Control UI page)

FlowBoard can appear as its own page in the OpenClaw **Control UI** — the
Gateway's own web interface — instead of only as a separate dashboard tab. The
page is the FlowBoard dashboard itself, running natively in the Control UI:

- the same **Overview**, **Ideas**, **Tasks** and **Files** tabs, the project
  list, search, the task detail panel, Specify, export and import;
- the same code as the standalone dashboard, so a feature that works there
  works here;
- the Control UI's look: the page follows the theme you chose in OpenClaw
  (light, dark or custom) and has no header of its own.

Two smaller views come with it: a **"Needs me" widget** for session dashboards
and a **task panel** for a session's side panel (see
[below](#dashboard-widget-and-session-panel)).

This is an opt-in lab feature of OpenClaw. The standalone dashboard is
unchanged and remains the complete product; the `agent:bootstrap` hook works on
every supported OpenClaw version regardless of what this page does.

## Requirements

| You need | Why |
|---|---|
| OpenClaw **2026.9.2 or newer** | Feature plugins and native Control UI pages do not exist before that. The page is verified on 2026.10.9. |
| The **Custom plugin UI** lab, enabled | OpenClaw does not load plugin-provided browser code unless you turn it on. |
| The Control UI opened over **HTTPS or `http://127.0.0.1:<port>`** | Native plugin assets need a secure context; plain HTTP on a LAN address cannot load them. |
| A running FlowBoard dashboard and the `dashboardBaseUrl` plugin option | The page has no data of its own. The Gateway reads and writes your dashboard on the page's behalf, so it has to know where the dashboard is. |
| `FLOWBOARD_SERVICE_TOKEN` (recommended) | Attributes what you do here to *you* rather than to an anonymous local caller. |

On an older OpenClaw, or with the lab off, nothing breaks: the sidebar entry
simply is not there, FlowBoard keeps running as the hook plus the standalone
dashboard.

## Turn it on

1. In the Control UI, open **Settings → Labs** and enable **Custom plugin UI**.
   The config equivalent is:

   ```json5
   { gateway: { controlUi: { experimental: { customPlugins: true } } } }
   ```

2. Reload the browser tab. From 2026.9.6 the Gateway applies the lab flag
   through live config reload and open pages refresh their plugin views; on
   2026.9.2–2026.9.5, restart the Gateway first.
3. Point FlowBoard at your dashboard and give it the service credential, for
   example:

   ```bash
   openclaw config set plugins.entries.flowboard.config.dashboardBaseUrl http://127.0.0.1:18700
   ```

   Store `serviceToken` as a secret reference rather than inline — it is the
   same value as the dashboard's `FLOWBOARD_SERVICE_TOKEN`. For example, with
   the token in a private JSON file (`chmod 600`, one hard link, owned by the
   Gateway user) such as `{"flowboard": {"serviceToken": "<64 hex chars>"}}`:

   ```json5
   {
     secrets: {
       providers: {
         flowboard: { source: "file", path: "~/.config/flowboard/secrets.json", mode: "json" },
       },
     },
     plugins: {
       entries: {
         flowboard: {
           config: {
             serviceToken: { source: "file", provider: "flowboard", id: "/flowboard/serviceToken" },
           },
         },
       },
     },
   }
   ```

   Any SecretRef source the Gateway supports works (`env`, `file`, `exec`,
   `store`; see OpenClaw's *Secrets* docs). The Gateway resolves the reference
   when it loads the plugin, and `openclaw config get` shows only the
   reference, with its `id` redacted. A plain string of at least 32 characters is still accepted, and
   is what OpenClaw versions before 2026.9 need — they cannot resolve a
   SecretRef, and the native page that uses the token needs 2026.9.2 or newer
   anyway. FlowBoard never sends a reference that reached it unresolved: it
   logs a warning without the reference, and operations fall back to the local
   operator.
4. Give the dashboard service the same token. For the standard per-user
   service (launchd/systemd) created by `setup.mjs`:

   ```bash
   FLOWBOARD_SERVICE_TOKEN=<the serviceToken value> \
     node scripts/setup.mjs --update --override-env FLOWBOARD_SERVICE_TOKEN
   ```

   Generate the token once (`openssl rand -hex 32`) and keep it out of shell
   history, for example by reading it from the file your secret reference
   points at.

   Setup writes it into the owner-only service definition, restarts the
   dashboard, and never prints the token; later `--update` runs keep it. A
   token shorter than 32 characters is reported and ignored by the dashboard.
   With a custom supervisor, set the variable there instead.
5. Open **FlowBoard** in the Control UI sidebar.

## What the page is

The page is the dashboard, so the dashboard's own documentation applies:
[Kanban](../concepts/kanban.md), [Idea Canvas](../concepts/idea-canvas.md),
[Specify](../concepts/specify-workflow.md) and the
[how-to guides](how-to/). What differs inside the Control UI:

- **No FlowBoard header.** The Control UI already has one. Search moves to the
  tab bar; the project list stays on the left.
- **The theme is OpenClaw's.** Colours, borders and radii come from the
  Control UI theme. FlowBoard keeps its own colours only where they carry
  meaning: task status, note colours and charts.
- **Data goes through the Gateway.** The browser never talks to the dashboard
  port. Every request travels over the Control UI's own Gateway connection and
  the Gateway forwards it to your dashboard (see
  [ADR-0042](../adr/0042-gateway-api-passthrough-for-native-dashboard.md)).

### What is not available here

- **Updating FlowBoard.** The self-update action is deliberately not forwarded
  by the Gateway. Update from the standalone dashboard or the command line.
- **Very large imports.** One request through the Gateway is limited to
  16 MiB, so a project bundle above that size has to be imported in the
  standalone dashboard, which accepts up to 72 MB.
- **Signing in to the dashboard.** The page uses your Control UI session. The
  dashboard's own sign-in (for example Telegram) plays no role here.

## Deep links

The page's own URL carries what you are looking at:

| Parameter | Meaning |
|---|---|
| `p.project=<project>` | The project to show. |
| `p.task=<id>` | The task to open (needs `p.project`). |

Opening a link with a task selects that project and opens the task's detail
panel, so a link you share and a reload land on the same task. The "Needs me"
widget and the session task panel use the same links.

## Dashboard widget and session panel

Two smaller FlowBoard views live outside the page, next to your sessions.

**"Needs me" widget.** A widget for a session dashboard that lists what is
waiting on you across projects: tasks in review, and blocked or stalled work.
Clicking a row opens that task on the FlowBoard page. An agent places it with
its `dashboard` tool, using the plugin widget kind `flowboard:needs-me`:

```json
{ "kind": "plugin", "pluginKind": "flowboard:needs-me" }
```

**Task panel.** In a session's side panel, choose **FlowBoard task**. The
panel shows the tasks the session's agent has claimed — in progress or in
review — in the project the session is bound to (or the agent's project when
the session has no binding of its own). It shows the task's description and
latest comments and checkpoints, takes a comment, approves a task in review,
and **Open in FlowBoard** opens the task on the page. FlowBoard claims belong
to an agent rather than to one session, so two sessions of the same agent in
the same project show the same tasks.

## Checkpoints without reminders

Agents forget to record checkpoints. On OpenClaw 2026.9.2 or newer the plugin
helps in two ways, neither of which changes the project context an agent
receives (so the model's prompt cache is unaffected):

- **Checkpoint on commit** (on by default). When an agent runs a successful
  `git commit` whose subject contains the id of a task it holds, such as
  `fix: retry upload (T-123)`, FlowBoard records a checkpoint
  `Commit <sha>: <subject>` on that task. Nothing happens for a task the agent
  does not hold, or in a session that is not bound to the task's project. Turn
  it off with:

  ```bash
  openclaw config set plugins.entries.flowboard.config.commitCheckpoints false
  ```

- **Reminder before finishing** (off by default). When an agent is about to
  finish while one of its claims has had no checkpoint for longer than the
  stale threshold, it is asked for one more pass to record a checkpoint, or to
  complete or release the task. This happens at most once per run and costs
  one extra model pass. OpenClaw only lets a plugin do this with conversation
  access, so it needs two settings:

  ```bash
  openclaw config set plugins.entries.flowboard.config.finalizeReminder true
  openclaw config set plugins.entries.flowboard.hooks.allowConversationAccess true
  ```

  Without the second setting OpenClaw blocks the hook and logs a warning;
  everything else keeps working. The reminder does not run when you stop a
  run yourself.

Agents outside OpenClaw have no such hooks. For them, and as the backstop for
everyone, stalled claims still show up in the "Needs me" widget and the stall
detection.

## Other things worth knowing

- **Refreshing.** The page refreshes when something changes. While a
  FlowBoard page is open, the plugin checks the project list about every 10
  seconds and the project on screen every 5 seconds, and notifies the page
  only when something actually moved — a task another agent moves appears
  within a few seconds, without a reload. As a safety net the page also
  reloads every 30 seconds while it is visible.
- **Nothing is polled when nobody is watching.** The check runs only while a
  Control UI client has the plugin loaded.
- **Permissions.** Reading uses your `operator.read` scope and every write
  uses your `operator.write` scope. FlowBoard applies its own rules on top;
  the Gateway scope is a ceiling, not a FlowBoard role. Every write is
  recorded against your signed-in OpenClaw profile, not against the Gateway.
- **Trust.** Native plugin UI is *not* sandboxed: it runs with your Control UI
  authority. That is why the lab exists and why it is off by default. See
  [SECURITY.md](../../SECURITY.md) and
  [ADR-0037](../adr/0037-trusted-collaborators-and-native-control-ui.md).

## Turn it off

- **Just this page:** disable **Settings → Labs → Custom plugin UI**, then
  reload the tab. The hook and the standalone dashboard keep working.
- **The whole integration:** `openclaw plugins disable flowboard` (or
  `uninstall`). The dashboard is a separate service and keeps running either
  way.

## See also

- [OpenClaw Integration](../concepts/openclaw-integration.md) — how the hook,
  the dashboard and this page fit together
- [Troubleshooting](how-to/troubleshooting.md) — hook not registered, context
  not ready, remote auth
- [Manage projects](how-to/manage-projects.md) — what activating a project does
