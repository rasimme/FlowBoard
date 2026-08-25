import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useAppState } from './AppStateContext.jsx';
import * as bridge from '../state/appStateBridge.mjs';
import { ApiError, apiJson } from '../utils/apiFetch.js';
import {
  fetchDashboardSnapshot as fetchDashboardSnapshotApi,
  fetchTasksForProject,
} from '../utils/dashboardApi.js';
import { installGlobalToast, showToast } from '../utils/toast.js';
import {
  INITIAL_CONNECTION_STATE,
  connectionFailure,
  connectionLoading,
  connectionRecovery,
  connectionScopeRecovery,
} from '../state/connectionState.mjs';
import {
  isAuthenticationFailure,
  isAuthHalted,
  getAuthHaltError,
  markAuthHalted,
  subscribeAuthState,
} from '../state/authState.mjs';
import { getLastMutationAt } from '../state/taskMutations.mjs';

const DashboardContext = createContext(null);

const POLL_INTERVAL_MS = 5000;

function retryAfterMs(error) {
  const seconds = Number(error?.retryAfterSeconds);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.max(1000, seconds * 1000) : 60000;
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
  const prevTasksRef = useRef('');
  const prevProjectsRef = useRef('');
  const prevAgentsRef = useRef('');
  const prevActiveRef = useRef(null);
  const connectionRef = useRef(state?.connection || INITIAL_CONNECTION_STATE);
  const snapshotRequestRef = useRef({ generation: 0, active: null });
  const taskRequestRef = useRef({ generation: 0, active: null });
  const projectSwitchRef = useRef(null);
  const queuedRetryRef = useRef(null);
  const coreCooldownUntilRef = useRef(0);
  const unmountedRef = useRef(false);
  const authHalted = useSyncExternalStore(subscribeAuthState, isAuthHalted, isAuthHalted);

  const publishConnection = useCallback((next) => {
    if (sameConnection(connectionRef.current, next)) return;
    connectionRef.current = next;
    dispatch({ connection: next });
  }, [dispatch]);

  const markConnectionFailure = useCallback((error, label, scope = 'core') => {
    console.error(`${label}:`, error);
    if (isAuthenticationFailure(error)) {
      // apiFetch normally opens the breaker before apiJson rejects. Keep this
      // safeguard for bootstrap/custom fetch implementations as well.
      markAuthHalted(error);
    }
    const next = connectionFailure(connectionRef.current, error, scope);
    if (error?.status === 429) {
      const cooldownUntil = Date.now() + retryAfterMs(error);
      if (scope === 'core') coreCooldownUntilRef.current = cooldownUntil;
      publishConnection({
        ...next,
        cooldownUntil,
        rateLimitScope: error.rateLimitScope || scope,
      });
      return;
    }
    publishConnection(next);
  }, [publishConnection]);

  const markConnectionSuccess = useCallback((projects, scope = 'core') => {
    if (scope === 'core') coreCooldownUntilRef.current = 0;
    publishConnection(connectionRecovery(connectionRef.current, projects, scope));
  }, [publishConnection]);

  // bootstrap.js can publish an auth failure before its promise resolves. Keep
  // the imperative request coordinator aligned with that central store value.
  useEffect(() => {
    connectionRef.current = state?.connection || INITIAL_CONNECTION_STATE;
  }, [state?.connection]);

  // A typed auth failure from Files or another view must put the shell in the
  // same auth state as a failed snapshot. This also gives the explicit Retry
  // button an auth-scoped request that can rerun /api/auth.
  useEffect(() => {
    if (!authHalted || connectionRef.current.errorScope === 'auth') return;
    const halted = getAuthHaltError();
    const error = new ApiError('Authentication required.', {
      status: halted?.status === 401 || halted?.status === 403 ? halted.status : 401,
      path: halted?.path || '/api',
    });
    publishConnection(connectionFailure(connectionRef.current, error, 'auth'));
  }, [authHalted, publishConnection]);

  // One task-request lane owns every list fetch that can ultimately publish to
  // appState.tasks: full snapshots, project navigation, mutation refreshes and
  // compatibility/override callers. Replacements are network-serial and abort
  // the old body parser before the next request starts.
  const fetchCoordinatedTasks = useCallback((project, kind, options = {}) => {
    const running = taskRequestRef.current.active;
    const generation = taskRequestRef.current.generation + 1;
    taskRequestRef.current.generation = generation;

    return (async () => {
      if (running) {
        running.superseded = true;
        running.controller.abort(new DOMException(`Superseded ${running.kind} task load`, 'AbortError'));
        await running.promise.catch(() => null);
        if (taskRequestRef.current.generation !== generation) return null;
        if (taskRequestRef.current.active === running) taskRequestRef.current.active = null;
      }

      const { signal: callerSignal, ...fetchOptions } = options;
      const controller = new AbortController();
      const forwardCallerAbort = () => controller.abort(callerSignal.reason);
      if (callerSignal?.aborted) forwardCallerAbort();
      else callerSignal?.addEventListener('abort', forwardCallerAbort, { once: true });

      let active;
      const request = (async () => {
        try {
          const tasks = await fetchTasksForProject(project, controller.signal, fetchOptions);
          if (controller.signal.aborted || taskRequestRef.current.generation !== generation) return null;
          return { tasks, generation };
        } catch (error) {
          if (active?.superseded || taskRequestRef.current.generation !== generation) return null;
          throw error;
        } finally {
          callerSignal?.removeEventListener('abort', forwardCallerAbort);
          if (taskRequestRef.current.active === active) taskRequestRef.current.active = null;
        }
      })();

      active = { generation, controller, promise: request, kind, project, superseded: false };
      taskRequestRef.current.active = active;
      return request;
    })();
  }, []);

  const fetchDashboardSnapshot = useCallback(async (signal, {
    retryAuth = false,
    onAuthRecovered = null,
  } = {}) => {
    // Wait for src/bootstrap.js to finish Telegram auth + agentId resolution so the
    // very first core calls see a populated agentId. An explicit auth Retry uses
    // bootstrap's one auth owner again before loading the core snapshot.
    if (window.__flowboardBootstrap && !window.__flowboardBootstrapReady) {
      await window.__flowboardBootstrap;
    }
    connectionRef.current = window.appState?.connection || connectionRef.current;
    if (retryAuth && typeof window.__flowboardAuthenticate === 'function') {
      await window.__flowboardAuthenticate(signal);
      onAuthRecovered?.();
    }
    if (signal.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
    // Capture the task-lane generation before the single request. A direct
    // navigation/mutation refresh that starts while this snapshot is in flight
    // invalidates the snapshot's task section before it can commit.
    const taskGeneration = taskRequestRef.current.generation;
    const snapshot = await fetchDashboardSnapshotApi(
      window.appState?.viewedProject || null,
      window.appState?.agentId || null,
      signal,
    );
    return { ...snapshot, taskGeneration };
  }, []);

  const commitFullSnapshot = useCallback((snapshot, recoveredScope = 'core') => {
    const { projects, agents, activeProject, viewedProject, tasks } = snapshot;
    prevProjectsRef.current = JSON.stringify(projects);
    prevAgentsRef.current = JSON.stringify(agents);
    prevActiveRef.current = activeProject;
    prevTasksRef.current = JSON.stringify(tasks);

    const connection = connectionRecovery(connectionRef.current, projects, recoveredScope);
    if (recoveredScope === 'core') coreCooldownUntilRef.current = 0;
    connectionRef.current = connection;
    dispatch({ projects, agents, activeProject, viewedProject, tasks, connection });
  }, [dispatch]);

  // T-454-7: reconciles a poll response against tasks this tab has since
  // mutated. `requestStartedAt` is when THIS poll's request was issued
  // (captured in runSnapshotRequest, before the network call) — reproduced
  // and root-caused in test-work-state-poll-race-e2e.js. The failure mode
  // was never a missing publish: taskMutations.mjs's mutate() always
  // publishes the server's canonical response on success via
  // bridge.replaceTasks (work-state PUTs deliberately skip only the
  // OPTIMISTIC pre-response patch at taskMutations.mjs:200, for the reason
  // documented there — that decision is untouched by this fix). The bug was
  // a plain race: a poll request already in flight when a mutation's success
  // lands still carries the pre-mutation task, and if its response arrives
  // after, DashboardContext had nothing telling it that data was now stale,
  // so it overwrote the just-applied canonical task with the older one.
  //
  // The reconciliation below is read-side only: for each polled task, if a
  // CONFIRMED mutation (taskMutations.mjs's getLastMutationAt, written only
  // from a validated server response — never a client guess) landed after
  // this poll's request started, keep the task already in the local store
  // instead of the poll's now-stale copy. Every other task in the response —
  // the overwhelming majority on any real board — is unaffected and still
  // comes straight from the poll. This must not become a second optimistic
  // path: it never invents or predicts a value, it only prefers a
  // already-confirmed newer one the store already has over a response that
  // predates it.
  const reconcilePolledTasks = useCallback((tasks, requestStartedAt) => {
    if (!Array.isArray(tasks) || typeof requestStartedAt !== 'number') return tasks;
    let changed = false;
    const next = tasks.map((polledTask) => {
      const id = polledTask?.id;
      if (!id || getLastMutationAt(id) <= requestStartedAt) return polledTask;
      const local = bridge.getTasks().find((t) => t?.id === id);
      if (!local || local === polledTask) return polledTask;
      changed = true;
      return local;
    });
    return changed ? next : tasks;
  }, []);

  const commitPollSnapshot = useCallback((snapshot, requestStartedAt) => {
    const { projects, agents, activeProject, viewedProject } = snapshot;
    const tasks = reconcilePolledTasks(snapshot.tasks, requestStartedAt);
    const projectsJson = JSON.stringify(projects);
    const agentsJson = JSON.stringify(agents);
    const tasksJson = JSON.stringify(tasks);
    const projectsChanged = projectsJson !== prevProjectsRef.current
      || activeProject !== prevActiveRef.current
      || viewedProject !== window.appState?.viewedProject;
    const agentsChanged = agentsJson !== prevAgentsRef.current;
    const tasksChanged = tasksJson !== prevTasksRef.current;

    // Only a complete successful core snapshot clears a core failure; bootstrap
    // auth failures outrank it until /api/auth itself succeeds.
    markConnectionSuccess(projects, 'core');

    if (isUserInteracting() && !projectsChanged) return;

    if (projectsChanged || tasksChanged || agentsChanged) {
      prevProjectsRef.current = projectsJson;
      prevAgentsRef.current = agentsJson;
      prevActiveRef.current = activeProject;
      prevTasksRef.current = tasksJson;
      dispatch({ projects, agents, activeProject, viewedProject, tasks });
    }
  }, [dispatch, markConnectionSuccess, reconcilePolledTasks]);

  const runSnapshotRequest = useCallback((kind, { showRetrying = false } = {}) => {
    if (kind === 'poll') {
      // A lane-local cooldown prevents a 429 from turning the five-second
      // reconciliation loop into a retry storm. Auth failures stop polling
      // entirely until the shared auth state is cleared by /api/auth.
      if (isAuthHalted()) return Promise.resolve(false);
      if (coreCooldownUntilRef.current > Date.now()) return Promise.resolve(false);
    }
    const running = snapshotRequestRef.current.active;
    // React StrictMode deliberately replays mount effects in development. A
    // replayed initial load must replace the rehearsal request instead of
    // reusing it; otherwise an aborted/slow first request can hold the real
    // mount hostage until the response or poll interval arrives. Polls and
    // other non-retry callers still deduplicate against the active snapshot.
    if (running && kind !== 'retry' && kind !== 'initial') return running.promise;

    const generation = snapshotRequestRef.current.generation + 1;
    snapshotRequestRef.current.generation = generation;
    if (showRetrying) publishConnection(connectionLoading(connectionRef.current));

    return (async () => {
      // Replacement is network-serial, not only commit-serial: abort the old
      // request and wait until every sibling fetch has settled before launching.
      if (running) {
        running.controller.abort(new DOMException('Superseded by retry', 'AbortError'));
        await running.promise.catch(() => false);
        if (snapshotRequestRef.current.generation !== generation) return false;
        if (snapshotRequestRef.current.active === running) snapshotRequestRef.current.active = null;
      }

      const controller = new AbortController();
      const retryAuth = kind === 'retry'
        && (window.appState?.connection?.errorScope || connectionRef.current.errorScope) === 'auth';
      let authRecovered = false;
      let active;
      const request = (async () => {
        // T-454-7: captured before the network call — the moment this
        // specific poll started reading task state — so commitPollSnapshot
        // can tell whether a mutation's confirmed success landed while this
        // request was in flight (see reconcilePolledTasks above).
        const requestStartedAt = Date.now();
        try {
          const snapshot = await fetchDashboardSnapshot(controller.signal, {
            retryAuth,
            onAuthRecovered: () => { authRecovered = true; },
          });
          if (controller.signal.aborted
            || snapshotRequestRef.current.generation !== generation
            || snapshot.taskGeneration !== taskRequestRef.current.generation) return false;
          if (kind === 'poll') commitPollSnapshot(snapshot, requestStartedAt);
          else commitFullSnapshot(snapshot, retryAuth ? 'auth' : 'core');
          return true;
        } catch (error) {
          const superseded = controller.signal.aborted
            || snapshotRequestRef.current.generation !== generation
            || error?.kind === 'aborted'
            || error?.name === 'AbortError';
          if (!superseded) {
            const scope = error?.path === '/api/auth' ? 'auth' : 'core';
            if (isAuthenticationFailure(error)) {
              // apiFetch opens the shared breaker; retain this explicit call
              // for protocol/auth errors raised by a custom fetcher.
              markAuthHalted(error);
            }
            if (authRecovered && scope !== 'auth') {
              connectionRef.current = connectionScopeRecovery(
                connectionRef.current,
                window.appState?.projects || [],
                'auth',
              );
            }
            markConnectionFailure(error, `${kind === 'poll' ? 'Refresh' : 'Dashboard load'} error`, scope);
          }
          return false;
        } finally {
          if (snapshotRequestRef.current.active === active) snapshotRequestRef.current.active = null;
        }
      })();

      active = { generation, controller, promise: request, kind };
      snapshotRequestRef.current.active = active;
      return request;
    })();
  }, [commitFullSnapshot, commitPollSnapshot, fetchDashboardSnapshot, markConnectionFailure, publishConnection]);

  const startSnapshotRequest = useCallback((kind, { showRetrying = false } = {}) => {
    const projectSwitch = projectSwitchRef.current;
    if (!projectSwitch) return runSnapshotRequest(kind, { showRetrying });

    // A project switch owns the task lane, but it must not swallow a Retry.
    // Keep the visible retry state immediately and queue one complete core
    // snapshot behind the switch. The queued operation also follows a later
    // switch instead of starting a request against an obsolete project.
    if (kind === 'retry') {
      if (showRetrying) publishConnection(connectionLoading(connectionRef.current));
      if (queuedRetryRef.current) return queuedRetryRef.current;

      const queued = (async () => {
        let observedSwitch = projectSwitch;
        while (observedSwitch) {
          await observedSwitch.promise?.catch(() => false);
          if (unmountedRef.current) return false;
          observedSwitch = projectSwitchRef.current;
        }
        if (unmountedRef.current) return false;
        return runSnapshotRequest('retry');
      })().finally(() => {
        if (queuedRetryRef.current === queued) queuedRetryRef.current = null;
      });
      queuedRetryRef.current = queued;
      return queued;
    }

    // Polling and task-only refreshes are already represented by the switch;
    // reusing its promise avoids a second task request while navigation owns
    // the lane.
    return projectSwitch.promise || Promise.resolve(false);
  }, [publishConnection, runSnapshotRequest]);

  const invalidateSnapshotRequest = useCallback(async (reason) => {
    const running = snapshotRequestRef.current.active;
    snapshotRequestRef.current.generation += 1;
    if (!running) return;
    running.controller.abort(new DOMException(reason, 'AbortError'));
    await running.promise.catch(() => false);
    if (snapshotRequestRef.current.active === running) snapshotRequestRef.current.active = null;
  }, []);

  const loadDashboardSnapshot = useCallback(() => (
    startSnapshotRequest('initial')
  ), [startSnapshotRequest]);

  const retryConnection = useCallback(() => (
    startSnapshotRequest('retry', { showRetrying: true })
  ), [startSnapshotRequest]);

  const refreshProjectsOnly = useCallback(() => (
    startSnapshotRequest('retry')
  ), [startSnapshotRequest]);

  const refreshTasks = useCallback(async (projectOverride = null, options = {}) => {
    const project = projectOverride
      || window.appState?.viewedProject
      || window.appState?.activeProject;
    if (!project) return null;

    // viewProject owns publication while navigation is pending. Same-target
    // callers reuse it; stale callbacks captured by the former project vanish.
    const projectSwitch = projectSwitchRef.current;
    if (projectSwitch) {
      return projectSwitch.name === project
        ? (projectSwitch.promise || null)
        : null;
    }

    const currentProject = window.appState?.viewedProject || window.appState?.activeProject;
    if (currentProject !== project) return null;

    try {
      const result = await fetchCoordinatedTasks(project, 'Board refresh', options);
      const latestProject = window.appState?.viewedProject || window.appState?.activeProject;
      if (result === null
        || result.generation !== taskRequestRef.current.generation
        || latestProject !== project
        || projectSwitchRef.current) return null;
      bridge.replaceTasks(result.tasks);
      prevTasksRef.current = JSON.stringify(result.tasks);
      markConnectionSuccess(window.appState?.projects || [], 'tasks');
      return result.tasks;
    } catch (error) {
      if (error?.kind !== 'aborted' && error?.name !== 'AbortError') {
        markConnectionFailure(error, 'Board refresh error', 'tasks');
      }
      return null;
    }
  }, [fetchCoordinatedTasks, markConnectionFailure, markConnectionSuccess]);

  const viewProject = useCallback((name) => {
    if (!name) return Promise.resolve(null);

    const pending = { name, promise: null };
    projectSwitchRef.current = pending;
    pending.promise = (async () => {
      await invalidateSnapshotRequest(`Project changed to ${name}`);
      if (projectSwitchRef.current !== pending) return null;

      try {
        const result = await fetchCoordinatedTasks(name, 'viewProject');
        if (result === null
          || result.generation !== taskRequestRef.current.generation
          || projectSwitchRef.current !== pending) return null;
        prevTasksRef.current = JSON.stringify(result.tasks);
        dispatch({ viewedProject: name, tasks: result.tasks });
        markConnectionSuccess(window.appState?.projects || [], 'tasks');
        return result.tasks;
      } catch (error) {
        if (projectSwitchRef.current === pending
          && error?.kind !== 'aborted'
          && error?.name !== 'AbortError') {
          markConnectionFailure(error, 'viewProject error', 'tasks');
        }
        return null;
      }
    })().finally(() => {
      if (projectSwitchRef.current === pending) projectSwitchRef.current = null;
    });
    return pending.promise;
  }, [dispatch, fetchCoordinatedTasks, invalidateSnapshotRequest, markConnectionFailure, markConnectionSuccess]);

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

    const installed = bridge.installRefreshBridge(refreshTasks);

    return () => {
      uninstallToast();
      backdrop?.removeEventListener('click', onBackdropClick);
      bridge.uninstallRefreshBridge(installed);
    };
  }, [toggleSidebar, refreshTasks]);

  // Initial fetch — runs once after window.appState bootstrap is in place.
  useEffect(() => {
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

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      projectSwitchRef.current = null;
      queuedRetryRef.current = null;
      snapshotRequestRef.current.generation += 1;
      snapshotRequestRef.current.active?.controller.abort(new DOMException('Dashboard unmounted', 'AbortError'));
      snapshotRequestRef.current.active = null;
      taskRequestRef.current.generation += 1;
      taskRequestRef.current.active?.controller.abort(new DOMException('Dashboard unmounted', 'AbortError'));
      taskRequestRef.current.active = null;
    };
  }, []);

  const value = useMemo(() => ({
    state,
    viewProject,
    activateProject,
    deactivateProject,
    switchTab,
    toggleSidebar,
    refreshProjectsOnly,
    refreshTasks,
    retryConnection,
    openSpec,
    applyTelegramTheme: applyTelegramThemeImpl,
    haptic,
    hapticNotification,
  }), [state, viewProject, activateProject, deactivateProject, switchTab, toggleSidebar, refreshProjectsOnly, refreshTasks, retryConnection, openSpec]);

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
