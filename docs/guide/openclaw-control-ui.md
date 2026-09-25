# FlowBoard inside OpenClaw (native Control UI page)

FlowBoard can appear as its own page in the OpenClaw **Control UI** — the
Gateway's own web interface — instead of only as a separate dashboard tab. The
page is two things:

- a compact **rail** — the projects you can switch between, the tasks waiting
  on you, and one status line;
- a **Kanban board** below it, built into the Gateway: five columns, cards you
  can move, reorder, archive and trash, work states you can set, the approve
  gate, "New task", and a detail panel that edits a task and takes comments;
- the tabs **Ideas**, **Files** and **Projects** next to the board: the
  dashboard's own views, framed one at a time without the dashboard's header,
  tab bar or sidebar.

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
| FlowBoard's `dashboardBaseUrl` plugin option | The *Ideas*, *Files* and *Projects* tabs frame your running dashboard, and every "Open in FlowBoard" link points at it. The board itself does not need it. |
| `FLOWBOARD_FRAME_ANCESTORS` on the dashboard, listing the Control UI origin | The dashboard refuses to be framed by — and its embed mode refuses to talk to — any origin not on that list. Only the framed tabs need it. See [Environment Variables](../reference/env-vars.md#embedding). |
| A dashboard the framed tabs can sign in to | Loopback and same-site dashboards work. A cross-site dashboard that only signs in through Telegram cannot be embedded (see [Limitations](#limitations-of-the-framed-tabs)). |
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
4. For the framed tabs, add the Control UI's origin to the dashboard's
   `FLOWBOARD_FRAME_ANCESTORS` (for example `http://127.0.0.1:18789`) and
   restart the dashboard.
5. Open **FlowBoard** in the Control UI sidebar.

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

**Board**, **Ideas**, **Files** and **Projects** are tabs under the rail.
*Board* is FlowBoard's own Kanban, drawn by the plugin; the other three are the
dashboard's views, framed one surface at a time (see
[below](#ideas-files-and-projects-framed-single-surface-views)). The **Open in
FlowBoard ↗** link on the right opens the full dashboard in a new browser tab.

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
  override with a reason rather than a drag. Archiving is not a move either;
  it is under **Manage**.
- **Position** — *Move to top*, *Move up* and *Move down* inside the column.
  They are offered only when the whole column is loaded: a rank computed
  against half a column would land anywhere, so on a truncated board load a
  single column first. Usually only the moved card is written; when there is
  no room between its new neighbours, the column is re-ranked from the top
  down to it.
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
- **Manage** — **Archive** (cards in **Done** only) and **Move to Trash** (any
  card). Both hide the card, so both ask for confirmation first, and both are
  followed by a notice with **Undo** for 15 seconds: undoing an archive puts
  the task back in Done, undoing a trash restores it. Permanent deletion and
  emptying the Trash are not board gestures; they stay in the dashboard behind
  its typed confirmations.

Dragging a card into another column is the same move, for when a pointer is
faster — dropping a review card on Done goes through the approve gate rather
than around it. Dragging within a column does not re-order; use **Position**.

After you act, the card shows *Saving…* and then whatever the server actually
did — the board never moves a card before the change succeeded. If FlowBoard
refuses (a lease someone else holds, a project rule, the approve gate), the
message it gave is shown on the card and in the panel, unedited, with one added
sentence when the refusal means the card you are looking at is already out of
date.

### New task

**+ New task** above the board asks for a title, creates the task in the
selected project and opens its panel. On a project that enforces Specify,
FlowBoard refuses a bare task; the form says so and offers **Continue in
Specify**, which opens the dashboard's Specify stepper in the frame with the
title you typed (see [Specify](#specify)).

### The detail panel

Clicking a card opens a panel beside the board: status, work state, priority,
agent, tags, dates, the claim, the linked spec, the description as plain text,
the newest 20 comments and the newest 10 checkpoints. The same actions menu is
in its header. **Escape** closes it.

Most of it is editable in place:

- **Title** — *Edit*, then save (1–200 characters).
- **Description** — a plain-text editor; **Ctrl/⌘+Enter** saves, **Escape**
  cancels. It keeps what you wrote exactly, including blank lines and
  indentation. A description longer than the panel receives is marked
  *Shortened* and cannot be edited here, because saving the part you see would
  delete the rest — open it in the dashboard instead.
- **Priority** — the select saves on change.
- **Tags** — comma-separated, at most 20, each under 40 characters.
- **Comment** — the box under *Comments*; **Enter** sends, **Shift+Enter** is a
  new line, up to 2,000 characters. The comment is signed with your OpenClaw
  profile.

Saving a value you did not change sends nothing. A refusal is FlowBoard's own
message, shown next to the field.

The description is shown as text with its line breaks, never as rendered
Markdown or HTML: this page runs with your Control UI authority, and anything
an agent writes into a task would otherwise be markup inside the Gateway's own
interface. A linked spec opens in the **Files** tab at that file. The link at
the bottom opens the dashboard, where the rich view lives.

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

| Parameter | Meaning |
|---|---|
| `p.project=<project>` | The project on the board and in the framed tabs. |
| `p.task=<id>` | The task whose panel is open (needs `p.project`). |
| `p.tab=ideas\|files\|projects` | A framed tab to open instead of the board. Absent means the board, so every older link still lands there. |
| `p.file=<path>` | With `p.tab=files`: the project file to open. |

Opening a link with a task selects that project, shows the **Board** tab and
opens the panel for that task — so a link you share, a reload and the
browser's back button all land on the same task. Clicking a card, a rail row
or a spec link updates the URL as you go.

The URL is rewritten when the project, the task or the file changes, not on
every tab click: the Control UI may remount the page on such a navigation, and
a remount per click would reload the frame that switching tabs is meant to
keep. The tab travels with the next write, which is what lets a remount land
on the framed tab you were on instead of the board. The transient Specify view
is never written into a link.

## Ideas, Files and Projects: framed single-surface views

These three tabs are the dashboard's own views, not ports of them: the page
loads your running dashboard in **embed mode** (`?embed=<surface>`), which
shows only that one surface — no header, tab bar or sidebar — for the project
the page is on. Everything the dashboard can do on that surface works,
including promoting ideas through Specify.

- **One frame, kept.** The frame is loaded the first time you open a framed
  tab and hidden, not destroyed, while the board is up. Switching tabs,
  projects or files tells the frame where to go instead of reloading it.
- **Links come back to the page.** What would leave the surface — opening a
  task, a spec, another tab or another project — is handed to the page: a task
  opens on the native board with its panel, a spec opens the **Files** tab at
  that file, and a project clicked in the framed **Projects** list becomes the
  board this page shows. That click does *not* rebind the agent; activating a
  project stays a deliberate click in the rail.
- **Open in FlowBoard ↗** next to the tabs opens the full dashboard in a new
  browser tab whenever you want more than one surface.

If the frame does not report back within 8 seconds, the page replaces the empty
box with a notice and an "Open in FlowBoard" link. That means the dashboard is
older than the plugin (it has no embed mode), refuses to be framed by this
origin (`FLOWBOARD_FRAME_ANCESTORS`), or cannot sign in inside the frame.

### Specify

Specify is a dialog in the dashboard, not a surface, so it has no tab. It opens
in two places: inside the framed **Ideas** tab, as in the dashboard, and from
**New task** on a project that enforces Specify. In the second case the frame
briefly shows just the Specify stepper, prefilled with your title. Closing it
returns to the tab you came from; finishing it opens the task it created on
the board.

### Limitations of the framed tabs

- **Writes inside the frame are the dashboard's.** They are attributed to the
  dashboard session the frame signed in with, not to your OpenClaw profile —
  the Gateway-verified identity (ADR-0040) applies to the native board and
  panel only.
- **Sign-in.** A loopback or same-site dashboard works. A dashboard on another
  site that signs in only through Telegram cannot be embedded: browsers do not
  send its cookie to a third-party frame, and the Telegram gate cannot run
  there. You get the 8-second notice; use "Open in FlowBoard".
- **Theme.** The framed surface keeps the dashboard's own theme inside the
  Control UI's.
- **Background refresh.** A hidden frame is still the dashboard, and keeps
  refreshing its own data while you are on the board.

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
- **Permissions.** Reading uses your `operator.read` scope; every native write
  — switching a project, moving, reordering, editing, commenting, archiving,
  trashing, creating, approving or rejecting — uses your `operator.write`
  scope. FlowBoard applies its own rules on top; the Gateway scope is a
  ceiling, not a FlowBoard role. Every native write is recorded against your
  signed-in OpenClaw profile, not against the Gateway. Writes inside the framed
  tabs are the exception (see above).
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
  `plugins.entries.flowboard.config.dashboardBaseUrl`. *Ideas*, *Files* and
  *Projects* are then disabled and say FlowBoard is not configured, instead of
  framing a dead URL. The native board keeps working.

## See also

- [OpenClaw Integration](../concepts/openclaw-integration.md) — how the hook,
  the dashboard and this page fit together
- [Troubleshooting](how-to/troubleshooting.md) — hook not registered, context
  not ready, remote auth
- [Manage projects](how-to/manage-projects.md) — what activating a project does
