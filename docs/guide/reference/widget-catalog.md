# Widget catalog

Every widget you can place on a [project overview](../how-to/customize-overview.md), grouped by the clusters in the add-widget picker. The `type` is what agents use in the layout API (`PUT /api/projects/:name/overview`).

## Needs you

| Widget | `type` | What it shows |
|---|---|---|
| Approvals | `approvals` | Tasks in review, waiting for your sign-off. |
| Blocked | `blocked` | Tasks flagged blocked, waiting for a human decision. |
| Agent Questions | `agent-questions` | Open questions agents raised — answer them inline. |
| Since your last visit | `since-last-visit` | What moved while you were away — status changes, checkpoints, comments. |

## Live

| Widget | `type` | What it shows |
|---|---|---|
| Active Agents | `active-agents` | Who's working on what right now — claims, lease countdown, activity pulse. |
| Current Focus | `current-focus` | The claimed tasks, prominent: who's on what, since when. |
| Momentum | `stall-detection` | Friendly stall check — last activity plus a 14-day strip. |
| Activity | `activity-stream` | Latest task events across the project. |
| Timeline | `timeline` | A dated spine over all project activity (tasks, checkpoints, comments). |

## Direction

| Widget | `type` | What it shows |
|---|---|---|
| Milestones | `milestones` | Milestones as definition-of-done checklists (`milestone:<name>` tags). |
| Task Stats | `task-stats` | Status distribution, throughput, average cycle time, a stuck hint. |
| Board Preview | `kanban-mini` | Compact Kanban preview; opens the full board. |
| Next Up | `next-up` | Top open/backlog tasks by priority. |
| Project Goal | `project-goals` | Goal/scope excerpt from `PROJECT.md`. |

## GitHub

One repository binding per project; a token is only needed for private repos. Each widget opts in via `props.repo`.

| Widget | `type` | What it shows |
|---|---|---|
| Repo Status | `repo-status` | GitHub at a glance — default branch, CI state, open PRs, latest commits. |
| CI Runs | `gh-ci` | Workflow run history as a duration trend with pass rate. |
| Issues | `gh-issues` | Issue triage — new, unanswered, age distribution. |
| Pull Requests | `gh-pulls` | PR inbox — ready vs. draft, requested reviews first. |
| Releases | `gh-releases` | Latest release and what's unreleased since. |

## Knowledge & actions

| Widget | `type` | What it shows |
|---|---|---|
| File Viewer | `file-viewer` | Renders one project Markdown file on the overview (`props.path`). |
| Context Index | `context-index` | Files in `context/` — the knowledge agents read first. |
| Notes | `notes` | Scratchpad persisted as `context/NOTES.md`; agents can read and append. |
| Recent Decisions | `recent-decisions` | Latest entries from `DECISIONS.md`. |
| Quick Drop | `quick-drop` | Drop Markdown/text files — they land in `context/`. |
| Quick Actions | `quick-links` | Create a task, idea note, or context file in one click. |
| Links | `links` | Pinned external links (deploys, docs, dashboards) from `props.links`. |

## See also

- [Customize the project overview](../how-to/customize-overview.md)
- [Keyboard shortcuts](keyboard-shortcuts.md)
