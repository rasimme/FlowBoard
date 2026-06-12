import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Flag, ExternalLink, Upload, FileText, Pin, Sun, Coffee, Moon, Play, Plus, Save, GitBranch, GitPullRequest } from 'lucide-react';
import { OvWidget } from './widgets.jsx';
import { useAppState } from '../../context/AppStateContext.jsx';

const MarkdownEditor = lazy(() => import('../MarkdownEditor.jsx'));
const MarkdownPreview = lazy(() => import('../MarkdownPreview.jsx'));

/**
 * Overview widget catalog v2 (T-308) — milestones, timeline, context-index,
 * quick-drop, notes, links, stall-detection. Design: claude-design-t305
 * (dash-widgets2/3), implemented with restrained color use.
 */

function useGoTab() {
  const { dispatch } = useAppState();
  return (tab) => {
    dispatch({ currentTab: tab });
    if (tab === 'ideas') window._switchTab?.(tab);
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
async function persistWidgetProps(project, widgetId, mutate) {
  const cur = await fetch(`/api/projects/${project}/overview`, { credentials: 'include' })
    .then(r => (r.ok ? r.json() : null));
  const ov = cur?.overview;
  const target = (ov?.widgets || []).find(w => w.id === widgetId);
  if (!target) return null;
  target.props = mutate(target.props || {});
  delete ov.source;
  const res = await fetch(`/api/projects/${project}/overview`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(ov),
  });
  return res.ok ? target.props : null;
}

function useActivityFeed(project, limit) {
  const [items, setItems] = useState(null);
  useEffect(() => {
    if (!project) return;
    let alive = true;
    fetch(`/api/projects/${project}/activity?limit=${limit}`, { credentials: 'include' })
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
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--accent-2)" strokeWidth="5"
          strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - pct / 100)} />
      </svg>
      <span className="pct">{pct}</span>
    </span>
  );
}

