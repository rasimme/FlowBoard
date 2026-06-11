import { useEffect, useState } from 'react';
import { Clock, Plus, Kanban, Lightbulb, Folder, FileText } from 'lucide-react';
import AgentChip from '../AgentChip.jsx';
import { useAppState } from '../../context/AppStateContext.jsx';

/**
 * Overview widget catalog (T-305) — live-data implementations of the
 * Claude Design handoff (context/claude-design-t305). Every widget is an
 * <OvWidget> card whose content adapts via container queries from w=4 to
 * w=12; all layout classes live in styles/overview.css.
 */

/* ---------- widget shell ---------- */
// Edit chrome (drag affordance, remove button) lives OUTSIDE the card as a
// cell overlay (see OverviewView) so the widget renders identically in view
// and edit mode.
export function OvWidget({ title, meta, children }) {
  return (
    <section className="ov-widget">
      <div className="ov-whead">
        <span className="ov-wtitle">{title}</span>
        {meta && <span className="ov-wmeta">{meta}</span>}
      </div>
      <div className="ov-wbody">{children}</div>
    </section>
  );
}

/* ---------- shared data helpers ---------- */
function useProjectTasks() {
  const { state } = useAppState();
  return (state?.tasks || []).filter(t => !t.trashedAt);
}

// Module-level caches: widgets remount when the view/edit renderer swaps —
// serving the last known data immediately avoids the empty-state flash.
const _fileCache = new Map();
const _activityCache = new Map();

function useProjectFile(project, filename) {
  const key = `${project}:${filename}`;
  const [content, setContent] = useState(() => _fileCache.get(key) ?? null);
  useEffect(() => {
    if (!project) return;
    let alive = true;
    if (_fileCache.has(key)) setContent(_fileCache.get(key));
    fetch(`/api/projects/${project}/files/${filename}`, { credentials: 'include' })
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        const c = d?.content ?? null;
        _fileCache.set(key, c);
        if (alive) setContent(c);
      })
      .catch(() => { if (alive && !_fileCache.has(key)) setContent(null); });
    return () => { alive = false; };
  }, [project, filename, key]);
  return content;
}

// Navigate like the TabBar does: dispatch the shared tab state, and hand
// off to the legacy DOM switcher only for legacy-owned views.
function useGoTab() {
  const { dispatch } = useAppState();
  return (tab) => {
    dispatch({ currentTab: tab });
    if (tab === 'ideas') window._switchTab?.('ideas');
  };
}

/* ---------- active-agents ---------- */
function leaseState(task) {
  if (!task.leaseUntil) return { label: '—', cls: '' };
  const ms = new Date(task.leaseUntil).getTime() - Date.now();
  if (ms <= 0) return { label: 'stealable', cls: ' expired' };
  const min = Math.round(ms / 60000);
  return { label: `lease ${min}m`, cls: min <= 5 ? ' expiring' : '' };
}

