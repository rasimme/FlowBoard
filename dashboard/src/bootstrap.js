// Bootstrap-only: install the window.appState store Proxy and run Telegram
// WebApp auth + agentId resolution. Imported FIRST by src/main.jsx so the store
// exists before any React code runs; the React tree owns all UI and data
// fetching via DashboardContext.
//
// window.__flowboardBootstrap is a Promise the React shell awaits before its
// first /api/* fetch so agentId is populated when the session is Telegram-backed.

import { resolveDashboardAgentIdentity } from './utils/projectSelection.mjs';
import { installAppStateProxy } from './state/appStore.mjs';
import { connectionFailure } from './state/connectionState.mjs';
import { authenticateTelegram } from './utils/dashboardApi.js';
import { markAuthHalted } from './state/authState.mjs';

// window.appState is now a Proxy over the React-owned store (appStore.mjs). The
// auth/agentId writes below go through it and notify React automatically.
installAppStateProxy();

let resolveBootstrap;
window.__flowboardBootstrap = new Promise((r) => { resolveBootstrap = r; });
window.__flowboardBootstrapReady = false;

const tg = window.Telegram?.WebApp;

// Route external links through Telegram so they open in the platform browser.
document.addEventListener('click', (e) => {
  const link = e.target.closest('a[href]');
  if (!link) return;
  const href = link.href;
  if (tg && href.startsWith('http') && !href.includes(window.location.hostname)) {
    e.preventDefault();
    tg.openLink(href);
  }
});

function applyDashboardIdentity(authAgentId = null) {
  const identity = resolveDashboardAgentIdentity({
    urlSearch: window.location.search,
    telegramWebApp: tg,
    authAgentId,
    storedAgentId: localStorage.getItem('flowboard_agent_id'),
  });
  window.appState.agentId = identity.agentId;
  window.appState.agentIdSource = identity.source;
  window.appState.agentIdChatBound = identity.chatBound;
  if (identity.agentId) {
    try { localStorage.setItem('flowboard_agent_id', identity.agentId); } catch { /* ignore */ }
  }
  return identity;
}

function describeAuthError(error) {
  return {
    // The API returns stable T-441 codes. Keep a safe fallback for network,
    // timeout, and malformed-response failures that have no server code.
    code: error?.code || (error?.kind === 'protocol' ? 'AUTH_RESPONSE_INVALID' : 'AUTH_REQUEST_FAILED'),
    message: error?.message || 'Authentication failed.',
  };
}

async function authenticateDashboard(signal) {
  if (!tg?.initData) {
    window.appState.authError = null;
    window.appState.bootstrapAuthError = null;
    return applyDashboardIdentity();
  }

  const authData = await authenticateTelegram(tg.initData, signal);
  window.appState.bootstrapAuthError = null;
  window.appState.authError = null;
  window.appState.authUser = authData.user.username || null;
  applyDashboardIdentity(authData.agentId);
  return authData;
}

// DashboardContext uses the same function for an explicit Retry after an auth
// failure. This keeps /api/auth validation and identity writes in one owner.
window.__flowboardAuthenticate = authenticateDashboard;

(async () => {
  try {
    if (tg?.initData) {
      tg.ready();
      tg.expand();
      tg.disableVerticalSwipes?.();
    }
    // The no-auth dashboard path only resolves URL/local identity and is
    // synchronous in practice. Keep that path visible to the first React
    // effect so React StrictMode can rehearse and restart its initial network
    // request instead of postponing the rehearsal until after cleanup.
    if (tg?.initData) await authenticateDashboard();
    else authenticateDashboard();
  } catch (error) {
    const authError = describeAuthError(error);
    console.warn(`Auth failed (${authError.code}):`, authError.message);
    window.appState.authError = authError;
    window.appState.bootstrapAuthError = error;
    if (error?.status === 401 || error?.status === 403) markAuthHalted(error);
    window.appState.connection = connectionFailure(window.appState.connection, error, 'auth');
    window.appState.authUser = null;
    // Keep the non-auth fallback identity available for the local-first core
    // snapshot, but never treat it as proof that the Telegram exchange worked.
    applyDashboardIdentity();
  } finally {
    window.__flowboardBootstrapReady = true;
    // Notify React explicitly so authUser/agentId/connection propagate without
    // relying on a polling watchdog (T-356).
    try { window.dispatchEvent(new CustomEvent('appstate:change')); } catch { /* non-DOM env */ }
    resolveBootstrap();
  }
})();
