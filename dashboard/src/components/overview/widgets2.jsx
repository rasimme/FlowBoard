import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Flag, ExternalLink, Upload, FileText, Pin, Sun, Coffee, Moon, Play, Plus, Save, GitBranch, GitPullRequest, KeyRound, Pencil, Trash2, X, Check } from 'lucide-react';
import { OvWidget } from './widgets.jsx';
import ScrollArea from '../ScrollArea.jsx';
import { useAppState } from '../../context/AppStateContext.jsx';
import { useDashboard } from '../../context/DashboardContext.jsx';
import { useNavigation } from '../../context/NavigationContext.jsx';
import { refreshTasks } from '../../state/appStateBridge.mjs';
import { apiFetch } from '../../utils/apiFetch.js';
import { posToOffset, resolveSelection, estimateColumn } from '../../utils/notesLocate.mjs';

const MarkdownEditor = lazy(() => import('../MarkdownEditor.jsx'));
const MarkdownPreview = lazy(() => import('../MarkdownPreview.jsx'));

/**
 * Overview widget catalog v2 (T-308) — milestones, timeline, context-index,
 * quick-drop, notes, links, stall-detection. Design: claude-design-t305
 * (dash-widgets2/3), implemented with restrained color use.
 */

function useGoTab() {
  const { dispatch } = useAppState();
  const { switchTab } = useDashboard();
  return (tab) => {
    dispatch({ currentTab: tab });
    if (tab === 'ideas') switchTab(tab);
  };
}

function Empty({ icon: Icon, title, hint }) {
  return (
    <div className="ov-empty">
      {Icon && <Icon size={22} />}
      <span className="ov-empty-title">{title}</span>
      <span className="ov-empty-hint">{hint}</span>
    </div>
  );
}

// persist a widget's props into overview.json — the same write path
// agents use; local widget state keeps the UI fresh until the next mount
export async function persistWidgetProps(project, widgetId, mutate) {
  const cur = await apiFetch(`/api/projects/${project}/overview`)
    .then(r => (r.ok ? r.json() : null));
  const ov = cur?.overview;
  const target = (ov?.widgets || []).find(w => w.id === widgetId);
  if (!target) return null;
  target.props = mutate(target.props || {});
  delete ov.source;
  const res = await apiFetch(`/api/projects/${project}/overview`, {
    method: 'PUT',
    body: JSON.stringify(ov),
  });
  return res.ok ? target.props : null;
}

/**
 * T-320 — inline GitHub token entry. The token is stored server-side
 * (write-only; GET only reports whether one exists) and applies to every
 * gh-* widget at once. Hidden as soon as a token is configured.
 */
export function TokenAffordance({ editing, onSaved }) {
  const [state, setState] = useState(null); // { set, source }
  const [open, setOpen] = useState(false);
  const [val, setVal] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let alive = true;
    apiFetch('/api/settings/github-token')
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (alive) setState(d); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  if (!state || state.set) return null;

  async function save() {
    if (!val.trim() || saving) return;
    setSaving(true);
    try {
      const res = await apiFetch('/api/settings/github-token', {
        method: 'PUT',
        body: JSON.stringify({ token: val.trim() }),
      });
      if (res.ok) {
        setState({ set: true });
        setVal(''); setOpen(false);
        window.showToast?.('GitHub token saved — applies to all GitHub widgets', 'success');
        onSaved?.();
      } else {
        const d = await res.json().catch(() => ({}));
        window.showToast?.(d.error || 'Saving token failed', 'error');
      }
    } finally {
      setSaving(false);
    }
  }

  return open ? (
    <div className="lk-add">
      <input className="lk-in" type="password" placeholder="GitHub token (read-only PAT)" value={val} autoFocus
        onChange={e => setVal(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setOpen(false); }}
        disabled={editing} />
      <button type="button" className="lk-btn" onClick={save} disabled={editing || saving || !val.trim()}>
        {saving ? '…' : 'Save'}
      </button>
    </div>
  ) : (
    <button type="button" className="gh-token-toggle" onClick={() => setOpen(true)} disabled={editing}>
      <KeyRound size={11} /> Add a GitHub token — private repos &amp; higher rate limit
    </button>
  );
}

/**
 * T-328 — project-level GitHub binding shared by every gh-* widget.
 * Connecting/changing it in ONE widget updates all of them (window event);
 * widget props.repo/props.branch remain as per-widget overrides.
 */
const _ghBinding = new Map(); // project → { repo, branch } | null
export function useProjectGithub(project) {
  const [binding, setBinding] = useState(() => _ghBinding.get(project) ?? null);
  useEffect(() => {
    if (!project) return;
    let alive = true;
    if (_ghBinding.has(project)) setBinding(_ghBinding.get(project));
    apiFetch(`/api/projects/${project}/github`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (!d) return; _ghBinding.set(project, d.github); if (alive) setBinding(d.github); })
      .catch(() => {});
    const onChange = e => { if (e.detail?.project === project) setBinding(e.detail.github); };
    window.addEventListener('fb:github-binding', onChange);
    return () => { alive = false; window.removeEventListener('fb:github-binding', onChange); };
  }, [project]);

  async function saveBinding(repo, branch) {
    const res = await apiFetch(`/api/projects/${project}/github`, {
      method: 'PUT',
      body: JSON.stringify({ repo, ...(branch ? { branch } : {}) }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      window.showToast?.(d.error || 'Saving GitHub binding failed', 'error');
      return false;
    }
    const d = await res.json();
    _ghBinding.set(project, d.github);
    window.dispatchEvent(new CustomEvent('fb:github-binding', { detail: { project, github: d.github } }));
    return true;
  }
  return { binding, saveBinding };
}

function useActivityFeed(project, limit) {
  const [items, setItems] = useState(null);
  useEffect(() => {
    if (!project) return;
    let alive = true;
    apiFetch(`/api/projects/${project}/activity?limit=${limit}`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (alive) setItems(d?.activity || []); })
      .catch(() => { if (alive) setItems([]); });
    return () => { alive = false; };
  }, [project, limit]);
  return items;
}

/* ---------- milestones: tasks tagged milestone:<name> ---------- */
function Ring({ pct, size = 54 }) {
  const r = size / 2 - 5;
  const c = 2 * Math.PI * r;
  return (
    <span className="ms-ring" style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--secondary)" strokeWidth="5" />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--chart-1)" strokeWidth="5"
          strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - pct / 100)} />
      </svg>
      <span className="pct">{pct}</span>
    </span>
  );
}

