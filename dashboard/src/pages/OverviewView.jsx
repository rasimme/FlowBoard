import { useEffect, useMemo, useRef, useState } from 'react';
import { ReactGridLayout, verticalCompactor } from 'react-grid-layout';
import { LayoutTemplate, Pencil, Plus, X, Users, Crosshair, OctagonAlert, CheckCheck, History, ListTodo, Target, BarChart3, FileText, Link2, Kanban, Activity, Flag, GanttChartSquare, Pin, Upload, StickyNote, ExternalLink, Coffee, GitBranch, GitPullRequest, Workflow, Rocket, CircleDot, HelpCircle } from 'lucide-react';

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
  'quick-links': { icon: Link2, short: 'Quick actions' },
  'milestones': { icon: Flag, short: 'Milestones' },
  'timeline': { icon: GanttChartSquare, short: 'Timeline' },
  'context-index': { icon: Pin, short: 'Context' },
  'quick-drop': { icon: Upload, short: 'Drop' },
  'notes': { icon: StickyNote, short: 'Notes' },
  'links': { icon: ExternalLink, short: 'Links' },
  'stall-detection': { icon: Coffee, short: 'Momentum' },
  'file-viewer': { icon: FileText, short: 'File' },
  'repo-status': { icon: GitBranch, short: 'Repo' },
  'gh-pulls': { icon: GitPullRequest, short: 'PRs' },
  'gh-ci': { icon: Workflow, short: 'CI' },
  'gh-releases': { icon: Rocket, short: 'Releases' },
  'gh-issues': { icon: CircleDot, short: 'Issues' },
  'agent-questions': { icon: HelpCircle, short: 'Questions' },
};

