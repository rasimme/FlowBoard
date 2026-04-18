# BOOT.md Extension

Add this section to your existing `BOOT.md` (do not replace existing content).

```markdown
## Project State Recovery (FlowBoard)
After a gateway restart:
1. Read the regenerated `BOOTSTRAP.md` — it contains the active project and
   the rules manifest.
2. If an active project is set: name the project and, if useful, the current
   task status.
3. If no active project: skip project-related notifications.
```
