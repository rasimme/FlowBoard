---
name: session-handoff
description: "Automatic session context persistence with LLM summarization. Saves context on /new, loads on bootstrap."
metadata:
  openclaw:
    emoji: "🧠"
    events: ["command:new", "agent:bootstrap"]
    requires:
      config: ["gateway.http.endpoints.chatCompletions.enabled"]
---

# Session Handoff Hook

> Formerly "Simme Memory" — renamed for clarity.

Automatic session context management with LLM-powered summarization.

## Events

- **`command:new`** — Summarize current session → write SESSION-STATE.md
- **`agent:bootstrap`** — Inject SESSION-STATE.md into new session context
- **Memory flush** — Update SESSION-STATE.md before compaction

## Requirements

- OpenClaw 2026.2.x+
- `gateway.http.endpoints.chatCompletions.enabled: true`
- `hooks.internal.enabled: true`

## Cost

~$0.001-0.002 per `/new` command (Claude Haiku)

## Version

v1.1.0 (formerly Simme Memory v3.1.0)

### Changelog
- 1.1.0: Renamed to session-handoff, integrated into memory-management system
- 1.0.0: Initial release as part of memory-management (based on simme-memory v3.1.0)
