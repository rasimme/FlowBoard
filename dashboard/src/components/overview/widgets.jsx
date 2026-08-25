import { useEffect, useState, useRef, useLayoutEffect, Fragment } from 'react';
import { createPortal } from 'react-dom';
import { Clock, Plus, Lightbulb, FileText, FilePlus } from 'lucide-react';
import AgentChip from '../AgentChip.jsx';
import ScrollArea from '../ScrollArea.jsx';
import { useAppState } from '../../context/AppStateContext.jsx';
import { useDashboard } from '../../context/DashboardContext.jsx';
import { useNavigation } from '../../context/NavigationContext.jsx';
import { apiFetch } from '../../utils/apiFetch.js';
import { extractGoal } from '../../utils/projectGoal.mjs';
import { normalizeTaskWorkState } from '../../utils/workState.js';
import {
  activeAgentLeaseHealthLabel,
  buildActiveAgentWidgetRows,
  LEASE_HEALTH,
} from '../../utils/activeAgents.js';

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
    apiFetch(`/api/projects/${project}/files/${filename}`)
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
  const { switchTab } = useDashboard();
  return (tab) => {
    dispatch({ currentTab: tab });
    if (tab === 'ideas') switchTab('ideas');
  };
}

/* ---------- active-agents ---------- */
// T-457: wording/color for a claim's lease now comes from the same source
// as the bar and the task card (`getLeaseHealth`/`LEASE_HEALTH` via
// `activeAgents.js`, `activeAgentLeaseHealthLabel`). "stealable" is gone —
// stale and expired render identically (one amber signal, `.ov-lease
// attention`, reusing the bar's own `.active-agents-health` dot classes so
// a future color change cannot land in one place and not the other); the
// severity still lives in the word, never the color.
const GROUP_LABELS = { working: 'Working', 'needs-attention': 'Needs attention', idle: 'Idle here' };

function leaseCountdownText(task) {
  if (!task?.leaseUntil) return '—';
  const ms = new Date(task.leaseUntil).getTime() - Date.now();
  const min = Math.max(0, Math.round(ms / 60000));
  return `${min}m`;
}

function LeaseBadge({ task, health }) {
  const label = health === LEASE_HEALTH.CURRENT ? leaseCountdownText(task) : activeAgentLeaseHealthLabel(health);
  const attention = health !== LEASE_HEALTH.CURRENT;
  return (
    <span className={'ov-lease' + (attention ? ' attention' : '')} title={`Lease health: ${activeAgentLeaseHealthLabel(health)}`}>
      <span className={`active-agents-health active-agents-health--${health}`}>
        <span className="active-agents-health__dot" aria-hidden="true" />
      </span>
      <Clock size={10} /> {label}
    </span>
  );
}

// Distributes a maxRows display budget across ordered, non-empty groups —
// group labels themselves don't count against it, only agent/claim rows do
// (matches the widgets' prior "claims then idle, sliced" behavior, now
// labeled per group instead of run together, T-457).
function sliceGroupSections(sections, maxRows) {
  let budget = maxRows;
  return sections
    .map(s => {
      const rows = s.rows.slice(0, Math.max(0, budget));
      budget -= rows.length;
      return { key: s.key, rows };
    })
    .filter(s => s.rows.length > 0);
}

