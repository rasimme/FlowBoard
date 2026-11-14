/**
 * FlowBoard native Control UI entry (T-515).
 *
 * Mounts the dashboard's own React app as the Control UI page. The app is the
 * same code as the standalone dashboard; only two things differ here: API
 * calls travel through the Gateway (ADR-0042), and the host supplies the page
 * header and the theme.
 *
 * Two smaller surfaces reuse the same transport and styles (T-515-6): the
 * "Needs me" dashboard widget and the task panel beside a session. Both link
 * into the page with `project` / `task` parameters.
 *
 * This file is compiled by scripts/build-native-ui.mjs before
 * `openclaw plugins build` sees it.
 */
import { createRoot } from 'react-dom/client';
import { defineControlUiPlugin } from 'openclaw/plugin-sdk/control-ui';
import { createFeatureClient } from 'openclaw/plugin-sdk/feature-contract';
import { contract } from '../contract.js';
import { readPageParams } from '../control-ui/lib/deep-link.js';
import { createGatewayTransport } from './gateway-transport.js';
import NeedsMeView from './views/NeedsMeView.jsx';
import TaskPanelView from './views/TaskPanelView.jsx';
import { mountDashboard } from '../../dashboard/src/mount.jsx';
import { setApiTransport } from '../../dashboard/src/utils/apiFetch.js';
import { requestDeepLink } from '../../dashboard/src/utils/deepLink.js';

const PLUGIN_ID = 'flowboard';
const PAGE_ID = 'flowboard';
export const WIDGET_ID = 'needs-me';
export const PANEL_ID = 'task';
const ROOT_CLASS = 'fb-native-root';
const NEEDS_ME_LIMIT = 40;

/**
 * Bind this connection's Gateway-verified operator profile (ADR-0040). Per
 * connection, so it is redone after a reconnect.
 */
function createIdentityBinder(host) {
  let pending = null;
  const ensure = () => {
    if (!pending) pending = Promise.resolve().then(() => host.request('flowboard.ui.identity', {})).catch(() => null);
    return pending;
  };
  const unsubscribe = host.subscribe?.(() => {
    if (!host.connection?.connected) pending = null;
    else void ensure();
  });
  return { ensure, dispose: () => unsubscribe?.() };
}

function linkFromProps(props) {
  const { project, task } = readPageParams(props);
  if (project) requestDeepLink({ project, task });
}

function mountPage(container, context, transport) {
  const root = document.createElement('div');
  root.className = ROOT_CLASS;
  container.replaceChildren(root);
  linkFromProps(context.props);

  let handle = null;
  let disposed = false;
  mountDashboard(root, { transport, hostChrome: true }).then(
    (mounted) => {
      handle = mounted;
      if (disposed) mounted.dispose();
    },
    (error) => {
      root.textContent = `FlowBoard could not start: ${error?.message || error}`;
    },
  );
  return {
    update: (next) => linkFromProps(next?.props),
    dispose() {
      disposed = true;
      handle?.dispose();
      // The widget and the panel outlive the page and share the transport.
      setApiTransport(transport);
      root.remove();
    },
  };
}

/** A small React view in its own scoped root (widget, panel). */
function mountView(container, context, render) {
  const root = document.createElement('div');
  root.className = `${ROOT_CLASS} fb-native-view`;
  container.replaceChildren(root);
  const reactRoot = createRoot(root);
  const draw = (current) => reactRoot.render(render(current));
  draw(context);
  return {
    update: draw,
    dispose() {
      reactRoot.unmount();
      root.remove();
    },
  };
}

export default defineControlUiPlugin({
  id: PLUGIN_ID,
  activate(host) {
    const identity = createIdentityBinder(host);
    void identity.ensure();
    const transport = createGatewayTransport((method, params) => host.request(method, params));
    setApiTransport(transport);
    const feature = createFeatureClient(contract, host);

    const openInPage = (project, task) => {
      const params = { project };
      if (task) params.task = task;
      host.navigation?.openPage?.({ id: PAGE_ID, params });
    };
    const watchNeedsMe = (onChange, onError) => {
      let stop = () => {};
      let cancelled = false;
      identity.ensure().then(() => {
        if (cancelled) return;
        try {
          stop = feature.watch('tasks.needing-me', { limit: NEEDS_ME_LIMIT }, {
            events: ['tasks-changed', 'projects-changed'],
            onChange,
            onError,
          });
        } catch (error) {
          onError(error instanceof Error ? error : new Error(String(error)));
        }
      });
      return () => { cancelled = true; stop(); };
    };
    const onTasksChanged = (listener) => {
      try { return feature.on('tasks-changed', listener); } catch { return () => {}; }
    };

    const disposers = [
      host.ui.registerNavigation({ id: PAGE_ID, label: 'FlowBoard', page: { id: PAGE_ID }, icon: 'kanban' }),
      host.ui.registerPage({
        id: PAGE_ID,
        label: 'FlowBoard',
        mount: (container, context) => mountPage(container, context, transport),
      }),
      host.ui.registerWidget({
        id: WIDGET_ID,
        label: 'FlowBoard: needs me',
        mount: (container, context) => mountView(container, context, () => (
          <NeedsMeView watch={watchNeedsMe} onOpen={openInPage} />
        )),
      }),
      host.ui.registerPanel({
        id: PANEL_ID,
        label: 'FlowBoard task',
        mount: (container, context) => mountView(container, context, (current) => (
          <TaskPanelView
            session={{ agentId: current?.props?.agentId, sessionKey: current?.props?.sessionKey }}
            subscribe={onTasksChanged}
            onOpen={openInPage}
          />
        )),
      }),
      host.ui.registerAction({
        id: 'open-task-panel',
        label: 'FlowBoard task',
        placement: 'header',
        run: (context) => host.ui.openPanel(PANEL_ID, { sessionKey: context.sessionKey, agentId: context.agentId }),
      }),
    ];

    return () => {
      identity.dispose();
      for (const dispose of disposers) dispose?.();
      setApiTransport(null);
    };
  },
});
