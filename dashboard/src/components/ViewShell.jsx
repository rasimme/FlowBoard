import { useLayoutEffect, useState, useRef, Suspense } from 'react';
import { createPortal } from 'react-dom';
import { useAppState } from '../context/AppStateContext.jsx';
import { getView } from '../config/views.js';

/**
 * ViewShell — migration boundary for per-view rendering.
 *
 * For legacy-owned views: renders nothing (vanilla switchTab populates #content).
 * For react-owned views: renders the component from the view registry into #content.
 *
 * This is the single place to plug in future React views.
 */
export default function ViewShell() {
  const { state } = useAppState();
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

  const currentTab = state?.currentTab || 'tasks';
  const view = getView(currentTab);
  const isReactOwned = view?.owner === 'react';

  // When switching FROM a React view TO a legacy view, clear #content
  // so legacy render has a clean slate
  useLayoutEffect(() => {
    if (prevOwnerRef.current === 'react' && !isReactOwned && container) {
      container.innerHTML = '';
    }
    prevOwnerRef.current = isReactOwned ? 'react' : 'legacy';
  }, [currentTab, isReactOwned, container]);

  // Legacy views: don't render anything — vanilla code manages #content
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
