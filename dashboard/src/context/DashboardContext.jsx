import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import { useAppState } from './AppStateContext.jsx';
import { selectViewedProject } from '../utils/projectSelection.mjs';
import * as bridge from '../state/appStateBridge.mjs';
import { ApiError, apiJson } from '../utils/apiFetch.js';
import { installGlobalToast, showToast } from '../utils/toast.js';
import {
  INITIAL_CONNECTION_STATE,
  connectionFailure,
  connectionLoading,
  connectionRecovery,
  connectionSuccess,
} from '../state/connectionState.mjs';

const DashboardContext = createContext(null);

const POLL_INTERVAL_MS = 5000;

function invalidPayload(path, expectation) {
  return new ApiError(`Invalid FlowBoard response: expected ${expectation}.`, {
    kind: 'protocol',
    path,
  });
}

function objectArrayField(data, field, path) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data[field])) {
    throw invalidPayload(path, `an object with a ${field} array`);
  }
  if (data[field].some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry))) {
    throw invalidPayload(path, `${field} to contain objects`);
  }
  return data[field];
}

async function fetchProjectsList(signal) {
  const path = '/projects';
  const data = await apiJson(path, { signal });
  const projects = objectArrayField(data, 'projects', path);
  if (projects.some((project) => typeof project.name !== 'string' || !project.name)) {
    throw invalidPayload(path, 'every project to have a non-empty name');
  }
  return projects;
}

async function fetchAgentsList(signal) {
  const path = '/agents';
  const data = await apiJson(path, { signal });
  return objectArrayField(data, 'agents', path);
}

async function fetchActiveProjectForAgent(agentId, signal) {
  if (!agentId) return null;
  const path = `/status?agentId=${encodeURIComponent(agentId)}`;
  const data = await apiJson(path, { signal });
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw invalidPayload(path, 'a status object');
  }
  if (data?.agentId !== agentId) {
    throw invalidPayload(path, `agentId ${agentId}`);
  }
  if (data.activeProject !== null && typeof data.activeProject !== 'string') {
    throw invalidPayload(path, 'activeProject to be a string or null');
  }
  return data.activeProject;
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
    && a?.httpStatus === b?.httpStatus
    && a?.errorScope === b?.errorScope;
}

