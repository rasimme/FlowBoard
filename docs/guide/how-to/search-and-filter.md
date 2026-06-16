# Search and filter tasks

FlowBoard has a command-palette search that finds tasks across all projects, with typo-tolerant matching and structured filter operators.

## Open the palette

Press **`Cmd+K`** (macOS) or **`Ctrl+K`** (Windows/Linux) anywhere in the dashboard. Start typing; results update as you type. Use the **arrow keys** to move through results and **Enter** to open one.

## What plain text matches

- **Task number** — type `T-123` (or just `123`) to jump straight to a task.
- **Title** — partial words and minor typos still match; an exact match is flagged with a badge so you can spot it.
- **Project names** are searchable too.

## Filter operators

Refine results with `key:value` operators. Combine several — they narrow the result set together, and you can still add free text.

| Operator | Matches |
|---|---|
| `status:open` | tasks in a column (`backlog`, `open`, `in-progress`, `review`, `done`) |
| `project:my-app` | tasks in a specific project |
| `agent:claude-code` | tasks claimed by / routed to an agent |
| `is:blocked` | tasks flagged blocked |
| `is:claimed` | tasks currently claimed |
| `has:spec` | tasks that have a linked spec file |

**Examples**

```
status:in-progress agent:claude-code      # what that agent is working on now
project:my-app is:blocked                  # blocked work in one project
has:spec login                             # tasks about "login" that have a spec
```

## See also

- [Getting started](../getting-started.md)
- [Manage projects](manage-projects.md)
