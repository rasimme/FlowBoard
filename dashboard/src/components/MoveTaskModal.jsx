import { useEffect, useState } from 'react';
import Modal from './Modal.jsx';
import Button from './Button.jsx';
import Dropdown from './Dropdown.jsx';
import FormGroup from './FormGroup.jsx';
import { formatDisplayName } from '../utils/formatting.js';

/**
 * MoveTaskModal — move a task to another project or change its parent (T-302).
 * Cross-project moves assign a fresh id in the target project (FlowBoard ids
 * are project-scoped); the old reference is kept as an audit comment.
 */
export default function MoveTaskModal({ open, onClose, task, project, projects = [], onDone }) {
  const [targetProject, setTargetProject] = useState('');
  const [targetParent, setTargetParent] = useState('');
  const [parentOptions, setParentOptions] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const isSubtask = Boolean(task?.parentId);
  const hasSubtasks = (task?.subtaskIds || []).length > 0;

  useEffect(() => {
    if (!open || !project) return;
    setTargetProject('');
    setTargetParent('');
    setError(null);
    setSubmitting(false);
    // top-level tasks of this project are the parent candidates
    fetch(`/api/projects/${project}/tasks`, { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        const opts = (d.tasks || [])
          .filter(t => !t.parentId && t.id !== task?.id && !t.trashedAt && t.status !== 'archived')
          .map(t => ({ value: t.id, label: `${t.id} — ${t.title}` }));
        setParentOptions(opts);
      })
      .catch(() => setParentOptions([]));
  }, [open, project, task?.id]);

  if (!open || !task) return null;

  const projectOptions = projects
    .filter(p => p.name !== project)
    .map(p => ({ value: p.name, label: formatDisplayName(p.name, projects) }));

  async function call(path, body) {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${project}/tasks/${task.id}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || `HTTP ${res.status}`);
        setSubmitting(false);
        return null;
      }
      return data.task;
    } catch (err) {
      setError(err.message);
      setSubmitting(false);
      return null;
    }
  }

  async function handleMove() {
    if (!targetProject) return;
    const moved = await call('move', { toProject: targetProject });
    if (moved) {
      window.showToast?.(`Moved to ${targetProject} as ${moved.id}`, 'success');
      onDone?.({ type: 'move', task: moved, toProject: targetProject });
      onClose?.();
    }
  }

  async function handleReparent(parentId) {
    const updated = await call('parent', { parentId });
    if (updated) {
      window.showToast?.(parentId ? `Now a subtask of ${parentId} (${updated.id})` : `Promoted to top-level (${updated.id})`, 'success');
      onDone?.({ type: 'reparent', task: updated });
      onClose?.();
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Move ${task.id}`}
      size="sm"
      showClose
      dismissible={!submitting}
    >
      <div className="flex flex-col gap-4">
        {!isSubtask && (
          <FormGroup label="Move to project" hint="The task and its subtasks get fresh ids in the target project.">
            <div className="flex items-center gap-2">
              <Dropdown
                value={targetProject}
                onChange={setTargetProject}
                options={projectOptions}
                placeholder="Select project…"
                disabled={submitting}
                className="flex-1"
              />
              <Button size="sm" disabled={!targetProject || submitting} onClick={handleMove}>
                Move
              </Button>
            </div>
          </FormGroup>
        )}

        {!hasSubtasks && (
          <FormGroup label={isSubtask ? 'Change parent' : 'Make subtask of'}>
            <div className="flex items-center gap-2">
              <Dropdown
                value={targetParent}
                onChange={setTargetParent}
                options={parentOptions.filter(o => o.value !== task.parentId)}
                placeholder="Select parent task…"
                disabled={submitting}
                className="flex-1"
              />
              <Button size="sm" disabled={!targetParent || submitting} onClick={() => handleReparent(targetParent)}>
                Apply
              </Button>
            </div>
          </FormGroup>
        )}

        {isSubtask && (
          <Button variant="secondary" size="sm" disabled={submitting} onClick={() => handleReparent(null)}>
            Promote to top-level task
          </Button>
        )}

        {hasSubtasks && isSubtask === false && (
          <p className="text-[11px] text-muted m-0">
            This task has subtasks — it cannot become a subtask itself.
          </p>
        )}

        {error && <div className="text-[11px] text-danger">{error}</div>}
      </div>
    </Modal>
  );
}
