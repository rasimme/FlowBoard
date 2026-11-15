/**
 * "Needs me" dashboard widget (T-515-6): the review lane plus blocked and
 * stalled work across projects. The backend decides what needs the operator
 * (`tasks.needing-me`); this view only renders it.
 */
import { useEffect, useState } from 'react';
import { describeNeedsMe, groupNeedsMe, reasonLabel } from '../lib/needs-me.js';

export default function NeedsMeView({ watch, onOpen }) {
  const [state, setState] = useState({ items: null, truncated: false, error: null });
  useEffect(() => watch(
    (result) => setState({ items: result?.items || [], truncated: Boolean(result?.truncated), error: null }),
    (error) => setState((prev) => ({ ...prev, error: error?.message || 'FlowBoard is unavailable' })),
  ), [watch]);

  const groups = groupNeedsMe(state.items || []).filter((group) => group.items.length > 0);
  const total = groups.reduce((sum, group) => sum + group.items.length, 0);
  return (
    <section className="ov-widget" data-fb-view="needs-me">
      <div className="ov-whead">
        <span className="ov-wtitle">Needs me</span>
        {total > 0 && <span className="ov-wmeta">{total}{state.truncated ? '+' : ''} waiting</span>}
      </div>
      <div className="ov-wbody fb-view-scroll">
        {state.error && <div className="ov-empty"><span className="ov-empty-title">Could not load</span><span className="ov-empty-hint">{state.error}</span></div>}
        {!state.error && state.items === null && <div className="ov-empty"><span className="ov-empty-hint">Loading…</span></div>}
        {!state.error && state.items !== null && total === 0 && (
          <div className="ov-empty">
            <span className="ov-empty-title">Nothing waiting on you</span>
            <span className="ov-empty-hint">Tasks in review and blocked or stalled work appear here.</span>
          </div>
        )}
        {groups.map((group) => (
          <div key={group.id} className="ov-tasks" data-fb-group={group.id}>
            <div className="fb-view-label">{group.label} ({group.items.length})</div>
            {group.items.map((item) => (
              <div
                key={`${item.project}:${item.id}`}
                className="ov-task-row"
                role="button"
                tabIndex={0}
                title={describeNeedsMe(item) || undefined}
                data-fb-item={`${item.project}:${item.id}`}
                onClick={() => onOpen(item.project, item.id)}
                onKeyDown={(event) => { if (event.key === 'Enter') onOpen(item.project, item.id); }}
              >
                <span className="ov-task-id">{item.id}</span>
                <span className="ov-task-title">{item.title || '(untitled)'}</span>
                <span className="fb-view-project">{item.project}</span>
                <span className={`ov-pill ${item.reason === 'review' ? '' : 'high'}`}>{reasonLabel(item)}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}
