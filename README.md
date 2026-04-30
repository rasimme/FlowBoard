<h1 align="center">FlowBoard</h1>

<p align="center">
  <strong>Project workspaces for AI agents. Built for <a href="https://github.com/openclaw/openclaw">OpenClaw</a>.</strong>
</p>

<p align="center">
  <a href="https://github.com/rasimme/FlowBoard/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-green.svg" alt="License"></a>
  <a href="https://github.com/rasimme/FlowBoard/releases"><img src="https://img.shields.io/badge/version-v4.0.1-orange.svg" alt="Version"></a>
  <a href="https://github.com/rasimme/FlowBoard"><img src="https://img.shields.io/github/stars/rasimme/FlowBoard?style=social" alt="Stars"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> •
  <a href="#features">Features</a> •
  <a href="#-idea-canvas">Idea Canvas</a> •
  <a href="#remote-access-telegram-mini-app">Remote Access</a> •
  <a href="CHANGELOG.md">Changelog</a>
</p>

---

Your agent loses context every session. What was I building? What decisions did I make? What's the next task? All gone.

**FlowBoard fixes that.**

- **📂 Project context on demand** — Activate a project and your agent gets goals, decisions, tasks, and specs. Lazy-loaded to save tokens.
- **📋 Kanban you both use** — Your agent creates tasks, writes specs, moves cards, breaks work into subtasks. You see progress live.
- **💡 Idea Canvas** — Brainstorm together visually. One click turns connected ideas into tasks with specs and subtasks.

![FlowBoard Kanban](docs/screenshot-kanban.png)

---

## Features

### 📂 Project Workspaces

Activate a project and the agent instantly gets the context it needs — goal, scope, architecture, decisions, task status, specs. Everything is loaded on demand: the agent pulls in what it needs, when it needs it, keeping token usage low. Switch between projects without losing track.

- Structured workspace: `PROJECT.md` → `DECISIONS.md` → `tasks.json` → `specs/`
- Lazy loading — zero overhead when no project is active
- Session handoff — pick up exactly where you left off

### 📋 Agent-Native Kanban

Your agent operates the board through the same REST API as the dashboard. It creates tasks, sets priorities, writes specs with acceptance criteria, and updates status as it works.

- Tasks with workflow: `open → in-progress → review → done`
- Parent tasks with subtasks and progress tracking
- Spec files with acceptance criteria and logs
- Real-time visibility into what the agent is doing

### 💡 Idea Canvas

A node-based brainstorming space. Sticky notes with connections form clusters. One click sends them to your agent, who analyzes the ideas and creates:

![FlowBoard Canvas](docs/screenshot-canvas.png)

- **Simple idea** → Task with title and priority
- **Detailed idea** → Task + spec with acceptance criteria
- **Complex cluster** → Parent task + subtasks with specs

Visual brainstorming → structured tasks, zero manual overhead.

### 📁 File Explorer

Browse, preview, and edit project files without leaving the dashboard. Markdown rendering with syntax highlighting, inline editing, and auto-refresh.

![FlowBoard Files](docs/screenshot-files.png)

### 📱 Telegram Mini App

Access FlowBoard remotely from Telegram. Secure authentication via HMAC-SHA256, mobile-optimized UI, works through Cloudflare Tunnel, ngrok, or Tailscale.

---

## Quick Start

### 1. Clone & install

```bash
git clone https://github.com/rasimme/FlowBoard.git
cd FlowBoard/dashboard
npm install
```

### 2. Register the hook with OpenClaw

FlowBoard ships as an OpenClaw hook pack (declared via `package.json` →
`openclaw.hooks`). Register it through OpenClaw's plugin lifecycle so the
gateway loads `project-context` on startup, `/new`, `/reset`, and after
compaction:

```bash
openclaw plugins install ~/repos/FlowBoard --link
openclaw config set hooks.internal.load.extraDirs '["~/repos/FlowBoard/hooks"]' --merge
openclaw gateway restart
```

`--link` keeps the hook pointing at this checkout, so `git pull` propagates
hook changes without a re-install. The second command (`extraDirs`) is
currently required because OpenClaw's runtime hook discovery doesn't yet
read the `--link` install record directly — once the upstream gap is
closed, this step becomes optional.

Verify the hook is registered:

```bash
openclaw hooks info project-context
# Expect: ✓ Ready, source openclaw-managed, all four events listed
```

#### Upgrading from earlier FlowBoard versions

Versions before this change shipped a `scripts/install-hooks.sh` script
that symlinked or copied the hook into `~/.openclaw/hooks/project-context/`.
The new install path replaces that — remove the legacy hook directory once
before running the commands above:

```bash
rm -rf ~/.openclaw/hooks/project-context
```

If you previously edited `~/.openclaw/openclaw.json` to register the hook
manually, no extra cleanup is needed — `openclaw config set --merge` keeps
existing entries intact.

