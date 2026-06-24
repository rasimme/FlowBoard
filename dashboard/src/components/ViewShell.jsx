import { useLayoutEffect, useEffect, useState, Suspense } from 'react';
import { createPortal } from 'react-dom';
import { useAppState } from '../context/AppStateContext.jsx';
import { useDashboard } from '../context/DashboardContext.jsx';
import { getView } from '../config/views.js';

export default function ViewShell() {
  const { state } = useAppState();
  const { applyTelegramTheme } = useDashboard();
  const [container, setContainer] = useState(null);

  useLayoutEffect(() => {
    const el = document.getElementById('content');
    if (el) setContainer(el);
  }, []);

  // Telegram theme: apply once on mount and re-apply on themeChanged events.
  useEffect(() => {
    applyTelegramTheme();
    const tg = window.Telegram?.WebApp;
    if (tg?.onEvent && tg?.offEvent) {
      tg.onEvent('themeChanged', applyTelegramTheme);
      return () => tg.offEvent('themeChanged', applyTelegramTheme);
    }
    return undefined;
  }, [applyTelegramTheme]);

  const currentTab = state?.currentTab || 'overview';
  const view = getView(currentTab);

  // Mirror the active tab onto the .app element so CSS can scope per-view styles.
  useEffect(() => {
    const app = document.querySelector('.app');
    if (app) app.setAttribute('data-view', currentTab);
  }, [currentTab]);

  if (!container || !state) return null;

  const ViewComponent = view?.component;
  if (!ViewComponent) return null;

  return createPortal(
    <Suspense fallback={<div className="p-6 text-sm text-muted">Loading...</div>}>
      <ViewComponent />
    </Suspense>,
    container
  );
}