export function DashboardProvider({ children }) {
  const { state, dispatch } = useAppState();
  const initRef = useRef(false);
  const prevTasksRef = useRef('');
  const prevProjectsRef = useRef('');
  const prevAgentsRef = useRef('');
  const prevActiveRef = useRef(null);
  const connectionRef = useRef(state?.connection || INITIAL_CONNECTION_STATE);
  const snapshotRequestRef = useRef({ generation: 0, active: null });

  const publishConnection = useCallback((next) => {
    if (sameConnection(connectionRef.current, next)) return;
    connectionRef.current = next;
    dispatch({ connection: next });
  }, [dispatch]);

  const markConnectionFailure = useCallback((error, label, scope = 'core') => {
    console.error(`${label}:`, error);
    publishConnection(connectionFailure(connectionRef.current, error, scope));
  }, [publishConnection]);

  const markConnectionSuccess = useCallback((projects, scope = 'core') => {
    publishConnection(connectionRecovery(connectionRef.current, projects, scope));
  }, [publishConnection]);

  const fetchTasksForProject = useCallback(async (project, signal) => {
    if (!project) return [];
    const path = `/projects/${encodeURIComponent(project)}/tasks?includeArchived=true`;
    const data = await apiJson(path, { signal });
    return objectArrayField(data, 'tasks', path);
  }, []);

  const fetchDashboardSnapshot = useCallback(async (signal) => {
    // Wait for src/bootstrap.js to finish Telegram auth + agentId resolution so the
    // very first /projects + /status calls see a populated agentId. bootstrap's auth
    // fetch has the same deadline as all apiJson calls, so this wait is bounded too.
    if (window.__flowboardBootstrap) await window.__flowboardBootstrap;
    if (signal.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');

    const projects = await fetchProjectsList(signal);
    const [agents, activeProject] = await Promise.all([
      fetchAgentsList(signal),
      fetchActiveProjectForAgent(window.appState?.agentId, signal),
    ]);
    const viewedProject = selectViewedProject({
      projects,
      agents,
      activeProject,
      currentViewedProject: window.appState?.viewedProject || null,
    });
    const tasks = viewedProject ? await fetchTasksForProject(viewedProject, signal) : [];

    return { projects, agents, activeProject, viewedProject, tasks };
  }, [fetchTasksForProject]);

  const commitFullSnapshot = useCallback((snapshot) => {
    const { projects, agents, activeProject, viewedProject, tasks } = snapshot;
    prevProjectsRef.current = JSON.stringify(projects);
    prevAgentsRef.current = JSON.stringify(agents);
    prevActiveRef.current = activeProject;
    prevTasksRef.current = JSON.stringify(tasks);

    const connection = connectionSuccess(projects);
    connectionRef.current = connection;
    dispatch({ projects, agents, activeProject, viewedProject, tasks, connection });
  }, [dispatch]);

  const commitPollSnapshot = useCallback((snapshot) => {
    const { projects, agents, activeProject, viewedProject, tasks } = snapshot;
    const projectsJson = JSON.stringify(projects);
    const agentsJson = JSON.stringify(agents);
    const tasksJson = JSON.stringify(tasks);
    const projectsChanged = projectsJson !== prevProjectsRef.current
      || activeProject !== prevActiveRef.current
      || viewedProject !== window.appState?.viewedProject;
    const agentsChanged = agentsJson !== prevAgentsRef.current;
    const tasksChanged = tasksJson !== prevTasksRef.current;

    // Only a complete successful core snapshot clears a core failure.
    markConnectionSuccess(projects, 'core');

    if (isUserInteracting() && !projectsChanged) return;

    if (projectsChanged || tasksChanged || agentsChanged) {
      prevProjectsRef.current = projectsJson;
      prevAgentsRef.current = agentsJson;
      prevActiveRef.current = activeProject;
      prevTasksRef.current = tasksJson;
      dispatch({ projects, agents, activeProject, viewedProject, tasks });
    }
  }, [dispatch, markConnectionSuccess]);

  const startSnapshotRequest = useCallback((kind, { showRetrying = false } = {}) => {
    const running = snapshotRequestRef.current.active;
    if (running && kind !== 'retry') return running.promise;
    if (running) running.controller.abort(new DOMException('Superseded by retry', 'AbortError'));

    const generation = snapshotRequestRef.current.generation + 1;
    const controller = new AbortController();
    snapshotRequestRef.current.generation = generation;
    if (showRetrying) publishConnection(connectionLoading(connectionRef.current));

    const request = (async () => {
      try {
        const snapshot = await fetchDashboardSnapshot(controller.signal);
        if (controller.signal.aborted || snapshotRequestRef.current.generation !== generation) return false;
        if (kind === 'poll') commitPollSnapshot(snapshot);
        else commitFullSnapshot(snapshot);
        return true;
      } catch (error) {
        const superseded = controller.signal.aborted
          || snapshotRequestRef.current.generation !== generation
          || error?.kind === 'aborted';
        if (!superseded) markConnectionFailure(error, `${kind === 'poll' ? 'Refresh' : 'Dashboard load'} error`, 'core');
        return false;
      } finally {
        if (snapshotRequestRef.current.generation === generation) {
          snapshotRequestRef.current.active = null;
        }
      }
    })();

    snapshotRequestRef.current.active = { generation, controller, promise: request, kind };
    return request;
  }, [commitFullSnapshot, commitPollSnapshot, fetchDashboardSnapshot, markConnectionFailure, publishConnection]);

  const loadDashboardSnapshot = useCallback(() => (
    startSnapshotRequest('initial')
  ), [startSnapshotRequest]);

  const retryConnection = useCallback(() => (
    startSnapshotRequest('retry', { showRetrying: true })
  ), [startSnapshotRequest]);

  const refreshProjectsOnly = useCallback(() => (
    startSnapshotRequest('retry')
  ), [startSnapshotRequest]);

  const viewProject = useCallback(async (name) => {
    if (!name) return;
    try {
      const tasks = await fetchTasksForProject(name);
      prevTasksRef.current = JSON.stringify(tasks);
      dispatch({ viewedProject: name, tasks });
      markConnectionSuccess(window.appState?.projects || [], 'tasks');
      return tasks;
    } catch (error) {
      markConnectionFailure(error, 'viewProject error', 'tasks');
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
        markConnectionSuccess(window.appState?.projects || [], 'tasks');
        return tasks;
      } catch (error) {
        markConnectionFailure(error, 'Board refresh error', 'tasks');
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
    const tick = () => startSnapshotRequest('poll');

    const id = setInterval(tick, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [startSnapshotRequest]);

  useEffect(() => () => {
    snapshotRequestRef.current.generation += 1;
    snapshotRequestRef.current.active?.controller.abort(new DOMException('Dashboard unmounted', 'AbortError'));
    snapshotRequestRef.current.active = null;
  }, []);

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
