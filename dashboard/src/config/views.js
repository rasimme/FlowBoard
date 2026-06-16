import { lazy } from 'react';

const DesignTest = lazy(() => import('../pages/DesignTest.jsx'));
const CanvasView = lazy(() => import('../pages/CanvasView.jsx'));
const TasksView = lazy(() => import('../pages/TasksView.jsx'));
const OverviewView = lazy(() => import('../pages/OverviewView.jsx'));
const FilesView = lazy(() => import('../pages/FilesView.jsx'));

/**
 * View registry — single source of truth for top-level dashboard views.
 * Every view is a React component rendered by ViewShell into #content
 * (the legacy owner split ended with the canvas migration, T-340).
 */
export const VIEWS = [
  { id: 'overview', label: 'Overview', component: OverviewView },
  { id: 'ideas', label: 'Ideas', component: CanvasView },
  { id: 'tasks', label: 'Tasks', component: TasksView },
  { id: 'files', label: 'Files', component: FilesView },
  { id: 'design', label: 'Design', component: DesignTest, hidden: true },
];

export function getView(id) {
  return VIEWS.find(v => v.id === id);
}
