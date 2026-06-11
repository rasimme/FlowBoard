import {
  ActiveAgentsWidget,
  TaskStatsWidget,
  NextUpWidget,
  RecentDecisionsWidget,
  ProjectGoalsWidget,
  QuickLinksWidget,
  KanbanMiniWidget,
} from './widgets.jsx';

/**
 * Trusted widget registry (T-305) — the renderer instantiates ONLY types
 * listed here. The server mirrors this catalog in overview.js and rejects
 * unknown types on write; unknown types in a stored config are skipped on
 * render (forward compatibility, ADR-0023).
 */
export const WIDGET_REGISTRY = {
  'active-agents': ActiveAgentsWidget,
  'task-stats': TaskStatsWidget,
  'next-up': NextUpWidget,
  'recent-decisions': RecentDecisionsWidget,
  'project-goals': ProjectGoalsWidget,
  'quick-links': QuickLinksWidget,
  'kanban-mini': KanbanMiniWidget,
};
