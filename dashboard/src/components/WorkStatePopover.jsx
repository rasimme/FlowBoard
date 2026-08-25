import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight } from 'lucide-react';
import Popover from './Popover.jsx';
import Button from './Button.jsx';
import { WORK_STATE_ICONS } from './WorkStateChip.jsx';
import Input from './Input.jsx';
import Textarea from './Textarea.jsx';
import {
  EMPTY_WORK_STATE_DETAILS,
  WORK_STATE_OPTIONS,
  formatDateTimeLocal,
  normalizeTaskWorkState,
  normalizeWorkStateDetails,
  parseDateTimeLocal,
} from '../utils/workState.js';

// UI labels are English and deliberately differ from the internal `working`
// vocabulary — spec "Verbindliche Entscheidungen": Active / Waiting /
// Blocked / Paused, no explanatory text.
const STATE_LABELS = {
  working: 'Active',
  waiting: 'Waiting',
  blocked: 'Blocked',
  paused: 'Paused',
};

// T-452-3: waiting/blocked ask exactly one question before committing;
// paused/active ask nothing and commit straight from the list. The question
// maps onto the existing model fields — `waitingFor` for waiting, `reason`
// for blocked (the same field the old four-field form used for "blocked"'s
// explanation) — so no model change is needed.
const QUESTION_TEXT = {
  waiting: 'What is this task waiting for?',
  blocked: 'What is blocking it?',
};
const QUESTION_FIELD = {
  waiting: 'waitingFor',
  blocked: 'reason',
};

// Popover.jsx clamps horizontal overflow against an assumed content width,
// sized for short menu rows like Status/Priority. The question step is a real
// mini-form and needs to be wider. Left unstated, the clamp under-fires and
// the form has been observed hanging ~120px off the right edge of the
// viewport, entirely unreachable. Popover.jsx therefore takes an explicit
// `width` (T-452-2); its default is unchanged, so Status and Priority
// position exactly as before.
//
// T-454-5: the form used to hard-code that width at 288px — a guess from
// when the popover was new. The mock shows it filling almost the whole
// sidebar, so this now derives from DetailPanel's actually-measured panel
// width (`panelWidth` prop, captured by openHeaderPopover at click-time —
// the panel is responsive, `w-full max-w-[480px]`, so there is no fixed
// number to hard-code instead). PANEL_EDGE_MARGIN approximates the header's
// `px-5` (20px) on both sides so the form reads as "panel width minus a
// comfortable margin", not edge-to-edge. The min/max bounds keep it sane at
// the extremes: never so narrow the question wraps awkwardly, never wider
// than a sidebar has any business being.
const PANEL_EDGE_MARGIN = 40;
const QUESTION_FORM_MIN_WIDTH = 260;
const QUESTION_FORM_MAX_WIDTH = 420;
// Fallback for the rare case panelWidth isn't measurable yet (e.g. a caller
// that opens the popover without going through DetailPanel's ref) — the old
// hard-coded value, so behavior degrades to exactly what it was before.
const QUESTION_FORM_FALLBACK_WIDTH = 288;

function questionFormWidth(panelWidth) {
  if (typeof panelWidth !== 'number' || !Number.isFinite(panelWidth) || panelWidth <= 0) {
    return QUESTION_FORM_FALLBACK_WIDTH;
  }
  const target = panelWidth - PANEL_EDGE_MARGIN;
  return Math.max(QUESTION_FORM_MIN_WIDTH, Math.min(QUESTION_FORM_MAX_WIDTH, target));
}

// T-454-6: the answer textarea grows with its content up to this height,
// then scrolls — long blocker/waiting explanations shouldn't be able to push
// the Save button and More-context toggle off-panel indefinitely.
const ANSWER_MAX_HEIGHT = 160;

/**
 * The state's icon, from the same map the panel and card chips use
 * (WorkStateChip.jsx). Shared on purpose: a state must not read as a padlock
 * on the card and something else in the menu that sets it.
 */
function StateIcon({ state }) {
  const Icon = WORK_STATE_ICONS[state];
  if (!Icon) return null;
  return <Icon size={12} className="shrink-0 text-muted" aria-hidden="true" />;
}

