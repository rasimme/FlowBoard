import { useEffect, useRef, useState } from 'react';
import { Rocket, ExternalLink } from 'lucide-react';
import { OvWidget } from './widgets.jsx';
import { TokenAffordance, useProjectGithub } from './widgets2.jsx';
import ScrollArea from '../ScrollArea.jsx';
import { useAppState } from '../../context/AppStateContext.jsx';
import { useDashboard } from '../../context/DashboardContext.jsx';
import { useNavigation } from '../../context/NavigationContext.jsx';

/**
 * GitHub widget family (T-316..T-319) — gh-pulls, gh-ci, gh-releases,
 * gh-issues. All views go through GET /api/github/insight (server-side
 * fetch + cache, token never reaches the client) and resolve their repo
 * from props.repo with an inline connect form, like repo-status.
 */

function ago(ts) {
  if (!ts) return '';
  const min = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 60000));
  if (min < 60) return `${min}m`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

function useInsight(repo, view, branch) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!repo) return;
    let alive = true;
    setData(null); setError(null);
    const q = branch ? `&branch=${encodeURIComponent(branch)}` : '';
    fetch(`/api/github/insight?repo=${encodeURIComponent(repo)}&view=${view}${q}`, { credentials: 'include' })
      .then(async r => {
        const d = await r.json().catch(() => ({}));
        if (!alive) return;
        if (r.ok) setData(d.insight);
        else setError(d.error || 'GitHub fetch failed');
      })
      .catch(() => { if (alive) setError('GitHub unreachable'); });
    return () => { alive = false; };
  }, [repo, view, branch, tick]);
  return { data, error, reload: () => setTick(t => t + 1) };
}

function GhError({ error, editing, onRetry }) {
  return (
    <div className="gh-errwrap">
      <div className="gh-error">{error}</div>
      <TokenAffordance editing={editing} onSaved={onRetry} />
    </div>
  );
}

// shared repo plumbing: the project-level binding (one repo per project,
// set once in any gh widget) with widget props as per-widget override
function useRepoProp(widget) {
  const { state } = useAppState();
  const project = state?.viewedProject;
  const { binding, saveBinding } = useProjectGithub(project);
  const repo = widget?.props?.repo || binding?.repo || '';
  const branch = widget?.props?.branch || binding?.branch || '';

  async function connect(raw) {
    const clean = raw.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\/+$/, '');
    if (!project || !/^[\w.-]+\/[\w.-]+$/.test(clean)) return false;
    const ok = await saveBinding(clean, null);
    if (ok) window.showToast?.(`Connected ${clean} for this project`, 'success');
    return ok;
  }
  return { repo, branch, connect };
}

function GhSetup({ hint, editing, onConnect }) {
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit() {
    if (!draft.trim() || saving) return;
    setSaving(true);
    try { await onConnect(draft); } finally { setSaving(false); }
  }
  return (
    <div className="gh-setup">
      <span className="gh-setup-hint">{hint}</span>
      <div className="lk-add">
        <input className="lk-in" placeholder="owner/name" value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') submit(); }}
          disabled={editing} />
        <button type="button" className="lk-btn" onClick={submit} disabled={editing || saving || !draft.trim()}>
          {saving ? '…' : 'Connect'}
        </button>
      </div>
      <TokenAffordance editing={editing} />
    </div>
  );
}

function GhLink({ href, editing, className, children, title, style }) {
  return (
    <a className={className} style={style} href={editing ? undefined : href} target="_blank" rel="noreferrer"
      title={title} onClick={e => { if (editing) e.preventDefault(); }}>
      {children}
    </a>
  );
}