export function ActiveAgentsWidget({ widget, editing, onRemove }) {
  const goTab = useGoTab();
  const tasks = useProjectTasks();
  const { state } = useAppState();
  const maxRows = widget?.props?.maxRows || 6;

  const claims = tasks
    .filter(t => t.agent && t.claimedAt)
    .map(t => ({ agent: t.agent, task: t }))
    .sort((a, b) => String(b.task.lastCheckpointAt || '').localeCompare(String(a.task.lastCheckpointAt || '')));
  const claiming = new Set(claims.map(c => c.agent));
  const idle = (state?.agents || [])
    .filter(a => a.active_project === state?.viewedProject && !claiming.has(a.agent_id))
    .map(a => ({ agent: a.agent_id }));
  const rows = [...claims, ...idle].slice(0, maxRows);

  return (
    <OvWidget title={widget?.title || 'Active Agents'} meta={`${claims.length} claiming`}>
      <div className="ov-agents">
        {rows.length === 0 && (
          <div className="ov-empty">
            <span className="ov-empty-title">No agents on this project</span>
            <span className="ov-empty-hint">Agents appear here as soon as they claim a task or activate the project.</span>
          </div>
        )}
        {rows.map(({ agent, task }) => {
          if (!task) {
            return (
              <div key={agent} className="ov-agent-row idle">
                <span className="ov-agent-id"><AgentChip name={agent} size="md" variant="soft" /></span>
                <span className="ov-agent-main">
                  <span className="ov-agent-handle">@{agent}</span>
                  <span className="ov-agent-task hide-narrow">idle · no claim</span>
                </span>
                <span className="ov-lease">—</span>
              </div>
            );
          }
          const lease = leaseState(task);
          const fresh = task.lastCheckpointAt && (Date.now() - new Date(task.lastCheckpointAt).getTime()) < 10 * 60 * 1000;
          return (
            <div
              key={agent + task.id}
              className="ov-agent-row"
              style={{ cursor: editing ? undefined : 'pointer' }}
              onClick={editing ? undefined : () => { goTab('tasks'); window._scrollToTaskId = task.id; }}
              title={editing ? undefined : `Open ${task.id} on the board`}
            >
              <span className="ov-agent-id"><AgentChip name={agent} size="md" /></span>
              <span className="ov-agent-main">
                <span className="ov-agent-handle">@{agent}</span>
                <span className="ov-agent-task">
                  <span className="tid">{task.id}</span>
                  <span className="ttl"> · {task.title}</span>
                </span>
              </span>
              <span className={'ov-lease' + lease.cls}><Clock size={10} /> {lease.label}</span>
              {fresh && <span className="ov-pulse" title="Active — checkpointing"></span>}
            </div>
          );
        })}
      </div>
    </OvWidget>
  );
}

/* ---------- task-stats ---------- */
const STATUS_COLORS = {
  backlog: '#5a5f6a',
  open: 'var(--status-open)',
  'in-progress': 'var(--status-in-progress)',
  review: 'var(--status-review)',
  done: 'var(--status-done)',
};
const STATUS_ORDER = ['backlog', 'open', 'in-progress', 'review', 'done'];
const STATUS_LABELS = { backlog: 'Backlog', open: 'Open', 'in-progress': 'In Progress', review: 'Review', done: 'Done' };