/**
 * WorkStatePopover — the state-selection popover opened from the combo
 * chip's state half (T-452-2/T-452-3, spec
 * T-452-workstate-im-ui-vereinfachen-kombi-chip.md). Third instance of
 * DetailPanel's headerPopover + Popover.jsx pattern (Status, Priority, now
 * WorkState) — see DetailPanel's openHeaderPopover/closeHeaderPopover and
 * the sibling Status/Priority <Popover> blocks it renders next to. Escape
 * and click-outside both come from Popover.jsx; DetailPanel's
 * closeHeaderPopover returns focus to the trigger chip.
 *
 * Two-step flow, both steps living in the same popover instance:
 *  - 'list': four entries, no descriptions, current state checked
 *    (T-452-2). Picking Active or Paused commits immediately — those ask
 *    nothing (T-452-3's "Paused und Active fragen nichts").
 *  - 'question': picking Waiting or Blocked moves here instead of
 *    committing right away. Exactly one input, one English question, Enter
 *    (or Save) commits state + answer together in a single write. An
 *    optional, collapsed "More context" reveals Responsible and Check again
 *    at — the same technical fields the old WorkStatePicker exposed, now
 *    readable/editable but never mandatory.
 *
 * Preserves the contract of the old WorkStatePicker.jsx it replaces:
 *  - `onChange(nextState, nextDetails)` is still DetailPanel's
 *    `handleWorkStateChange`, unchanged.
 *  - Optimistic set with rollback: `commit()` mirrors WorkStatePicker's
 *    `commit()`/`rollbackDraft()` almost verbatim, including using
 *    `err.canonicalTask` (not the possibly-stale `task` prop) to reset the
 *    local draft to the real server state on failure.
 *  - `checkAgainAt` is written as the ISO-8601 string `parseDateTimeLocal`
 *    produces (with timezone/UTC `Z`), using the exact same validation and
 *    error copy as before ("Choose a real local time. DST gap times are not
 *    valid.").
 *  - Switching to `working` (Active) clears workStateDetails; switching
 *    among waiting/blocked/paused preserves whatever details already exist.
 */