// add-widget picker: catalog grouped by concept cluster
const PICKER_CLUSTERS = [
  { label: 'Needs you', types: ['blocked', 'approvals', 'agent-questions', 'since-last-visit'] },
  { label: 'Live', types: ['current-focus', 'active-agents', 'activity-stream', 'timeline', 'stall-detection'] },
  { label: 'Direction', types: ['next-up', 'project-goals', 'task-stats', 'milestones', 'kanban-mini'] },
  { label: 'GitHub', types: ['repo-status', 'gh-pulls', 'gh-ci', 'gh-releases', 'gh-issues'] },
  { label: 'Knowledge & actions', types: ['recent-decisions', 'context-index', 'file-viewer', 'quick-drop', 'notes', 'links', 'quick-links'] },
];
import Button from '../components/Button.jsx';
import Modal from '../components/Modal.jsx';
import { useAppState } from '../context/AppStateContext.jsx';
import { WIDGET_REGISTRY } from '../components/overview/registry.js';
import { apiFetch } from '../utils/apiFetch.js';
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
  const pinnedCard = useRef(null); // card pinned via inline styles during a resize
  // RGL's latest compacted layout — the on-screen truth. The draft only
  // updates on drag/resize stop, so compaction that happened without an
  // explicit interaction (e.g. after a remove) was lost on save.
  const liveLayout = useRef(null);
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
    apiFetch(`/api/projects/${project}/overview`)
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
    // stable child order for the whole edit session — re-sorting mid-
    // interaction made every card jump (feedback round)
    const ordered = knownWidgets.slice().sort((a, b) => a.grid.y - b.grid.y || a.grid.x - b.grid.x);
    setDraft(ordered.map(w => ({ ...w, grid: { ...w.grid }, ...(w.props ? { props: { ...w.props } } : {}) })));
    setDraftPreset(overview?.preset || null);
    liveLayout.current = null;
    setEditing(true);
    if (!manifest) {
      apiFetch('/api/overview/widgets')
        .then(r => r.json())
        .then(setManifest)
        .catch(() => {});
    }
  }

  function cancelEdit() {
    setEditing(false);
    setDraft(null);
    setResizing(null);
    liveLayout.current = null;
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

  // first free slot scanning top-to-bottom, left-to-right — completes a
  // half-filled row on the right before starting a new one
  function findFreeSlot(widgets, w, h) {
    const collides = (x, y) => widgets.some(it =>
      x < it.grid.x + it.grid.w && x + w > it.grid.x &&
      y < it.grid.y + it.grid.h && y + h > it.grid.y);
    const maxY = widgets.reduce((m, it) => Math.max(m, it.grid.y + it.grid.h), 0);
    for (let y = 0; y <= maxY; y++) {
      for (let x = 0; x + w <= 12; x++) {
        if (!collides(x, y)) return { x, y };
      }
    }
    return { x: 0, y: maxY };
  }

  function addWidget(type) {
    const def = (manifest?.widgets || []).find(w => w.type === type);
    const size = def?.defaultSize || { w: 4, h: 2 };
    setDraft(prev => {
      const slot = findFreeSlot(prev, size.w, size.h);
      let id = `w-${type}`;
      let n = 2;
      while (prev.some(w => w.id === id)) id = `w-${type}-${n++}`;
      return [...prev, { id, type, grid: { x: slot.x, y: slot.y, w: size.w, h: size.h } }];
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
    // persist what the user SEES: merge RGL's compacted positions into the
    // draft — otherwise gaps closed by compaction reappeared after save
    let widgets = draft;
    if (liveLayout.current) {
      widgets = draft.map(w => {
        const item = liveLayout.current.find(l => l.i === w.id);
        return item ? { ...w, grid: { x: item.x, y: item.y, w: item.w, h: item.h } } : w;
      });
    }
    try {
      const res = await apiFetch(`/api/projects/${project}/overview`, {
        method: 'PUT',
        body: JSON.stringify({ version: 1, layout: 'grid', ...(draftPreset ? { preset: draftPreset, widgets } : { widgets }) }),
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
  // view mode sorts for the CSS grid; edit mode keeps the draft's stable order
  const sorted = editing
    ? draft
    : knownWidgets.slice().sort((a, b) => a.grid.y - b.grid.y || a.grid.x - b.grid.x);

  return (
    <div className="flex flex-col h-full min-h-0 px-1">
      <div className="ov-toolbar max-w-[1500px] mx-auto w-full">
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

      {/* the scroll surface spans the full window width so the wheel works
          in the side gutters too; the content itself stays capped */}
      <div className="flex-1 min-h-0 overflow-y-auto pt-[9px] pr-[9px] pb-[10px] pl-[4px]">
        <div ref={setContainerEl} className="max-w-[1500px] mx-auto w-full">
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
                  className={'ov-cell' + (w.props?.emphasis ? ' ov-emph' : '')}
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
            resizeConfig={{ enabled: true, handles: ['e', 's', 'w'] }}
            compactor={verticalCompactor}
            onLayoutChange={(layout) => { liveLayout.current = layout; }}
            onDragStop={(layout) => applyLayout(layout)}
            onResizeStart={(layout, oldItem, newItem, placeholder, e) => {
              // pin the card via inline styles for the whole interaction —
              // inline survives RGL's class churn at mouse-up, so the card
              // never flashes to the cursor size before the commit renders.
              const item = e?.target?.closest?.('.react-grid-item');
              const card = item?.querySelector?.('.ov-widget');
              if (card) {
                pinnedCard.current = card;
                card.style.flex = 'none';
                // anchor side is fixed from the grabbed handle: west resizes
                // keep the right edge put
                if (e?.target?.closest?.('.react-resizable-handle-w')) {
                  card.style.position = 'absolute';
                  card.style.right = '0';
                  card.style.top = '0';
                }
              }
            }}
            onResize={(layout, oldItem, newItem) => {
              // clamp to the type's minimum — RGL can report transient
              // sub-minimum values that pinned the card to a zero box
              const type = draft?.find(d => d.id === newItem.i)?.type;
              const min = (manifest?.widgets || []).find(m => m.type === type)?.minSize || { w: 1, h: 1 };
              const w = Math.max(newItem.w, min.w);
              const h = Math.max(newItem.h, min.h);
              const atMin = newItem.w <= min.w || newItem.h <= min.h;
              setResizing({ id: newItem.i, w, h });
              // RGL v2 merges our cell INTO the grid item (verified via
              // browser probe) and writes the continuous size onto it.
              // We pin the CARD (.ov-widget) to the snapped step instead,
              // via variables on the non-RGL container.
              const colW = (width - 12 * 11) / 12;
              if (pinnedCard.current) {
                pinnedCard.current.style.width = Math.round(colW * w + 12 * (w - 1)) + 'px';
                pinnedCard.current.style.height = (88 * h + 12 * (h - 1)) + 'px';
              }
              // the size label inside RGL's memoized subtree lags React
              // state mid-interaction — a CSS-driven live label replaces it;
              // at the minimum it flips to "w × h · min" and tints accent
              containerEl?.style.setProperty('--ov-snap-label', JSON.stringify(w + ' \u00d7 ' + h + (atMin ? ' \u00b7 min' : '')));
              containerEl?.classList.toggle('ov-min-reached', atMin);
            }}
            onResizeStop={(layout) => {
              containerEl?.classList.remove('ov-min-reached');
              applyLayout(layout);
              setResizing(null);
              containerEl?.style.removeProperty('--ov-snap-label');
              // suppress RGL's 200ms width/height transition while settling —
              // otherwise the item animates from the cursor size to the
              // committed size and the card visibly wanders after release
              containerEl?.classList.add('ov-settle');
              setTimeout(() => containerEl?.classList.remove('ov-settle'), 300);
              // release the inline pin only AFTER the committed layout has
              // rendered — otherwise the card flashes to the cursor size
              const card = pinnedCard.current;
              pinnedCard.current = null;
              requestAnimationFrame(() => requestAnimationFrame(() => {
                if (!card) return;
                card.style.width = '';
                card.style.height = '';
                card.style.flex = '';
                card.style.position = '';
                card.style.right = '';
                card.style.top = '';
              }));
            }}
            className={'ov-rgl editing' + (animReady ? '' : ' ov-no-anim')}
          >
            {sorted.map(w => {
              const Widget = WIDGET_REGISTRY[w.type];
              return (
                <div key={w.id} className={'ov-cell' + (w.props?.emphasis ? ' ov-emph' : '')}>
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
                  <span className="ov-fin-size">{w.grid.w} × {w.grid.h}</span>
                </div>
              );
            })}
          </ReactGridLayout>
        ) : null}
        </div>
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
            // while editing, the applied-but-unsaved choice is the active one
            const isActive = (editing ? draftPreset : overview?.preset) === p.name;
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
        size="lg"
        showClose
      >
        <div className="max-h-[60vh] overflow-y-auto pr-1 flex flex-col gap-4">
          {manifest ? PICKER_CLUSTERS.map(cluster => {
            const entries = cluster.types
              .map(t => (manifest.widgets || []).find(w => w.type === t))
              .filter(Boolean);
            if (entries.length === 0) return null;
            return (
              <div key={cluster.label}>
                <div className="text-[10px] uppercase tracking-wider font-semibold text-muted mb-1.5">{cluster.label}</div>
                <div className="grid grid-cols-2 gap-1.5">
                  {entries.map(w => {
                    const t = THUMB[w.type] || {};
                    const Icon = t.icon;
                    const onBoard = (draft || []).some(d => d.type === w.type);
                    return (
                      <button
                        key={w.type}
                        type="button"
                        onClick={() => addWidget(w.type)}
                        title={w.description}
                        className="flex items-start gap-2.5 px-3 py-2 min-h-[62px] text-left rounded-md border border-border bg-bg-accent cursor-pointer hover:border-accent"
                      >
                        {Icon && <Icon size={15} className="text-muted shrink-0 mt-0.5" />}
                        <span className="flex flex-col gap-0.5 min-w-0">
                          <span className="text-[12.5px] font-medium text-text-strong leading-tight">
                            {w.label}
                            {onBoard && <span className="ml-1.5 text-[9px] uppercase tracking-wide text-accent-2">on board</span>}
                          </span>
                          <span className="text-[10.5px] text-muted leading-snug overflow-hidden" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{w.description}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          }) : <span className="text-sm text-muted px-3 py-2">Loading widget catalog…</span>}
        </div>
      </Modal>
    </div>
  );
}
