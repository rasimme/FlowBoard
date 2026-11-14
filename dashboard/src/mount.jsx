/**
 * Mount the dashboard into an arbitrary element (T-515-2).
 *
 * The standalone page keeps using main.jsx against index.html's markup. A host
 * page (the native OpenClaw Control UI) calls this instead: it builds the
 * shell frame inside `root`, points shell and portal lookups at it, installs
 * the host's API transport, and only then loads the app, because bootstrap.js
 * has import-time side effects (the store proxy and the first identity
 * resolution).
 *
 * One dashboard per document: the store is module state.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { setApiTransport } from './utils/apiFetch.js';
import { setPortalRoot } from './utils/portalRoot.js';
import { buildShell, setShell } from './utils/shell.js';

const OWNED_GLOBALS = ['openTaskDetail', '_detailQueue', 'showToast'];

export async function mountDashboard(root, { transport = null, hostChrome = false } = {}) {
  buildShell(root, { header: !hostChrome });
  setShell(root, { hostChrome });
  setPortalRoot(root.querySelector('#modalRoot'));
  setApiTransport(transport);

  await import('./bootstrap.js');
  const { default: App } = await import('./App.jsx');
  const reactRoot = createRoot(root.querySelector('#react-root'));
  reactRoot.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );

  return {
    dispose() {
      try { reactRoot.unmount(); } catch { /* already gone */ }
      setApiTransport(null);
      setPortalRoot(null);
      setShell(null);
      for (const name of OWNED_GLOBALS) {
        try { delete window[name]; } catch { /* non-configurable in a host */ }
      }
      root.replaceChildren();
    },
  };
}