export default function WorkStatePopover({ task, open, anchorRect, panelWidth, onClose, onChange }) {
  const normalized = normalizeTaskWorkState(task || {});
  const currentState = normalized.workState || 'working';
  const formWidth = questionFormWidth(panelWidth);

  const [step, setStep] = useState('list'); // 'list' | 'question'
  const [pendingState, setPendingState] = useState(null); // state being saved/edited
  const [answer, setAnswer] = useState('');
  const [responsible, setResponsible] = useState('');
  const [checkAgainAtInput, setCheckAgainAtInput] = useState('');
  const [moreOpen, setMoreOpen] = useState(false);
  const [dateError, setDateError] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  // T-454-6: the answer field grows with its content (scrollHeight-driven,
  // same technique DetailPanel's title field already uses), capped at
  // ANSWER_MAX_HEIGHT and scrollable past that.
  const answerRef = useRef(null);

  function autoResizeAnswer(el) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, ANSWER_MAX_HEIGHT)}px`;
  }

  // Resize on every step/question entry — not just on user typing — so a
  // pre-filled answer (editing an existing waiting/blocked task) starts at
  // its correct grown height instead of a single-row default that then
  // jumps on the first keystroke.
  useEffect(() => {
    if (step === 'question') autoResizeAnswer(answerRef.current);
  }, [step, answer]);

  // Fresh draft every time the popover opens. Keyed on `open` alone (not on
  // `task`) so a task update arriving from the background poll while the
  // popover is open never clobbers an in-progress answer — same reasoning
  // as the old WorkStatePicker's detailsKey-gated effect.
  useEffect(() => {
    if (!open) return;
    setStep('list');
    setPendingState(null);
    setAnswer('');
    setError('');
    setDateError('');
    const details = normalizeWorkStateDetails(normalized.workStateDetails);
    setResponsible(details.responsible || '');
    setCheckAgainAtInput(formatDateTimeLocal(details.checkAgainAt));
    setMoreOpen(Boolean(details.responsible || details.checkAgainAt));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Shared by rollbackDraft() and the list's question-branch: load the
  // question-step draft for `state` from `details`, or fall back to the
  // plain list (Active/Paused have no question).
  function loadDraftForState(state, details) {
    const field = QUESTION_FIELD[state];
    setPendingState(field ? state : null);
    setStep(field ? 'question' : 'list');
    setAnswer(field ? (details[field] || '') : '');
    setResponsible(details.responsible || '');
    setCheckAgainAtInput(formatDateTimeLocal(details.checkAgainAt));
    setMoreOpen(Boolean(details.responsible || details.checkAgainAt));
    setDateError('');
  }

  // A failed write must reset the local draft to the real server state, not
  // to whatever the user was about to save — see WorkStatePicker.jsx's old
  // rollbackDraft() for the identical reasoning. `canonicalTask` comes from
  // handleWorkStateChange's `err.canonicalTask`, falling back to the last
  // known `task` prop only if the caller didn't supply one.
  function rollbackDraft(canonicalTask) {
    const canon = normalizeTaskWorkState(canonicalTask || task || {});
    const details = normalizeWorkStateDetails(canon.workStateDetails);
    loadDraftForState(canon.workState || 'working', details);
  }

  async function commit(nextState, nextDetails) {
    setError('');
    if (dateError) return false;
    setSaving(true);
    try {
      const result = await onChange?.(nextState, nextDetails);
      if (result === false || result?.ok === false) {
        const failure = new Error(result?.error || 'The work state could not be saved.');
        if (result?.canonicalTask) failure.canonicalTask = result.canonicalTask;
        throw failure;
      }
      return result;
    } catch (err) {
      rollbackDraft(err?.canonicalTask || task);
      setError(err?.message || 'The work state could not be saved.');
      return false;
    } finally {
      setSaving(false);
    }
  }

  function handleCheckAgainAtChange(event) {
    const raw = event.target.value;
    setCheckAgainAtInput(raw);
    if (!raw) {
      setDateError('');
      return;
    }
    const parsed = parseDateTimeLocal(raw);
    if (!parsed) {
      setDateError('Choose a real local time. DST gap times are not valid.');
      return;
    }
    setDateError('');
  }

  async function handleOptionClick(nextState) {
    if (saving) return;
    const field = QUESTION_FIELD[nextState];
    if (field) {
      // Waiting/Blocked: ask the one question first; the write happens on
      // submit, bundling state + answer into a single commit.
      setError('');
      loadDraftForState(nextState, normalizeWorkStateDetails(normalized.workStateDetails));
      return;
    }
    // Active/Paused: nothing to ask, commit straight away.
    if (nextState === currentState) {
      onClose?.();
      return;
    }
    setPendingState(nextState);
    const currentDetails = normalizeWorkStateDetails(normalized.workStateDetails);
    const nextDetails = nextState === 'working' ? EMPTY_WORK_STATE_DETAILS : currentDetails;
    const result = await commit(nextState, nextDetails);
    if (result !== false) onClose?.();
  }

  async function handleQuestionSubmit(event) {
    event.preventDefault();
    if (saving || dateError) return;
    const field = QUESTION_FIELD[pendingState];
    const currentDetails = normalizeWorkStateDetails(normalized.workStateDetails);
    const nextDetails = {
      ...currentDetails,
      [field]: answer.trim() || null,
      responsible: responsible.trim() || null,
      checkAgainAt: checkAgainAtInput ? parseDateTimeLocal(checkAgainAtInput) : null,
    };
    const result = await commit(pendingState, nextDetails);
    if (result !== false) onClose?.();
  }

  // T-454-6: the answer field became a <textarea> so it can grow with its
  // content, but a plain <textarea> doesn't submit its form on Enter the way
  // a single-line <input> does — it inserts a newline instead. The spec's
  // "Ein Feld, Enter, fertig" still has to hold, so Enter is handled
  // explicitly here; Shift+Enter is left alone and falls through to the
  // browser's normal newline behavior.
  function handleAnswerKeyDown(event) {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    handleQuestionSubmit(event);
  }

  const displayedState = pendingState || currentState;

  // The one editable field is `waitingFor` for waiting, `reason` for
  // blocked — keep the input's `name` on the same convention the old
  // four-field WorkStatePicker used (`workStateWaitingFor` / `workStateReason`)
  // so it stays a stable, self-describing test/automation hook. Guarded on
  // `step === 'question'`: `pendingState` is also set transiently to
  // `paused`/`working` while an immediate list commit is in flight (for the
  // list's optimistic checkmark), and those have no QUESTION_FIELD entry —
  // indexing into it unconditionally crashed the whole render tree.
  const questionField = step === 'question' && pendingState ? QUESTION_FIELD[pendingState] : null;
  const answerFieldName = questionField
    ? `workState${questionField[0].toUpperCase()}${questionField.slice(1)}`
    : undefined;

  return (
    <Popover
      open={open}
      onClose={onClose}
      anchorRect={anchorRect}
      width={step === 'question' ? formWidth : undefined}
    >
      {step === 'list' && (
        <div data-work-state-popover="true" data-work-state-list="true">
          {WORK_STATE_OPTIONS.map((state) => (
            <Popover.Option key={state} onClick={() => handleOptionClick(state)}>
              <span data-work-state-option={state} className="flex items-center gap-2">
                <Check
                  size={11}
                  className={state === displayedState ? 'opacity-100' : 'opacity-0'}
                  aria-hidden="true"
                />
                <StateIcon state={state} />
                <span>{STATE_LABELS[state]}</span>
              </span>
            </Popover.Option>
          ))}
          {saving && <div className="px-2 py-1 text-[10px] text-muted" role="status">Saving…</div>}
          {error && <div className="px-2 py-1 max-w-[220px] text-[11px] text-danger" role="alert">{error}</div>}
        </div>
      )}

      {step === 'question' && (
        <form
          onSubmit={handleQuestionSubmit}
          data-work-state-popover="true"
          data-work-state-question="true"
          className="p-3 max-w-[calc(100vw-16px)]"
          style={{ width: formWidth }}
          aria-busy={saving}
        >
          <label className="block text-[11px] text-muted mb-1" htmlFor="work-state-question-input">
            {QUESTION_TEXT[pendingState]}
          </label>
          {/* T-454-6: a growing <textarea> replaces the old single-line
              <input> — content past one line no longer gets clipped. Enter
              still submits (handleAnswerKeyDown), Shift+Enter still inserts
              a newline (native <textarea> behavior, left untouched). */}
          <Textarea
            ref={answerRef}
            id="work-state-question-input"
            name={answerFieldName}
            data-work-state-answer="true"
            rows={1}
            className="min-h-[44px] px-2 py-1.5 text-[11px] rounded-md overflow-y-auto"
            style={{ maxHeight: ANSWER_MAX_HEIGHT }}
            autoFocus
            value={answer}
            onChange={(event) => { setAnswer(event.target.value); autoResizeAnswer(event.target); }}
            onKeyDown={handleAnswerKeyDown}
            disabled={saving}
          />

          <button
            type="button"
            onClick={() => setMoreOpen((value) => !value)}
            data-work-state-more="true"
            aria-expanded={moreOpen}
            className="mt-2.5 inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted bg-transparent border-0 appearance-none cursor-pointer hover:text-text"
          >
            {moreOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            More context
          </button>

          {moreOpen && (
            <div className="mt-2 space-y-2">
              <label className="block text-[11px] text-muted">
                Responsible
                <Input
                  name="workStateResponsible"
                  size="sm"
                  className="mt-1 min-h-[44px]"
                  value={responsible}
                  onChange={(event) => setResponsible(event.target.value)}
                  disabled={saving}
                  placeholder="Who should act next?"
                />
              </label>
              <label className="block text-[11px] text-muted">
                Check again at
                <Input
                  type="datetime-local"
                  name="workStateCheckAgainAt"
                  size="sm"
                  className="mt-1 min-h-[44px]"
                  value={checkAgainAtInput}
                  onChange={handleCheckAgainAtChange}
                  disabled={saving}
                  aria-invalid={dateError ? 'true' : 'false'}
                  aria-describedby={dateError ? 'work-state-check-again-error' : undefined}
                />
                {dateError && (
                  <span id="work-state-check-again-error" className="mt-1 block text-[11px] text-danger" role="alert">
                    {dateError}
                  </span>
                )}
              </label>
            </div>
          )}

          <div className="flex items-center justify-between gap-2 mt-3">
            {saving ? <span className="text-[10px] text-muted" role="status">Saving…</span> : <span />}
            <Button
              type="submit"
              size="xs"
              variant="secondary"
              data-work-state-save="true"
              className="min-h-[44px]"
              disabled={saving || !!dateError}
            >
              Save
            </Button>
          </div>

          {error && <div className="mt-2 text-[11px] text-danger" role="alert">{error}</div>}
        </form>
      )}
    </Popover>
  );
}
