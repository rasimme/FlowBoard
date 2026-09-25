# FlowBoard inside OpenClaw (native Control UI page)

FlowBoard can appear as its own page in the OpenClaw **Control UI** — the
Gateway's own web interface — instead of only as a separate dashboard tab. The
page is two things:

- a compact **rail** — the projects you can switch between, the tasks waiting
  on you, and one status line;
- a **Kanban board** below it, built into the Gateway: five columns, cards you
  can move, work states you can set, and the approve gate. *Ideas* and *Files*
  are still the framed dashboard, on their own tabs.

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
| FlowBoard's `dashboardBaseUrl` plugin option | The *Ideas* and *Files* tabs frame your running dashboard, and every "Open in FlowBoard" link points at it. The board itself does not need it. |
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

2. Reload the browser tab. From 2026.9.6 the Gateway applies the lab flag
   through live config reload and open pages refresh their plugin views; on
   2026.9.2–2026.9.5, restart the Gateway first.
3. Point FlowBoard at your dashboard and give it the service credential, for
   example:

   ```bash
   openclaw config set plugins.entries.flowboard.config.dashboardBaseUrl http://127.0.0.1:18700
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

Clicking a row opens that task: the board switches to its project and the
detail panel opens on it. The selection goes into the Control UI's own URL, so
it survives a reload and can be shared.

**Status line.** Which agent the rail is following, its active project, which
binding layer answered (`session` or `agent`), whether the project's context is
ready for a bootstrap, when the data last refreshed, and whether the Gateway
connection is live.

**Collapse.** The toggle in the rail header hides everything but the board; the
choice is remembered in this browser.

## The board

**Board**, **Ideas** and **Files** are tabs under the rail. *Board* is
FlowBoard's own Kanban, drawn by the plugin; *Ideas* and *Files* are the framed
dashboard (see below). The link on the right opens the full dashboard in a new
browser tab.

The board shows the five lifecycle columns — Backlog, Open, In Progress, Review
and Done — for the project selected in the rail, with a count per column.
Archived tasks are not shown. Each card carries its id and title, its priority,
who has claimed it, its work state when that is not *Active*, its subtask count
or its parent, a dot when a spec is linked, and a hint when the work lease has
expired and the task is free to be reclaimed. Cards are ordered by their board
rank, then by id.

A large project does not fit in one read. When the board says it is showing
only the first tasks, the **Column** picker above it loads a single column
instead of the whole project; "All columns" goes back. The columns that are not
loaded say so rather than showing an empty count.

### Acting on a card

Every card has an actions button (`⋯`), and it is the accessible path: it opens
a menu you can walk with the arrow keys and leave with Escape.

- **Move to …** — the other columns, minus the ones FlowBoard refuses:
  *Review → Done* is the approve gate (use **Approve**), and a task in **Done**
  offers no move at all, because reopening accepted work needs an explicit
  override with a reason rather than a drag. Archiving is not here either; it
  hides a task from every column, so it stays in the dashboard.
- **Work state …** — *Active*, *Waiting*, *Blocked* or *Paused*, independent of
  the column the task is in. Everything but *Active* offers a short reason,
  which is stored as the work state's reason and shown on the card and in the
  panel. The reason *replaces* whatever context the work state carried before
  (an agent's "waiting for", a scheduled re-check), and setting a state without
  a reason clears that context. Returning a task to *Active* clears the state
  and carries no reason with it.
- **Approve** and **Reject** — only on cards in **Review**, because that is
  FlowBoard's approve gate. *Approve* accepts the work and moves it to Done.
  *Reject* asks for a reason, will not send anything without one, and sends the
  task back to **In Progress**; FlowBoard writes the reason into the task's
  comments itself, so it is on the record with your name on it. If the work is
  also blocked on something, set the work state afterwards.

Dragging a card into another column is the same move, for when a pointer is
faster — dropping a review card on Done goes through the approve gate rather
than around it. Within a column nothing is re-ordered: ranking tasks stays in
the dashboard.

After you act, the card shows *Saving…* and then whatever the server actually
did — the board never moves a card before the change succeeded. If FlowBoard
refuses (a lease someone else holds, a project rule, the approve gate), the
message it gave is shown on the card and in the panel, unedited, with one added
sentence when the refusal means the card you are looking at is already out of
date.

### The detail panel

Clicking a card opens a panel beside the board: status, work state, priority,
agent, tags, dates, the claim, the linked spec, the description as plain text,
the newest 20 comments and the newest 10 checkpoints. The same actions menu is
in its header. **Escape** closes it.

The description is shown as text with its line breaks, never as rendered
Markdown or HTML: this page runs with your Control UI authority, and anything
an agent writes into a task would otherwise be markup inside the Gateway's own
interface. The link at the bottom opens the task in the dashboard, where the
rich view lives.

### Keyboard

Tab reaches every card and every actions button, the arrow keys walk an open
menu and the tab strip, Enter opens what is focused, and Escape closes the menu
and then the panel. A refresh arriving in the background does not move the
focus.

## The agent setting

The rail follows one agent — `main` unless you change it. The field in the rail
header sets it and remembers it in this browser only, under
`flowboard.controlUi.agentId`. An id FlowBoard would reject (it must be
lowercase kebab-case, like `claude-code`) is refused instead of stored, so a
typo cannot quietly detach the rail from every board.

The setting is a *view* preference. It decides whose binding you see and
change; it never changes who you are. Everything you do from this page is
attributed to your signed-in OpenClaw profile.

## Deep links

The page's own URL carries what you are looking at:
`?p.project=<project>&p.task=<id>`. Opening such a link selects that project,
shows the **Board** tab and opens the panel for that task — so a link you
share, a reload and the browser's back button all land on the same task.
Clicking a card or a rail row updates the URL as you go.

## Ideas and Files are still the framed dashboard

The **Ideas** and **Files** tabs show your running dashboard in a frame; only
the board is native so far. The frame is loaded once and kept, so switching
between the tabs and the board never reloads it.

One limitation remains from stage 1: the dashboard SPA has no URL routing for a
project or a task, so the frame cannot be pointed at one. It is framed with the
agent the rail follows, which means it opens that agent's active project —
switching a project in the rail therefore also moves the frame, but opening a
task from the rail moves only the native board. Use the "Open in FlowBoard"
links for the dashboard's own view of a task.

## Other things worth knowing

- **Refreshing.** The rail, the board and the open task refresh when something
  changes, not on a timer in your browser. FlowBoard checks about every 10
  seconds while a FlowBoard page is open in the Control UI and pushes an update
  only when something actually moved. The page tells FlowBoard which project it
  is showing, so that project is watched in full — a task another agent moves
  appears on the board within a few seconds, without a reload. Switching
  projects or reconnecting always refetches.
- **Nothing is polled when nobody is watching.** The check runs only while a
  Control UI client has the plugin loaded.
- **Permissions.** Reading uses your `operator.read` scope; switching a
  project, moving a card, setting a work state and approving or rejecting use
  your `operator.write` scope. FlowBoard applies its own rules on top; the
  Gateway scope is a ceiling, not a FlowBoard role. Every write is recorded
  against your signed-in OpenClaw profile, not against the Gateway.
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
- **Just the framed tabs:** clear
  `plugins.entries.flowboard.config.dashboardBaseUrl`. *Ideas* and *Files* are
  then disabled and the status line says FlowBoard is not configured, instead
  of framing a dead URL. The native board keeps working.

## See also

- [OpenClaw Integration](../concepts/openclaw-integration.md) — how the hook,
  the dashboard and this page fit together
- [Troubleshooting](how-to/troubleshooting.md) — hook not registered, context
  not ready, remote auth
- [Manage projects](how-to/manage-projects.md) — what activating a project does