// T-315: milestones are tasks tagged milestone:<name> — the widget can
// create and manage them directly. Drilldown = definition-of-done
// checklist (checkmarks come from task status, tasks ARE the items).
async function putTaskTags(project, taskId, tags) {
  const res = await apiFetch(`/api/projects/${project}/tasks/${taskId}`, {
    method: 'PUT',
    body: JSON.stringify({ tags }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `PUT ${taskId} failed`);
}

function MsTaskPicker({ tasks, excludeIds, busy, confirmLabel, onConfirm, onCancel }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(() => new Set());
  const candidates = tasks
    .filter(t => !excludeIds.has(t.id))
    .filter(t => !q || `${t.id} ${t.title}`.toLowerCase().includes(q.toLowerCase()))
    .slice(0, 50);
  return (
    <div className="msp">
      <input className="lk-in" placeholder="Filter tasks…" value={q} onChange={e => setQ(e.target.value)} />
      <ScrollArea className="flex-1 min-h-0" innerClassName="msp-list">
        {candidates.length === 0 && <span className="gh-none">No matching tasks.</span>}
        {candidates.map(t => (
          <label key={t.id} className="msp-row">
            <input type="checkbox" checked={sel.has(t.id)}
              onChange={e => setSel(prev => {
                const next = new Set(prev);
                if (e.target.checked) next.add(t.id); else next.delete(t.id);
                return next;
              })} />
            <span className="num">{t.id}</span>
            <span className="msg">{t.title}</span>
          </label>
        ))}
      </ScrollArea>
      <div className="msp-foot">
        <button type="button" className="lk-btn ghosty" onClick={onCancel}>Cancel</button>
        <button type="button" className="lk-btn" disabled={busy || sel.size === 0} onClick={() => onConfirm([...sel])}>
          {busy ? '…' : `${confirmLabel} (${sel.size})`}
        </button>
      </div>
    </div>
  );
}

function MsChecklist({ items, editing, goTab, busy, onRemove }) {
  const { goToTask } = useNavigation();
  return (
    <ScrollArea className="flex-1 min-h-0" innerClassName="ms-check">
      {items.length === 0 && <span className="gh-none">Empty milestone — it disappears once nothing carries the tag.</span>}
      {items.map(t => (
        <div key={t.id} className={'ms-check-row' + (t.status === 'done' ? ' done' : '')}>
          <span className="box" aria-hidden="true">{t.status === 'done' ? '✓' : ''}</span>
          <span className="body" style={{ cursor: editing ? undefined : 'pointer' }}
            onClick={editing ? undefined : () => { goTab('tasks'); goToTask(t.id); }}>
            <span className="num">{t.id}</span>
            <span className="msg">{t.title}</span>
            <span className={'ms-st only-wide st-' + t.status}>{t.status}</span>
            {t.agent && <span className="ms-agent only-wide">@{t.agent}</span>}
          </span>
          {!editing && onRemove && (
            <button type="button" className="rm" title={`Remove ${t.id} from this milestone`}
              disabled={busy} onClick={() => onRemove(t.id)}>×</button>
          )}
        </div>
      ))}
    </ScrollArea>
  );
}

export function MilestonesWidget({ widget, editing }) {
  const { state } = useAppState();
  const project = state?.viewedProject;
  const goTab = useGoTab();
  const tasks = (state?.tasks || []).filter(t => !t.trashedAt && t.status !== 'archived');
  const groups = new Map(); // name → task[]
  for (const t of tasks) {
    for (const tag of t.tags || []) {
      if (tag.startsWith('milestone:')) {
        const name = tag.slice('milestone:'.length);
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name).push(t);
      }
    }
  }
  const pct = arr => Math.round((arr.filter(t => t.status === 'done').length / arr.length) * 100);
  const all = [...groups.entries()].sort((a, b) => pct(b[1]) - pct(a[1]));
  // completed milestones step aside — they stay reachable but stop
  // occupying the focus slot and the roadmap
  const active = all.filter(([, items]) => pct(items) < 100);
  const completed = all.filter(([, items]) => pct(items) === 100);
  // the focus is pinnable (props.focus); default: furthest-along active one
  // local override so the pin shows immediately — the stored overview only
  // refreshes on reload
  const [localFocus, setLocalFocus] = useState(undefined);
  useEffect(() => { setLocalFocus(undefined); }, [widget?.id]);
  const _pinWanted = localFocus !== undefined ? localFocus : widget?.props?.focus;
  const focusName = _pinWanted && groups.has(_pinWanted) && pct(groups.get(_pinWanted)) < 100
    ? _pinWanted
    : (active[0]?.[0] ?? null);
  const list = active; // roadmap source

  const pinned = Boolean(_pinWanted) && _pinWanted === focusName;

  async function pinFocus(name) {
    if (!project || !widget?.id) return;
    setLocalFocus(name);
    await persistWidgetProps(project, widget.id, props => {
      const next = { ...props };
      if (name) next.focus = name; else delete next.focus;
      return next;
    });
    window.showToast?.(name ? `${name} is now the focus milestone` : 'Focus follows progress again', 'success');
  }

  const [view, setView] = useState({ mode: 'list' }); // | {mode:'detail',name} | {mode:'create'} | {mode:'add',name}
  const [draftName, setDraftName] = useState('');
  const [busy, setBusy] = useState(false);

  async function applyTag(ids, name, add) {
    if (!project || busy) return;
    setBusy(true);
    const tag = `milestone:${name}`;
    try {
      for (const id of ids) {
        const t = tasks.find(x => x.id === id);
        if (!t) continue;
        const cur = t.tags || [];
        const next = add ? [...new Set([...cur, tag])] : cur.filter(x => x !== tag);
        if (next.length !== cur.length || add !== cur.includes(tag)) await putTaskTags(project, id, next);
      }
      await refreshTasks();
      window.showToast?.(add ? `Tagged ${ids.length} task${ids.length === 1 ? '' : 's'} with ${tag}` : 'Task removed from milestone', 'success');
    } catch (e) {
      window.showToast?.(e.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  const metaText = all.length ? `${active.length} active${completed.length ? ` · ${completed.length} done` : ''}` : null;
  const meta = view.mode === 'detail' || view.mode === 'add' ? null : (
    <>
      {metaText}
      {!editing && (
        <button type="button" className="ms-add-head" title="New milestone"
          onClick={() => setView({ mode: 'create' })}>+</button>
      )}
    </>
  );

  // ---------- create flow ----------
  if (view.mode === 'create') {
    const clean = draftName.trim().replace(/\s+/g, '-');
    return (
      <OvWidget title={widget?.title || 'Milestones'} meta="new milestone">
        <div className="ms-create">
          <input className="lk-in" placeholder="Milestone name — e.g. v5.1 or launch" value={draftName}
            autoFocus onChange={e => setDraftName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape') setView({ mode: 'list' }); }} />
          {clean ? (
            <MsTaskPicker tasks={tasks} excludeIds={new Set()} busy={busy} confirmLabel="Create"
              onCancel={() => { setView({ mode: 'list' }); setDraftName(''); }}
              onConfirm={async ids => {
                await applyTag(ids, clean, true);
                setDraftName('');
                setView({ mode: 'detail', name: clean });
              }} />
          ) : (
            <span className="gh-none">Pick a name, then choose the tasks that define "done".</span>
          )}
        </div>
      </OvWidget>
    );
  }

  // ---------- detail / add-tasks flow ----------
  if (view.mode === 'detail' || view.mode === 'add') {
    const items = groups.get(view.name) || [];
    const ids = new Set(items.map(t => t.id));
    return (
      <OvWidget title={widget?.title || 'Milestones'} meta={`milestone:${view.name}`}>
        <div className="ms-detail">
          <div className="ms-detail-head">
            <button type="button" className="ms-back" onClick={() => setView({ mode: 'list' })}>←</button>
            <span className="ms-name">{view.name}</span>
            {items.length > 0 && <span className="ms-meta"><span className="w-mono">{items.filter(t => t.status === 'done').length}/{items.length}</span> done</span>}
          </div>
          {items.length > 0 && <div className="ms-bar"><span style={{ width: pct(items) + '%' }}></span></div>}
          {view.mode === 'add' ? (
            <MsTaskPicker tasks={tasks} excludeIds={ids} busy={busy} confirmLabel="Add"
              onCancel={() => setView({ mode: 'detail', name: view.name })}
              onConfirm={async sel => {
                await applyTag(sel, view.name, true);
                setView({ mode: 'detail', name: view.name });
              }} />
          ) : (
            <>
              <MsChecklist items={items} editing={editing} goTab={goTab} busy={busy}
                onRemove={id => applyTag([id], view.name, false)} />
              {!editing && (
                <div className="ms-detail-actions">
                  <button type="button" className="lk-addtoggle" onClick={() => setView({ mode: 'add', name: view.name })}>
                    <Plus size={11} /> Add tasks
                  </button>
                  {items.length > 0 && (
                    <button type="button" className="lk-addtoggle danger" disabled={busy}
                      onClick={async () => {
                        if (!window.confirm(`Remove milestone "${view.name}"? The ${items.length} task${items.length === 1 ? '' : 's'} stay — only the tag goes away.`)) return;
                        await applyTag(items.map(t => t.id), view.name, false);
                        setView({ mode: 'list' });
                      }}>
                      Remove milestone
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </OvWidget>
    );
  }

  // ---------- list (default) ----------
  return (
    <OvWidget title={widget?.title || 'Milestones'} meta={meta}>
      {all.length === 0 ? (
        <div className="ov-empty">
          <Flag size={22} />
          <span className="ov-empty-title">No milestones yet</span>
          <span className="ov-empty-hint">A milestone is a set of tasks tagged <span className="w-mono">milestone:&lt;name&gt;</span> — its checklist is done when they are.</span>
          {!editing && (
            <button type="button" className="lk-btn ms-cta" onClick={() => setView({ mode: 'create' })}>
              Create your first milestone
            </button>
          )}
        </div>
      ) : (
        <div className="ms-wrap">
          <div className="ms-top">
          {focusName && (() => {
            const items = groups.get(focusName);
            const p100 = pct(items);
            return (
              <div className="ms-focus" style={{ cursor: 'pointer' }} title="Open checklist"
                onClick={() => setView({ mode: 'detail', name: focusName })}>
                <div className="ms-ring-row">
                  <Ring pct={p100} />
                  <span className="ms-head">
                    <span className="ms-name">
                      {focusName}
                      {!editing && (
                        <button type="button" className={'ms-pin head' + (pinned ? ' on' : '')}
                          title={pinned ? 'Pinned as focus — click to follow progress again' : 'Pin as focus milestone'}
                          onClick={e => { e.stopPropagation(); pinFocus(pinned ? null : focusName); }}>
                          {pinned ? '★' : '☆'}
                        </button>
                      )}
                    </span>
                    <span className="ms-meta"><span className="w-mono">{items.filter(t => t.status === 'done').length}/{items.length}</span> tasks done</span>
                  </span>
                </div>
                <div className="ms-bar"><span style={{ width: p100 + '%' }}></span></div>
              </div>
            );
          })()}
          {list.filter(([name]) => name !== focusName).length > 0 && (
            <div className="ms-roadmap">
              {list.filter(([name]) => name !== focusName).map(([name, items]) => (
                <div key={name} className="ms-up" style={{ cursor: 'pointer' }} title="Open checklist"
                  onClick={() => setView({ mode: 'detail', name })}>
                  <span className="nm">
                    <span className="t">{name}</span>
                    <span className="v">{pct(items)}%</span>
                    {!editing && (
                      <button type="button" className="ms-pin" title="Set as focus milestone"
                        onClick={e => { e.stopPropagation(); pinFocus(name); }}>☆</button>
                    )}
                  </span>
                  <span className="mini"><span style={{ width: pct(items) + '%' }}></span></span>
                </div>
              ))}
            </div>
          )}
          </div>
          {focusName && (
            <div className="ms-inline">
              <MsChecklist items={groups.get(focusName)} editing={editing} goTab={goTab} busy={busy}
                onRemove={id => applyTag([id], focusName, false)} />
            </div>
          )}
          {completed.length > 0 && (
            <div className="ms-done-row">
              {completed.map(([name]) => (
                <button key={name} type="button" className="ms-done-chip" title="Open checklist"
                  onClick={() => setView({ mode: 'detail', name })}>✓ {name}</button>
              ))}
            </div>
          )}
          {!editing && (
            <button type="button" className="lk-addtoggle" onClick={() => setView({ mode: 'create' })}>
              <Plus size={11} /> New milestone
            </button>
          )}
        </div>
      )}
    </OvWidget>
  );
}

/* ---------- timeline: dated spine over the activity feed ---------- */
function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const diff = Math.floor((today.setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86400000);
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString('en', { month: 'short', day: 'numeric' });
}

export function TimelineWidget({ widget, editing }) {
  const goTab = useGoTab();
  const { goToTask } = useNavigation();
  const { state } = useAppState();
  const items = useActivityFeed(state?.viewedProject, widget?.props?.limit || 25);
  const groups = [];
  for (const it of items || []) {
    const label = dayLabel(it.timestamp);
    const last = groups[groups.length - 1];
    if (!last || last.label !== label) groups.push({ label, items: [it] });
    else last.items.push(it);
  }
  return (
    <OvWidget title={widget?.title || 'Timeline'} meta={items?.length ? 'all activity' : null}>
      {items && items.length === 0 ? (
        <Empty icon={Flag} title="Nothing logged yet"
          hint="One dated spine across tasks, checkpoints and comments — it fills automatically as you and agents work." />
      ) : (
        <ScrollArea className="flex-1 min-h-0" innerClassName="tl-spine">
          {groups.map(grp => (
            <div key={grp.label} className="tl-group">
              <div className="tl-day">{grp.label}</div>
              {grp.items.map((it, i) => (
                <div key={`${it.taskId || ''}:${it.timestamp || ''}:${i}`} className="tl-node" style={{ cursor: editing ? undefined : 'pointer' }}
                  onClick={editing ? undefined : () => { goTab('tasks'); goToTask(it.taskId); }}>
                  <span className={'tl-dot ' + (it.event === 'status_changed' ? 'hot' : '')}></span>
                  <span className="tl-title"><span className="tid">{it.taskId}</span> {it.message}</span>
                </div>
              ))}
            </div>
          ))}
        </ScrollArea>
      )}
    </OvWidget>
  );
}

/* ---------- context-index: context/ files, pins via props ---------- */
export function ContextIndexWidget({ widget, editing }) {
  const { state } = useAppState();
  const { openSpec } = useDashboard();
  const project = state?.viewedProject;
  const [files, setFiles] = useState(null);
  useEffect(() => {
    if (!project) return;
    let alive = true;
    apiFetch(`/api/projects/${project}/files`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (!alive) return;
        const ctx = (d?.tree || []).find(e => e.name === 'context' && e.type === 'directory');
        setFiles((ctx?.children || []).filter(e => e.type === 'file').map(e => e.name));
      })
      .catch(() => { if (alive) setFiles([]); });
    return () => { alive = false; };
  }, [project]);

  const pins = widget?.props?.pins || [];
  const sorted = [...(files || [])].sort((a, b) => (pins.includes(b) ? 1 : 0) - (pins.includes(a) ? 1 : 0) || a.localeCompare(b));

  return (
    <OvWidget title={widget?.title || 'Context Index'} meta={files?.length ? `${files.length} files` : null}>
      {files && files.length === 0 ? (
        <Empty icon={Pin} title="No context files yet"
          hint={<>Files in <span className="w-mono">context/</span> are what agents read first — drop knowledge here.</>} />
      ) : (
        <ScrollArea className="flex-1 min-h-0" innerClassName="ci-list">
          {sorted.slice(0, widget?.props?.limit || 100).map(f => (
            <div key={f} className="ci-row" style={{ cursor: editing ? undefined : 'pointer' }}
              onClick={editing ? undefined : () => openSpec(`context/${f}`)}>
              <FileText size={13} className="text-muted shrink-0" />
              <span className="nm">{pins.includes(f) && <span className="pin">★ </span>}{f}</span>
            </div>
          ))}
        </ScrollArea>
      )}
    </OvWidget>
  );
}

/* ---------- quick-drop: drop markdown/text into context/ ---------- */
export function QuickDropWidget({ editing }) {
  const { state } = useAppState();
  const project = state?.viewedProject;
  const [hot, setHot] = useState(false);
  const [recent, setRecent] = useState([]);

  async function onDrop(e) {
    e.preventDefault();
    setHot(false);
    if (editing || !project) return;
    for (const file of e.dataTransfer?.files || []) {
      if (!/\.(md|txt|markdown)$/i.test(file.name)) {
        window.showToast?.(`${file.name}: only markdown/text files`, 'warn');
        continue;
      }
      const content = await file.text();
      const res = await apiFetch(`/api/projects/${project}/files/context`, {
        method: 'POST',
        body: JSON.stringify({ filename: file.name, content }),
      });
      if (res.ok) {
        setRecent(r => [{ nm: file.name }, ...r].slice(0, 3));
        window.showToast?.(`${file.name} → context/`, 'success');
      } else {
        const d = await res.json().catch(() => ({}));
        window.showToast?.(d.error || `Upload failed: ${file.name}`, 'error');
      }
    }
  }

  return (
    <OvWidget title="Quick Drop" meta="→ context/">
      <div
        className={'qd-zone' + (hot ? ' hot' : '')}
        onDragOver={e => { e.preventDefault(); if (!editing) setHot(true); }}
        onDragLeave={() => setHot(false)}
        onDrop={onDrop}
      >
        <span className="qd-ring"><Upload size={14} /></span>
        <span className="qd-title">Drop files to add context</span>
        <span className="qd-hint hide-narrow">Specs and notes — agents read <span className="w-mono">context/</span> first</span>
      </div>
      {recent.length > 0 && (
        <div className="qd-recent only-wide">
          {recent.map(r => <span key={r.nm} className="qd-chip"><FileText size={11} /><span className="nm">{r.nm}</span></span>)}
        </div>
      )}
    </OvWidget>
  );
}

/* ---------- notes: scratchpad persisted as context/NOTES.md ---------- */
export function NotesWidget({ editing }) {
  const { state } = useAppState();
  const project = state?.viewedProject;
  const [text, setText] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const existsRef = useRef(false);

  useEffect(() => {
    if (!project) return;
    let alive = true;
    apiFetch(`/api/projects/${project}/files/context/NOTES.md`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (!alive) return;
        existsRef.current = Boolean(d);
        setText(d?.content ?? '');
      })
      .catch(() => { if (alive) setText(''); });
    return () => { alive = false; };
  }, [project]);

  async function save() {
    if (!project || text === null) return;
    setSaving(true);
    try {
      const res = existsRef.current
        ? await apiFetch(`/api/projects/${project}/files/context/NOTES.md`, {
            method: 'PUT',
            body: JSON.stringify({ content: text }),
          })
        : await apiFetch(`/api/projects/${project}/files/context`, {
            method: 'POST',
            body: JSON.stringify({ filename: 'NOTES.md', content: text }),
          });
      if (res.ok) {
        existsRef.current = true;
        setDirty(false);
        window.showToast?.('Notes saved', 'success');
      } else {
        window.showToast?.('Saving notes failed', 'error');
      }
    } finally {
      setSaving(false);
    }
  }

  // the editor only shows while actually writing — clicking out
  // autosaves and returns to the rendered note
  const [open, setOpen] = useState(false);
  // T-380: location captured from the preview click/selection, applied in the editor
  const [pendingLoc, setPendingLoc] = useState(null);
  // T-385: outer scroll positions to hold steady across the open transition
  const scrollLockRef = useRef(null);

  // T-385: opening the editor (focus + async lazy mount + CM revealing the
  // caret) could scroll the surrounding page. Hold the outer scroll containers
  // (captured at click time) steady for a few frames across the transition.
  // CM's own scroller lives inside the editor subtree and is not captured here.
  useEffect(() => {
    if (!open) return undefined;
    const lock = scrollLockRef.current;
    if (!lock || !lock.length) return undefined;
    let frames = 0;
    let raf = requestAnimationFrame(function tick() {
      for (const [el, top, left] of lock) {
        if (el.scrollTop !== top) el.scrollTop = top;
        if (el.scrollLeft !== left) el.scrollLeft = left;
      }
      if (++frames < 18) raf = requestAnimationFrame(tick);
      else scrollLockRef.current = null;
    });
    return () => cancelAnimationFrame(raf);
  }, [open]);

  function finishEdit() {
    if (dirty) save();
    setOpen(false);
    setPendingLoc(null);
  }

  // Map a click/selection in the rendered preview back to a source location.
  function locateFromEvent(ev) {
    const src = text ?? '';
    const scroller = ev.currentTarget;
    const anchorY = ev.clientY - scroller.getBoundingClientRect().top;
    const lineOf = (node) => {
      let el = node && node.nodeType === 3 ? node.parentElement : node;
      el = el && el.closest ? el.closest('[data-sourceline]') : null;
      const n = el ? parseInt(el.getAttribute('data-sourceline'), 10) : NaN;
      return Number.isFinite(n) ? n : null;
    };
    const sel = typeof window !== 'undefined' ? window.getSelection?.() : null;
    if (sel && !sel.isCollapsed && sel.toString().trim()) {
      const a = lineOf(sel.anchorNode);
      const b = lineOf(sel.focusNode);
      if (a != null || b != null) {
        const lo = Math.min(a ?? b, b ?? a);
        const hi = Math.max(a ?? b, b ?? a);
        const { from, to } = resolveSelection(src, lo, hi, sel.toString());
        return { from, to, anchorY };
      }
    }
    const line = lineOf(ev.target);
    if (line == null) return { anchorY };
    let col = 0;
    try {
      let cr = document.caretRangeFromPoint?.(ev.clientX, ev.clientY);
      if (!cr && document.caretPositionFromPoint) {
        const p = document.caretPositionFromPoint(ev.clientX, ev.clientY);
        if (p) cr = { startContainer: p.offsetNode, startOffset: p.offset };
      }
      if (cr && cr.startContainer && cr.startContainer.nodeType === 3) {
        const before = cr.startContainer.textContent.slice(0, cr.startOffset);
        col = estimateColumn(src.split('\n')[line - 1] || '', before);
      }
    } catch { /* best-effort column */ }
    const off = posToOffset(src, line, col);
    return { from: off, to: off, anchorY };
  }

  function openFromPreview(ev) {
    if (editing) return;
    // T-385: snapshot the scroll offset of every scrollable ancestor (the
    // outer page containers) + the document, to restore across the transition.
    const lock = [];
    for (let el = ev.currentTarget.parentElement; el; el = el.parentElement) {
      if (el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth) lock.push([el, el.scrollTop, el.scrollLeft]);
    }
    const se = document.scrollingElement;
    if (se) lock.push([se, se.scrollTop, se.scrollLeft]);
    scrollLockRef.current = lock;
    setPendingLoc(locateFromEvent(ev));
    setOpen(true);
  }

  return (
    <OvWidget title="Notes" meta="context/NOTES.md">
      {open ? (
        <div
          className="nt-md-wrap"
          onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) finishEdit(); }}
        >
          <Suspense fallback={<div className="nt-loading">Loading editor…</div>}>
            <MarkdownEditor
              className="nt-md"
              value={text ?? ''}
              onChange={v => { setText(v); setDirty(true); }}
              onSave={finishEdit}
              initialLocation={pendingLoc}
            />
          </Suspense>
        </div>
      ) : (
        <ScrollArea className="flex-1 min-h-0" innerClassName="nt-view" title="Click to edit"
          onMouseUp={editing ? undefined : openFromPreview}
          innerStyle={{ cursor: editing ? undefined : 'text' }}>
          {text ? (
            <Suspense fallback={<div className="nt-loading">…</div>}>
              <MarkdownPreview content={text} breaks trackSource />
            </Suspense>
          ) : (
            <span className="nt-placeholder">Click to jot anything — agents can read and append to NOTES.md too.</span>
          )}
        </ScrollArea>
      )}
      <div className="nt-foot">
        <span className="nt-state">{saving ? 'saving…' : dirty ? 'unsaved' : 'saved'}</span>
        {open && (
          <button type="button" className="nt-save" onMouseDown={e => e.preventDefault()} onClick={finishEdit} disabled={saving}>
            <Save size={11} /> Done
          </button>
        )}
      </div>
    </OvWidget>
  );
}

/* ---------- links: pinned externals from props ---------- */
// a bare "example.com" would resolve relative to the dashboard origin
function absoluteUrl(url) {
  return /^[a-z][a-z0-9+.-]*:/i.test(url || '') ? url : `https://${url}`;
}

export function LinksWidget({ widget, editing }) {
  const { state } = useAppState();
  const project = state?.viewedProject;
  // local copy so a link added through the widget shows up without a
  // full overview reload — props win again on the next mount
  const [links, setLinks] = useState(widget?.props?.links || []);
  useEffect(() => { setLinks(widget?.props?.links || []); }, [widget?.id, widget?.props?.links]);
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('');
  const [saving, setSaving] = useState(false);
  // T-381: per-row edit state. editIdx is the index of the link being edited.
  const [editIdx, setEditIdx] = useState(-1);
  const [editLabel, setEditLabel] = useState('');
  const [editUrl, setEditUrl] = useState('');
  // T-381: explicit manage mode toggled from the footer — keeps the normal
  // view clean (plain links) and only shows edit/remove affordances on demand.
  const [manage, setManage] = useState(false);

  function startEdit(idx, link) {
    setAdding(false);
    setEditIdx(idx);
    setEditLabel(link.label || '');
    setEditUrl(link.url || '');
  }
  function cancelEdit() { setEditIdx(-1); setEditLabel(''); setEditUrl(''); }

  async function saveEdit(idx) {
    const cleanUrl = editUrl.trim() ? absoluteUrl(editUrl.trim()) : '';
    if (!project || !widget?.id || !cleanUrl || saving) return;
    setSaving(true);
    try {
      const next = await persistWidgetProps(project, widget.id, props => ({
        ...props,
        links: (props.links || []).map((l, i) => i === idx ? { label: editLabel.trim() || cleanUrl, url: cleanUrl } : l),
      }));
      if (next) { setLinks(next.links); cancelEdit(); window.showToast?.('Link updated', 'success'); }
      else window.showToast?.('Updating link failed — save the layout first?', 'error');
    } finally { setSaving(false); }
  }

  async function removeLink(idx) {
    if (!project || !widget?.id || saving) return;
    setSaving(true);
    try {
      const next = await persistWidgetProps(project, widget.id, props => ({
        ...props,
        links: (props.links || []).filter((_, i) => i !== idx),
      }));
      if (next) { setLinks(next.links); if (editIdx === idx) cancelEdit(); if (!next.links.length) setManage(false); window.showToast?.('Link removed', 'success'); }
      else window.showToast?.('Removing link failed — save the layout first?', 'error');
    } finally { setSaving(false); }
  }

  async function addLink() {
    const cleanUrl = url.trim() ? absoluteUrl(url.trim()) : '';
    if (!project || !widget?.id || !cleanUrl || saving) return;
    setSaving(true);
    try {
      const next = await persistWidgetProps(project, widget.id, props => ({
        ...props,
        links: [...(props.links || []), { label: label.trim() || cleanUrl, url: cleanUrl }],
      }));
      if (next) {
        setLinks(next.links);
        setLabel(''); setUrl(''); setAdding(false);
        window.showToast?.('Link pinned', 'success');
      } else {
        window.showToast?.('Adding link failed — save the layout first?', 'error');
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <OvWidget title={widget?.title || 'Links'} meta={links.length ? `${links.length} pinned` : null}>
      {links.length === 0 && !adding ? (
        <Empty icon={ExternalLink} title="No links yet"
          hint="Pin deploys, docs or dashboards — via the button below or by asking your agent." />
      ) : (
        <ScrollArea className="flex-1 min-h-0" innerClassName="lk-list">
          {links.slice(0, widget?.props?.limit || 6).map((l, idx) => (
            editIdx === idx ? (
              <div key={idx} className="lk-add lk-edit">
                <input className="lk-in" placeholder="Label" value={editLabel} autoFocus
                  onChange={e => setEditLabel(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Escape') cancelEdit(); }} />
                <input className="lk-in" placeholder="https://…" value={editUrl}
                  onChange={e => setEditUrl(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') saveEdit(idx); if (e.key === 'Escape') cancelEdit(); }} />
                <button type="button" className="lk-btn" onClick={() => saveEdit(idx)} disabled={saving || !editUrl.trim()} title="Save">
                  {saving ? '…' : <Save size={12} />}
                </button>
                <button type="button" className="lk-btn lk-btn-ghost" onClick={cancelEdit} title="Cancel"><X size={12} /></button>
              </div>
            ) : manage && !editing ? (
              <div key={idx} className="lk-row lk-row-manage">
                <span className="lk-fav">{(l.label || l.url).slice(0, 1).toUpperCase()}</span>
                <span className="nm">{l.label || l.url}</span>
                <button type="button" className="lk-act" title="Edit link" aria-label="Edit link"
                  onClick={() => startEdit(idx, l)}><Pencil size={13} /></button>
                <button type="button" className="lk-act lk-act-danger" title="Remove link" aria-label="Remove link"
                  onClick={() => removeLink(idx)} disabled={saving}><Trash2 size={13} /></button>
              </div>
            ) : (
              <a key={idx} className="lk-row" href={editing ? undefined : absoluteUrl(l.url)} target="_blank" rel="noreferrer"
                onClick={e => { if (editing) e.preventDefault(); }}>
                <span className="lk-fav">{(l.label || l.url).slice(0, 1).toUpperCase()}</span>
                <span className="nm">{l.label || l.url}</span>
                <ExternalLink size={11} className="text-muted shrink-0" />
              </a>
            )
          ))}
        </ScrollArea>
      )}
      {!editing && (adding ? (
        <div className="lk-add">
          <input className="lk-in" placeholder="Label" value={label} autoFocus
            onChange={e => setLabel(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape') setAdding(false); }} />
          <input className="lk-in" placeholder="https://…" value={url}
            onChange={e => setUrl(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') addLink(); if (e.key === 'Escape') setAdding(false); }} />
          <button type="button" className="lk-btn" onClick={addLink} disabled={saving || !url.trim()}>
            {saving ? '…' : 'Pin'}
          </button>
        </div>
      ) : (
        <div className="lk-foot">
          <button type="button" className="lk-addtoggle" onClick={() => { setAdding(true); setManage(false); cancelEdit(); }}>
            <Plus size={11} /> Add link
          </button>
          {links.length > 0 && (
            <button type="button" className={manage ? 'lk-addtoggle is-active' : 'lk-addtoggle'}
              aria-pressed={manage} onClick={() => { setManage(m => !m); cancelEdit(); }}>
              {manage ? <><Check size={11} /> Done</> : <><Pencil size={11} /> Manage</>}
            </button>
          )}
        </div>
      ))}
    </OvWidget>
  );
}

/* ---------- stall-detection: friendly momentum check ---------- */
// T-387: human labels + display order for the Momentum tooltip's action breakdown.
const SD_TYPE_ORDER = ['status_changed', 'task_created', 'checkpoint_recorded', 'comment_added', 'task_archived', 'project_created'];
const SD_TYPE_LABEL = {
  status_changed: 'status changes',
  task_created: 'created',
  checkpoint_recorded: 'checkpoints',
  comment_added: 'comments',
  task_archived: 'archived',
  project_created: 'project created',
};
const sdDayLabel = (iso) => new Date(iso).toLocaleDateString('en', { weekday: 'long', month: 'short', day: 'numeric' });

export function StallDetectionWidget({ widget }) {
  const { state } = useAppState();
  const project = state?.viewedProject;
  const [agg, setAgg] = useState(null);
  useEffect(() => {
    if (!project) return;
    let alive = true;
    apiFetch(`/api/projects/${project}/activity/daily?days=14`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (alive) setAgg(d); })
      .catch(() => { if (alive) setAgg({ days: [], latest: null, total: 0 }); });
    return () => { alive = false; };
  }, [project]);

  // T-387: hover/focus tooltip. `tip` holds the day + the bar's screen anchor;
  // tipPos is computed after the tooltip mounts so we can place it above the
  // bar (flipping below when there's no room) and clamp it into the viewport.
  const [tip, setTip] = useState(null);
  const [tipPos, setTipPos] = useState(null);
  const tipRef = useRef(null);
  useLayoutEffect(() => {
    if (!tip || !tipRef.current) return;
    const r = tipRef.current.getBoundingClientRect();
    const gap = 8;
    const left = Math.max(6, Math.min(tip.anchor.cx - r.width / 2, window.innerWidth - r.width - 6));
    let top = tip.anchor.top - r.height - gap;
    if (top < 6) top = tip.anchor.bottom + gap;
    setTipPos({ top, left });
  }, [tip]);
  function showTip(e, d) { const r = e.currentTarget.getBoundingClientRect(); setTipPos(null); setTip({ d, anchor: { cx: r.left + r.width / 2, top: r.top, bottom: r.bottom } }); }
  function hideTip() { setTip(null); setTipPos(null); }

  if (!agg) return <OvWidget title={widget?.title || 'Momentum'} meta="stall check"><div /></OvWidget>;

  const now = Date.now();
  const day = 86400000;
  const last = agg.latest ? new Date(agg.latest.timestamp).getTime() : 0;
  const idleDays = last ? Math.floor((now - last) / day) : 99;
  const cfg = idleDays < 1
    ? { Icon: Sun, cls: 'active', head: 'Active today', sub: agg.latest ? `Last touched ${agg.latest.taskId} · ${agg.latest.message.slice(0, 60)}` : '' }
    : idleDays < 5
      ? { Icon: Coffee, cls: 'slow', head: `Quiet for ${idleDays} day${idleDays > 1 ? 's' : ''}`, sub: 'Nothing urgent — just a nudge.' }
      : { Icon: Moon, cls: 'dormant', head: `Resting — ${idleDays > 30 ? '30+' : idleDays} days`, sub: 'Pick it back up whenever you are ready.' };

  const days = agg.days || [];
  const perDay = days.map(d => d.count);
  const max = Math.max(...perDay, 1);
  const activeDays = perDay.filter(n => n > 0).length;
  const busiest = days.reduce((m, d) => (d.count > (m?.count || 0) ? d : m), null);
  const todayIso = days.length ? days[days.length - 1].day : null;

  // Height encodes volume; colour no longer doubles it. Instead one accent
  // marks days above the *typical* active-day pace (median, robust to spikes),
  // so the bars read against your own baseline rather than three arbitrary
  // tiers. The reference line makes that baseline visible. (T-387)
  const heightPct = (c) => (c ? 18 + (c / max) * 78 : 8);
  const activeSorted = perDay.filter(n => n > 0).slice().sort((a, b) => a - b);
  const median = activeSorted.length ? activeSorted[Math.floor((activeSorted.length - 1) / 2)] : 0;
  const showMedian = activeSorted.length >= 3 && median > 0 && median < max;

  return (
    <>
    <OvWidget title={widget?.title || 'Momentum'} meta="stall check">
      <div className="sd-wrap">
        <div className="sd-status">
          <span className={'sd-orb ' + cfg.cls}><cfg.Icon size={15} /></span>
          <span className="sd-txt">
            <span className="sd-headline">{cfg.head}</span>
            <span className="sd-sub">{cfg.sub}</span>
          </span>
        </div>
        <div className="sd-strip-block">
          <div className="sd-strip">
            {showMedian && <span className="sd-median" style={{ bottom: heightPct(median) + '%' }} aria-hidden="true" />}
            {days.map(d => {
              const cls = d.count === 0 ? 'sd-bar' : d.count > median ? 'sd-bar a-peak' : 'sd-bar a-on';
              return <i key={d.day}
                className={cls + (d.day === todayIso ? ' is-today' : '')}
                tabIndex={0} role="img"
                aria-label={`${sdDayLabel(d.day)}: ${d.count} event${d.count === 1 ? '' : 's'}`}
                style={{ height: heightPct(d.count) + '%' }}
                onMouseEnter={e => showTip(e, d)} onMouseLeave={hideTip}
                onFocus={e => showTip(e, d)} onBlur={hideTip}></i>;
            })}
          </div>
          <div className="sd-strip-lbl">Activity · last 14 days{showMedian ? ` · typical ${median}/day` : ''}</div>
        </div>
        <div className="sd-stats">
          <span><b>{agg.total}</b> events · 14d</span>
          <span><b>{activeDays}</b>/14 active days</span>
          {busiest?.count > 0 && <span>busiest <b>{new Date(busiest.day).toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric' })}</b></span>}
        </div>
      </div>
    </OvWidget>
    {tip && createPortal(
      <div ref={tipRef} role="tooltip" className="sd-tip"
        style={{ top: tipPos ? tipPos.top : -9999, left: tipPos ? tipPos.left : -9999, visibility: tipPos ? 'visible' : 'hidden' }}>
        <div className="sd-tip-head">
          <span className="sd-tip-date">{sdDayLabel(tip.d.day)}</span>
          {tip.d.day === todayIso && <span className="sd-tip-today">today</span>}
        </div>
        <div className="sd-tip-total"><b>{tip.d.count}</b> event{tip.d.count === 1 ? '' : 's'}</div>
        {tip.d.count > 0 ? (
          <ul className="sd-tip-rows">
            {SD_TYPE_ORDER.filter(t => tip.d.byType?.[t]).map(t => (
              <li key={t}><span className="sd-tip-dot" aria-hidden="true" /><b>{tip.d.byType[t]}</b> {SD_TYPE_LABEL[t]}</li>
            ))}
            {Object.keys(tip.d.byType || {}).filter(t => !SD_TYPE_ORDER.includes(t)).map(t => (
              <li key={t}><span className="sd-tip-dot" aria-hidden="true" /><b>{tip.d.byType[t]}</b> {t.replace(/_/g, ' ')}</li>
            ))}
          </ul>
        ) : <div className="sd-tip-empty">No activity</div>}
        {median > 0 && (
          <div className="sd-tip-foot">
            typical ≈ <b>{median}</b>/day · {tip.d.count === 0 ? 'quiet day' : tip.d.count > median ? 'busier than usual' : 'around your usual pace'}
          </div>
        )}
      </div>,
      document.body
    )}
    </>
  );
}

/* ---------- repo-status: GitHub at a glance (opt-in via props.repo) ---------- */
function ago(ts) {
  if (!ts) return '';
  const min = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 60000));
  if (min < 60) return `${min}m`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

const CI_LABEL = { passing: 'CI passing', failing: 'CI failing', pending: 'CI running', none: 'no CI' };

export function RepoStatusWidget({ widget, editing }) {
  const { state } = useAppState();
  const project = state?.viewedProject;
  const { binding, saveBinding } = useProjectGithub(project);
  const repo = widget?.props?.repo || binding?.repo || '';
  const branch = widget?.props?.branch || binding?.branch || '';
  const [draft, setDraftRepo] = useState('');
  const [saving, setSaving] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [tick, setTick] = useState(0);
  const reload = () => setTick(t => t + 1);

  useEffect(() => {
    if (!repo) return;
    let alive = true;
    setData(null); setError(null);
    const q = branch ? `&branch=${encodeURIComponent(branch)}` : '';
    apiFetch(`/api/github/repo-status?repo=${encodeURIComponent(repo)}${q}`)
      .then(async r => {
        const d = await r.json().catch(() => ({}));
        if (!alive) return;
        if (r.ok) setData(d.status);
        else setError(d.error || 'GitHub fetch failed');
      })
      .catch(() => { if (alive) setError('GitHub unreachable'); });
    return () => { alive = false; };
  }, [repo, branch, tick]);

  function pickBranch(next) {
    // branch is part of the shared project binding — gh-ci etc. follow
    saveBinding(repo, next === data?.defaultBranch ? null : next);
  }

  async function connect() {
    const clean = draft.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\/+$/, '');
    if (!project || !/^[\w.-]+\/[\w.-]+$/.test(clean) || saving) return;
    setSaving(true);
    try {
      if (await saveBinding(clean, null)) window.showToast?.(`Connected ${clean} for this project`, 'success');
    } finally {
      setSaving(false);
    }
  }

  if (!repo) {
    return (
      <OvWidget title={widget?.title || 'Repo Status'} meta="GitHub">
        <div className="gh-setup">
          <span className="gh-setup-hint">Connect a GitHub repository — CI, open PRs and latest commits show up here.</span>
          <div className="lk-add">
            <input className="lk-in" placeholder="owner/name" value={draft}
              onChange={e => setDraftRepo(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') connect(); }}
              disabled={editing} />
            <button type="button" className="lk-btn" onClick={connect} disabled={editing || saving || !draft.trim()}>
              {saving ? '…' : 'Connect'}
            </button>
          </div>
          <TokenAffordance editing={editing} />
        </div>
      </OvWidget>
    );
  }

  return (
    <OvWidget title={widget?.title || 'Repo Status'} meta={data ? `updated ${ago(data.fetchedAt)} ago` : 'GitHub'}>
      <div className="gh-head">
        <a className="gh-repo" href={editing ? undefined : `https://github.com/${repo}`} target="_blank" rel="noreferrer"
          onClick={e => { if (editing) e.preventDefault(); }}>
          <GitBranch size={13} />
          <span className="nm">{repo}</span>
        </a>
        {data?.branches?.length > 0 ? (
          <select
            className="gh-branch"
            value={data.branch}
            disabled={editing}
            onClick={e => e.stopPropagation()}
            onChange={e => pickBranch(e.target.value)}
            title="Branch — commits and CI follow this selection"
          >
            {data.branches.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
        ) : data?.branch ? (
          <span className="br">{data.branch}</span>
        ) : null}
        {data && <span className={'gh-ci ' + data.ci}>{CI_LABEL[data.ci] || data.ci}</span>}
      </div>
      {error ? (
        <div className="gh-errwrap">
          <div className="gh-error">{error}</div>
          <TokenAffordance editing={editing} onSaved={reload} />
        </div>
      ) : !data ? (
        <div className="nt-loading">Loading…</div>
      ) : (
        <div className="gh-body">
          <div className="gh-sec hide-narrow">
            <div className="gh-sec-h"><GitPullRequest size={11} /> Open PRs · {data.pulls.length}{data.pulls.length === 5 ? '+' : ''}</div>
            <ScrollArea className="flex-1 min-h-0" innerClassName="gh-rows">
            {data.pulls.length === 0 ? (
              <span className="gh-none">No open pull requests</span>
            ) : data.pulls.slice(0, 6).map(p => (
              <a key={p.number} className="gh-row" href={editing ? undefined : `https://github.com/${repo}/pull/${p.number}`}
                target="_blank" rel="noreferrer" onClick={e => { if (editing) e.preventDefault(); }}>
                <span className="num">#{p.number}</span>
                <span className="msg">{p.draft ? '[draft] ' : ''}{p.title}</span>
              </a>
            ))}
            </ScrollArea>
          </div>
          <div className="gh-sec">
            <div className="gh-sec-h">Latest commits</div>
            <ScrollArea className="flex-1 min-h-0" innerClassName="gh-rows">
            {data.commits.slice(0, 6).map(c => (
              <a key={c.sha} className="gh-row" href={editing ? undefined : `https://github.com/${repo}/commit/${c.sha}`}
                target="_blank" rel="noreferrer" onClick={e => { if (editing) e.preventDefault(); }}>
                <span className="num">{c.sha}</span>
                <span className="msg">{c.message}</span>
                <span className="when">{ago(c.date)}</span>
              </a>
            ))}
            </ScrollArea>
          </div>
        </div>
      )}
      {!editing && <TokenAffordance editing={editing} onSaved={reload} />}
    </OvWidget>
  );
}

/* ---------- file-viewer: one rendered file on the overview (T-322) ---------- */
export function FileViewerWidget({ widget, editing }) {
  const { state } = useAppState();
  const { openSpec } = useDashboard();
  const project = state?.viewedProject;
  // local path state: the pick must render immediately — the stored
  // overview only refreshes on reload, and in an unsaved edit draft the
  // persist has nothing to write to yet
  const [path, setPath] = useState(widget?.props?.path || '');
  useEffect(() => { setPath(widget?.props?.path || ''); }, [widget?.id, widget?.props?.path]);
  const [files, setFiles] = useState([]);
  const [content, setContent] = useState(null);
  const [error, setError] = useState(null);

  // candidates: root markdown files + everything in context/
  useEffect(() => {
    if (!project) return;
    let alive = true;
    apiFetch(`/api/projects/${project}/files`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (!alive || !d) return;
        const out = [];
        for (const e of d.tree || []) {
          if (e.type === 'file' && /\.md$/i.test(e.name)) out.push(e.path);
          if (e.type === 'directory' && e.name === 'context') {
            for (const c of e.children || []) if (c.type === 'file') out.push(c.path);
          }
        }
        setFiles(out);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [project]);

  useEffect(() => {
    if (!project || !path) return;
    let alive = true;
    setContent(null); setError(null);
    apiFetch(`/api/projects/${project}/files/${path}`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(d => { if (alive) setContent(d?.content ?? ''); })
      .catch(e => { if (alive) setError(`Could not read ${path}: ${e.message}`); });
    return () => { alive = false; };
  }, [project, path]);

  function pickFile(next) {
    if (!next) return;
    setPath(next);
    if (project && widget?.id) {
      persistWidgetProps(project, widget.id, props => ({ ...props, path: next }))
        .then(ok => { if (!ok) window.showToast?.('Shown for now — save the layout to keep this file', 'info'); })
        .catch(() => {});
    }
  }

  const name = path.split('/').pop();
  return (
    <OvWidget
      title={widget?.title || 'File Viewer'}
      meta={files.length > 0 ? (
        <select className="fv-pick" value={path} disabled={editing}
          onClick={e => e.stopPropagation()} onChange={e => pickFile(e.target.value)}>
          {!path && <option value="">choose a file…</option>}
          {files.map(f => <option key={f} value={f}>{f}</option>)}
        </select>
      ) : 'file'}
    >
      {!path ? (
        <Empty icon={FileText} title="No file selected"
          hint="Pick a markdown file in the header — it renders right here and grows with the widget." />
      ) : error ? (
        <div className="gh-error">{error}</div>
      ) : content === null ? (
        <div className="nt-loading">Loading…</div>
      ) : (
        <ScrollArea className="flex-1 min-h-0" innerClassName="fv-body"
          innerStyle={{ cursor: editing ? undefined : 'pointer' }}
          title={editing ? undefined : `Open ${name} in Files`}
          onClick={editing ? undefined : e => { if (!e.target.closest('a')) openSpec(path); }}>
          <Suspense fallback={<div className="nt-loading">…</div>}>
            <MarkdownPreview content={content} />
          </Suspense>
        </ScrollArea>
      )}
    </OvWidget>
  );
}
