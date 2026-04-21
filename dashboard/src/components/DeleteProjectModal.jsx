import { useState, useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';
import Modal from './Modal.jsx';
import Button from './Button.jsx';
import Input from './Input.jsx';
import Alert from './Alert.jsx';

export default function DeleteProjectModal({ open, onClose, project, onDeleted }) {
  const [stage, setStage] = useState(1); // 1 = intent, 2 = type-to-confirm
  const [typed, setTyped] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) {
      setStage(1);
      setTyped('');
      setSubmitting(false);
      setError(null);
    }
  }, [open]);

  if (!open || !project) return null;

  const match = typed === project.name;
  const label = project.displayName || project.name;

  async function handleDelete() {
    if (!match) return;
    setSubmitting(true);
    setError(null);
    try {
      const name = encodeURIComponent(project.name);
      const res = await fetch(`/api/projects/${name}?confirm=${name}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || `HTTP ${res.status}`);
        setSubmitting(false);
        return;
      }
      onDeleted?.(project.name, data);
      onClose?.();
    } catch (e) {
      setError(e.message);
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={submitting ? undefined : onClose}
      title="Delete project"
      actions={
        stage === 1 ? (
          <>
            <Button variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="danger" size="sm" onClick={() => setStage(2)}>
              Continue
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" size="sm" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={handleDelete}
              disabled={!match || submitting}
            >
              {submitting ? 'Deleting…' : 'Delete permanently'}
            </Button>
          </>
        )
      }
    >
      {stage === 1 ? (
        <div className="flex items-start gap-3 p-3 rounded-lg bg-danger-subtle text-danger border border-danger">
          <AlertTriangle size={20} className="shrink-0 mt-0.5" />
          <div className="text-sm">
            <div className="font-semibold mb-1">
              Permanently remove <em>{label}</em>?
            </div>
            <ul className="list-disc pl-4 opacity-90 space-y-0.5">
              <li>All active tasks will be archived.</li>
              <li>The project folder will be moved to <code>.trash/</code>.</li>
              <li>The slug <code>{project.name}</code> cannot be reused.</li>
            </ul>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="text-sm">
            To confirm, type the project slug{' '}
            <code className="bg-bg-elevated px-1.5 py-0.5 rounded font-mono text-[12px]">
              {project.name}
            </code>{' '}
            below.
          </div>
          <Input
            autoFocus
            placeholder={project.name}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && match && !submitting) handleDelete();
            }}
          />
          {error && <Alert variant="error">{error}</Alert>}
        </div>
      )}
    </Modal>
  );
}
