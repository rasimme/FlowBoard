import { lazy } from 'react';

const DesignTest = lazy(() => import('../pages/DesignTest.jsx'));
const TasksView = lazy(() => import('../pages/TasksView.jsx'));

/**
 * View registry — single source of truth for top-level dashboard views.
 *
 * owner: 'legacy' | 'react'
 *   - legacy: React hands off to vanilla switchTab(); #content is DOM-managed
 *   - react:  ViewShell renders the component directly into #content
 *
 * To migrate a view: set owner to 'react' and add a `component` field.
 */
export const VIEWS = [
  { id: 'ideas', label: 'Ideas', owner: 'legacy' },
  { id: 'tasks', label: 'Tasks', owner: 'react', component: TasksView },
  { id: 'files', label: 'Files', owner: 'legacy' },
  { id: 'design', label: 'Design', owner: 'react', component: DesignTest, hidden: true },
];

export function getView(id) {
  return VIEWS.find(v => v.id === id);
}
