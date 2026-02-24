# FlowBoard

[![GitHub](https://img.shields.io/badge/GitHub-FlowBoard-blue?logo=github)](https://github.com/rasimme/FlowBoard)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-v3.0.0-orange.svg)](https://github.com/rasimme/FlowBoard/releases)

> **File-based project management with Kanban dashboard for OpenClaw agents.**

Stop re-explaining context. Work on multiple projects with persistent state, structured task tracking, and a beautiful live dashboard, without needing separate agents.

![FlowBoard Dashboard](docs/screenshot-kanban.png)

---

## The Problem

When working on different projects with an AI agent, **context gets lost** between sessions. The agent doesn't remember which project you're working on, what decisions were made, or what's next. You spend time re-explaining everything.

Separate agents per project? That's heavyweight: each needs its own config, workspace, memory store, and API profile. For most projects, that's **overkill**.

## The Solution

**FlowBoard** uses a lazy-loading, file-based approach:

- ✨ **Zero overhead** when no project is active
- 🎯 **Instant context switching** - One command loads full project state
- 📋 **Structured task tracking** - Tasks survive restarts, visible in Kanban UI
- 🔄 **Automatic task updates** - Agent tracks progress in real-time
- 💾 **Session persistence** - Context survives gateway restarts

**How it works:** A tiny trigger in `AGENTS.md` checks for an active project on session start. When you activate a project, the agent loads rules + context. Tasks are tracked in `tasks.json`, visible on a live Kanban dashboard. When you switch projects or restart the gateway, everything just works.

---

## Features

- 📋 **Task Management** - Structured `tasks.json` with status workflow (open → in-progress → review → done)
- 📄 **Spec Files** - Optional detailed specs for complex tasks (`specs/` folder, template scaffolding)
- 🎯 **Kanban Dashboard** - Interactive web UI with drag & drop, inline editing, auto-refresh
- 📁 **File Explorer** - Browse, preview, and edit project files with auto-refresh
- 🔄 **Live Task Workflow** - Agent updates task status as it works
- ✨ **Auto-task Creation** - Agent breaks down work into tasks automatically
- 🔗 **API-Based Switching** - Dashboard + chat use same API, instant context loading
- 💾 **Session Persistence** - Project context survives gateway restarts
- 🚀 **Zero Overhead** - Lazy-loading, only active when needed
- 📱 **Telegram Mini App** - Optional remote access via secure tunnel, auth, and mobile-optimized UI

---

## Quick Start

### 1. Clone & install

```bash
git clone https://github.com/rasimme/FlowBoard.git
cd FlowBoard/dashboard
npm install
```

### 2. Set up workspace files

```bash
# Copy project structure into your OpenClaw workspace
cp ~/FlowBoard/files/ACTIVE-PROJECT.md ~/.openclaw/workspace/
cp -r ~/FlowBoard/files/projects ~/.openclaw/workspace/
```

### 3. Add AGENTS.md trigger

Copy the project trigger block into the top of your `~/.openclaw/workspace/AGENTS.md`:

```bash
cat ~/FlowBoard/snippets/AGENTS-trigger.md
# → Paste that block into your AGENTS.md
```

This tells your agent to check for an active project on every session start.

### 4. Install hooks (recommended)

```bash
cp -r ~/FlowBoard/hooks/project-context ~/.openclaw/hooks/
cp -r ~/FlowBoard/hooks/session-handoff ~/.openclaw/hooks/
openclaw gateway restart
```

- **project-context** — Auto-loads project rules + context on session start
- **session-handoff** — Persists session context across `/new` commands

### 5. Start the dashboard

```bash
# Quick start (development)
cd ~/FlowBoard/dashboard
node server.js

# Production: systemd service (auto-start on boot)
mkdir -p ~/.local/share/systemd/user
cp ~/FlowBoard/templates/dashboard.service ~/.local/share/systemd/user/
# Edit the file: replace /path/to/ with your actual paths
nano ~/.local/share/systemd/user/dashboard.service
systemctl --user daemon-reload
systemctl --user enable --now dashboard
```

### 6. Create your first project

Open http://localhost:18790 and tell your agent:

> `New project: my-project`

The agent creates the folder structure, tasks.json, and registers it in the dashboard.

### Expected folder structure

```
~/.openclaw/workspace/
├── AGENTS.md                    # With project trigger block
├── ACTIVE-PROJECT.md            # "project: none" (until activated)
├── projects/
│   ├── PROJECT-RULES.md         # System rules (from files/)
│   ├── _index.md                # Project registry
│   └── my-project/              # Created per project
│       ├── PROJECT.md
│       ├── DECISIONS.md
│       ├── tasks.json
│       ├── context/
│       └── specs/

~/.openclaw/hooks/
├── project-context/             # Auto-context loading
│   └── handler.js
└── session-handoff/             # Session persistence
    └── handler.js

~/FlowBoard/dashboard/           # Dashboard (git repo = live instance)
├── server.js                    # Express API + auth
├── index.html                   # Dashboard UI
├── js/                          # JS modules
├── styles/                      # CSS
└── package.json
```

---

## Remote Access (Telegram Mini App)

FlowBoard can be accessed remotely as a **Telegram Mini App** through a secure tunnel. This is entirely optional — the dashboard works locally without any of this.

### How it works

1. A tunnel (Cloudflare, ngrok, Tailscale, etc.) exposes port 18790 to the internet
2. Your Telegram Bot gets a menu button that opens the dashboard URL
3. Authentication via Telegram `initData` (HMAC-SHA256 signature) + JWT session cookie
4. Only allowlisted Telegram user IDs can access the dashboard
5. Without auth config, the dashboard stays open (local development)

### Step 1: Set up a tunnel

You need a way to expose port 18790 to the internet. Any tunnel works:

**Option A: Cloudflare Tunnel (recommended — free, stable)**
```bash
# Install cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/
cloudflared tunnel login
cloudflared tunnel create flowboard

# Set up DNS (replace with your domain)
cloudflared tunnel route dns flowboard dashboard.your-domain.com

# Copy and edit config
cp ~/FlowBoard/templates/cloudflare-config.yml ~/.cloudflared/config.yml
nano ~/.cloudflared/config.yml  # Replace <TUNNEL_ID>, <USER>, <YOUR_DOMAIN>

# Start tunnel (or use systemd template)
cloudflared tunnel run flowboard

# Optional: auto-start on boot
cp ~/FlowBoard/templates/cloudflared-tunnel.service ~/.local/share/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now cloudflared-tunnel
```

**Option B: ngrok**
```bash
ngrok http 18790
# Note: set AUTH_ALWAYS=true (see Step 2)
```

**Option C: Tailscale Funnel**
```bash
tailscale funnel 18790
# Note: set AUTH_ALWAYS=true (see Step 2)
```

### Step 2: Configure authentication

```bash
# Generate a JWT secret
JWT_SECRET=$(openssl rand -hex 32)

# Find your Telegram user ID (message @userinfobot on Telegram)

# Create systemd drop-in for env vars
mkdir -p ~/.config/systemd/user/dashboard.service.d
cp ~/FlowBoard/templates/systemd-auth.conf.example \
   ~/.config/systemd/user/dashboard.service.d/auth.conf

# Edit with your values
nano ~/.config/systemd/user/dashboard.service.d/auth.conf
```

Fill in these values:
- `TELEGRAM_BOT_TOKEN` — from [@BotFather](https://t.me/BotFather) (your OpenClaw bot token)
- `JWT_SECRET` — the random secret you just generated
- `ALLOWED_USER_IDS` — your Telegram user ID (comma-separated for multiple users)
- `DASHBOARD_ORIGIN` — your public URL, e.g. `https://dashboard.your-domain.com`
- `AUTH_ALWAYS` — set to `true` if using ngrok/Tailscale (not needed for Cloudflare)

```bash
# Apply changes
systemctl --user daemon-reload
systemctl --user restart dashboard
```

### Step 3: Register Telegram Mini App button

1. Open [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/setmenubutton`
3. Select your OpenClaw bot
4. Send your public dashboard URL (e.g. `https://dashboard.your-domain.com`)
5. Send a button label (e.g. `Dashboard`)

Now your bot has a menu button that opens FlowBoard as a Telegram Mini App.

### Auth behavior

| Env vars set? | AUTH_ALWAYS | Tunnel | Result |
|---|---|---|---|
| No | — | — | Open (no auth, local dev) |
| Yes | false | Cloudflare | Auth via CF-Ray header detection |
| Yes | true | Any | Auth on every request |

### Health check

```bash
curl http://localhost:18790/api/health
# → { "ok": true, "auth": true, "authAlways": false, "version": "...", "uptime": 123 }
```

### Notes

- **Session cookies** use `sameSite: strict`. If your Telegram client has issues with cookies not being sent, change to `lax` in `server.js`.
- **Rate limiting** uses `CF-Connecting-IP` header for real client IPs behind Cloudflare. With other tunnels, all requests may share the same IP for rate limiting purposes.
- **CSP** allows `unsafe-inline` for scripts (required for inline JS). For stricter security, consider migrating to nonce-based CSP.

---

## Commands

- `Project: [Name]` - Activate project (loads context)
- `New project: [Name]` - Create new project
- `End project` - Deactivate project
- `Projects` - List all projects

---

## Architecture

### File Structure

```
~/.openclaw/workspace/
├── AGENTS.md                          # Trigger (mandatory)
├── ACTIVE-PROJECT.md                  # Current project state
├── projects/
│   ├── PROJECT-RULES.md               # System rules (loaded on demand)
│   ├── _index.md                      # Project registry
│   ├── my-project/
│   │   ├── PROJECT.md                 # Project context
│   │   ├── tasks.json                 # Task tracking
│   │   ├── context/                   # Project-level docs
│   │   └── specs/                     # Task spec files (created lazily)
│   └── another-project/
│       └── ...
~/FlowBoard/dashboard/                         # Dashboard (git repo = live instance)
    ├── index.html                     # Main HTML + Telegram WebApp SDK
    ├── server.js                      # Express API + auth middleware
    ├── styles/
    │   └── dashboard.css              # Responsive styles (mobile + desktop)
    └── js/
        ├── utils.js                   # Shared utilities + API client
        ├── kanban.js                  # Kanban view module
        └── file-explorer.js           # File explorer module
```

### Key Principles

1. **Lazy Loading** - Only load what's needed
2. **File-based Conventions** - No custom hooks required
3. **Single Source of Truth** - ACTIVE-PROJECT.md + tasks.json
4. **Graceful Degradation** - Errors = "no project active"
5. **Modular Frontend** - Clean separation of concerns

---

## Task Management

Each project gets a `tasks.json`:

```json
{
  "tasks": [
    {
      "id": "T-001",
      "title": "Set up authentication",
      "status": "in-progress",
      "priority": "high",
      "specFile": "specs/T-001-auth.md",
      "created": "2026-02-10",
      "completed": null
    }
  ]
}
```

**Task Workflow:**
```
open → in-progress → review → done
```

**Rules:**
- Agent works on ONE task at a time
- Status updates in real-time as agent works
- Manual confirmation moves tasks to "done"
- Unplanned work creates new tasks automatically

---

## Dashboard

The Kanban dashboard provides:

- **Tasks View:** Drag & drop kanban board with 4 columns
- **Spec Badges:** Lucide SVG icon on cards — click to open spec, hover to create
- **Files View:** File tree with Markdown/JSON preview and inline editing
- **File Auto-Refresh:** Detects new, modified, and deleted files automatically
- **Live Updates:** Auto-refresh every 5 seconds (fingerprint-based diff)
- **Inline Editing:** Click to edit, drag to change status
- **Priority Management:** Visual indicators with popover selector
- **Context Health:** File size tracking with warnings

**Access:** http://localhost:18790

The file explorer lets you browse your entire project structure, preview Markdown and JSON files with syntax highlighting, and edit files inline - all without leaving the dashboard.

![FlowBoard File Explorer](docs/screenshot-files.png)

---

## Changelog

### v3.0.0 (2026-02-22) - Telegram Mini App + Remote Access
- **Telegram Mini App** - Access dashboard from Telegram via secure tunnel
- **Auth middleware** - HMAC-SHA256 initData validation + JWT session cookies
- **User allowlist** - Only configured Telegram user IDs can access
- **AUTH_ALWAYS mode** - Tunnel-agnostic auth (Cloudflare, ngrok, Tailscale, etc.)
- **Security hardening** - Rate limiting, CORS, CSP, X-Frame-Options, auth logging
- **Health endpoint** - `GET /api/health` for monitoring
- **Responsive mobile CSS** - Horizontal kanban scroll, sidebar overlay, touch-friendly cards
- **Mobile file explorer** - Navigation pattern (tree → preview → back button)
- **Telegram WebApp SDK** - Theme sync, viewport handling, haptic feedback
- **Single Source of Truth** - Git repo = live dashboard instance (canvas/ removed)
- **Templates** - Cloudflare config, systemd auth drop-in, .env.example

### v2.5.0 (2026-02-19) - Spec Files & Auto-Refresh
- **Spec file system** - Optional `specs/` folder for complex tasks with template scaffolding
- **Spec UI integration** - Lucide SVG badge on task cards (click to open, hover to create)
- **File auto-refresh** - File explorer auto-updates on create/modify/delete (fingerprint-based polling)
- **Auto-expand directories** - Opening a file via badge auto-expands parent dirs in tree
- **Deleted file handling** - Auto-opens first file when selected file is deleted
- **Priority popover fix** - Correct horizontal layout
- **Design guidelines** - Documented design system reference (Gateway Dashboard alignment)
- **Spec API** - `POST /api/projects/:name/specs/:taskId` for programmatic spec creation

### v2.4.0 (2026-02-15) - Modular Frontend
- **JavaScript module refactoring** - Separated Kanban and File Explorer into clean modules
- **Improved code organization** - utils.js, kanban.js, file-explorer.js
- **Better maintainability** - Clear separation of concerns
- **Enhanced documentation** - Updated architecture diagrams

### v2.3.0 (2026-02-14) - Production Ready
- **API-based project switching** - Dashboard + chat use same endpoint
- **Wake events** - Instant context switching without /new
- **project-context Hook** - Automatic BOOTSTRAP.md generation
- **Webhook integration** - System events to agent
- **End-to-end tested** - Dashboard + chat verified

### v2.2.0 (2026-02-14)
- File Explorer with tab system
- Markdown & JSON preview with syntax highlighting
- Inline file editing
- Context health tracking

### v2.1.1 (2026-02-14)
- Memory-flush integration for session persistence
- SESSION-STATE.md reminder after compaction

### v2.1.0 (2026-02-13)
- Dashboard systemd auto-start service
- Port 18790
- UI polish

### v2.0.0 (2026-02-12)
- Task management system with tasks.json
- Kanban Dashboard with drag & drop
- Task workflow rules
- Auto-task creation

---

## Philosophy

- 🎯 **Simplicity** - No unnecessary complexity
- 💰 **Low cost** - Efficient token usage
- 🔒 **Privacy** - Everything runs locally
- ⚡ **Automatic** - Self-maintaining

---

## License

MIT © 2026