/* ---------- gh-pulls: PR inbox ---------- */
export function GhPullsWidget({ widget, editing }) {
  const { repo, connect } = useRepoProp(widget);
  const { data, error, reload } = useInsight(repo, 'pulls');
  if (!repo) {
    return (
      <OvWidget title={widget?.title || 'Pull Requests'} meta="GitHub">
        <GhSetup editing={editing} onConnect={connect}
          hint="Connect a repository — open PRs, drafts and requested reviews show up here." />
      </OvWidget>
    );
  }
  const pulls = data?.pulls || [];
  const ready = pulls.filter(p => !p.draft);
  const drafts = pulls.filter(p => p.draft);
  const needReview = ready.filter(p => p.reviewers > 0);

  return (
    <OvWidget title={widget?.title || 'Pull Requests'} meta={data ? repo : 'GitHub'}>
      {error ? <GhError error={error} editing={editing} onRetry={reload} /> : !data ? <div className="nt-loading">Loading…</div> : (
        <div className="ghp-wrap">
          <div className="ghp-kpis">
            <span className="ghp-kpi"><b>{ready.length}</b> ready</span>
            <span className="ghp-kpi"><b className={needReview.length ? 'hot' : ''}>{needReview.length}</b> awaiting review</span>
            <span className="ghp-kpi"><b>{drafts.length}</b> draft{drafts.length === 1 ? '' : 's'}</span>
          </div>
          {pulls.length > 0 && (
            <div className="ghp-split" aria-hidden="true">
              {needReview.length > 0 && <span className="rev" style={{ flex: needReview.length }}></span>}
              {ready.length - needReview.length > 0 && <span className="rdy" style={{ flex: ready.length - needReview.length }}></span>}
              {drafts.length > 0 && <span className="drf" style={{ flex: drafts.length }}></span>}
            </div>
          )}
          {pulls.length === 0 ? (
            <span className="gh-none">No open pull requests — clean slate.</span>
          ) : (
            <ScrollArea className="flex-1 min-h-0" innerClassName="gh-rows">
              {[...needReview, ...ready.filter(p => p.reviewers === 0), ...drafts].slice(0, 5).map(p => (
                <GhLink key={p.number} className={'gh-row' + (p.draft ? ' dim' : '')} editing={editing}
                  href={`https://github.com/${repo}/pull/${p.number}`}>
                  <span className="num">#{p.number}</span>
                  <span className="msg">{p.draft ? '[draft] ' : ''}{p.title}</span>
                  {p.reviewers > 0 && <span className="ghp-rev" title={`${p.reviewers} review${p.reviewers === 1 ? '' : 's'} requested`}>{p.reviewers}⊙</span>}
                  <span className="when">{ago(p.updatedAt)}</span>
                </GhLink>
              ))}
            </ScrollArea>
          )}
        </div>
      )}
    </OvWidget>
  );
}

/* ---------- gh-ci: workflow run history ---------- */
const RUN_COLOR = { success: 'ok', failure: 'fail', cancelled: 'mute', timed_out: 'fail' };

