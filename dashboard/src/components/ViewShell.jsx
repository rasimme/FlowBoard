import { useLayoutEffect, useEffect, useState, useRef, Suspense } from 'react';
import { createPortal } from 'react-dom';
import { useAppState } from '../context/AppStateContext.jsx';
import { useDashboard } from '../context/DashboardContext.jsx';
import { getView } from '../config/views.js';

export default function ViewShell() {
  const { state } = useAppState();
  const { applyTelegramTheme } = useDashboard();
  const [container, setContainer] = useState(null);
  const prevOwnerRef = useRef(null);

  useLayoutEffect(() => {
    const el = document.getElementById('content');
    if (el) setContainer(el);
  }, []);

  useLayoutEffect(() => {
    const path = window.location.pathname;
    if (path === '/design-test') {
      window.dispatchEvent(new CustomEvent('appstate:change', {
        detail: { currentTab: 'design' }
      }));
    }
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

  const currentTab = state?.currentTab || 'tasks';
  const view = getView(currentTab);
  const isReactOwned = view?.owner === 'react';

  // Mirror the active tab onto the .app element so CSS can scope per-view styles.
  useEffect(() => {
    const app = document.querySelector('.app');
    if (app) app.setAttribute('data-view', currentTab);
  }, [currentTab]);

  useLayoutEffect(() => {
    if (!container) return;
    const wasLegacy = prevOwnerRef.current === 'legacy';
    if (wasLegacy && isReactOwned) {
      const legacyChildren = container.querySelectorAll('.canvas-wrap');
      legacyChildren.forEach(el => el.remove());
    }
    if (prevOwnerRef.current === 'react' && !isReactOwned) {
      container.innerHTML = '';
    }
    prevOwnerRef.current = isReactOwned ? 'react' : 'legacy';
  }, [currentTab, isReactOwned, container]);

  // Legacy ideas tab: lazy-load and render the canvas into #content.
  // Lives here (not in DashboardContext) so the import only fires on demand.
  useEffect(() => {
    if (!container) return;
    if (currentTab !== 'ideas') return;
    let cancelled = false;
    const id = setTimeout(async () => {
      if (cancelled) return;
      if (container.querySelector('.canvas-wrap')) return;
      try {
        const mod = await import('../../js/canvas/index.js');
        if (cancelled) return;
        mod.renderIdeaCanvas?.(window.appState);
      } catch (err) {
        console.warn('[ideas-canvas]', err);
      }
    }, 50);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [currentTab, container, state?.viewedProject]);

  if (!container || !state || !isReactOwned) return null;

  const ViewComponent = view.component;
  if (!ViewComponent) return null;

  return createPortal(
    <Suspense fallback={<div className="p-6 text-sm text-muted">Loading...</div>}>
      <ViewComponent />
    </Suspense>,
    container
  );
}
