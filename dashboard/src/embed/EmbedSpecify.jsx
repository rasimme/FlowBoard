// T-499 F1 — the transient framed Specify surface.
//
// The host opens it after its native "New task" hit Specify on a governed
// project. It reuses the board's New Task flow (createBacklogTask — the same
// 409 SPECIFY_REQUIRED recovery AddTaskForm uses) and the normal Specify
// stepper modal; the host hears `specify-closed` when the stepper closes.
// Starting a session is a write, so it waits for an explicit click.

import { useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppState } from '../context/AppStateContext.jsx';
import { useSpecify } from '../context/SpecifyContext.jsx';
import { Button, Input, PriorityPill } from '../components/index.js';
import { createBacklogTask } from '../utils/taskCreation.js';
import { getTasks, replaceTasks } from '../state/appStateBridge.mjs';
import { applyTaskResponse } from '../state/taskState.mjs';
import { MAX_TITLE_LENGTH, PRIORITIES } from './embedMode.mjs';
import { useEmbedState } from './useEmbedState.js';

export default function EmbedSpecify({ embed }) {
  const { state } = useAppState();
  const specify = useSpecify();
  const { specifyClosed } = useEmbedState(embed);
  const [container, setContainer] = useState(null);
  const [title, setTitle] = useState(embed.config.title || '');
  const [priority, setPriority] = useState(embed.config.priority || 'medium');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const project = state?.viewedProject || null;

  useLayoutEffect(() => {
    const el = document.getElementById('content');
    if (el) setContainer(el);
  }, []);

  const start = async () => {
    const trimmed = title.trim();
    if (!trimmed || !project || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await createBacklogTask({ project, title: trimmed, priority });
      if (result.kind === 'specify') {
        embed.resetSpecify();
        specify.show(result.sessionId);
      } else {
        // The project did not require Specify after all: the task exists now.
        const { data } = result;
        if (data.task) replaceTasks(applyTaskResponse(getTasks(), data));
        const id = data.task?.id;
        embed.specifyClosed({ completed: true, tasks: id ? [id] : [], project });
        if (id) embed.openTask(id, project);
      }
    } catch (err) {
      setError(err?.message || 'Failed to create task');
    } finally {
      setSubmitting(false);
    }
  };

  if (!container) return null;

  let body;
  if (!project) {
    body = <p className="text-sm text-muted">No project selected.</p>;
  } else if (specifyClosed) {
    body = (
      <>
        <p className="text-sm text-text" data-embed-specify-status>
          {specifyClosed.completed ? 'Specify finished.' : 'Specify was closed.'}
        </p>
        <div>
          <Button variant="secondary" size="sm" onClick={() => embed.resetSpecify()}>Start again</Button>
        </div>
      </>
    );
  } else {
    body = (
      <>
        <p className="text-sm text-muted">
          New tasks in <strong className="text-text">{project}</strong> go through Specify first.
        </p>
        <Input
          id="embedSpecifyTitle"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); start(); } }}
          placeholder="Task title..."
          maxLength={MAX_TITLE_LENGTH}
          disabled={submitting}
        />
        <div className="priority-selector">
          {PRIORITIES.map((p) => (
            <PriorityPill
              key={p}
              priority={p}
              onClick={() => setPriority(p)}
              className={priority !== p ? 'opacity-50' : ''}
            />
          ))}
        </div>
        {error && <p className="text-sm text-danger" role="alert">{error}</p>}
        <div>
          <Button size="sm" data-embed-specify-start onClick={start} disabled={!title.trim() || submitting}>
            {submitting ? 'Starting…' : 'Start Specify'}
          </Button>
        </div>
      </>
    );
  }

  return createPortal(
    <div className="embed-specify" data-embed-specify>
      <h2 className="text-base font-semibold text-text-strong">New task</h2>
      {body}
    </div>,
    container
  );
}
