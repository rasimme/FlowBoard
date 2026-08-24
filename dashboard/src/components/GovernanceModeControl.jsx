import { useEffect, useState } from 'react';
import { RotateCcw, ShieldCheck, ShieldAlert } from 'lucide-react';
import Button from './Button.jsx';
import { apiFetch } from '../utils/apiFetch.js';

function formatAuditTime(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString();
}

/**
 * Human-visible governance rollout control. Reads are intentionally available
 * to every caller; the server's canChange hint only hides a mutation affordance
 * from agents and the PUT route remains the final authorization boundary.
 */
export default function GovernanceModeControl({ project }) {
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!project) return undefined;
    let alive = true;
    setState(null);
    apiFetch(`/api/projects/${project}/governance/mode`)
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || `Governance mode unavailable (HTTP ${response.status})`);
        return data;
      })
      .then(data => { if (alive) setState(data); })
      .catch(error => {
        if (alive) setState({ error: error.message });
      });
    return () => { alive = false; };
  }, [project]);

  async function changeMode(nextMode) {
    if (!project || !state?.canChange || loading) return;
    setLoading(true);
    try {
      const response = await apiFetch(`/api/projects/${project}/governance/mode`, {
        method: 'PUT',
        body: JSON.stringify({ mode: nextMode }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        window.showToast?.(data.error || 'Only a verified human can change governance mode', 'error');
        return;
      }
      setState(previous => ({ ...previous, ...data, canChange: true, lastChange: data.lastChange }));
      window.showToast?.(nextMode === 'enforce' ? 'Enforcement enabled' : 'Rolled back to compatibility mode', 'success');
    } catch (error) {
      window.showToast?.(error.message || 'Governance mode update failed', 'error');
    } finally {
      setLoading(false);
    }
  }

  if (!state) {
    return <div className="governance-mode-control" data-testid="governance-mode-control">Loading policy…</div>;
  }
  if (state.error) {
    return <div className="governance-mode-control governance-mode-error" data-testid="governance-mode-control">Policy unavailable</div>;
  }

  const enforcing = state.mode === 'enforce';
  const auditTime = formatAuditTime(state.lastChange?.changedAt);
  return (
    <div
      className={`governance-mode-control ${enforcing ? 'is-enforce' : 'is-compat'}`}
      data-testid="governance-mode-control"
      data-governance-mode={state.mode}
      title={auditTime ? `Last changed by ${state.lastChange.actor} at ${auditTime}` : 'Default compatibility mode'}
    >
      {enforcing ? <ShieldAlert size={13} aria-hidden="true" /> : <ShieldCheck size={13} aria-hidden="true" />}
      <span className="governance-mode-label">Policy</span>
      <span className="governance-mode-value">{state.mode}</span>
      {state.canChange ? (
        <Button
          variant="ghost"
          size="xs"
          className="governance-mode-action"
          onClick={() => changeMode(enforcing ? 'compat' : 'enforce')}
          disabled={loading}
          aria-label={enforcing ? 'Roll back to compatibility mode' : 'Switch to enforce mode'}
        >
          {enforcing ? <RotateCcw size={12} aria-hidden="true" /> : 'Enable'}
          <span>{enforcing ? 'Rollback' : 'Enforce'}</span>
        </Button>
      ) : (
        <span className="governance-mode-hint">Verified human required</span>
      )}
    </div>
  );
}
