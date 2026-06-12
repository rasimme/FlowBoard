import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import { useAppState } from './AppStateContext.jsx';
import { selectViewedProject } from '../utils/projectSelection.mjs';
import * as bridge from '../state/appStateBridge.mjs';
import useTaskActions from '../hooks/useTaskActions.jsx';
import { apiJson } from '../utils/apiFetch.js';
import { installGlobalToast, showToast } from '../utils/toast.js';

const DashboardContext = createContext(null);

const POLL_INTERVAL_MS = 5000;

async function fetchAgentsList() {
  try {
    const data = await apiJson('/agents');
    return Array.isArray(data?.agents) ? data.agents : [];
  } catch {
    return [];
  }
}

async function fetchActiveProjectForAgent(agentId) {
  if (!agentId) return null;
  const data = await apiJson(`/status?agentId=${encodeURIComponent(agentId)}`);
  if (data?.agentId !== agentId) {
    console.warn('[status] agentId mismatch', { requested: agentId, received: data?.agentId });
    return null;
  }
  return data.activeProject || null;
}

function isUserInteracting() {
  if (document.getElementById('modalOverlay')) return true;
  const active = document.activeElement;
  return !!(active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA'));
}

function applyTelegramThemeImpl() {
  const tg = window.Telegram?.WebApp;
  if (!tg?.themeParams) return;
  const { bg_color, text_color, hint_color, button_color, secondary_bg_color } = tg.themeParams;
  const r = document.documentElement;
  if (bg_color)           r.style.setProperty('--tg-bg', bg_color);
  if (text_color)         r.style.setProperty('--tg-text', text_color);
  if (hint_color)         r.style.setProperty('--tg-hint', hint_color);
  if (button_color)       r.style.setProperty('--tg-btn', button_color);
  if (secondary_bg_color) r.style.setProperty('--tg-secondary-bg', secondary_bg_color);
}

function haptic(type = 'light') {
  window.Telegram?.WebApp?.HapticFeedback?.impactOccurred(type);
}

function hapticNotification(type = 'success') {
  window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred(type);
}

export function DashboardProvider({ children }) {
  const { state, dispatch } = useAppState();
  const actions = useTaskActions();
  const initRef = useRef(false);
  const prevTasksRef = useRef('');
  const prevProjectsRef = useRef('');
  const prevAgentsRef = useRef('');
  const prevActiveRef = useRef(null);

  const fetchTasksForProject = useCallback(async (project) => {
    if (!project) return [];
    const data = await apiJson(`/projects/${encodeURIComponent(project)}/tasks?includeArchived=true`);
    return data?.tasks || [];
  }, []);

  const refreshProjectsOnly = useCallback(async () => {
    try {
      const data = await apiJson('/projects');
      const newProjects = data?.projects || [];
      const newAgents = await fetchAgentsList();
      const newActive = await fetchActiveProjectForAgent(window.appState?.agentId);

      const updates = {
        projects: newProjects,
        agents: newAgents,
        activeProject: newActive,
      };

      const currentViewed = window.appState?.viewedProject;
      if (currentViewed && !newProjects.some(p => p.name === currentViewed)) {
        updates.viewedProject = selectViewedProject({
          projects: newProjects,
          agents: newAgents,
          activeProject: newActive,
          currentViewedProject: null,
        });
        updates.tasks = [];
        prevTasksRef.current = '';
      }

      prevProjectsRef.current = JSON.stringify(newProjects);
      prevAgentsRef.current = JSON.stringify(newAgents);
      prevActiveRef.current = newActive;

      dispatch(updates);
    } catch (err) {
      console.error('refreshProjectsOnly error:', err);
    }
  }, [dispatch]);

  const viewProject = useCallback(async (name) => {
    if (!name) return;
    const tasks = await fetchTasksForProject(name);
    prevTasksRef.current = JSON.stringify(tasks);
    dispatch({
      viewedProject: name,
      tasks,
    });
  }, [dispatch, fetchTasksForProject]);

  const activateProject = useCallback(async () => {
    const agentId = window.appState?.agentId;
    const viewed = window.appState?.viewedProject;
    if (!agentId) {
      showToast('No agent context for activation.', 'warn');
      return;
    }
    if (!viewed) return;
    await apiJson('/status', { method: 'PUT', body: { project: viewed, agentId } });
    dispatch({ activeProject: viewed });
    prevActiveRef.current = viewed;
    showToast(`Project "${viewed}" activated`, 'success');
  }, [dispatch]);

  const deactivateProject = useCallback(async () => {
    const agentId = window.appState?.agentId;
    if (!agentId) {
      showToast('No agent context for deactivation.', 'warn');
      return;
    }
    await apiJson('/status', { method: 'PUT', body: { project: null, agentId } });
    dispatch({ activeProject: null });
    prevActiveRef.current = null;
    showToast('Project deactivated.', 'info');
  }, [dispatch]);

  const switchTab = useCallback((tab) => {
    if (!tab) return;
    dispatch({ currentTab: tab });
  }, [dispatch]);

  const toggleSidebar = useCallback(() => {
    document.getElementById('app')?.classList.toggle('sidebar-collapsed');
    haptic('light');
  }, []);

  const openSpec = useCallback((specPath, taskId) => {
    if (!specPath) {
      showToast(`No spec linked${taskId ? ` for ${taskId}` : ''}`, 'warn');
      return;
    }
    dispatch({
      pendingSpecFile: specPath,
      pendingSpecTaskId: taskId || null,
      currentTab: 'files',
    });
  }, [dispatch]);

  // Install legacy bridge stubs so existing React components (Sidebar, TabBar,
  // ProjectActionsMenu, TasksView, FilesView, DetailPanel) and the appStateBridge
  // refresh hook continue to function without changes.
  useEffect(() => {
    window._viewProject = viewProject;
    window._activateProject = activateProject;
    window._deactivateProject = deactivateProject;
    window._toggleSidebar = toggleSidebar;
    window._switchTab = switchTab;
    window._refreshProjects = refreshProjectsOnly;
    window._openSpec = openSpec;
    const uninstallToast = installGlobalToast();

    // Restore sidebar-backdrop click handler (was in legacy app.js, lost in migration)
    const backdrop = document.querySelector('.sidebar-backdrop');
    const onBackdropClick = () => toggleSidebar();
    backdrop?.addEventListener('click', onBackdropClick);

    const installed = bridge.installRefreshBridge(async () => {
      const project = window.appState?.viewedProject || window.appState?.activeProject;
      if (!project) return null;
      const tasks = await fetchTasksForProject(project);
      bridge.replaceTasks(tasks);
      prevTasksRef.current = JSON.stringify(tasks);
      return tasks;
    });

    return () => {
      delete window._viewProject;
      delete window._activateProject;
      delete window._deactivateProject;
      delete window._toggleSidebar;
      delete window._switchTab;
      delete window._refreshProjects;
      delete window._openSpec;
      uninstallToast();
      backdrop?.removeEventListener('click', onBackdropClick);
      if (window.appState && installed && window.appState._refreshBoard === installed) {
        delete window.appState._refreshBoard;
      }
    };
  }, [viewProject, activateProject, deactivateProject, toggleSidebar, switchTab, refreshProjectsOnly, openSpec, fetchTasksForProject]);

  // Initial fetch — runs once after window.appState bootstrap is in place.
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;

    (async () => {
      try {
        // Wait for src/bootstrap.js to finish Telegram auth + agentId resolution so the
        // very first /projects + /status calls see a populated agentId.
        if (window.__flowboardBootstrap) await window.__flowboardBootstrap;
        const data = await apiJson('/projects');
        const projects = data?.projects || [];
        const agents = await fetchAgentsList();
        const agentId = window.appState?.agentId;
        const activeProject = await fetchActiveProjectForAgent(agentId);
        const viewedProject = selectViewedProject({
          projects,
          agents,
          activeProject,
          currentViewedProject: window.appState?.viewedProject || null,
        });

        let tasks = [];
        if (viewedProject) {
          tasks = await fetchTasksForProject(viewedProject);
        }

        prevProjectsRef.current = JSON.stringify(projects);
        prevAgentsRef.current = JSON.stringify(agents);
        prevActiveRef.current = activeProject;
        prevTasksRef.current = JSON.stringify(tasks);

        dispatch({
          projects,
          agents,
          activeProject,
          viewedProject,
          tasks,
        });
      } catch (err) {
        console.error('Dashboard init error:', err);
      }
    })();
  }, [dispatch, fetchTasksForProject]);

  // Background refresh poll — same cadence as legacy app.js (5s).
  // Skips re-renders when user is interacting unless projects-level changes
  // happened, mirroring the legacy isUserInteracting() guard.
  useEffect(() => {
    const tick = async () => {
      try {
        const agentId = window.appState?.agentId;
        const data = await apiJson('/projects');
        const newProjects = data?.projects || [];
        const newAgents = await fetchAgentsList();
        const newActive = await fetchActiveProjectForAgent(agentId);

        const projectsJson = JSON.stringify(newProjects);
        const agentsJson = JSON.stringify(newAgents);
        const projectsChanged = projectsJson !== prevProjectsRef.current || newActive !== prevActiveRef.current;
        const agentsChanged = agentsJson !== prevAgentsRef.current;

        const updates = {};
        if (projectsJson !== prevProjectsRef.current) updates.projects = newProjects;
        if (agentsChanged) updates.agents = newAgents;
        if (newActive !== prevActiveRef.current) updates.activeProject = newActive;

        let viewedProject = window.appState?.viewedProject;
        if (!viewedProject) {
          viewedProject = selectViewedProject({
            projects: newProjects,
            agents: newAgents,
            activeProject: newActive,
          });
          if (viewedProject) updates.viewedProject = viewedProject;
        }

        let tasksChanged = false;
        let tasksJson = prevTasksRef.current;
        if (viewedProject) {
          const newTasks = await fetchTasksForProject(viewedProject);
          tasksJson = JSON.stringify(newTasks);
          if (tasksJson !== prevTasksRef.current) {
            tasksChanged = true;
            updates.tasks = newTasks;
          }
        }

        // T-246-7: commit the "seen" refs only when we actually dispatch.
        // The old code updated the refs first and then bailed on the
        // interaction guard — the change was marked as seen and the kanban
        // never received it (stale cards until the next real server change
        // or a reload).
        if (isUserInteracting() && !projectsChanged) return;

        if (projectsChanged || tasksChanged || agentsChanged) {
          prevProjectsRef.current = projectsJson;
          prevAgentsRef.current = agentsJson;
          prevActiveRef.current = newActive;
          prevTasksRef.current = tasksJson;
          dispatch(updates);
        }
      } catch (err) {
        console.error('Refresh error:', err);
      }
    };

    const id = setInterval(tick, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [dispatch, fetchTasksForProject]);

  const value = useMemo(() => ({
    state,
    actions,
    viewProject,
    activateProject,
    deactivateProject,
    switchTab,
    toggleSidebar,
    refreshProjectsOnly,
    openSpec,
    applyTelegramTheme: applyTelegramThemeImpl,
    haptic,
    hapticNotification,
  }), [state, actions, viewProject, activateProject, deactivateProject, switchTab, toggleSidebar, refreshProjectsOnly, openSpec]);

  return (
    <DashboardContext.Provider value={value}>
      {children}
    </DashboardContext.Provider>
  );
}

export function useDashboard() {
  const ctx = useContext(DashboardContext);
  if (!ctx) throw new Error('useDashboard must be used within DashboardProvider');
  return ctx;
}

export default DashboardContext;