export function MilestonesWidget({ widget }) {
  const { state } = useAppState();
  const tasks = (state?.tasks || []).filter(t => !t.trashedAt && t.status !== 'archived');
  const groups = new Map();
  for (const t of tasks) {
    for (const tag of t.tags || []) {
      if (tag.startsWith('milestone:')) {
        const name = tag.slice('milestone:'.length);
        if (!groups.has(name)) groups.set(name, { total: 0, done: 0 });
        const g = groups.get(name);
        g.total++;
        if (t.status === 'done') g.done++;
      }
    }
  }
  const list = [...groups.entries()].sort((a, b) => (b[1].done / b[1].total) - (a[1].done / a[1].total));

  return (
    <OvWidget title={widget?.title || 'Milestones'} meta={list.length ? `${list.length} tracked` : null}>
      {list.length === 0 ? (
        <Empty icon={Flag} title="No milestones yet"
          hint={<>Tag tasks with <span className="w-mono">milestone:&lt;name&gt;</span> — progress toward each milestone shows up here.</>} />
      ) : (
        <div className="ms-wrap">
          {list.slice(0, 1).map(([name, g]) => {
            const pct = Math.round((g.done / g.total) * 100);
            return (
              <div key={name} className="ms-focus">
                <div className="ms-ring-row">
                  <Ring pct={pct} />
                  <span className="ms-head">
                    <span className="ms-name">{name}</span>
                    <span className="ms-meta"><span className="w-mono">{g.done}/{g.total}</span> tasks done</span>
                  </span>
                </div>
                <div className="ms-bar"><span style={{ width: pct + '%' }}></span></div>
              </div>
            );
          })}
          <div className="ms-roadmap only-wide">
            {list.slice(1, 4).map(([name, g]) => (
              <div key={name} className="ms-up">
                <span className="nm">{name} <span className="v">{Math.round((g.done / g.total) * 100)}%</span></span>
                <span className="mini"><span style={{ width: Math.round((g.done / g.total) * 100) + '%' }}></span></span>
              </div>
            ))}
          </div>
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
        <div className="tl-spine">
          {groups.map(grp => (
            <div key={grp.label} className="tl-group">
              <div className="tl-day">{grp.label}</div>
              {grp.items.map((it, i) => (
                <div key={i} className="tl-node" style={{ cursor: editing ? undefined : 'pointer' }}
                  onClick={editing ? undefined : () => { goTab('tasks'); window._scrollToTaskId = it.taskId; }}>
                  <span className={'tl-dot ' + (it.event === 'status_changed' ? 'hot' : '')}></span>
                  <span className="tl-title"><span className="tid">{it.taskId}</span> {it.message}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </OvWidget>
  );
}

/* ---------- context-index: context/ files, pins via props ---------- */
export function ContextIndexWidget({ widget, editing }) {
  const { state } = useAppState();
  const project = state?.viewedProject;
  const [files, setFiles] = useState(null);
  useEffect(() => {
    if (!project) return;
    let alive = true;
    fetch(`/api/projects/${project}/files`, { credentials: 'include' })
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
        <div className="ci-list">
          {sorted.slice(0, widget?.props?.limit || 100).map(f => (
            <div key={f} className="ci-row" style={{ cursor: editing ? undefined : 'pointer' }}
              onClick={editing ? undefined : () => window._openSpec?.(`context/${f}`)}>
              <FileText size={13} className="text-muted shrink-0" />
              <span className="nm">{pins.includes(f) && <span className="pin">★ </span>}{f}</span>
            </div>
          ))}
        </div>
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
      const res = await fetch(`/api/projects/${project}/files/context`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
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
    fetch(`/api/projects/${project}/files/context/NOTES.md`, { credentials: 'include' })
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
        ? await fetch(`/api/projects/${project}/files/context/NOTES.md`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ content: text }),
          })
        : await fetch(`/api/projects/${project}/files/context`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
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

  function finishEdit() {
    if (dirty) save();
    setOpen(false);
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
            />
          </Suspense>
        </div>
      ) : (
        <div className="nt-view" onClick={editing ? undefined : () => setOpen(true)}
          style={{ cursor: editing ? undefined : 'text' }} title="Click to edit">
          {text ? (
            <Suspense fallback={<div className="nt-loading">…</div>}>
              <MarkdownPreview content={text} />
            </Suspense>
          ) : (
            <span className="nt-placeholder">Click to jot anything — agents can read and append to NOTES.md too.</span>
          )}
        </div>
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
  useEffect(() => { setLinks(widget?.props?.links || []); }, [widget]);
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('');
  const [saving, setSaving] = useState(false);

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
        <div className="lk-list">
          {links.slice(0, widget?.props?.limit || 6).map(l => (
            <a key={l.url} className="lk-row" href={editing ? undefined : absoluteUrl(l.url)} target="_blank" rel="noreferrer"
              onClick={e => { if (editing) e.preventDefault(); }}>
              <span className="lk-fav">{(l.label || l.url).slice(0, 1).toUpperCase()}</span>
              <span className="nm">{l.label || l.url}</span>
              <ExternalLink size={11} className="text-muted shrink-0" />
            </a>
          ))}
        </div>
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
        <button type="button" className="lk-addtoggle" onClick={() => setAdding(true)}>
          <Plus size={11} /> Add link
        </button>
      ))}
    </OvWidget>
  );
}

/* ---------- stall-detection: friendly momentum check ---------- */
export function StallDetectionWidget({ widget }) {
  const { state } = useAppState();
  const items = useActivityFeed(state?.viewedProject, 200);
  if (!items) return <OvWidget title={widget?.title || 'Momentum'} meta="stall check"><div /></OvWidget>;

  const now = Date.now();
  const day = 86400000;
  const last = items[0] ? new Date(items[0].timestamp).getTime() : 0;
  const idleDays = last ? Math.floor((now - last) / day) : 99;
  const cfg = idleDays < 1
    ? { Icon: Sun, cls: 'active', head: 'Active today', sub: items[0] ? `Last touched ${items[0].taskId} · ${items[0].message.slice(0, 60)}` : '' }
    : idleDays < 5
      ? { Icon: Coffee, cls: 'slow', head: `Quiet for ${idleDays} day${idleDays > 1 ? 's' : ''}`, sub: 'Nothing urgent — just a nudge.' }
      : { Icon: Moon, cls: 'dormant', head: `Resting — ${idleDays > 30 ? '30+' : idleDays} days`, sub: 'Pick it back up whenever you are ready.' };

  const strip = Array.from({ length: 14 }, (_, i) => {
    const dayStart = new Date(now - (13 - i) * day).setHours(0, 0, 0, 0);
    const n = items.filter(it => {
      const t = new Date(it.timestamp).getTime();
      return t >= dayStart && t < dayStart + day;
    }).length;
    return Math.min(3, n > 6 ? 3 : n > 2 ? 2 : n > 0 ? 1 : 0);
  });

  return (
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
            {strip.map((v, i) => <i key={i} className={v ? 'a' + v : ''} style={{ height: (20 + v * 26) + '%' }}></i>)}
          </div>
          <div className="sd-strip-lbl">Activity · last 14 days</div>
        </div>
      </div>
    </OvWidget>
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
  const [repo, setRepo] = useState(widget?.props?.repo || '');
  useEffect(() => { setRepo(widget?.props?.repo || ''); }, [widget]);
  const [draft, setDraftRepo] = useState('');
  const [saving, setSaving] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!repo) return;
    let alive = true;
    setData(null); setError(null);
    fetch(`/api/github/repo-status?repo=${encodeURIComponent(repo)}`, { credentials: 'include' })
      .then(async r => {
        const d = await r.json().catch(() => ({}));
        if (!alive) return;
        if (r.ok) setData(d.status);
        else setError(d.error || 'GitHub fetch failed');
      })
      .catch(() => { if (alive) setError('GitHub unreachable'); });
    return () => { alive = false; };
  }, [repo]);

  async function connect() {
    const clean = draft.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\/+$/, '');
    if (!project || !widget?.id || !/^[\w.-]+\/[\w.-]+$/.test(clean) || saving) return;
    setSaving(true);
    try {
      const next = await persistWidgetProps(project, widget.id, props => ({ ...props, repo: clean }));
      if (next) { setRepo(clean); window.showToast?.(`Connected ${clean}`, 'success'); }
      else window.showToast?.('Connecting failed — save the layout first?', 'error');
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
          {data?.branch && <span className="br">{data.branch}</span>}
        </a>
        {data && <span className={'gh-ci ' + data.ci}>{CI_LABEL[data.ci] || data.ci}</span>}
      </div>
      {error ? (
        <div className="gh-error">{error}</div>
      ) : !data ? (
        <div className="nt-loading">Loading…</div>
      ) : (
        <div className="gh-body">
          <div className="gh-sec hide-narrow">
            <div className="gh-sec-h"><GitPullRequest size={11} /> Open PRs · {data.pulls.length}{data.pulls.length === 5 ? '+' : ''}</div>
            {data.pulls.length === 0 ? (
              <span className="gh-none">No open pull requests</span>
            ) : data.pulls.slice(0, 3).map(p => (
              <a key={p.number} className="gh-row" href={editing ? undefined : `https://github.com/${repo}/pull/${p.number}`}
                target="_blank" rel="noreferrer" onClick={e => { if (editing) e.preventDefault(); }}>
                <span className="num">#{p.number}</span>
                <span className="msg">{p.draft ? '[draft] ' : ''}{p.title}</span>
              </a>
            ))}
          </div>
          <div className="gh-sec">
            <div className="gh-sec-h">Latest commits</div>
            {data.commits.slice(0, 3).map(c => (
              <a key={c.sha} className="gh-row" href={editing ? undefined : `https://github.com/${repo}/commit/${c.sha}`}
                target="_blank" rel="noreferrer" onClick={e => { if (editing) e.preventDefault(); }}>
                <span className="num">{c.sha}</span>
                <span className="msg">{c.message}</span>
                <span className="when">{ago(c.date)}</span>
              </a>
            ))}
          </div>
        </div>
      )}
    </OvWidget>
  );
}
