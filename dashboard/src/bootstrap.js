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

// window.appState is now a Proxy over the React-owned store (appStore.mjs). The
// auth/agentId writes below go through it and notify React automatically.
installAppStateProxy();

let resolveBootstrap;
window.__flowboardBootstrap = new Promise((r) => { resolveBootstrap = r; });

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

async function authenticateDashboard(signal) {
  if (!tg?.initData) return applyDashboardIdentity();

  const authData = await authenticateTelegram(tg.initData, signal);
  window.appState.bootstrapAuthError = null;
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
    await authenticateDashboard();
  } catch (error) {
    console.warn('Auth failed:', error);
    window.appState.bootstrapAuthError = error;
    window.appState.connection = connectionFailure(window.appState.connection, error, 'auth');
    // Resolve a safe fallback identity without pretending authentication worked.
    applyDashboardIdentity();
  } finally {
    // Notify React explicitly so authUser/agentId/connection propagate without
    // relying on a polling watchdog (T-356).
    try { window.dispatchEvent(new CustomEvent('appstate:change')); } catch { /* non-DOM env */ }
    resolveBootstrap();
  }
})();