export function GhCiWidget({ widget, editing }) {
  const { repo, branch, connect } = useRepoProp(widget);
  const { data, error, reload } = useInsight(repo, 'ci', branch);
  const runCount = (data?.runs || []).length;
  // integer bar widths — fractional flex/grid tracks render with visibly
  // uneven gaps on some zoom levels. Hooks live ABOVE the early return:
  // conditional hook counts crash React (#310).
  const barsRef = useRef(null);
  const [barW, setBarW] = useState(null);
  useEffect(() => {
    const el = barsRef.current;
    if (!el || runCount === 0) return;
    const measure = () => setBarW(Math.max(3, Math.floor((el.clientWidth - (runCount - 1) * 3) / runCount)));
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, [runCount]);
  if (!repo) {
    return (
      <OvWidget title={widget?.title || 'CI Runs'} meta="GitHub">
        <GhSetup editing={editing} onConnect={connect}
          hint="Connect a repository — workflow run history and duration trend show up here." />
      </OvWidget>
    );
  }
  const runs = (data?.runs || []).slice().reverse(); // oldest → newest
  const done = runs.filter(r => r.status === 'completed');
  const passRate = done.length ? Math.round((done.filter(r => r.conclusion === 'success').length / done.length) * 100) : null;
  // a still-running run has no updatedAt → guard NaN so the bar height stays finite
  const durations = runs.map(r => {
    const d = (new Date(r.updatedAt) - new Date(r.startedAt)) / 1000;
    return Number.isFinite(d) && d > 0 ? d : 0;
  });
  const maxDur = Math.max(...durations, 1);
  const latest = runs[runs.length - 1];

  return (
    <OvWidget title={widget?.title || 'CI Runs'}
      meta={data ? `${data.branch}${passRate !== null ? ` · ${passRate}% pass` : ''}` : 'GitHub'}>
      {error ? <GhError error={error} editing={editing} onRetry={reload} /> : !data ? <div className="nt-loading">Loading…</div> : runs.length === 0 ? (
        <span className="gh-none">No workflow runs on {data.branch} yet.</span>
      ) : (
        <div className="ghc-wrap">
          <div className="ghc-bars" ref={barsRef}>
            {runs.map((r, i) => {
              const dur = durations[i];
              const cls = r.status !== 'completed' ? 'live' : (RUN_COLOR[r.conclusion] || 'mute');
              const mins = dur >= 90 ? `${Math.round(dur / 60)}min` : `${Math.round(dur)}s`;
              return (
                <GhLink key={r.id} editing={editing} href={r.url} className={'ghc-bar ' + cls}
                  style={barW ? { width: barW + 'px', flex: 'none' } : undefined}
                  title={`${r.name} #${r.number} — ${r.status === 'completed' ? r.conclusion : r.status} · ${mins} · ${ago(r.startedAt)} ago`}>
                  <i style={{ height: (15 + (dur / maxDur) * 85) + '%' }}></i>
                </GhLink>
              );
            })}
          </div>
          {latest && (
            <GhLink className="ghc-latest" editing={editing} href={latest.url}>
              <span className={'ghc-dot ' + (latest.status !== 'completed' ? 'live' : (RUN_COLOR[latest.conclusion] || 'mute'))}></span>
              <span className="msg">{latest.name} <span className="num">#{latest.number}</span></span>
              <span className="when">{latest.status === 'completed' ? latest.conclusion : latest.status} · {ago(latest.startedAt)} ago</span>
            </GhLink>
          )}
        </div>
      )}
    </OvWidget>
  );
}

/* ---------- gh-releases: latest release + unreleased work ---------- */
export function GhReleasesWidget({ widget, editing }) {
  const { repo, connect } = useRepoProp(widget);
  const { data, error, reload } = useInsight(repo, 'releases');
  if (!repo) {
    return (
      <OvWidget title={widget?.title || 'Releases'} meta="GitHub">
        <GhSetup editing={editing} onConnect={connect}
          hint="Connect a repository — the latest release and everything unreleased show up here." />
      </OvWidget>
    );
  }
  return (
    <OvWidget title={widget?.title || 'Releases'} meta={data ? repo : 'GitHub'}>
      {error ? <GhError error={error} editing={editing} onRetry={reload} /> : !data ? <div className="nt-loading">Loading…</div> : !data.latest ? (
        <span className="gh-none">No releases yet — tag one and it shows up here.</span>
      ) : (
        <div className="ghr-wrap">
          <div className="ghr-head">
            <GhLink className="ghr-tag" editing={editing} href={data.latest.url}>
              <Rocket size={14} />
              <span className="tag">{data.latest.tag}</span>
              {data.latest.prerelease && <span className="pre">pre</span>}
            </GhLink>
            <span className="ghr-when">released {ago(data.latest.publishedAt)} ago</span>
          </div>
          {data.ahead !== null && (
            <GhLink className="ghr-ahead" editing={editing}
              href={`https://github.com/${repo}/compare/${data.latest.tag}...${data.defaultBranch}`}>
              <span className="n">{data.ahead}</span>
              <span className="lbl">commit{data.ahead === 1 ? '' : 's'} on {data.defaultBranch} since {data.latest.tag}</span>
              <ExternalLink size={11} className="text-muted shrink-0" />
            </GhLink>
          )}
          {data.unreleased.length > 0 && (
            <div className="gh-rows only-wide">
              {data.unreleased.map(c => (
                <GhLink key={c.sha} className="gh-row" editing={editing} href={`https://github.com/${repo}/commit/${c.sha}`}>
                  <span className="num">{c.sha}</span>
                  <span className="msg">{c.message}</span>
                </GhLink>
              ))}
            </div>
          )}
        </div>
      )}
    </OvWidget>
  );
}

/* ---------- gh-issues: triage view ---------- */
export function GhIssuesWidget({ widget, editing }) {
  const { repo, connect } = useRepoProp(widget);
  const { data, error, reload } = useInsight(repo, 'issues');
  if (!repo) {
    return (
      <OvWidget title={widget?.title || 'Issues'} meta="GitHub">
        <GhSetup editing={editing} onConnect={connect}
          hint="Connect a repository — new and unanswered issues show up here for triage." />
      </OvWidget>
    );
  }
  const issues = data?.issues || [];
  const day = 86400000;
  const now = Date.now();
  const unanswered = issues.filter(i => i.comments === 0);
  const fresh = issues.filter(i => now - new Date(i.createdAt).getTime() < 7 * day);
  const buckets = [
    { label: '< 1d', n: issues.filter(i => now - new Date(i.createdAt) < day).length },
    { label: '≤ 7d', n: issues.filter(i => { const a = now - new Date(i.createdAt); return a >= day && a < 7 * day; }).length },
    { label: '≤ 30d', n: issues.filter(i => { const a = now - new Date(i.createdAt); return a >= 7 * day && a < 30 * day; }).length },
    { label: 'older', n: issues.filter(i => now - new Date(i.createdAt) >= 30 * day).length },
  ];
  const maxB = Math.max(...buckets.map(b => b.n), 1);

  return (
    <OvWidget title={widget?.title || 'Issues'} meta={data ? repo : 'GitHub'}>
      {error ? <GhError error={error} editing={editing} onRetry={reload} /> : !data ? <div className="nt-loading">Loading…</div> : issues.length === 0 ? (
        <span className="gh-none">No open issues — inbox zero.</span>
      ) : (
        <div className="ghi-wrap">
          <div className="ghp-kpis">
            <span className="ghp-kpi"><b>{issues.length}</b> open</span>
            <span className="ghp-kpi"><b className={unanswered.length ? 'hot' : ''}>{unanswered.length}</b> unanswered</span>
            <span className="ghp-kpi"><b>{fresh.length}</b> new · 7d</span>
          </div>
          <div className="ghi-age only-wide" aria-hidden="true">
            {buckets.map(b => (
              <div key={b.label} className="ghi-bucket" title={`${b.n} issue${b.n === 1 ? '' : 's'} ${b.label}`}>
                <span className="bar"><i style={{ width: (b.n / maxB) * 100 + '%' }}></i></span>
                <span className="lbl">{b.label}</span>
                <span className="n">{b.n}</span>
              </div>
            ))}
          </div>
          <ScrollArea className="flex-1 min-h-0" innerClassName="gh-rows">
            {[...unanswered, ...issues.filter(i => i.comments > 0)].slice(0, 3).map(i => (
              <GhLink key={i.number} className="gh-row" editing={editing} href={`https://github.com/${repo}/issues/${i.number}`}>
                <span className="num">#{i.number}</span>
                <span className="msg">{i.title}</span>
                {i.comments === 0
                  ? <span className="ghi-quiet" title="No replies yet">quiet</span>
                  : <span className="when">{i.comments}💬</span>}
                <span className="when">{ago(i.createdAt)}</span>
              </GhLink>
            ))}
          </ScrollArea>
        </div>
      )}
    </OvWidget>
  );
}

/* ---------- agent-questions: open questions from agents (T-307) ---------- */
export function AgentQuestionsWidget({ widget, editing }) {
  const { state } = useAppState();
  const { switchTab } = useDashboard();
  const { goToTask } = useNavigation();
  const project = state?.viewedProject;
  const [questions, setQuestions] = useState(null);
  const [tick, setTick] = useState(0);
  const [answering, setAnswering] = useState(null); // question id
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!project) return;
    let alive = true;
    fetch(`/api/projects/${project}/questions?limit=${widget?.props?.limit || 20}`, { credentials: 'include' })
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (alive) setQuestions(d?.questions || []); })
      .catch(() => { if (alive) setQuestions([]); });
    return () => { alive = false; };
  }, [project, tick, widget?.props?.limit]);

  async function sendAnswer(q) {
    const text = reply.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/projects/${project}/tasks/${q.taskId}/comment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ author: 'human', message: text, kind: 'answer', questionId: q.id }),
      });
      if (res.ok) {
        setReply(''); setAnswering(null); setTick(t => t + 1);
        window.showToast?.(`Answered ${q.author ? '@' + q.author : 'the question'} on ${q.taskId}`, 'success');
      } else {
        const d = await res.json().catch(() => ({}));
        window.showToast?.(d.error || 'Answer failed', 'error');
      }
    } finally {
      setBusy(false);
    }
  }

  const goTask = (taskId) => {
    switchTab('tasks');
    goToTask(taskId);
  };

  return (
    <OvWidget title={widget?.title || 'Agent Questions'}
      meta={questions?.length ? <span className="aq-count">{questions.length} open</span> : null}>
      {questions === null ? (
        <div className="nt-loading">Loading…</div>
      ) : questions.length === 0 ? (
        <div className="ov-empty">
          <span className="ov-empty-title">No open questions</span>
          <span className="ov-empty-hint">Agents ask by commenting with <span className="w-mono">kind: "question"</span> — answer right here, the answer lands on the task.</span>
        </div>
      ) : (
        <ScrollArea className="flex-1 min-h-0" innerClassName="aq-list">
          {questions.map(q => (
            <div key={q.id} className="aq-item">
              <div className="aq-head">
                <button type="button" className="aq-task" disabled={editing} onClick={() => goTask(q.taskId)}>{q.taskId}</button>
                {q.author && <span className="aq-author">@{q.author}</span>}
                <span className="aq-when">{ago(q.timestamp)}</span>
              </div>
              <div className="aq-msg">{q.message}</div>
              {answering === q.id ? (
                <div className="lk-add">
                  <input className="lk-in" autoFocus placeholder="Your answer…" value={reply}
                    onChange={e => setReply(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') sendAnswer(q); if (e.key === 'Escape') { setAnswering(null); setReply(''); } }}
                    disabled={editing || busy} />
                  <button type="button" className="lk-btn" onClick={() => sendAnswer(q)} disabled={editing || busy || !reply.trim()}>
                    {busy ? '…' : 'Send'}
                  </button>
                </div>
              ) : (
                !editing && (
                  <button type="button" className="lk-addtoggle" onClick={() => { setAnswering(q.id); setReply(''); }}>
                    Answer
                  </button>
                )
              )}
            </div>
          ))}
        </ScrollArea>
      )}
    </OvWidget>
  );
}
