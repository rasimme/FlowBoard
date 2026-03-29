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

### 2. Set up workspace

```bash
cp FlowBoard/files/ACTIVE-PROJECT.md ~/.openclaw/workspace/
cp -r FlowBoard/files/projects ~/.openclaw/workspace/
```

### 3. Add agent trigger

Add the project trigger to the top of your `~/.openclaw/workspace/AGENTS.md`:

```bash
cat FlowBoard/snippets/AGENTS-trigger.md
# → Paste that block into your AGENTS.md
```

### 4. Install hooks

```bash
cp -r FlowBoard/hooks/project-context ~/.openclaw/hooks/
cp -r FlowBoard/hooks/session-handoff ~/.openclaw/hooks/
openclaw gateway restart
```

### 5. Start the dashboard

```bash
node server.js
# Or with systemd (auto-start on boot):
cp templates/dashboard.service ~/.local/share/systemd/user/
systemctl --user enable --now dashboard
```

### 6. Create your first project

Open **http://localhost:18790** and tell your agent:

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
~/.openclaw/workspace/
├── AGENTS.md                     # Agent trigger
├── ACTIVE-PROJECT.md             # Current project state
└── projects/
    ├── PROJECT-RULES.md          # System rules
    ├── _index.md                 # Project registry
    └── my-project/
        ├── PROJECT.md            # Goal, scope, status, session log
        ├── DECISIONS.md          # Architecture decisions
        ├── tasks.json            # Tasks (API-managed)
        ├── canvas.json           # Idea canvas data
        ├── context/              # External references
        └── specs/                # Task specs

~/FlowBoard/dashboard/            # Dashboard server
├── server.js                     # Express 5 API + auth
├── index.html                    # SPA shell
├── js/                           # ES modules (vanilla JS, no build step)
└── styles/                       # CSS (dark theme)
```

**Key principles:**
- 🎯 **Vanilla JS** — No framework, no build step, no bundler
- 💾 **File-based** — JSON + Markdown, no database
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
