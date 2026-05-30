// Bootstrap-only: initialise window.appState shape and run Telegram WebApp
// auth + agentId resolution. The React tree (src/main.jsx) owns all UI and
// data fetching via DashboardContext.
//
// window.__flowboardBootstrap is a Promise the React shell awaits before its
// first /api/* fetch so agentId is populated when the session is Telegram-backed.

import { resolveDashboardAgentId } from './project-selection.mjs';

window.appState = {
  projects: [],
  activeProject: null,
  viewedProject: null,
  tasks: [],
  canvasNotes: [],
  canvasConnections: [],
  currentTab: 'tasks',
  agents: [],
  agentId: null,
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
        window.appState.agentId = resolveDashboardAgentId({
          urlSearch: window.location.search,
          telegramWebApp: tg,
          authAgentId: authData?.agentId,
          storedAgentId: localStorage.getItem('flowboard_agent_id'),
        });
      } catch (e) {
        console.warn('Auth failed:', e);
      }
    } else {
      window.appState.agentId = resolveDashboardAgentId({
        urlSearch: window.location.search,
        telegramWebApp: tg,
        storedAgentId: localStorage.getItem('flowboard_agent_id'),
      });
    }
    if (window.appState.agentId) {
      try { localStorage.setItem('flowboard_agent_id', window.appState.agentId); } catch { /* ignore */ }
    }
  } finally {
    resolveBootstrap();
  }
})();
