import { useEffect, useMemo, useState } from 'react';
import { ReactGridLayout, useContainerWidth, verticalCompactor } from 'react-grid-layout';
import { GripVertical, Pencil, Plus, X } from 'lucide-react';
import Button from '../components/Button.jsx';
import Modal from '../components/Modal.jsx';
import { useAppState } from '../context/AppStateContext.jsx';
import { WIDGET_REGISTRY } from '../components/overview/registry.js';
import 'react-grid-layout/css/styles.css';
import '../../styles/overview.css';

/**
 * OverviewView (T-305) — the per-project landing page. Server-driven UI:
 * GET /api/projects/:name/overview returns the layout (or the default
 * preset); the renderer instantiates only trusted-registry types on the
 * 12-column grid (88px rows, 12px gutter).
 *
 * One react-grid-layout renderer serves view AND edit mode (visual
 * parity); editing enables header-drag and corner-resize (w×h chip) with
 * dynamic vertical compaction. Narrow viewports render a read-only
 * single-column stack. Save writes the same overview.json schema agents
 * use via PUT.
 */
export default function OverviewView() {
  const { state } = useAppState();
  const project = state?.viewedProject;
  const [overview, setOverview] = useState(null);
  const [error, setError] = useState(null);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(null); // widgets array while editing
  const [manifest, setManifest] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [resizing, setResizing] = useState(null); // { id, w, h } during resize
  const [saving, setSaving] = useState(false);

  const { width, containerRef, mounted } = useContainerWidth();

  useEffect(() => {
    if (!project) return;
    let alive = true;
    setOverview(null);
    setError(null);
    setEditing(false);
    setDraft(null);
    fetch(`/api/projects/${project}/overview`, { credentials: 'include' })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(d => { if (alive) setOverview(d.overview); })
      .catch(e => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [project]);

  const knownWidgets = useMemo(
    () => (overview?.widgets || []).filter(w => WIDGET_REGISTRY[w.type]),
    [overview]
  );

  function enterEdit() {
    setDraft(knownWidgets.map(w => ({ ...w, grid: { ...w.grid }, ...(w.props ? { props: { ...w.props } } : {}) })));
    setEditing(true);
    if (!manifest) {
      fetch('/api/overview/widgets', { credentials: 'include' })
        .then(r => r.json())
        .then(setManifest)
        .catch(() => {});
    }
  }

  function cancelEdit() {
    setEditing(false);
    setDraft(null);
    setResizing(null);
  }

  function applyLayout(layout) {
    setDraft(prev => prev?.map(w => {
      const item = layout.find(l => l.i === w.id);
      return item ? { ...w, grid: { x: item.x, y: item.y, w: item.w, h: item.h } } : w;
    }) || prev);
  }

  function removeWidget(id) {
    setDraft(prev => prev.filter(w => w.id !== id));
  }

  function addWidget(type) {
    const def = (manifest?.widgets || []).find(w => w.type === type);
    const size = def?.defaultSize || { w: 4, h: 2 };
    setDraft(prev => {
      const maxY = prev.reduce((m, w) => Math.max(m, w.grid.y + w.grid.h), 0);
      let id = `w-${type}`;
      let n = 2;
      while (prev.some(w => w.id === id)) id = `w-${type}-${n++}`;
      return [...prev, { id, type, grid: { x: 0, y: maxY, w: size.w, h: size.h } }];
    });
    setPickerOpen(false);
  }

  async function saveLayout() {
    setSaving(true);
    try {
      const res = await fetch(`/api/projects/${project}/overview`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ version: 1, layout: 'grid', widgets: draft }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        window.showToast?.(data.error || 'Saving the layout failed', 'error');
        return;
      }
      setOverview(data.overview);
      setEditing(false);
      setDraft(null);
      window.showToast?.('Layout saved', 'success');
    } catch (e) {
      window.showToast?.(e.message, 'error');
    } finally {
      setSaving(false);
    }
  }

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

  const skipped = (overview.widgets || []).length - knownWidgets.length;
  const widgets = editing ? draft : knownWidgets;
  const sorted = widgets.slice().sort((a, b) => a.grid.y - b.grid.y || a.grid.x - b.grid.x);

  return (
    <div className="flex flex-col h-full min-h-0 px-1">
      <div className="ov-toolbar">
        <span className="ov-toolbar-note">
          {editing
            ? 'Editing layout — drag widgets by their header, pull a corner to resize'
            : overview.source === 'default'
              ? 'Default layout — your agent can compose this page via the overview API'
              : overview.preset
                ? `Preset: ${overview.preset}`
                : 'Custom layout'}
          {!editing && skipped > 0 ? ` · ${skipped} unknown widget(s) skipped` : ''}
        </span>
        {editing ? (
          <>
            <Button variant="ghost" size="sm" onClick={() => setPickerOpen(true)}>
              <Plus size={13} /> Add widget
            </Button>
            <Button variant="secondary" size="sm" onClick={cancelEdit} disabled={saving}>Cancel</Button>
            <Button size="sm" onClick={saveLayout} disabled={saving}>{saving ? 'Saving…' : 'Save layout'}</Button>
          </>
        ) : (
          <Button variant="ghost" size="sm" className="max-md:hidden" onClick={enterEdit}>
            <Pencil size={13} /> Edit layout
          </Button>
        )}
      </div>

      <div ref={containerRef} className="flex-1 min-h-0 overflow-y-auto">
        {/* View mode: fluid CSS grid — widgets track the container width
            seamlessly (container queries do the rest) and stack on narrow
            viewports. Edit mode: react-grid-layout for drag/resize; the
            edit chrome overlays the cell so cards render identically. */}
        {!editing ? (
          <div className="ov-grid">
            {sorted.map(w => {
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
        ) : mounted ? (
          <ReactGridLayout
            width={width}
            layout={sorted.map(w => {
              const min = (manifest?.widgets || []).find(m => m.type === w.type)?.minSize || { w: 2, h: 1 };
              return { i: w.id, x: w.grid.x, y: w.grid.y, w: w.grid.w, h: w.grid.h, minW: min.w, minH: min.h };
            })}
            gridConfig={{ cols: 12, rowHeight: 88, margin: [12, 12], containerPadding: [0, 0] }}
            dragConfig={{ enabled: true, handle: '.ov-whead' }}
            resizeConfig={{ enabled: true, handles: ['se', 'sw', 'ne', 'nw'] }}
            compactor={verticalCompactor}
            onLayoutChange={applyLayout}
            onResize={(layout, oldItem, newItem) => setResizing({ id: newItem.i, w: newItem.w, h: newItem.h })}
            onResizeStop={() => setResizing(null)}
            className="ov-rgl editing"
          >
            {sorted.map(w => {
              const Widget = WIDGET_REGISTRY[w.type];
              return (
                <div key={w.id} className="ov-cell">
                  <Widget widget={w} editing />
                  {/* edit chrome — overlays the card, never shifts its layout */}
                  <span className="ov-edit-grip" title="Drag by the header to move">
                    <GripVertical size={11} />
                  </span>
                  <button
                    type="button"
                    className="ov-edit-x"
                    title="Remove widget"
                    aria-label={`Remove ${w.type} widget`}
                    onClick={() => removeWidget(w.id)}
                  >
                    <X size={11} />
                  </button>
                  {resizing?.id === w.id && (
                    <span className="ov-sizechip" style={{ zIndex: 10 }}>{`w ${resizing.w} · h ${resizing.h}`}</span>
                  )}
                </div>
              );
            })}
          </ReactGridLayout>
        ) : null}
      </div>

      <Modal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title="Add widget"
        size="md"
        showClose
      >
        <div className="flex flex-col gap-1">
          {(manifest?.widgets || []).map(w => (
            <button
              key={w.type}
              type="button"
              onClick={() => addWidget(w.type)}
              className="flex flex-col gap-0.5 w-full px-3 py-2 text-left rounded-md border border-transparent bg-transparent cursor-pointer hover:bg-bg-hover hover:border-border"
            >
              <span className="text-sm font-medium text-text-strong">{w.label}</span>
              <span className="text-[11px] text-muted">{w.description}</span>
            </button>
          ))}
          {!manifest && <span className="text-sm text-muted px-3 py-2">Loading widget catalog…</span>}
        </div>
      </Modal>
    </div>
  );
}
