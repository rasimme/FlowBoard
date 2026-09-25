// T-499 F1 — embed-mode runtime (browser side of src/embed/embedMode.mjs).
//
// initEmbedMode() runs once from bootstrap.js before React. When embed mode is
// not active it returns null and every getEmbed() caller keeps its standalone
// code path unchanged. When active, the controller below is the only place
// that talks to the host window.

import {
  coalesceOutbound,
  hostSurfaceForTab,
  isTrustedHostEvent,
  parseHostMessage,
  postToHost,
  resolveEmbedConfig,
} from './embedMode.mjs';
import { getState } from '../state/appStore.mjs';

let controller; // undefined = not resolved yet, null = standalone

function currentProject() {
  const state = getState();
  return state?.viewedProject || null;
}

function createController(config) {
  const hostOrigin = config.hostOrigin;
  const parentWindow = window.parent;
  let state = { surface: config.surface, specifyClosed: null };
  const listeners = new Set();
  let outbound = [];
  let flushScheduled = false;
  let readySent = false;

  const emit = () => listeners.forEach((listener) => listener());
  const setState = (patch) => {
    state = { ...state, ...patch };
    emit();
  };

  const flush = () => {
    flushScheduled = false;
    const batch = coalesceOutbound(outbound);
    outbound = [];
    for (const { kind, payload } of batch) postToHost(parentWindow, hostOrigin, kind, payload);
  };

  // Standalone navigation often issues two intents in one handler (switch to
  // Tasks, then scroll to a task). Collect one synchronous burst and send the
  // coalesced result.
  const send = (kind, payload) => {
    outbound.push({ kind, payload });
    if (!flushScheduled) {
      flushScheduled = true;
      queueMicrotask(flush);
    }
  };

  return {
    config,
    hostOrigin,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot() { return state; },
    surface() { return state.surface; },
    setSurface(surface) {
      if (surface === state.surface) return;
      document.documentElement.setAttribute('data-fb-embed', surface);
      setState({ surface, specifyClosed: null });
    },
    sendReady() {
      if (readySent) return;
      readySent = true;
      send('ready', { surface: state.surface, project: currentProject() });
    },
    // DashboardContext.switchTab
    requestTab(tab) {
      const surface = hostSurfaceForTab(tab);
      if (!surface || surface === state.surface) return;
      send('open-surface', { surface, project: currentProject() });
    },
    // DashboardContext.openSpec
    openSpec(file) {
      send('open-surface', { surface: 'files', project: currentProject(), file });
    },
    // NavigationContext.goToTask + window.openTaskDetail
    openTask(task, project = currentProject()) {
      send('open-task', { project, task });
    },
    // Sidebar project click
    openProject(project) {
      send('open-project', { project });
    },
    // SpecifyContext hide / complete
    // `completed` only drives the frame's own closed state; the host hears
    // the first created task (if any).
    specifyClosed({ completed = false, tasks = [], project = currentProject() } = {}) {
      setState({ specifyClosed: { completed: completed === true } });
      const task = Array.isArray(tasks) && tasks.length > 0 ? tasks[0] : undefined;
      send('specify-closed', { project, task });
    },
    resetSpecify() {
      if (state.specifyClosed) setState({ specifyClosed: null });
    },
    // host -> frame: only `context` from the verified parent + origin.
    onHostMessage(handler) {
      const listener = (event) => {
        if (!isTrustedHostEvent(event, { parent: parentWindow, hostOrigin })) return;
        const msg = parseHostMessage(event.data);
        if (msg) handler(msg);
      };
      window.addEventListener('message', listener);
      return () => window.removeEventListener('message', listener);
    },
  };
}

/** Resolve embed mode once. Returns the controller or null (standalone). */
export function initEmbedMode() {
  if (controller !== undefined) return controller;
  controller = null;
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;
  let config = null;
  try {
    config = resolveEmbedConfig(window.location.search, {
      isFramed: window.top !== window.self,
      allowList: window.__FLOWBOARD_FRAME_ANCESTORS__,
      ancestorOrigins: window.location.ancestorOrigins || null,
    });
  } catch {
    config = null;
  }
  const root = document.documentElement;
  if (!config) {
    // The inline index.html marker is a first-paint hint only; this module is
    // authoritative.
    root.removeAttribute('data-fb-embed');
    return null;
  }
  root.setAttribute('data-fb-embed', config.surface);
  controller = createController(config);
  return controller;
}

/** The active embed controller, or null in standalone mode. */
export function getEmbed() {
  return controller || null;
}
