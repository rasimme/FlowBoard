# Brainstorm on the canvas and promote to tasks

The Idea Canvas is a spatial place to think before things are structured work. When an idea is ready, one click turns it into a task — or a whole task tree.

## Sketch ideas

- **Add notes:** double-tap (or use the toolbar) to drop a sticky note; type into it.
- **Connect** notes into **clusters** by drawing links between them. A cluster is how the canvas knows several notes belong to one idea.
- Pan, zoom, multi-select, recolor, resize, duplicate, and undo as you'd expect; a minimap helps on big canvases. The viewport is remembered per project.

## Promote to tasks

1. Select one or more connected notes.
2. Click **Create Task**. This opens the **Specify stepper** in the browser.
3. The stepper asks a few clarification questions (each with a recommended option you can accept or skip), then shows a **proposal** you can revise.
4. Confirm to create the work. Depending on the idea's shape, you get:
   - a single **task** (with a title and priority),
   - a task **plus a spec** (acceptance criteria), or
   - a **parent task with subtasks and specs** for a complex cluster.
5. Optionally let the stepper **clean up** the promoted notes, and jump straight to the new card with **View in Kanban**.

No webhook or agent configuration is needed — the whole flow runs in the dashboard.

## The chat-agent path (optional)

OpenClaw webhooks are only needed for the **chat-agent path** (scripted
callers passing an explicit `agentId`, so a chat-bound agent runs the
clarification conversation instead of the dashboard stepper):

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

Without these, everything works — including canvas promote via the dashboard stepper; only the chat-agent promote path is unavailable.


## See also

- [Work the Kanban board](work-the-kanban.md)
- [Getting started](../getting-started.md)
