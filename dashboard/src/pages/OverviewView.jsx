import { useEffect, useMemo, useState } from 'react';
import { ReactGridLayout, verticalCompactor } from 'react-grid-layout';
import { LayoutTemplate, Pencil, Plus, X, Users, Crosshair, OctagonAlert, CheckCheck, History, ListTodo, Target, BarChart3, FileText, Link2, Kanban, Activity } from 'lucide-react';

// thumbnail metadata: icon, short label and cluster tint per widget type
const THUMB = {
  'blocked': { icon: OctagonAlert, short: 'Blocked' },
  'approvals': { icon: CheckCheck, short: 'Approvals' },
  'since-last-visit': { icon: History, short: 'Since visit' },
  'current-focus': { icon: Crosshair, short: 'Focus' },
  'active-agents': { icon: Users, short: 'Agents' },
  'activity-stream': { icon: Activity, short: 'Activity' },
  'next-up': { icon: ListTodo, short: 'Next up' },
  'project-goals': { icon: Target, short: 'Goal' },
  'task-stats': { icon: BarChart3, short: 'Stats' },
  'recent-decisions': { icon: FileText, short: 'Decisions' },
  'kanban-mini': { icon: Kanban, short: 'Board' },
  'quick-links': { icon: Link2, short: 'Links' },
};
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
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [draftPreset, setDraftPreset] = useState(null); // preset name while the draft is untouched
  const [resizing, setResizing] = useState(null); // { id, w, h } during resize
  const [saving, setSaving] = useState(false);
  // suppress RGL's mount animation — items would visibly fly to their
  // position when edit mode opens
  const [animReady, setAnimReady] = useState(false);
  useEffect(() => {
    if (!editing) { setAnimReady(false); return; }
    const t = setTimeout(() => setAnimReady(true), 150);
    return () => clearTimeout(t);
  }, [editing]);

  // Own width tracking: a ResizeObserver on the scroll container keeps the
  // edit grid in lockstep with the window/sidebar. A callback ref (state)
  // is required — the container mounts AFTER the data loads, so a plain
  // useRef + mount effect would observe nothing and the grid stayed empty.
  const [containerEl, setContainerEl] = useState(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!containerEl) return;
    const ro = new ResizeObserver(entries => {
      const w = Math.floor(entries[0]?.contentRect?.width || 0);
      if (w) setWidth(w);
    });
    ro.observe(containerEl);
    setWidth(Math.floor(containerEl.clientWidth));
    return () => ro.disconnect();
  }, [containerEl]);
  const mounted = width > 0;

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
    setDraftPreset(overview?.preset || null);
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
    setDraft(prev => {
      if (!prev) return prev;
      let changed = false;
      const next = prev.map(w => {
        const item = layout.find(l => l.i === w.id);
        if (!item) return w;
        const g = w.grid;
        if (g.x !== item.x || g.y !== item.y || g.w !== item.w || g.h !== item.h) changed = true;
        return { ...w, grid: { x: item.x, y: item.y, w: item.w, h: item.h } };
      });
      if (changed) setDraftPreset(null);
      return next;
    });
  }

  function removeWidget(id) {
    setDraftPreset(null);
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

  function applyPreset(preset) {
    // replaces the draft only — the edit grid itself becomes the live
    // preview; Save persists, Cancel restores the previous layout
    setDraft(preset.widgets.map(w => ({ ...w, grid: { ...w.grid }, ...(w.props ? { props: { ...w.props } } : {}) })));
    setDraftPreset(preset.name);
    setPresetsOpen(false);
    window.showToast?.(`Preview: ${preset.label} — Save to keep it`, 'info');
  }

  async function saveLayout() {
    setSaving(true);
    try {
      const res = await fetch(`/api/projects/${project}/overview`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ version: 1, layout: 'grid', ...(draftPreset ? { preset: draftPreset, widgets: draft } : { widgets: draft }) }),
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
            ? 'Editing layout — drag a card by its hatched title row, pull an edge bar to resize'
            : overview.source === 'default'
              ? 'Default layout — your agent can compose this page via the overview API'
              : overview.preset
                ? `Preset: ${overview.preset}`
                : 'Custom layout'}
          {!editing && skipped > 0 ? ` · ${skipped} unknown widget(s) skipped` : ''}
        </span>
        {editing ? (
          <>
            <Button variant="ghost" size="sm" onClick={() => setPresetsOpen(true)}>
              <LayoutTemplate size={13} /> Presets
            </Button>
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

      <div ref={setContainerEl} className="flex-1 min-h-0 overflow-y-auto pt-[9px] pr-[9px] pb-[10px] pl-[4px]">
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
            resizeConfig={{ enabled: true, handles: ['n', 'e', 's', 'w'] }}
            compactor={verticalCompactor}
            onLayoutChange={applyLayout}
            onResize={(layout, oldItem, newItem, placeholder, e, handleEl) => {
              setResizing({ id: newItem.i, w: newItem.w, h: newItem.h });
              // Pin the CARD to the snapped grid step while RGL's item box
              // follows the cursor. We write directly to our own cell div
              // (neither React nor RGL touch it mid-interaction), located
              // deterministically from the resize handle in the event.
              const cell = (handleEl?.closest ? handleEl : e?.target)?.closest?.('.react-grid-item')?.querySelector?.(':scope > .ov-cell');
              if (cell) {
                const colW = (width - 12 * 11) / 12;
                cell.style.width = Math.round(colW * newItem.w + 12 * (newItem.w - 1)) + 'px';
                cell.style.height = (88 * newItem.h + 12 * (newItem.h - 1)) + 'px';
                cell.dataset.ovSnapped = '1';
              }
            }}
            onResizeStop={() => {
              setResizing(null);
              // release all pinned cells back to layout-driven sizing
              containerEl?.querySelectorAll('[data-ov-snapped]').forEach(cell => {
                cell.style.width = '';
                cell.style.height = '';
                delete cell.dataset.ovSnapped;
              });
            }}
            className={'ov-rgl editing' + (animReady ? '' : ' ov-no-anim')}
          >
            {sorted.map(w => {
              const Widget = WIDGET_REGISTRY[w.type];
              return (
                <div key={w.id} className="ov-cell">
                  <Widget widget={w} editing />
                  {/* edit chrome — overlays the card, never shifts its layout */}
                  <button
                    type="button"
                    className="ov-edit-x"
                    title="Remove widget"
                    aria-label={`Remove ${w.type} widget`}
                    onClick={() => removeWidget(w.id)}
                  >
                    <X size={11} />
                  </button>
                  <span className="ov-fin-size">
                    {(resizing?.id === w.id ? resizing.w : w.grid.w)} × {(resizing?.id === w.id ? resizing.h : w.grid.h)}
                  </span>
                </div>
              );
            })}
          </ReactGridLayout>
        ) : null}
      </div>

      <Modal
        open={presetsOpen}
        onClose={() => setPresetsOpen(false)}
        title="Layout presets"
        size="lg"
        showClose
      >
        <div className="grid grid-cols-2 gap-2">
          {(manifest?.presets || []).map(p => {
            const rows = Math.max(...p.widgets.map(w => w.grid.y + w.grid.h), 1);
            const isActive = overview?.preset === p.name;
            return (
              <button
                key={p.name}
                type="button"
                onClick={() => applyPreset(p)}
                className={`flex flex-col gap-2 p-3 text-left rounded-lg border cursor-pointer bg-bg-accent hover:border-accent ${
                  isActive ? 'border-accent' : 'border-border'
                }`}
              >
                {/* schematic thumbnail generated from the preset's grid coords */}
                <div
                  className="relative w-full rounded-md bg-bg overflow-hidden"
                  style={{ aspectRatio: `12 / ${rows}`, minHeight: 64 }}
                  aria-hidden="true"
                >
                  {p.widgets.map(w => {
                    const t = THUMB[w.type] || {};
                    const Icon = t.icon;
                    const showLabel = w.grid.w >= 4;
                    return (
                      <span
                        key={w.id}
                        className="absolute rounded-[3px] border border-border-strong flex items-center justify-center gap-1 overflow-hidden"
                        style={{
                          left: `${(w.grid.x / 12) * 100}%`,
                          top: `${(w.grid.y / rows) * 100}%`,
                          width: `calc(${(w.grid.w / 12) * 100}% - 3px)`,
                          height: `calc(${(w.grid.h / rows) * 100}% - 3px)`,
                          margin: '1.5px',
                          background: 'var(--bg-elevated)',
                        }}
                        title={t.short || w.type}
                      >
                        {Icon && <Icon size={10} className="text-muted shrink-0" />}
                        {showLabel && (
                          <span className="text-[8.5px] leading-none text-muted whitespace-nowrap overflow-hidden text-ellipsis">
                            {t.short || w.type}
                          </span>
                        )}
                      </span>
                    );
                  })}
                </div>
                <span className="text-sm font-medium text-text-strong">
                  {p.label}
                  {isActive && <span className="ml-2 text-[10px] text-accent uppercase tracking-wide">active</span>}
                </span>
                <span className="text-[11px] text-muted leading-snug">{p.description}</span>
              </button>
            );
          })}
          {!manifest && <span className="text-sm text-muted px-3 py-2 col-span-2">Loading presets…</span>}
        </div>
      </Modal>

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