export function ActiveAgentsWidget({ widget, editing, onRemove }) {
  const goTab = useGoTab();
  const { goToTask } = useNavigation();
  const tasks = useProjectTasks();
  const { state } = useAppState();
  const maxRows = widget?.props?.maxRows || 14;

  const { working, needsAttention, idle } = buildActiveAgentWidgetRows({
    agents: state?.agents,
    tasks,
    viewedProject: state?.viewedProject,
    staleThresholdMinutes: state?.staleThresholdMinutes,
  });
  const claiming = working.length + needsAttention.length;
  const sections = sliceGroupSections(
    [
      { key: 'working', rows: working },
      { key: 'needs-attention', rows: needsAttention },
      { key: 'idle', rows: idle },
    ],
    maxRows,
  );

  return (
    <OvWidget title={widget?.title || 'Active Agents'} meta={`${claiming} claiming`}>
      <ScrollArea className="flex-1 min-h-0" innerClassName="ov-agents">
        {sections.length === 0 && (
          <div className="ov-empty">
            <span className="ov-empty-title">No agents on this project</span>
            <span className="ov-empty-hint">Agents appear here as soon as they claim a task or activate the project.</span>
          </div>
        )}
        {sections.map(section => (
          <Fragment key={section.key}>
            <div className="ov-agent-group">{GROUP_LABELS[section.key]}</div>
            {section.rows.map(entry => {
              const { agentId, task } = entry;
              if (!task) {
                return (
                  <div key={agentId} className="ov-agent-row idle">
                    <span className="ov-agent-id"><AgentChip name={agentId} size="md" variant="soft" /></span>
                    <span className="ov-agent-main">
                      <span className="ov-agent-handle">@{agentId}</span>
                      <span className="ov-agent-task hide-narrow">idle · no claim</span>
                    </span>
                    <span className="ov-lease">—</span>
                  </div>
                );
              }
              const fresh = task.lastCheckpointAt && (Date.now() - new Date(task.lastCheckpointAt).getTime()) < 10 * 60 * 1000;
              return (
                <div
                  key={agentId + task.id}
                  className="ov-agent-row"
                  style={{ cursor: editing ? undefined : 'pointer' }}
                  onClick={editing ? undefined : () => { goTab('tasks'); goToTask(task.id); }}
                  title={editing ? undefined : `Open ${task.id} on the board`}
                >
                  <span className="ov-agent-id"><AgentChip name={agentId} size="md" /></span>
                  <span className="ov-agent-main">
                    <span className="ov-agent-handle">@{agentId}</span>
                    <span className="ov-agent-task">
                      <span className="tid">{task.id}</span>
                      <span className="ttl"> · {task.title}</span>
                    </span>
                  </span>
                  <LeaseBadge task={task} health={entry.leaseHealth} />
                  {fresh && <span className="ov-pulse" title="Active — checkpointing"></span>}
                </div>
              );
            })}
          </Fragment>
        ))}
      </ScrollArea>
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
  const goTab = useGoTab();
  const { goToTask, goToColumn } = useNavigation();
  const allTasks = useProjectTasks();
  const tasks = allTasks.filter(t => t.status !== 'archived');
  const { state } = useAppState();
  const [stuckTasks, setStuckTasks] = useState([]);

  useEffect(() => {
    let alive = true;
    apiFetch('/api/tasks/stuck')
      .then(r => r.json())
      .then(d => {
        if (!alive) return;
        setStuckTasks((d?.stuck?.combined || []).filter(t => t.project === state?.viewedProject));
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [state?.viewedProject]);
  const stuck = stuckTasks.length;

  // T-389: styled hover/focus tooltip on the spark bars (mirrors Momentum/T-387).
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
  const showTip = (e, v) => { const r = e.currentTarget.getBoundingClientRect(); setTipPos(null); setTip({ v, anchor: { cx: r.left + r.width / 2, top: r.top, bottom: r.bottom } }); };
  const hideTip = () => { setTip(null); setTipPos(null); };

  // stats as a launchpad (inert while editing): a status jumps to that
  // column on the board, the stuck chip to the oldest stuck task itself.
  const jumpTo = (id) => { if (editing || !id) return; goTab('tasks'); goToTask(id); };
  const showColumn = (s) => { if (editing) return; goToColumn(s); goTab('tasks'); };

  const counts = Object.fromEntries(STATUS_ORDER.map(s => [s, 0]));
  for (const t of tasks) if (counts[t.status] !== undefined) counts[t.status]++;
  const total = tasks.length || 1;

  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  // throughput counts finished work even after it gets archived — the
  // archive sweep was silently shrinking "done · 7d"
  const doneDated = allTasks.filter(t => (t.status === 'done' || t.status === 'archived') && t.completed);
  const throughput = doneDated.filter(t => now - new Date(t.completed).getTime() < 7 * day).length;
  const cycles = doneDated
    .filter(t => t.created)
    .map(t => (new Date(t.completed).getTime() - new Date(t.created).getTime()) / day)
    .filter(d => d >= 0)
    .slice(-30);
  const avgCycle = cycles.length ? (cycles.reduce((a, b) => a + b, 0) / cycles.length) : null;

  // calendar-day buckets with labels — bars show "tasks completed that
  // day" (the momentum widget counts ALL events, hence many more bars)
  const spark = Array.from({ length: 7 }, (_, i) => {
    const d0 = new Date(now - (6 - i) * day);
    d0.setHours(0, 0, 0, 0);
    const n = doneDated.filter(t => {
      const ts = new Date(t.completed).getTime();
      return ts >= d0.getTime() && ts < d0.getTime() + day;
    }).length;
    return { n, label: d0.toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric' }) };
  });
    const max = Math.max(...spark.map(x => x.n), 1);

  return (
    <>
    <OvWidget title={widget?.title || 'Task Stats'} meta={`${tasks.length} tasks`}>
      <div className="ts-wrap">
        <div className="ov-statbar">
          {STATUS_ORDER.map(s => (
            <span key={s} style={{ width: (counts[s] / total * 100) + '%', background: STATUS_COLORS[s] }}></span>
          ))}
        </div>
        <div className="ov-legend">
          {STATUS_ORDER.map(s => (
            <button key={s} type="button" className="ov-legend-item"
              disabled={editing}
              title={editing ? undefined : `Show the ${STATUS_LABELS[s]} column on the board`}
              onClick={editing ? undefined : () => showColumn(s)}>
              <span className="dot" style={{ background: STATUS_COLORS[s] }}></span>
              {STATUS_LABELS[s]} <span className="n">{counts[s]}</span>
            </button>
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
          {stuck > 0 && (
            <button type="button" className="ov-stuck" disabled={editing}
              title={editing ? undefined : 'Open the oldest stuck task'}
              onClick={editing ? undefined : () => jumpTo(stuckTasks[0]?.taskId)}>
              ⚠ {stuck} stuck{editing ? '' : ' →'}
            </button>
          )}
        </div>
        <div className="ts-trend">
          <div className="bars">
            {spark.map((v, i) => (
              <i key={i} className={i === spark.length - 1 ? 'hi' : ''}
                tabIndex={0} role="img" aria-label={`${v.label} — ${v.n} done`}
                onMouseEnter={e => showTip(e, { ...v, today: i === spark.length - 1 })} onMouseLeave={hideTip}
                onFocus={e => showTip(e, { ...v, today: i === spark.length - 1 })} onBlur={hideTip}
                style={{ height: v.n ? Math.max(12, Math.round(v.n / max * 100)) + '%' : '6%' }}></i>
            ))}
          </div>
          <div className="lbl">Completed · last 7 days</div>
        </div>
      </div>
    </OvWidget>
    {tip && createPortal(
      <div ref={tipRef} role="tooltip" className="sd-tip"
        style={{ top: tipPos ? tipPos.top : -9999, left: tipPos ? tipPos.left : -9999, visibility: tipPos ? 'visible' : 'hidden' }}>
        <div className="sd-tip-head">
          <span className="sd-tip-date">{tip.v.label}</span>
          {tip.v.today && <span className="sd-tip-today">today</span>}
        </div>
        <div className="sd-tip-total"><b>{tip.v.n}</b> done</div>
      </div>,
      document.body
    )}
    </>
  );
}

/* ---------- next-up ---------- */
const PRIO_RANK = { high: 0, medium: 1, low: 2 };

export function NextUpWidget({ widget, editing, onRemove }) {
  const goTab = useGoTab();
  const { goToTask } = useNavigation();
  const tasks = useProjectTasks();
  const limit = widget?.props?.limit || 12;
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
      <ScrollArea className="flex-1 min-h-0" innerClassName="ov-tasks">
        {next.length === 0 && (
          <div className="ov-empty">
            <span className="ov-empty-title">Nothing queued</span>
            <span className="ov-empty-hint">Open and backlog tasks show up here, ordered by priority.</span>
          </div>
        )}
        {next.map(t => (
          <div key={t.id} className="ov-task-row" onClick={editing ? undefined : () => { goTab('tasks'); goToTask(t.id); }}>
            <span className="ov-task-id">{t.id}</span>
            <span className="ov-task-title">{t.title}</span>
            <span className={'ov-pill ' + (t.priority || 'medium')}>{t.priority || 'medium'}</span>
          </div>
        ))}
      </ScrollArea>
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
    entries.push({ date, iso: dateMatch ? dateMatch[1] : '', title, text: body.slice(0, 200) });
  }
  return entries;
}

/* ---------- recent-decisions ---------- */
export function RecentDecisionsWidget({ widget, editing, onRemove }) {
  const goTab = useGoTab();
  const { openSpec } = useDashboard();
  const { state } = useAppState();
  const md = useProjectFile(state?.viewedProject, 'DECISIONS.md');
  const count = widget?.props?.count || 12;
  // entry order in the file varies (some projects prepend, some append) —
  // sort by the date in the heading, newest first; undated keep file order
  const decisions = parseDecisions(md)
    .map((e, i) => ({ ...e, i }))
    .sort((a, b) => (b.iso || '').localeCompare(a.iso || '') || a.i - b.i)
    .slice(0, count);

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
          <ScrollArea className="flex-1 min-h-0" innerClassName="ov-decs">
            {decisions.map((d, i) => (
              <div key={`${d.iso || ''}:${d.title}:${i}`} className="ov-dec">
                <span className="ov-dec-date">{d.date}</span>
                <span className="ov-dec-body">
                  <span className="ov-dec-title">{d.title}</span>
                  <span className="ov-dec-text">{d.text}</span>
                </span>
              </div>
            ))}
          </ScrollArea>
          <div className="ov-wfoot" onClick={editing ? undefined : () => openSpec('DECISIONS.md', null, { backTab: 'overview' })}>DECISIONS.md →</div>
        </>
      )}
    </OvWidget>
  );
}

/* ---------- project-goals ---------- */
export function ProjectGoalsWidget({ widget, editing, onRemove }) {
  const goTab = useGoTab();
  const { openSpec } = useDashboard();
  const { state } = useAppState();
  const md = useProjectFile(state?.viewedProject, 'PROJECT.md');

  const hasFile = Boolean(md);
  const goal = hasFile ? extractGoal(md) : '';

  return (
    <OvWidget title={widget?.title || 'Project Goal'} meta={hasFile ? 'PROJECT.md' : null}>
      {!goal ? (
        <div className="ov-empty">
          <FileText size={22} />
          <span className="ov-empty-title">{hasFile ? 'No goal section yet' : 'No PROJECT.md yet'}</span>
          <span className="ov-empty-hint">
            {hasFile
              ? 'Add a ## Ziel or ## Goal section to PROJECT.md — it renders here.'
              : 'The project goal renders here from PROJECT.md — markdown stays the source of truth.'}
          </span>
        </div>
      ) : (
        <>
          <ScrollArea className="flex-1 min-h-0" innerClassName="ov-goal-view"
            title="Open PROJECT.md"
            onClick={editing ? undefined : () => openSpec('PROJECT.md', null, { backTab: 'overview' })}
            innerStyle={{ cursor: editing ? undefined : 'pointer' }}>
            <div className="ov-goal-text">{goal}</div>
          </ScrollArea>
          <div className="ov-wfoot ov-goal-foot" onClick={editing ? undefined : () => openSpec('PROJECT.md', null, { backTab: 'overview' })}>PROJECT.md →</div>
        </>
      )}
    </OvWidget>
  );
}

/* ---------- quick-links ---------- */
export function QuickLinksWidget({ widget, editing, onRemove }) {
  const goTab = useGoTab();
  const { requestNewTask, requestNewNote, requestNewFile } = useNavigation();
  return (
    <OvWidget title={widget?.title || 'Quick Actions'}>
      <div className="ov-links">
        <button type="button" className="ov-link main" title="Create a task in the Kanban backlog"
          onClick={() => { requestNewTask(); goTab('tasks'); }}>
          <Plus size={15} /><span>New Task</span><span className="sub">Kanban</span>
        </button>
        <button type="button" className="ov-link" title="Create an idea note on the Ideas canvas"
          onClick={() => { requestNewNote(); goTab('ideas'); }}>
          <Lightbulb size={15} /><span>New Idea</span><span className="sub">Ideas canvas</span>
        </button>
        <button type="button" className="ov-link" title="Create a markdown file in context/"
          onClick={() => { requestNewFile(); goTab('files'); }}>
          <FilePlus size={15} /><span>New File</span><span className="sub">context/</span>
        </button>
      </div>
    </OvWidget>
  );
}

/* ---------- kanban-mini ---------- */
export function KanbanMiniWidget({ widget, editing, onRemove }) {
  const goTab = useGoTab();
  const { goToTask } = useNavigation();
  const tasks = useProjectTasks().filter(t => !t.parentId && t.status !== 'archived');
  const cols = STATUS_ORDER.map(s => {
    const inCol = tasks.filter(t => t.status === s);
    return {
      key: s,
      label: STATUS_LABELS[s],
      n: inCol.length,
      bars: inCol.slice(0, 15),
      more: Math.max(0, inCol.length - 15),
    };
  });

  return (
    <OvWidget title={widget?.title || 'Board Preview'} meta="opens Kanban">
      <div className="ov-kmini" onClick={editing ? undefined : () => goTab('tasks')} style={{ cursor: editing ? undefined : 'pointer' }}>
        {cols.map(c => (
          <div key={c.key} className="ov-kcol">
            <div className="ov-kcol-head">
              <span className="ov-kcol-title">{c.label}</span>
              <span className="ov-kcol-count">{c.n}</span>
            </div>
            <ScrollArea className="flex-1 min-h-0" innerClassName="ov-kbars">
              {c.bars.map(t => (
                <span key={t.id} className="ov-kbar" title={`${t.id} ${t.title}`}
                  onClick={editing ? undefined : e => { e.stopPropagation(); goTab('tasks'); goToTask(t.id); }}>
                  <span className="tid">{t.id}</span>
                  <span className="ttl">{t.title}</span>
                  {t.agent && <AgentChip name={t.agent} size="xs" />}
                </span>
              ))}
              {c.more > 0 && <span className="ov-kmore">+{c.more} more</span>}
            </ScrollArea>
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
// T-457: this widget carried the exact same self-filter bug as
// ActiveAgentsWidget (`t.agent && t.claimedAt`, no archived/done/trashed
// check, its own "stealable" wording) — found via the T-457 sweep for other
// `claimedAt` filters, not something the original bug report named. Same
// predicate/vocabulary source as ActiveAgentsWidget; the task-first row
// layout (its reason for existing as a separate widget) is unchanged, and it
// intentionally has no idle section — it has only ever shown claims.
export function CurrentFocusWidget({ widget, editing }) {
  const goTab = useGoTab();
  const { goToTask } = useNavigation();
  const tasks = useProjectTasks();
  const { state } = useAppState();
  const maxRows = widget?.props?.maxRows || 10;

  const { working, needsAttention } = buildActiveAgentWidgetRows({
    agents: state?.agents,
    tasks,
    viewedProject: state?.viewedProject,
    staleThresholdMinutes: state?.staleThresholdMinutes,
  });
  const claims = working.length + needsAttention.length;
  const sections = sliceGroupSections(
    [
      { key: 'working', rows: working },
      { key: 'needs-attention', rows: needsAttention },
    ],
    maxRows,
  );

  return (
    <OvWidget title={widget?.title || 'Current Focus'} meta={claims ? `${claims} in flight` : null}>
      <ScrollArea className="flex-1 min-h-0" innerClassName="ov-agents">
        {claims === 0 && (
          <div className="ov-empty">
            <span className="ov-empty-title">Nothing claimed right now</span>
            <span className="ov-empty-hint">As soon as an agent claims a task, it shows up here with its lease.</span>
          </div>
        )}
        {sections.map(section => (
          <Fragment key={section.key}>
            <div className="ov-agent-group">{GROUP_LABELS[section.key]}</div>
            {section.rows.map(({ agentId, task, leaseHealth }) => {
              const fresh = task.lastCheckpointAt && (Date.now() - new Date(task.lastCheckpointAt).getTime()) < 10 * 60 * 1000;
              return (
                <div
                  key={agentId + task.id}
                  className="ov-agent-row"
                  style={{ cursor: editing ? undefined : 'pointer' }}
                  onClick={editing ? undefined : () => { goTab('tasks'); goToTask(task.id); }}
                >
                  <span className="ov-agent-id"><AgentChip name={agentId} size="md" /></span>
                  <span className="ov-agent-main">
                    <span className="ov-agent-handle">{task.id} · {task.title}</span>
                    <span className="ov-agent-task hide-narrow">@{agentId} · for {timeAgo(task.claimedAt)}</span>
                  </span>
                  <LeaseBadge task={task} health={leaseHealth} />
                  {fresh && <span className="ov-pulse" title="Active — checkpointing"></span>}
                </div>
              );
            })}
          </Fragment>
        ))}
      </ScrollArea>
    </OvWidget>
  );
}

/* ---------- blocked: needs-me — what is stuck on a human ---------- */
export function BlockedWidget({ widget, editing }) {
  const goTab = useGoTab();
  const { goToTask } = useNavigation();
  // T-452-5: filter on the canonical work state, not the legacy `blocked`
  // boolean that T-452-7 removes server-side. Reading the old field here
  // would leave this widget permanently empty after that removal.
  const tasks = useProjectTasks().filter(t => normalizeTaskWorkState(t).workState === 'blocked'
    && t.status !== 'archived' && t.status !== 'done');
  return (
    <OvWidget title={widget?.title || 'Blocked'} meta={tasks.length ? `${tasks.length} waiting` : null}>
      <ScrollArea className="flex-1 min-h-0" innerClassName="ov-tasks">
        {tasks.length === 0 && (
          <div className="ov-empty">
            <span className="ov-empty-title">Nothing blocked</span>
            <span className="ov-empty-hint">Tasks flagged as blocked appear here — they wait for you.</span>
          </div>
        )}
        {tasks.slice(0, widget?.props?.limit || 14).map(t => (
          <div key={t.id} className="ov-task-row" onClick={editing ? undefined : () => { goTab('tasks'); goToTask(t.id); }}>
            <span className="ov-task-id">{t.id}</span>
            <span className="ov-task-title">{t.title}</span>
            <span className="ov-pill high">blocked</span>
          </div>
        ))}
      </ScrollArea>
    </OvWidget>
  );
}

/* ---------- approvals: needs-me — the review lane is your inbox ---------- */
export function ApprovalsWidget({ widget, editing }) {
  const goTab = useGoTab();
  const { goToTask } = useNavigation();
  const tasks = useProjectTasks()
    .filter(t => t.status === 'review')
    .sort((a, b) => String(a.created || '').localeCompare(String(b.created || '')));
  return (
    <OvWidget title={widget?.title || 'Approvals'} meta={tasks.length ? `${tasks.length} in review` : null}>
      <ScrollArea className="flex-1 min-h-0" innerClassName="ov-tasks">
        {tasks.length === 0 && (
          <div className="ov-empty">
            <span className="ov-empty-title">Nothing to approve</span>
            <span className="ov-empty-hint">Tasks an agent moved to review land here, waiting for your sign-off.</span>
          </div>
        )}
        {tasks.slice(0, widget?.props?.limit || 14).map(t => (
          <div key={t.id} className="ov-task-row" onClick={editing ? undefined : () => { goTab('tasks'); goToTask(t.id); }}>
            <span className="ov-task-id">{t.id}</span>
            <span className="ov-task-title">{t.title}</span>
            {t.agent && <AgentChip name={t.agent} size="xs" />}
          </div>
        ))}
      </ScrollArea>
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
    apiFetch(`/api/projects/${project}/activity?${qs}`)
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
  const { goToTask } = useNavigation();
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
    <ScrollArea className="flex-1 min-h-0" innerClassName="ov-decs">
      {items.map((a, i) => (
        <div
          key={`${a.taskId || ''}:${a.timestamp || ''}:${i}`}
          className="ov-dec"
          style={{ cursor: editing ? undefined : 'pointer' }}
          onClick={editing ? undefined : () => { goTab('tasks'); goToTask(a.taskId); }}
        >
          <span className="ov-dec-date">{timeAgo(a.timestamp)}</span>
          <span className="ov-dec-body">
            <span className="ov-dec-title">{a.taskId}{a.agent ? ` · @${a.agent}` : ''}</span>
            <span className="ov-dec-text">{a.message}</span>
          </span>
        </div>
      ))}
    </ScrollArea>
  );
}

/* ---------- since-last-visit: what moved while you were away ---------- */
export function SinceLastVisitWidget({ widget, editing }) {
  const goTab = useGoTab();
  const { state } = useAppState();
  const project = state?.viewedProject;
  // re-read the previous visit whenever the project changes — the widget
  // does NOT remount on a project switch, so a once-captured value kept the
  // first project's baseline. Read this project's stored timestamp, then
  // bump it on leave (tab switch unmounts → cleanup; full close → beforeunload).
  const [sinceTs, setSinceTs] = useState(null);
  useEffect(() => {
    if (!project) return;
    const stored = localStorage.getItem(`ov-visit:${project}`);
    setSinceTs(stored || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
    const bump = () => localStorage.setItem(`ov-visit:${project}`, new Date().toISOString());
    window.addEventListener('beforeunload', bump);
    return () => {
      window.removeEventListener('beforeunload', bump);
      bump();
    };
  }, [project]);

  const items = useActivity(project, sinceTs, widget?.props?.limit || 20);
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
