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
      <div className="sidebar-label">Projects</div>
      <div id="projectList">
        {projects.length === 0 ? (
          <div className="sidebar-empty">No projects</div>
        ) : (
          projects.map(p => {
            const isActive = p.name === activeProject;
            const isViewed = p.name === viewedProject;
            const openCount = (p.taskCounts?.open || 0) + (p.taskCounts?.['in-progress'] || 0);
            let cls = 'project-item';
            if (isActive) cls += ' agent-active';
            if (isViewed) cls += ' viewed';
            return (
              <div
                key={p.name}
                className={cls}
                onClick={() => handleViewProject(p.name)}
              >
                <span>{formatDisplayName(p.name, projects)}</span>
                {openCount > 0 && <span className="project-badge">{openCount}</span>}
              </div>
            );
          })
        )}
      </div>
      <div className="sidebar-actions" id="sidebarActions">
        {showActivate && (
          <Button
            variant="primary"
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
