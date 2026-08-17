import { useEffect, useMemo, useState } from 'react';
import Button from './Button.jsx';
import {
  EMPTY_WORK_STATE_DETAILS,
  WORK_STATE_OPTIONS,
  formatDateTimeLocal,
  normalizeTaskWorkState,
  normalizeWorkStateDetails,
  parseDateTimeLocal,
} from '../utils/workState.js';

const LABELS = {
  working: 'Working',
  waiting: 'Waiting',
  blocked: 'Blocked',
  paused: 'Paused',
};

const DESCRIPTIONS = {
  working: 'Actively being worked on.',
  waiting: 'Waiting for an external person, answer, or dependency.',
  blocked: 'Cannot make progress until the blocking condition changes.',
  paused: 'Intentionally paused; no active intervention is expected yet.',
};

function detailsFor(task) {
  return normalizeWorkStateDetails(normalizeTaskWorkState(task)?.workStateDetails);
}

function sameDetails(a, b) {
  return ['reason', 'waitingFor', 'responsible', 'checkAgainAt']
    .every((key) => (a?.[key] || null) === (b?.[key] || null));
}

/**
 * Canonical task work-state editor. Lifecycle status stays in DetailPanel's
 * existing status picker; this component only owns workState + details.
 */
export default function WorkStatePicker({ task, onChange, disabled = false }) {
  const normalizedTask = normalizeTaskWorkState(task || {});
  const canonicalState = normalizedTask?.workState || 'working';
  const canonicalDetails = detailsFor(normalizedTask);
  const detailsKey = useMemo(() => JSON.stringify(canonicalDetails), [
    canonicalDetails.reason,
    canonicalDetails.waitingFor,
    canonicalDetails.responsible,
    canonicalDetails.checkAgainAt,
    canonicalDetails.setAt,
  ]);
  const [draftState, setDraftState] = useState(canonicalState);
  const [draftDetails, setDraftDetails] = useState(canonicalDetails);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setDraftState(canonicalState);
    setDraftDetails(canonicalDetails);
    setError('');
    // The detail key changes only when the server/parent task changes; it does
    // not change while a user edits this local draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [normalizedTask?.id, canonicalState, detailsKey]);

  if (!task) return null;

  const updateDetail = (field, value) => {
    setDraftDetails((prev) => ({ ...prev, [field]: value }));
  };

  async function commit(nextState, nextDetails) {
    setError('');
    setSaving(true);
    try {
      const result = await onChange?.(nextState, nextDetails);
      if (result === false || result?.ok === false) {
        throw new Error(result?.error || 'The work state could not be saved.');
      }
      return result;
    } catch (err) {
      setError(err?.message || 'The work state could not be saved.');
      setDraftState(canonicalState);
      setDraftDetails(canonicalDetails);
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function handleStateChange(event) {
    const nextState = event.target.value;
    const nextDetails = nextState === 'working' ? EMPTY_WORK_STATE_DETAILS : draftDetails;
    setDraftState(nextState);
    await commit(nextState, nextDetails);
  }

  async function handleSaveDetails(event) {
    event.preventDefault();
    await commit(draftState, draftDetails);
  }

  const detailsChanged = !sameDetails(draftDetails, canonicalDetails);
  const setAtLabel = canonicalDetails.setAt
    ? new Date(canonicalDetails.setAt).toLocaleString()
    : null;

  return (
    <section
      data-work-state-picker="true"
      className="mt-3 rounded-lg border border-border bg-bg-accent px-3 py-3"
      aria-labelledby="work-state-label"
      aria-busy={saving}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div id="work-state-label" className="text-[10px] uppercase tracking-wider text-muted font-semibold">
            Work state
          </div>
          <div className="text-[11px] text-muted mt-1">
            Independent of the lifecycle status.
          </div>
        </div>
        {saving && <span className="text-[10px] text-muted shrink-0" role="status">Saving…</span>}
      </div>

      <label className="sr-only" htmlFor="work-state-select">Work state</label>
      <select
        id="work-state-select"
        name="workState"
        value={draftState}
        onChange={handleStateChange}
        disabled={disabled || saving}
        className="mt-2 w-full min-h-[36px] rounded-md border border-solid border-border bg-bg text-text px-2.5 text-sm outline-none focus:border-accent disabled:opacity-60"
        aria-describedby="work-state-help"
      >
        {WORK_STATE_OPTIONS.map((state) => (
          <option key={state} value={state}>{LABELS[state]}</option>
        ))}
      </select>
      <div id="work-state-help" className="mt-1 text-[11px] text-muted" aria-live="polite">
        {DESCRIPTIONS[draftState]}
        {draftState === 'blocked' && <span className="sr-only"> Legacy blocked is derived from this state.</span>}
      </div>

      {draftState !== 'working' && (
        <form className="mt-3 space-y-2.5" onSubmit={handleSaveDetails}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <label className="block text-[11px] text-muted">
              Reason
              <input
                name="workStateReason"
                value={draftDetails.reason || ''}
                onChange={(event) => updateDetail('reason', event.target.value)}
                disabled={disabled || saving}
                className="mt-1 w-full min-h-[36px] rounded-md border border-solid border-border bg-bg text-text px-2.5 text-sm outline-none focus:border-accent disabled:opacity-60"
                placeholder="What is the current context?"
              />
            </label>
            <label className="block text-[11px] text-muted">
              Waiting for
              <input
                name="workStateWaitingFor"
                value={draftDetails.waitingFor || ''}
                onChange={(event) => updateDetail('waitingFor', event.target.value)}
                disabled={disabled || saving}
                className="mt-1 w-full min-h-[36px] rounded-md border border-solid border-border bg-bg text-text px-2.5 text-sm outline-none focus:border-accent disabled:opacity-60"
                placeholder="Person, team, or dependency"
              />
            </label>
            <label className="block text-[11px] text-muted">
              Responsible
              <input
                name="workStateResponsible"
                value={draftDetails.responsible || ''}
                onChange={(event) => updateDetail('responsible', event.target.value)}
                disabled={disabled || saving}
                className="mt-1 w-full min-h-[36px] rounded-md border border-solid border-border bg-bg text-text px-2.5 text-sm outline-none focus:border-accent disabled:opacity-60"
                placeholder="Who should act next?"
              />
            </label>
            <label className="block text-[11px] text-muted">
              Check again at
              <input
                type="datetime-local"
                name="workStateCheckAgainAt"
                value={formatDateTimeLocal(draftDetails.checkAgainAt)}
                onChange={(event) => updateDetail('checkAgainAt', parseDateTimeLocal(event.target.value))}
                disabled={disabled || saving}
                className="mt-1 w-full min-h-[36px] rounded-md border border-solid border-border bg-bg text-text px-2.5 text-sm outline-none focus:border-accent disabled:opacity-60"
              />
            </label>
          </div>
          <div className="flex items-center justify-between gap-2 pt-1">
            <span className="text-[10px] text-muted" title={canonicalDetails.setAt || undefined}>
              {setAtLabel ? `Set ${setAtLabel}` : 'Details are optional'}
            </span>
            <Button
              type="submit"
              size="xs"
              variant="secondary"
              data-work-state-save="true"
              disabled={disabled || saving || !detailsChanged}
            >
              Save details
            </Button>
          </div>
        </form>
      )}

      {error && (
        <div className="mt-2 text-[11px] text-danger" role="alert">{error}</div>
      )}
    </section>
  );
}
