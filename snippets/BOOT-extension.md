# BOOT.md Extension

Add this section to your existing `BOOT.md` (do not replace existing content).

```markdown
## Project State Recovery (FlowBoard)
After a gateway restart:
1. Use the live-injected `BOOTSTRAP.md` content already present in the
   run context. Do **not** use the Read tool on a workspace
   `BOOTSTRAP.md` path; the on-disk file is not authoritative and may
   be missing or stale. The `project-context` hook injects fresh content
   via `agent:bootstrap` and it contains the active project plus the
   rules manifest.
2. If an active project is set: name the project and, if useful, the
   current task status.
3. If no active project: skip project-related notifications.
```
