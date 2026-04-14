import { useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppState } from '../context/AppStateContext.jsx';
import { formatDisplayName } from '../utils.js';
import Button from './Button.jsx';

export default function Sidebar() {
  const { state } = useAppState();
  const [container, setContainer] = useState(null);

  useLayoutEffect(() => {
    const el = document.getElementById('sidebar');
    if (el) {
      el.innerHTML = '';
      setContainer(el);
    }
  }, []);

  if (!container || !state) return null;

  const { projects, viewedProject, activeProject } = state;

  function handleViewProject(name) {
    window._viewProject?.(name);
  }

  function handleActivate() {
    window._activateProject?.();
  }

  function handleDeactivate() {
    window._deactivateProject?.();
  }

  const showActivate = viewedProject && viewedProject !== activeProject;
  const showDeactivate = viewedProject && viewedProject === activeProject;

  return createPortal(
    <>
      <div className="text-[10px] uppercase tracking-[0.05em] text-muted font-semibold mb-2">Projects</div>
      <div id="projectList">
        {projects.length === 0 ? (
          <div className="text-muted text-xs p-3 text-center">No projects</div>
        ) : (
          projects.map(p => {
            const isActive = p.name === activeProject;
            const isViewed = p.name === viewedProject;
            const openCount = (p.taskCounts?.open || 0) + (p.taskCounts?.['in-progress'] || 0);
            return (
              <div
                key={p.name}
                className={[
                  'flex items-center justify-between px-3.5 py-2 rounded-lg text-[13px] font-medium text-muted cursor-pointer transition-all border border-transparent mb-0.5 hover:bg-bg-hover hover:text-text-strong',
                  isViewed && 'bg-accent-subtle text-text-strong',
                  isActive && 'border-accent text-text-strong shadow-[0_0_12px_rgba(255,92,92,.15)]',
                  isActive && isViewed && 'shadow-[0_0_12px_rgba(255,92,92,.15),inset_0_1px_0_rgba(255,92,92,.1)]',
                ].filter(Boolean).join(' ')}
                onClick={() => handleViewProject(p.name)}
              >
                <span>{formatDisplayName(p.name, projects)}</span>
                {openCount > 0 && <span className="bg-bg-elevated rounded-full px-2 py-0.5 text-[11px] font-medium text-muted">{openCount}</span>}
              </div>
            );
          })
        )}
      </div>
      <div className="mt-3 pt-3 border-t border-border" id="sidebarActions">
        {showActivate && (
          <Button
            variant="accent"
            size="sm"
            className="w-full"
            onClick={handleActivate}
          >
            Activate
          </Button>
        )}
        {showDeactivate && (
          <Button
            variant="secondary"
            size="sm"
            className="w-full"
            onClick={handleDeactivate}
          >
            Deactivate
          </Button>
        )}
      </div>
    </>,
    container
  );
}
