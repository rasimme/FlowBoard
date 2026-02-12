## Projects (MANDATORY)
MANDATORY on EVERY first message of a conversation: read `ACTIVE-PROJECT.md`.
- If an active project exists: read `projects/PROJECT-RULES.md`, then read the project's `PROJECT.md`. Follow all rules in PROJECT-RULES.md.
- If no active project or file is empty/missing: work normally without project context.

Commands — always read `projects/PROJECT-RULES.md` first before executing:
- "Projekt: [Name]" → activate project
- "Projekt beenden" → deactivate project
- "Projekte" → show project overview
- "Neues Projekt: [Name]" → create new project

Only explicit user commands may change ACTIVE-PROJECT.md. Never modify it automatically via cron, sub-agents, or other automation.
