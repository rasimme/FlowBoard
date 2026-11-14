/**
 * FlowBoard native Control UI entry (T-515).
 *
 * Mounts the dashboard's own React app as the Control UI page. The app is the
 * same code as the standalone dashboard; only two things differ here: API
 * calls travel through the Gateway (ADR-0042), and the host supplies the page
 * header and the theme.
 *
 * This file is compiled by scripts/build-native-ui.mjs before
 * `openclaw plugins build` sees it.
 */
import { defineControlUiPlugin } from 'openclaw/plugin-sdk/control-ui';
import { createGatewayTransport } from './gateway-transport.js';
import { mountDashboard } from '../../dashboard/src/mount.jsx';

const PLUGIN_ID = 'flowboard';
const PAGE_ID = 'flowboard';
const ROOT_CLASS = 'fb-native-root';

function mountPage(container, context) {
  const root = document.createElement('div');
  root.className = ROOT_CLASS;
  container.replaceChildren(root);

  let handle = null;
  let disposed = false;
  const transport = createGatewayTransport((method, params) => context.host.request(method, params));
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
    dispose() {
      disposed = true;
      handle?.dispose();
      root.remove();
    },
  };
}

export default defineControlUiPlugin({
  id: PLUGIN_ID,
  activate(host) {
    const disposers = [
      host.ui.registerNavigation({ id: PAGE_ID, label: 'FlowBoard', page: { id: PAGE_ID }, icon: 'kanban' }),
      host.ui.registerPage({ id: PAGE_ID, label: 'FlowBoard', mount: mountPage }),
    ];
    return () => {
      for (const dispose of disposers) dispose?.();
    };
  },
});
