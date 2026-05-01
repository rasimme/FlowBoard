# BOOT.md Extension

Add this section to your existing `BOOT.md` (do not replace existing content).

```markdown
## Project State Recovery (FlowBoard)
After a gateway restart:
1. Read the regenerated `BOOTSTRAP.md` content — it is live-injected by
   the `project-context` hook (event `agent:bootstrap`) on the first
   run and contains the active project plus the rules manifest.
2. If an active project is set: name the project and, if useful, the
   current task status.
3. If no active project: skip project-related notifications.
```
