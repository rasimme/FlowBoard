# Changelog

### v3.1.0 (2026-02-27) - UX & Mobile Improvements
- **Delete files** - Remove files from `context/` and `specs/` directly in the dashboard
- **Spec pre-fill** - `POST /specs/:taskId` accepts optional content body for programmatic creation
- **Smart session log trimming** - project-context hook keeps only last 2 sessions (smaller context)
- **Shared UI components** - `ICONS` registry and `renderDeleteBtn()` for consistent UI
- **LAN access via custom hostname** - Configurable `LOCAL_HOSTNAME` env var for auth bypass
- **Kanban scroll preservation** - Scroll position kept when switching between tabs
- **Mobile fixes** - Ghost-tap prevention, file explorer rebuild, no-cache HTML header
- **Extended PROJECT.md template** - Scope, Project Files, context/ convention documented
- **env.example template** - Easier setup with documented environment variables

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
