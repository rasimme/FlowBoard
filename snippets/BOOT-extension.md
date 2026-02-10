# BOOT.md Extension

Add this section to your existing BOOT.md (do not replace existing content).

```markdown
## Project State Recovery
After a gateway restart:
1. Read `ACTIVE-PROJECT.md`
2. If active project exists with pending actions: mention project name and what was in progress
3. If active project exists but no pending actions: briefly mention the active project
4. If no active project: skip project-related notifications
```