export function TaskStatsWidget({ widget, editing, onRemove }) {
  const tasks = useProjectTasks().filter(t => t.status !== 'archived');
  const { state } = useAppState();
  const [stuck, setStuck] = useState(0);

  useEffect(() => {
    let alive = true;
    fetch('/api/tasks/stuck', { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        if (!alive) return;
        const mine = (d?.stuck?.combined || []).filter(t => t.project === state?.viewedProject);
        setStuck(mine.length);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [state?.viewedProject]);

  const counts = Object.fromEntries(STATUS_ORDER.map(s => [s, 0]));
  for (const t of tasks) if (counts[t.status] !== undefined) counts[t.status]++;
  const total = tasks.length || 1;

  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const doneDated = tasks.filter(t => t.status === 'done' && t.completed);
  const throughput = doneDated.filter(t => now - new Date(t.completed).getTime() < 7 * day).length;
  const cycles = doneDated
    .filter(t => t.created)
    .map(t => (new Date(t.completed).getTime() - new Date(t.created).getTime()) / day)
    .filter(d => d >= 0)
    .slice(-30);
  const avgCycle = cycles.length ? (cycles.reduce((a, b) => a + b, 0) / cycles.length) : null;

  const spark = Array.from({ length: 7 }, (_, i) => {
    const dayStart = now - (6 - i) * day;
    return doneDated.filter(t => {
      const ts = new Date(t.completed).getTime();
      return ts >= dayStart - day / 2 && ts < dayStart + day / 2;
    }).length;
  });
  const max = Math.max(...spark, 1);

  return (
    <OvWidget title={widget?.title || 'Task Stats'} meta={`${tasks.length} tasks`}>
      <div style={{ display: 'flex', gap: 22, minHeight: 0, flex: 1 }}>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <div className="ov-statbar">
            {STATUS_ORDER.map(s => (
              <span key={s} style={{ width: (counts[s] / total * 100) + '%', background: STATUS_COLORS[s] }}></span>
            ))}
          </div>
          <div className="ov-legend">
            {STATUS_ORDER.map(s => (
              <span key={s} className="ov-legend-item">
                <span className="dot" style={{ background: STATUS_COLORS[s] }}></span>
                {STATUS_LABELS[s]} <span className="n">{counts[s]}</span>
              </span>
            ))}
          </div>
          <div className="ov-kpis">
            <span className="ov-kpi">
              <span className="num">{throughput}<em>/7d</em></span>
              <span className="lbl">Throughput</span>
            </span>
            {avgCycle !== null && (
              <span className="ov-kpi">
                <span className="num">{avgCycle.toFixed(1)}<em>d</em></span>
                <span className="lbl">Avg cycle</span>
              </span>
            )}
            {stuck > 0 && <span className="ov-stuck">⚠ {stuck} stuck</span>}
          </div>
        </div>
        <div className="ov-spark" style={{ flexShrink: 0, alignSelf: 'flex-end' }}>
          <div className="bars">
            {spark.map((v, i) => (
              <i key={i} className={i === spark.length - 1 ? 'hi' : ''} style={{ height: Math.round(v / max * 100) + '%' }}></i>
            ))}
          </div>
          <div className="lbl">Done · last 7d</div>
        </div>
      </div>
    </OvWidget>
  );
}

/* ---------- next-up ---------- */
const PRIO_RANK = { high: 0, medium: 1, low: 2 };

export function NextUpWidget({ widget, editing, onRemove }) {
  const goTab = useGoTab();
  const tasks = useProjectTasks();
  const limit = widget?.props?.limit || 5;
  // "next" = claimable first: open ranks above backlog, then priority,
  // then age. Statuses are configurable via props.statuses.
  const statuses = widget?.props?.statuses || ['open', 'backlog'];
  const statusRank = Object.fromEntries(statuses.map((s, i) => [s, i]));
  const next = tasks
    .filter(t => statusRank[t.status] !== undefined && !t.parentId)
    .sort((a, b) =>
      statusRank[a.status] - statusRank[b.status]
      || (PRIO_RANK[a.priority] ?? 3) - (PRIO_RANK[b.priority] ?? 3)
      || String(a.created || '').localeCompare(String(b.created || '')))
    .slice(0, limit);

  return (
    <OvWidget title={widget?.title || 'Next Up'} meta={`top ${limit} by priority`}>
      <div className="ov-tasks">
        {next.length === 0 && (
          <div className="ov-empty">
            <span className="ov-empty-title">Nothing queued</span>
            <span className="ov-empty-hint">Open and backlog tasks show up here, ordered by priority.</span>
          </div>
        )}
        {next.map(t => (
          <div key={t.id} className="ov-task-row" onClick={() => { goTab('tasks'); window._scrollToTaskId = t.id; }}>
            <span className="ov-task-id">{t.id}</span>
            <span className="ov-task-title">{t.title}</span>
            <span className={'ov-pill ' + (t.priority || 'medium')}>{t.priority || 'medium'}</span>
          </div>
        ))}
      </div>
    </OvWidget>
  );
}

/* ---------- markdown parsing (tolerant) ---------- */
function parseDecisions(md) {
  if (!md) return [];
  const entries = [];
  const sections = md.split(/^#{2,3}\s+/m).slice(1);
  for (const sec of sections) {
    const lines = sec.split('\n');
    const heading = (lines[0] || '').trim();
    const body = lines.slice(1).join(' ').replace(/[#>*_`]/g, '').trim();
    const dateMatch = heading.match(/(\d{4}-\d{2}-\d{2})/);
    let date = '';
    if (dateMatch) {
      const d = new Date(dateMatch[1]);
      date = d.toLocaleDateString('en', { month: 'short', day: 'numeric' });
    }
    const title = heading.replace(/\d{4}-\d{2}-\d{2}\s*[—–-]?\s*/, '').trim() || heading;
    entries.push({ date, title, text: body.slice(0, 200) });
  }
  return entries;
}

/* ---------- recent-decisions ---------- */
export function RecentDecisionsWidget({ widget, editing, onRemove }) {
  const goTab = useGoTab();
  const { state } = useAppState();
  const md = useProjectFile(state?.viewedProject, 'DECISIONS.md');
  const count = widget?.props?.count || 3;
  // the file is chronological (newest appended) — show the latest first
  const decisions = parseDecisions(md).slice(-count).reverse();

  return (
    <OvWidget title={widget?.title || 'Recent Decisions'} meta={decisions.length ? 'DECISIONS.md' : null}>
      {decisions.length === 0 ? (
        <div className="ov-empty">
          <FileText size={22} />
          <span className="ov-empty-title">No decisions documented yet</span>
          <span className="ov-empty-hint">
            Entries appear here as soon as you — or an agent working on this project — append to{' '}
            <span style={{ fontFamily: '"JetBrains Mono", monospace', color: 'var(--text)' }}>DECISIONS.md</span>.
          </span>
        </div>
      ) : (
        <>
          <div className="ov-decs">
            {decisions.map((d, i) => (
              <div key={i} className="ov-dec">
                <span className="ov-dec-date">{d.date}</span>
                <span className="ov-dec-body">
                  <span className="ov-dec-title">{d.title}</span>
                  <span className="ov-dec-text">{d.text}</span>
                </span>
              </div>
            ))}
          </div>
          <div className="ov-wfoot" onClick={() => goTab('files')}>DECISIONS.md →</div>
        </>
      )}
    </OvWidget>
  );
}

/* ---------- project-goals ---------- */
export function ProjectGoalsWidget({ widget, editing, onRemove }) {
  const goTab = useGoTab();
  const { state } = useAppState();
  const md = useProjectFile(state?.viewedProject, 'PROJECT.md');

  let goal = null;
  if (md) {
    const m = md.match(/^##\s+(Ziel|Goal)\s*\n+([\s\S]*?)(?=^##\s|\Z)/m);
    goal = (m ? m[2] : md.split(/^##\s/m)[0].split('\n').slice(1).join(' '))
      .replace(/[#>*_`\[\]]/g, '').trim().slice(0, 280);
  }

  return (
    <OvWidget title={widget?.title || 'Project Goal'} meta={md ? 'PROJECT.md' : null}>
      {!goal ? (
        <div className="ov-empty">
          <FileText size={22} />
          <span className="ov-empty-title">No PROJECT.md yet</span>
          <span className="ov-empty-hint">The project goal renders here from PROJECT.md — markdown stays the source of truth.</span>
        </div>
      ) : (
        <>
          <div className="ov-goal-text">{goal}</div>
          <div className="ov-wfoot" onClick={() => goTab('files')}>PROJECT.md →</div>
        </>
      )}
    </OvWidget>
  );
}

/* ---------- quick-links ---------- */
export function QuickLinksWidget({ widget, editing, onRemove }) {
  const goTab = useGoTab();
  const tiles = Boolean(widget?.props?.tiles);
  return (
    <OvWidget title={widget?.title || 'Quick Links'}>
      <div className={'ov-links' + (tiles ? ' tiles' : '')}>
        <button type="button" className="ov-link" title="Ideas Canvas" onClick={() => goTab('ideas')}><Lightbulb size={15} /><span>Ideas Canvas</span></button>
        <button type="button" className="ov-link" title="Kanban" onClick={() => goTab('tasks')}><Kanban size={15} /><span>Kanban</span></button>
        <button type="button" className="ov-link" title="Files" onClick={() => goTab('files')}><Folder size={15} /><span>Files</span></button>
        <button type="button" className="ov-link primary" title="New Task" onClick={() => { goTab('tasks'); window._openNewTask?.(); }}><Plus size={15} /><span>New Task</span></button>
      </div>
    </OvWidget>
  );
}

/* ---------- kanban-mini ---------- */
export function KanbanMiniWidget({ widget, editing, onRemove }) {
  const goTab = useGoTab();
  const tasks = useProjectTasks().filter(t => !t.parentId && t.status !== 'archived');
  const cols = STATUS_ORDER.map(s => {
    const inCol = tasks.filter(t => t.status === s);
    return {
      key: s,
      label: STATUS_LABELS[s],
      n: inCol.length,
      bars: inCol.slice(0, 3),
      more: Math.max(0, inCol.length - 3),
    };
  });

  return (
    <OvWidget title={widget?.title || 'Board Preview'} meta="opens Kanban">
      <div className="ov-kmini" onClick={() => goTab('tasks')} style={{ cursor: 'pointer' }}>
        {cols.map(c => (
          <div key={c.key} className="ov-kcol">
            <div className="ov-kcol-head">
              <span className="ov-kcol-title">{c.label}</span>
              <span className="ov-kcol-count">{c.n}</span>
            </div>
            <div className="ov-kbars">
              {c.bars.map(t => (
                <span key={t.id} className="ov-kbar" title={`${t.id} ${t.title}`}>
                  {t.agent && <AgentChip name={t.agent} size="xs" />}
                </span>
              ))}
              {c.more > 0 && <span className="ov-kmore">+{c.more} more</span>}
            </div>
          </div>
        ))}
      </div>
    </OvWidget>
  );
}

/* =====================================================================
   T-306 — needs-me cluster + re-orientation widgets (concept update 2)
   ===================================================================== */

function timeAgo(ts) {
  if (!ts) return '';
  const min = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 60000));
  if (min < 60) return `${min}m`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

/* ---------- current-focus: the prominent "who is on what, since when" ---------- */
export function CurrentFocusWidget({ widget, editing }) {
  const goTab = useGoTab();
  const tasks = useProjectTasks();
  const claims = tasks
    .filter(t => t.agent && t.claimedAt)
    .sort((a, b) => String(b.lastCheckpointAt || b.claimedAt).localeCompare(String(a.lastCheckpointAt || a.claimedAt)))
    .slice(0, widget?.props?.maxRows || 4);

  return (
    <OvWidget title={widget?.title || 'Current Focus'} meta={claims.length ? `${claims.length} in flight` : null}>
      <div className="ov-agents">
        {claims.length === 0 && (
          <div className="ov-empty">
            <span className="ov-empty-title">Nothing claimed right now</span>
            <span className="ov-empty-hint">As soon as an agent claims a task, it shows up here with its lease.</span>
          </div>
        )}
        {claims.map(t => {
          const lease = leaseState(t);
          const fresh = t.lastCheckpointAt && (Date.now() - new Date(t.lastCheckpointAt).getTime()) < 10 * 60 * 1000;
          return (
            <div
              key={t.id}
              className="ov-agent-row"
              style={{ cursor: editing ? undefined : 'pointer' }}
              onClick={editing ? undefined : () => { goTab('tasks'); window._scrollToTaskId = t.id; }}
            >
              <span className="ov-agent-id"><AgentChip name={t.agent} size="md" /></span>
              <span className="ov-agent-main">
                <span className="ov-agent-handle">{t.id} · {t.title}</span>
                <span className="ov-agent-task hide-narrow">@{t.agent} · for {timeAgo(t.claimedAt)}</span>
              </span>
              <span className={'ov-lease' + lease.cls}><Clock size={10} /> {lease.label}</span>
              {fresh && <span className="ov-pulse" title="Active — checkpointing"></span>}
            </div>
          );
        })}
      </div>
    </OvWidget>
  );
}

/* ---------- blocked: needs-me — what is stuck on a human ---------- */
export function BlockedWidget({ widget, editing }) {
  const goTab = useGoTab();
  const tasks = useProjectTasks().filter(t => t.blocked && t.status !== 'archived' && t.status !== 'done');
  return (
    <OvWidget title={widget?.title || 'Blocked'} meta={tasks.length ? `${tasks.length} waiting` : null}>
      <div className="ov-tasks">
        {tasks.length === 0 && (
          <div className="ov-empty">
            <span className="ov-empty-title">Nothing blocked</span>
            <span className="ov-empty-hint">Tasks flagged as blocked appear here — they wait for you.</span>
          </div>
        )}
        {tasks.slice(0, widget?.props?.limit || 6).map(t => (
          <div key={t.id} className="ov-task-row" onClick={editing ? undefined : () => { goTab('tasks'); window._scrollToTaskId = t.id; }}>
            <span className="ov-task-id">{t.id}</span>
            <span className="ov-task-title">{t.title}</span>
            <span className="ov-pill high">blocked</span>
          </div>
        ))}
      </div>
    </OvWidget>
  );
}

/* ---------- approvals: needs-me — the review lane is your inbox ---------- */
export function ApprovalsWidget({ widget, editing }) {
  const goTab = useGoTab();
  const tasks = useProjectTasks()
    .filter(t => t.status === 'review')
    .sort((a, b) => String(a.created || '').localeCompare(String(b.created || '')));
  return (
    <OvWidget title={widget?.title || 'Approvals'} meta={tasks.length ? `${tasks.length} in review` : null}>
      <div className="ov-tasks">
        {tasks.length === 0 && (
          <div className="ov-empty">
            <span className="ov-empty-title">Nothing to approve</span>
            <span className="ov-empty-hint">Tasks an agent moved to review land here, waiting for your sign-off.</span>
          </div>
        )}
        {tasks.slice(0, widget?.props?.limit || 6).map(t => (
          <div key={t.id} className="ov-task-row" onClick={editing ? undefined : () => { goTab('tasks'); window._scrollToTaskId = t.id; }}>
            <span className="ov-task-id">{t.id}</span>
            <span className="ov-task-title">{t.title}</span>
            {t.agent && <AgentChip name={t.agent} size="xs" />}
          </div>
        ))}
      </div>
    </OvWidget>
  );
}

/* ---------- shared activity fetch ---------- */
function useActivity(project, since, limit) {
  const key = `${project}:${since || ''}:${limit || 30}`;
  const [items, setItems] = useState(() => _activityCache.get(key) ?? null);
  useEffect(() => {
    if (!project) return;
    let alive = true;
    if (_activityCache.has(key)) setItems(_activityCache.get(key));
    const qs = new URLSearchParams();
    if (since) qs.set('since', since);
    qs.set('limit', String(limit || 30));
    fetch(`/api/projects/${project}/activity?${qs}`, { credentials: 'include' })
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        const a = d?.activity || [];
        _activityCache.set(key, a);
        if (alive) setItems(a);
      })
      .catch(() => { if (alive && !_activityCache.has(key)) setItems([]); });
    return () => { alive = false; };
  }, [project, since, limit, key]);
  return items;
}

function ActivityRows({ items, editing, goTab, emptyTitle, emptyHint }) {
  if (!items) return null;
  if (items.length === 0) {
    return (
      <div className="ov-empty">
        <span className="ov-empty-title">{emptyTitle}</span>
        <span className="ov-empty-hint">{emptyHint}</span>
      </div>
    );
  }
  return (
    <div className="ov-decs">
      {items.map((a, i) => (
        <div
          key={i}
          className="ov-dec"
          style={{ cursor: editing ? undefined : 'pointer' }}
          onClick={editing ? undefined : () => { goTab('tasks'); window._scrollToTaskId = a.taskId; }}
        >
          <span className="ov-dec-date">{timeAgo(a.timestamp)}</span>
          <span className="ov-dec-body">
            <span className="ov-dec-title">{a.taskId}{a.agent ? ` · @${a.agent}` : ''}</span>
            <span className="ov-dec-text">{a.message}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

/* ---------- since-last-visit: what moved while you were away ---------- */
export function SinceLastVisitWidget({ widget, editing }) {
  const goTab = useGoTab();
  const { state } = useAppState();
  const project = state?.viewedProject;
  // capture the previous visit ONCE; bump it when the user actually leaves
  const [sinceTs] = useState(() => {
    const stored = project ? localStorage.getItem(`ov-visit:${project}`) : null;
    return stored || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  });
  useEffect(() => {
    if (!project) return;
    const bump = () => localStorage.setItem(`ov-visit:${project}`, new Date().toISOString());
    window.addEventListener('beforeunload', bump);
    return () => {
      window.removeEventListener('beforeunload', bump);
      bump();
    };
  }, [project]);

  const items = useActivity(project, sinceTs, widget?.props?.limit || 8);
  return (
    <OvWidget title={widget?.title || 'Since your last visit'} meta={items?.length ? `${items.length} updates` : null}>
      <ActivityRows
        items={items}
        editing={editing}
        goTab={goTab}
        emptyTitle="All quiet since your last visit"
        emptyHint="Status changes, checkpoints and comments land here while you are away."
      />
    </OvWidget>
  );
}

/* ---------- activity-stream: plain recent activity ---------- */
export function ActivityStreamWidget({ widget, editing }) {
  const goTab = useGoTab();
  const { state } = useAppState();
  const items = useActivity(state?.viewedProject, null, widget?.props?.limit || 12);
  return (
    <OvWidget title={widget?.title || 'Activity'} meta="latest events">
      <ActivityRows
        items={items}
        editing={editing}
        goTab={goTab}
        emptyTitle="No activity yet"
        emptyHint="Task events show up here as agents and humans work."
      />
    </OvWidget>
  );
}
