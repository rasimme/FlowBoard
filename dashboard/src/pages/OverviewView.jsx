import { useEffect, useState } from 'react';
import { useAppState } from '../context/AppStateContext.jsx';
import { WIDGET_REGISTRY } from '../components/overview/registry.js';
import '../../styles/overview.css';

/**
 * OverviewView (T-305) — the per-project landing page. Server-driven UI:
 * GET /api/projects/:name/overview returns the layout (or the default
 * preset); the renderer walks the widget list and instantiates only
 * registry types on a 12-column CSS grid. Edit mode (drag/resize) lands
 * with T-305-5 — agents can already rearrange via PUT.
 */
export default function OverviewView() {
  const { state } = useAppState();
  const project = state?.viewedProject;
  const [overview, setOverview] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!project) return;
    let alive = true;
    setOverview(null);
    setError(null);
    fetch(`/api/projects/${project}/overview`, { credentials: 'include' })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(d => { if (alive) setOverview(d.overview); })
      .catch(e => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [project]);

  if (!project) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted">
        Select a project to see its overview.
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-danger">
        Overview failed to load: {error}
      </div>
    );
  }
  if (!overview) return null;

  const widgets = (overview.widgets || []).filter(w => WIDGET_REGISTRY[w.type]);
  const skipped = (overview.widgets || []).length - widgets.length;

  return (
    <div className="flex flex-col h-full min-h-0 px-1">
      <div className="ov-toolbar">
        <span className="ov-toolbar-note">
          {overview.source === 'default'
            ? 'Default layout — your agent can compose this page via the overview API'
            : overview.preset
              ? `Preset: ${overview.preset}`
              : 'Custom layout'}
          {skipped > 0 ? ` · ${skipped} unknown widget(s) skipped` : ''}
        </span>
      </div>
      <div className="ov-grid" style={{ overflowY: 'auto' }}>
        {widgets
          .slice()
          .sort((a, b) => a.grid.y - b.grid.y || a.grid.x - b.grid.x)
          .map(w => {
            const Widget = WIDGET_REGISTRY[w.type];
            return (
              <div
                key={w.id}
                className="ov-cell"
                style={{
                  gridColumn: `${w.grid.x + 1} / span ${w.grid.w}`,
                  gridRow: `${w.grid.y + 1} / span ${w.grid.h}`,
                }}
              >
                <Widget widget={w} />
              </div>
            );
          })}
      </div>
    </div>
  );
}
