/**
 * Task detail as a session panel (T-515-6): the task the session's agent is
 * working on in the session's FlowBoard project, with its latest activity, a
 * comment box and the approve gate.
 */
import { useCallback, useEffect, useState } from 'react';
import { apiJson } from '../../../dashboard/src/utils/apiFetch.js';
import MarkdownPreview from '../../../dashboard/src/components/MarkdownPreview.jsx';
import { mergeTaskFeed, pickSessionTasks, resolveSessionProject } from '../session-tasks.js';

const REFRESH_MS = 20000;

function when(timestamp) {
  if (!timestamp) return '';
  try { return new Date(timestamp).toLocaleString(); } catch { return ''; }
}

export default function TaskPanelView({ session, subscribe, onOpen }) {
  const { agentId, sessionKey } = session || {};
  const [state, setState] = useState({ loading: true, project: null, tasks: [], error: null });
  const [selected, setSelected] = useState(null);
  const [feed, setFeed] = useState([]);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);

  const load = useCallback(async () => {
    try {
      const { agents } = await apiJson('/api/agents');
      const project = resolveSessionProject(agents, { agentId, sessionKey });
      if (!project) { setState({ loading: false, project: null, tasks: [], error: null }); return; }
      const { tasks } = await apiJson(`/api/projects/${encodeURIComponent(project)}/tasks`);
      setState({ loading: false, project, tasks: pickSessionTasks(tasks, agentId), error: null });
    } catch (error) {
      setState((prev) => ({ ...prev, loading: false, error: error?.message || 'FlowBoard is unavailable' }));
    }
  }, [agentId, sessionKey]);

  useEffect(() => {
    load();
    const timer = setInterval(load, REFRESH_MS);
    const unsubscribe = subscribe?.(load);
    return () => { clearInterval(timer); unsubscribe?.(); };
  }, [load, subscribe]);

  const task = state.tasks.find((entry) => entry.id === selected) || state.tasks[0] || null;
  const taskPath = task && state.project
    ? `/api/projects/${encodeURIComponent(state.project)}/tasks/${encodeURIComponent(task.id)}`
    : null;
  const stamp = task ? `${task.lastCheckpointAt || ''}:${task.status}` : '';

  const loadFeed = useCallback(async () => {
    if (!taskPath) { setFeed([]); return; }
    const [comments, checkpoints] = await Promise.allSettled([apiJson(`${taskPath}/comments`), apiJson(`${taskPath}/checkpoints`)]);
    setFeed(mergeTaskFeed(
      comments.status === 'fulfilled' ? comments.value?.comments : [],
      checkpoints.status === 'fulfilled' ? checkpoints.value?.checkpoints : [],
    ));
  }, [taskPath]);
  useEffect(() => { loadFeed(); }, [loadFeed, stamp]);

  const act = async (run, done) => {
    setBusy(true); setNotice(null);
    try { await run(); setNotice(done); await Promise.all([load(), loadFeed()]); }
    catch (error) { setNotice(error?.message || 'FlowBoard refused the change'); }
    finally { setBusy(false); }
  };
  const sendComment = () => {
    const message = comment.trim();
    if (!message || !taskPath) return;
    act(async () => { await apiJson(`${taskPath}/comment`, { method: 'POST', body: { message, author: 'human' } }); setComment(''); }, 'Comment sent');
  };
  const approve = () => act(() => apiJson(`${taskPath}/approve`, { method: 'POST', body: { actor: 'human' } }), 'Approved');

  if (state.loading) return <div className="ov-empty" data-fb-view="task-panel"><span className="ov-empty-hint">Loading FlowBoard…</span></div>;
  if (state.error) return <div className="ov-empty" data-fb-view="task-panel"><span className="ov-empty-title">Could not load</span><span className="ov-empty-hint">{state.error}</span></div>;
  if (!state.project) {
    return (
      <div className="ov-empty" data-fb-view="task-panel" data-fb-state="no-project">
        <span className="ov-empty-title">No FlowBoard project</span>
        <span className="ov-empty-hint">This session is not bound to a project. It binds when the agent activates one.</span>
      </div>
    );
  }
  if (!task) {
    return (
      <div className="ov-empty" data-fb-view="task-panel" data-fb-state="no-task">
        <span className="ov-empty-title">No claimed task</span>
        <span className="ov-empty-hint">{agentId} holds no task in progress or in review in {state.project}.</span>
        <button className="btn btn-ghost btn-sm" onClick={() => onOpen(state.project, null)}>Open {state.project}</button>
      </div>
    );
  }
  return (
    <div className="fb-view-panel" data-fb-view="task-panel" data-fb-state="task" data-fb-task={task.id}>
      {state.tasks.length > 1 && (
        <div className="fb-view-tabs">
          {state.tasks.map((entry) => (
            <button key={entry.id} className={`btn btn-sm ${entry.id === task.id ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setSelected(entry.id)}>{entry.id}</button>
          ))}
        </div>
      )}
      <div className="fb-view-head">
        <span className="ov-task-id">{state.project} · {task.id}</span>
        <span className="ov-pill">{task.status}</span>
        {task.workState && task.workState !== 'working' && <span className="ov-pill high">{task.workState}</span>}
        <span className="ov-pill">{task.priority}</span>
      </div>
      <h3 className="fb-view-title">{task.title}</h3>
      {task.description && <div className="md-content fb-view-text"><MarkdownPreview content={task.description} breaks /></div>}
      <div className="fb-view-actions">
        {task.status === 'review' && <button className="btn btn-primary btn-sm" disabled={busy} onClick={approve}>Approve</button>}
        <button className="btn btn-ghost btn-sm" onClick={() => onOpen(state.project, task.id)}>Open in FlowBoard</button>
        {notice && <span className="fb-view-notice" role="status">{notice}</span>}
      </div>
      <div className="fb-view-label">Activity</div>
      <div className="fb-view-feed">
        {feed.length === 0 && <span className="ov-empty-hint">No comments or checkpoints yet.</span>}
        {feed.map((row, index) => (
          <div key={`${row.timestamp}:${index}`} className="ov-dec">
            <span className="ov-dec-body">
              <span className="ov-dec-title">{row.kind}{row.author ? ` · @${row.author}` : ''} · {when(row.timestamp)}</span>
              <span className="ov-dec-text">{row.text}</span>
            </span>
          </div>
        ))}
      </div>
      <div className="fb-view-comment">
        <textarea
          className="lk-in"
          rows={2}
          placeholder="Write a comment…"
          value={comment}
          onChange={(event) => setComment(event.target.value)}
        />
        <button className="btn btn-primary btn-sm" disabled={busy || !comment.trim()} onClick={sendComment}>Send</button>
      </div>
    </div>
  );
}
