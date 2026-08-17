import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import { useAppState } from './AppStateContext.jsx';
import { selectViewedProject } from '../utils/projectSelection.mjs';
import * as bridge from '../state/appStateBridge.mjs';
import { apiJson } from '../utils/apiFetch.js';
import { installGlobalToast, showToast } from '../utils/toast.js';
import {
  INITIAL_CONNECTION_STATE,
  connectionFailure,
  connectionLoading,
  connectionSuccess,
} from '../state/connectionState.mjs';

const DashboardContext = createContext(null);

const POLL_INTERVAL_MS = 5000;

async function fetchAgentsList() {
  const data = await apiJson('/agents');
  return Array.isArray(data?.agents) ? data.agents : [];
}

async function fetchActiveProjectForAgent(agentId) {
  if (!agentId) return null;
  const data = await apiJson(`/status?agentId=${encodeURIComponent(agentId)}`);
  if (data?.agentId !== agentId) {
    throw new Error(`Status agentId mismatch (${data?.agentId || 'missing'})`);
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

function sameConnection(a, b) {
  return a?.status === b?.status
    && a?.hasData === b?.hasData
    && a?.retrying === b?.retrying
    && a?.error === b?.error
    && a?.httpStatus === b?.httpStatus;
}

export function DashboardProvider({ children }) {
  const { state, dispatch } = useAppState();
  const initRef = useRef(false);
  const prevTasksRef = useRef('');
  const prevProjectsRef = useRef('');
  const prevAgentsRef = useRef('');
  const prevActiveRef = useRef(null);
  const connectionRef = useRef(state?.connection || INITIAL_CONNECTION_STATE);
  const loadInFlightRef = useRef(null);

  const publishConnection = useCallback((next) => {
    if (sameConnection(connectionRef.current, next)) return;
    connectionRef.current = next;
    dispatch({ connection: next });
  }, [dispatch]);

  const markConnectionFailure = useCallback((error, label) => {
    console.error(`${label}:`, error);
    publishConnection(connectionFailure(connectionRef.current, error));
  }, [publishConnection]);

  const markConnectionSuccess = useCallback((projects) => {
    publishConnection(connectionSuccess(projects));
  }, [publishConnection]);

  const fetchTasksForProject = useCallback(async (project) => {
    if (!project) return [];
    const data = await apiJson(`/projects/${encodeURIComponent(project)}/tasks?includeArchived=true`);
    return data?.tasks || [];
  }, []);

  const loadDashboardSnapshot = useCallback(({ showRetrying = false } = {}) => {
    if (loadInFlightRef.current) return loadInFlightRef.current;
    if (showRetrying) publishConnection(connectionLoading(connectionRef.current));

    const request = (async () => {
      try {
        // Wait for src/bootstrap.js to finish Telegram auth + agentId resolution so the
        // very first /projects + /status calls see a populated agentId.
        if (window.__flowboardBootstrap) await window.__flowboardBootstrap;
        const data = await apiJson('/projects');
        const projects = Array.isArray(data?.projects) ? data.projects : [];
        const [agents, activeProject] = await Promise.all([
          fetchAgentsList(),
          fetchActiveProjectForAgent(window.appState?.agentId),
        ]);
        const viewedProject = selectViewedProject({
          projects,
          agents,
          activeProject,
          currentViewedProject: window.appState?.viewedProject || null,
        });
        const tasks = viewedProject ? await fetchTasksForProject(viewedProject) : [];

        prevProjectsRef.current = JSON.stringify(projects);
        prevAgentsRef.current = JSON.stringify(agents);
        prevActiveRef.current = activeProject;
        prevTasksRef.current = JSON.stringify(tasks);

        const connection = connectionSuccess(projects);
        connectionRef.current = connection;
        dispatch({ projects, agents, activeProject, viewedProject, tasks, connection });
        return true;
      } catch (error) {
        markConnectionFailure(error, 'Dashboard load error');
        return false;
      } finally {
        loadInFlightRef.current = null;
      }
    })();

    loadInFlightRef.current = request;
    return request;
  }, [dispatch, fetchTasksForProject, markConnectionFailure, publishConnection]);

  const retryConnection = useCallback(() => (
    loadDashboardSnapshot({ showRetrying: true })
  ), [loadDashboardSnapshot]);

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
      markConnectionSuccess(newProjects);
      return true;
    } catch (err) {
      markConnectionFailure(err, 'refreshProjectsOnly error');
      return false;
    }
  }, [dispatch, markConnectionFailure, markConnectionSuccess]);

  const viewProject = useCallback(async (name) => {
    if (!name) return;
    try {
      const tasks = await fetchTasksForProject(name);
      prevTasksRef.current = JSON.stringify(tasks);
      dispatch({ viewedProject: name, tasks });
      markConnectionSuccess(window.appState?.projects || []);
      return tasks;
    } catch (error) {
      markConnectionFailure(error, 'viewProject error');
      return null;
    }
  }, [dispatch, fetchTasksForProject, markConnectionFailure, markConnectionSuccess]);

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

  const openSpec = useCallback((specPath, taskId, opts) => {
    if (!specPath) {
      showToast(`No spec linked${taskId ? ` for ${taskId}` : ''}`, 'warn');
      return;
    }
    dispatch({
      pendingSpecFile: specPath,
      pendingSpecTaskId: taskId || null,
      // T-399: files opened from an overview widget remember the tab to return
      // to, so the preview can show a "← Back to Overview" button.
      pendingSpecBackTab: (opts && opts.backTab) || null,
      currentTab: 'files',
    });
  }, [dispatch]);

  // Install the global toast, the sidebar-backdrop click handler, and the
  // appStateBridge refresh hook. T-356-2: the window._viewProject/_switchTab/…
  // command bridges were removed — components now call these actions directly
  // via useDashboard() instead of reaching through window.
  useEffect(() => {
    const uninstallToast = installGlobalToast();

    // Restore sidebar-backdrop click handler (was in legacy app.js, lost in migration)
    const backdrop = document.querySelector('.sidebar-backdrop');
    const onBackdropClick = () => toggleSidebar();
    backdrop?.addEventListener('click', onBackdropClick);

    const installed = bridge.installRefreshBridge(async () => {
      const project = window.appState?.viewedProject || window.appState?.activeProject;
      if (!project) return null;
      try {
        const tasks = await fetchTasksForProject(project);
        bridge.replaceTasks(tasks);
        prevTasksRef.current = JSON.stringify(tasks);
        markConnectionSuccess(window.appState?.projects || []);
        return tasks;
      } catch (error) {
        markConnectionFailure(error, 'Board refresh error');
        return null;
      }
    });

    return () => {
      uninstallToast();
      backdrop?.removeEventListener('click', onBackdropClick);
      if (window.appState && installed && window.appState._refreshBoard === installed) {
        delete window.appState._refreshBoard;
      }
    };
  }, [toggleSidebar, fetchTasksForProject, markConnectionFailure, markConnectionSuccess]);

  // Initial fetch — runs once after window.appState bootstrap is in place.
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;

    loadDashboardSnapshot();
  }, [loadDashboardSnapshot]);

  // Background refresh poll — same cadence as legacy app.js (5s).
  // Skips re-renders when user is interacting unless projects-level changes
  // happened, mirroring the legacy isUserInteracting() guard.
  useEffect(() => {
    const tick = async () => {
      if (loadInFlightRef.current) return;
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

        // A complete successful snapshot clears a previous degraded banner.
        // The data updates below remain guarded while the user is interacting.
        markConnectionSuccess(newProjects);

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
        markConnectionFailure(err, 'Refresh error');
      }
    };

    const id = setInterval(tick, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [dispatch, fetchTasksForProject, markConnectionFailure, markConnectionSuccess]);

  const value = useMemo(() => ({
    state,
    viewProject,
    activateProject,
    deactivateProject,
    switchTab,
    toggleSidebar,
    refreshProjectsOnly,
    retryConnection,
    openSpec,
    applyTelegramTheme: applyTelegramThemeImpl,
    haptic,
    hapticNotification,
  }), [state, viewProject, activateProject, deactivateProject, switchTab, toggleSidebar, refreshProjectsOnly, retryConnection, openSpec]);

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