### 3. Start the dashboard

Migrations run automatically on server start (tasks migration, per-agent
active-project DB setup, PROJECT-RULES canonical-path symlink, legacy-snippet
advisory).

```bash
HZL_ENABLED=true node server.js
# Or with systemd (auto-start on boot):
cp templates/dashboard.service ~/.local/share/systemd/user/
systemctl --user enable --now dashboard
```

### 4. Finish setup in the dashboard

Open **http://localhost:18790**. If any workspace needs setup, a
**Finish setup** (fresh install) or **Migration required** (upgrade from
an older FlowBoard) chip appears in the header. Click it to open the
setup modal and choose per workspace:

- **Upgrade** — byte-identical legacy snippets → new canonical block
- **Migration required** — user-edited legacy blocks → force-replace (per-file opt-in)
- **Add FlowBoard to workspace** — workspace doesn't have the snippet yet → append it
- **Dismiss** — this workspace shouldn't use FlowBoard (e.g. a voice agent)

Every change writes a `.bak-<timestamp>` copy first. If you prefer the
CLI path: `node dashboard/snippets-doctor.js` does the same detection
and `--apply` upgrades byte-identical blocks only.

### 5. Create your first project

Once the chip disappears, tell your agent:

> "New project: my-app"

The agent creates the folder structure, task file, and registers it in the dashboard.

---

## Canvas → Task Promote

The Idea Canvas promote feature requires OpenClaw webhooks:

**1. Enable webhooks** in `~/.openclaw/openclaw.json`:
```json5
{
  hooks: {
    enabled: true,
    token: "your-secret-token",  // openssl rand -hex 16
    path: "/hooks"
  }
}
```

**2. Set environment variables:**
```bash
OPENCLAW_HOOKS_TOKEN=your-secret-token
OPENCLAW_GATEWAY_URL=http://127.0.0.1:18789
OPENCLAW_DELIVER_CHANNEL=telegram        # or: discord, slack, etc.
OPENCLAW_DELIVER_TO=your-chat-id         # optional
```

Without these, everything works except canvas promote.

---

## Commands

Tell your agent:

| Command | What it does |
|---------|-------------|
| `Project: [Name]` | Activate project (loads full context) |
| `New project: [Name]` | Create project with folder structure |
| `End project` | Deactivate, save session summary |
| `Projects` | List all projects |

The agent also handles these autonomously while working:

| Action | What happens |
|--------|-------------|
| Create task | Agent calls API, sets priority, optionally writes spec |
| Create subtasks | Agent breaks a task into subtasks with a parent |
| Update status | Agent moves tasks through `open → in-progress → review → done` |
| Write spec | Agent creates `specs/T-xxx-slug.md` with acceptance criteria |
| Canvas promote | Agent receives cluster notes, decides task structure |

---

## Using FlowBoard with external agents (Codex, Cursor, Claude Code, …)

FlowBoard is designed for OpenClaw-managed agents *and* for external
runtimes that talk to the API directly. External agents are first-class:
they self-register on the first `PUT /api/status`, appear in the dashboard
agent list, and use the same task workflow as OpenClaw agents.

What's different for external agents: there is no live-injected
`BOOTSTRAP.md` in your run context (that mechanism is OpenClaw-runtime
specific). Instead, fetch the project context on demand via
`GET /api/projects/<project>/bootstrap`.

### Install the trigger snippet in your project repo

Run once per repo where you want an external agent to use FlowBoard:

```bash
node ~/repos/FlowBoard/dashboard/install-trigger.mjs --repo ~/myrepo
```

This adds the FlowBoard external-trigger block to `myrepo/AGENTS.md`
(idempotent — re-run anytime to refresh) and creates `myrepo/CLAUDE.md`
as a symlink to `AGENTS.md` so Claude Code reads the same content.
Use `--no-symlink` on filesystems without symlink support (Windows,
sync-mounted drives); the installer falls back to a copy.

To remove the block later:

```bash
node ~/repos/FlowBoard/dashboard/install-trigger.mjs --repo ~/myrepo --uninstall
```

### Discovery without the installer

The same content is served by the dashboard for tooling or quick
inspection:

```bash
curl http://localhost:18790/api/info
```

Returns service metadata, the API endpoint list, and the trigger
snippet as `trigger_snippet`. No auth is required — discovery happens
before identity. Suitable for users who prefer to copy-paste into a
specific config file (`.cursorrules`, `CONVENTIONS.md`, etc.) instead
of `AGENTS.md`.

### Identity convention

Pick a stable agent-id for your runtime:

| Runtime | Suggested agent-id |
|---|---|
| Claude Code | `claude-code` |
| Codex | `codex` |
| Cursor | `cursor` |
| Aider | `aider` |
| Custom script | a stable string of your choice |

