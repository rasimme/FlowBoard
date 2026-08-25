import { useEffect, useState } from 'react';
import { ListChecks } from 'lucide-react';
import { apiFetch } from '../utils/apiFetch.js';

// T-449-5: replaces the old GovernanceModeControl (compat/enforce). That
// switch was ungated ("Verified human required") because the T-447
// authorization layer never had a human principal to check against on an
// install without Telegram — see specs/T-449-*. Task discipline is a plain
// project property instead: list/standard/development, always editable by
// the local operator (`canChange` is now unconditionally true — see
// dashboard/server.js GET/PUT /api/projects/:name/task-discipline).
const DISCIPLINE_LABELS = { list: 'List', standard: 'Standard', development: 'Development' };
const DISCIPLINE_ORDER = ['list', 'standard', 'development'];

function formatAuditTime(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString();
}

/**
 * Project-type switch. Always visible — if a project checks task form
 * differently from its neighbor, that difference has to be visible, not
 * hidden behind a permission check (see spec "Sichtbarkeit"). `canChange`
 * only ever disables the buttons, it never hides the control: a flag/switch
 * informs, it doesn't gate (same rule the structureReview trail follows).
 */
export default function TaskDisciplineControl({ project }) {
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!project) return undefined;
    let alive = true;
    setState(null);
    apiFetch(`/api/projects/${project}/task-discipline`)
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || `Task discipline unavailable (HTTP ${response.status})`);
        return data;
      })
      .then(data => { if (alive) setState(data); })
      .catch(error => {
        if (alive) setState({ error: error.message });
      });
    return () => { alive = false; };
  }, [project]);

  async function changeDiscipline(nextDiscipline) {
    if (!project || !state?.canChange || loading || nextDiscipline === state?.discipline) return;
    setLoading(true);
    try {
      const response = await apiFetch(`/api/projects/${project}/task-discipline`, {
        method: 'PUT',
        body: JSON.stringify({ discipline: nextDiscipline }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        window.showToast?.(data.error || 'Only the operator can change the project type', 'error');
        return;
      }
      setState(previous => ({ ...previous, ...data, canChange: true }));
      window.showToast?.(`Project type set to ${DISCIPLINE_LABELS[nextDiscipline] || nextDiscipline}`, 'success');
    } catch (error) {
      window.showToast?.(error.message || 'Project type update failed', 'error');
    } finally {
      setLoading(false);
    }
  }

  if (!state) {
    return <div className="task-discipline-control" data-testid="task-discipline-control">Loading policy…</div>;
  }
  if (state.error) {
    return <div className="task-discipline-control task-discipline-error" data-testid="task-discipline-control">Policy unavailable</div>;
  }

  const values = Array.isArray(state.values) && state.values.length ? state.values : DISCIPLINE_ORDER;
  const auditTime = formatAuditTime(state.lastChange?.changedAt);

  return (
    <div
      className="task-discipline-control"
      data-testid="task-discipline-control"
      data-task-discipline={state.discipline}
      title={auditTime
        ? `Last changed by ${state.lastChange.actor} at ${auditTime}`
        : 'Project type — how strictly FlowBoard checks task form (list: none, standard: title/description, development: also batch and spec-link checks)'}
    >
      <ListChecks size={12} aria-hidden="true" />
      <span className="task-discipline-label">Project type</span>
      <div className="task-discipline-options" role="radiogroup" aria-label="Project type">
        {values.map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={state.discipline === value}
            className={`task-discipline-option${state.discipline === value ? ' is-active' : ''}`}
            disabled={!state.canChange || loading}
            onClick={() => changeDiscipline(value)}
          >
            {DISCIPLINE_LABELS[value] || value}
          </button>
        ))}
      </div>
    </div>
  );
}
