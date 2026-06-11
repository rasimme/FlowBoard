import { useEffect, useState } from 'react';
import { GripVertical, X, Clock, Plus, Kanban, Lightbulb, Folder, FileText } from 'lucide-react';
import AgentChip from '../AgentChip.jsx';
import { useAppState } from '../../context/AppStateContext.jsx';

/**
 * Overview widget catalog (T-305) — live-data implementations of the
 * Claude Design handoff (context/claude-design-t305). Every widget is an
 * <OvWidget> card whose content adapts via container queries from w=4 to
 * w=12; all layout classes live in styles/overview.css.
 */

/* ---------- widget shell ---------- */
export function OvWidget({ title, meta, editing, sizeChip, onRemove, children }) {
  return (
    <section className="ov-widget">
      <div className="ov-whead">
        {editing && <span className="ov-grip" title="Drag to move"><GripVertical size={11} /></span>}
        <span className="ov-wtitle">{title}</span>
        {meta && <span className="ov-wmeta">{meta}</span>}
        {editing && (
          <button type="button" className="ov-wx" title="Remove widget" aria-label="Remove widget" onClick={onRemove} style={{ marginLeft: meta ? 6 : 'auto' }}>
            <X size={11} />
          </button>
        )}
      </div>
      <div className="ov-wbody">{children}</div>
      {editing && <span className="ov-resize" title="Resize"></span>}
      {editing && sizeChip && <span className="ov-sizechip">{sizeChip}</span>}
    </section>
  );
}

/* ---------- shared data helpers ---------- */
function useProjectTasks() {
  const { state } = useAppState();
  return (state?.tasks || []).filter(t => !t.trashedAt);
}

function useProjectFile(project, filename) {
  const [content, setContent] = useState(null);
  useEffect(() => {
    if (!project) return;
    let alive = true;
    fetch(`/api/projects/${project}/files/${filename}`, { credentials: 'include' })
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (alive) setContent(d?.content ?? null); })
      .catch(() => { if (alive) setContent(null); });
    return () => { alive = false; };
  }, [project, filename]);
  return content;
}

function goTab(tab) {
  window._reactDispatch?.({ currentTab: tab });
  if (tab === 'ideas') window._switchTab?.('ideas');
}

/* ---------- active-agents ---------- */
function leaseState(task) {
  if (!task.leaseUntil) return { label: '—', cls: '' };
  const ms = new Date(task.leaseUntil).getTime() - Date.now();
  if (ms <= 0) return { label: 'stealable', cls: ' expired' };
  const min = Math.round(ms / 60000);
  return { label: `lease ${min}m`, cls: min <= 5 ? ' expiring' : '' };
}

export function ActiveAgentsWidget({ widget }) {
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
            <div key={agent + task.id} className="ov-agent-row">
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

export function TaskStatsWidget({ widget }) {
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

export function NextUpWidget({ widget }) {
  const tasks = useProjectTasks();
  const limit = widget?.props?.limit || 5;
  const next = tasks
    .filter(t => (t.status === 'open' || t.status === 'backlog') && !t.parentId)
    .sort((a, b) => (PRIO_RANK[a.priority] ?? 3) - (PRIO_RANK[b.priority] ?? 3) || (a.status === 'open' ? -1 : 1))
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
  const sections = md.split(/^##\s+/m).slice(1);
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
export function RecentDecisionsWidget({ widget }) {
  const { state } = useAppState();
  const md = useProjectFile(state?.viewedProject, 'DECISIONS.md');
  const count = widget?.props?.count || 3;
  const decisions = parseDecisions(md).slice(0, count);

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
export function ProjectGoalsWidget({ widget }) {
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
export function QuickLinksWidget({ widget }) {
  const tiles = Boolean(widget?.props?.tiles);
  return (
    <OvWidget title={widget?.title || 'Quick Links'}>
      <div className={'ov-links' + (tiles ? ' tiles' : '')}>
        <button type="button" className="ov-link" onClick={() => goTab('ideas')}><Lightbulb size={15} /><span>Ideas Canvas</span></button>
        <button type="button" className="ov-link" onClick={() => goTab('tasks')}><Kanban size={15} /><span>Kanban</span></button>
        <button type="button" className="ov-link" onClick={() => goTab('files')}><Folder size={15} /><span>Files</span></button>
        <button type="button" className="ov-link primary" onClick={() => { goTab('tasks'); window._openNewTask?.(); }}><Plus size={15} /><span>New Task</span></button>
      </div>
    </OvWidget>
  );
}

/* ---------- kanban-mini ---------- */
export function KanbanMiniWidget({ widget }) {
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
