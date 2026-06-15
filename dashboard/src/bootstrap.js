// Bootstrap-only: initialise window.appState shape and run Telegram WebApp
// auth + agentId resolution. Imported FIRST by src/main.jsx so the shape
// exists before any React code runs; the React tree owns all UI and data
// fetching via DashboardContext.
//
// window.__flowboardBootstrap is a Promise the React shell awaits before its
// first /api/* fetch so agentId is populated when the session is Telegram-backed.

import { resolveDashboardAgentIdentity } from './utils/projectSelection.mjs';

window.appState = {
  projects: [],
  activeProject: null,
  viewedProject: null,
  tasks: [],
  currentTab: 'overview',
  agents: [],
  agentId: null,
  agentIdSource: null,
  agentIdChatBound: false,
};

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

(async () => {
  try {
    if (tg?.initData) {
      tg.ready();
      tg.expand();
      tg.disableVerticalSwipes?.();
      try {
        const authRes = await fetch('/api/auth', {
          method: 'POST',
          headers: { 'X-Telegram-Init-Data': tg.initData },
          credentials: 'include',
        });
        const authData = await authRes.json().catch(() => null);
        if (authData?.user?.username) window.appState.authUser = authData.user.username;
        const identity = resolveDashboardAgentIdentity({
          urlSearch: window.location.search,
          telegramWebApp: tg,
          authAgentId: authData?.agentId,
          storedAgentId: localStorage.getItem('flowboard_agent_id'),
        });
        window.appState.agentId = identity.agentId;
        window.appState.agentIdSource = identity.source;
        window.appState.agentIdChatBound = identity.chatBound;
      } catch (e) {
        console.warn('Auth failed:', e);
      }
    } else {
      const identity = resolveDashboardAgentIdentity({
        urlSearch: window.location.search,
        telegramWebApp: tg,
        storedAgentId: localStorage.getItem('flowboard_agent_id'),
      });
      window.appState.agentId = identity.agentId;
      window.appState.agentIdSource = identity.source;
      window.appState.agentIdChatBound = identity.chatBound;
    }
    if (window.appState.agentId) {
      try { localStorage.setItem('flowboard_agent_id', window.appState.agentId); } catch { /* ignore */ }
    }
  } finally {
    // Notify React explicitly so authUser/agentId propagate without relying on a
    // polling watchdog (T-356). These writes happen after React mounts, so an
    // event is the propagation path; DashboardContext's first post-bootstrap
    // dispatch also picks them up, this just makes it intentional + immediate.
    try { window.dispatchEvent(new CustomEvent('appstate:change')); } catch { /* non-DOM env */ }
    resolveBootstrap();
  }
})();