Add a host suffix (`codex-laptop`, `claude-code-jetson`) if you run
multiple parallel instances. The agent-id is a freeform string —
auto-registered in `flowboard_agents` on the first `PUT /api/status`.
Keep it stable across the session so the dashboard shows clean
attribution.

---

<details>
<summary><h2>Remote Access (Telegram Mini App)</h2></summary>

FlowBoard can be accessed remotely as a Telegram Mini App through a secure tunnel.

### Set up a tunnel

Any tunnel works. Recommended: **Cloudflare Tunnel** (free, stable).

```bash
cloudflared tunnel login
cloudflared tunnel create flowboard
cloudflared tunnel route dns flowboard dashboard.your-domain.com
cp templates/cloudflare-config.yml ~/.cloudflared/config.yml
# Edit: replace <TUNNEL_ID>, <USER>, <YOUR_DOMAIN>
cloudflared tunnel run flowboard
```

### Configure authentication

```bash
JWT_SECRET=$(openssl rand -hex 32)

mkdir -p ~/.config/systemd/user/dashboard.service.d
cp templates/systemd-auth.conf.example \
   ~/.config/systemd/user/dashboard.service.d/auth.conf
# Edit with your values:
# - TELEGRAM_BOT_TOKEN (from @BotFather)
# - JWT_SECRET
# - ALLOWED_USER_IDS (your Telegram user ID)
# - DASHBOARD_ORIGIN (your public URL)

systemctl --user daemon-reload
systemctl --user restart dashboard
```

### Register Telegram button

1. Open @BotFather → `/setmenubutton`
2. Select your bot
3. Send your public dashboard URL
4. Send button label (e.g. "Dashboard")

</details>

---

## Architecture

```
~/.openclaw/workspace-<agent>/
├── AGENTS.md                     # Agent trigger — contains the FlowBoard snippet
├── BOOTSTRAP.md                  # Auto-generated per session (active project + rules manifest)
├── BOOT.md                       # Optional — gateway-restart recovery block
└── (ACTIVE-PROJECT.md)           # Legacy fallback, DB is canonical (flowboard_agents)

~/.openclaw/projects/             # Shared project data (m004-moved from workspace/projects)
└── my-project/
    ├── PROJECT.md                # Current state, focus, next steps
    ├── SESSIONS.md               # Chronological session log
    ├── DECISIONS.md              # Architecture + design rationale
    ├── canvas.json               # Idea canvas state
    ├── context/                  # External reference docs
    └── specs/                    # Task specs

~/.openclaw/workspace/.hzl/       # Coordination backend (SQLite)
├── flowboard.db                  # HZL event store — tasks, claims, checkpoints, comments
└── flowboard-cache.db            # Projections + flowboard_projects, flowboard_agents

~/repos/FlowBoard/                # SSoT — pulled from dev branch on GitHub
├── dashboard/
│   ├── server.js                 # Express 5 API + auth
│   ├── rules-api.js              # Lazy-load rules registry + manifest
│   ├── snippets-doctor.js        # Installer / migrator (state machine)
│   ├── src/                      # React + Vite + Tailwind UI
│   └── styles/dashboard.css      # Legacy vanilla fallback + component styles
├── docs/project-mode/            # Rule sections served via /api/projects/:name/rules/:section
│   ├── commands.md / tasks-api.md / hzl.md / canvas-and-notes.md
│   ├── project-files.md / specify-workflow.md / agent-bridge.md
│   ├── error-handling.md / key-principles.md
│   └── legacy/PROJECT-RULES.md   # Archived pre-lazy-load monolith
├── snippets/
│   ├── AGENTS-trigger.md         # Current trigger block for AGENTS.md
│   ├── BOOT-extension.md         # Current recovery block for BOOT.md
│   └── legacy/*.v1.md            # Vendored legacy copies for byte-match detection
└── hooks/project-context/        # Regenerates BOOTSTRAP.md on session events
```

**Key principles:**
- 📡 **DB-canonical** — project + per-agent state live in `flowboard_agents` / `flowboard_projects`
- 🧩 **Lazy-load rules** — agent sees a manifest in BOOTSTRAP.md, fetches sections on demand
- 🔒 **Local-first** — everything runs on your machine; API is localhost
- 🧪 **API-driven** — dashboard and agents share the same REST surface
- ⚡ **Lazy loading** — Zero overhead when no project active
- 🔒 **Local-first** — Everything runs on your machine
- 📡 **API-driven** — Dashboard and agent use the same REST API

---

## Contributing

Contributions welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

```bash
git checkout -b feat/your-feature
# Make changes on dev branch
git commit -m "feat: your feature"
```

---

## License

MIT © 2026

---

<p align="center">
  <strong>Built with ❤️ for the <a href="https://github.com/openclaw/openclaw">OpenClaw</a> community</strong>
</p>
