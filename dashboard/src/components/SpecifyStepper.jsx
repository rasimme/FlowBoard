import { useState, useEffect, useRef } from 'react';
import OptionList from './OptionList.jsx';
import { ChevronRight, ChevronDown, AlertCircle, RotateCcw, FastForward, CheckCircle2 } from 'lucide-react';
import { Modal, Button, Textarea, Spinner, Checkbox } from './index.js';
import MarkdownPreview from './MarkdownPreview.jsx';

// Mirrors MAX_CLARIFICATIONS in specify-policy.js (server-enforced cap).
const MAX_QUESTIONS = 4;

// NOTE: Tailwind preflight is disabled in this project (legacy CSS coexists),
// so raw <button> elements keep the UA's light default background. Every
// button here must set an explicit background class.

function BusyState({ label, hint }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-8">
      <div className="flex items-center gap-3">
        <Spinner size="md" />
        <span className="text-text">{label}</span>
      </div>
      {hint && <p className="text-muted text-sm m-0">{hint}</p>}
    </div>
  );
}

export default function SpecifyStepper({ sessionId, onComplete, onCancel }) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [answerText, setAnswerText] = useState('');
  const [selectedOption, setSelectedOption] = useState(null);
  const [showSpecPreview, setShowSpecPreview] = useState(false);
  const [showAnswered, setShowAnswered] = useState(false);
  const [cleanupNotes, setCleanupNotes] = useState(true);
  const [createdTasks, setCreatedTasks] = useState([]);
  const [showRevise, setShowRevise] = useState(false);
  const [reviseText, setReviseText] = useState('');
  const [isOpen, setIsOpen] = useState(true);
  const requestedNext = useRef(new Set());
  const lastQuestionId = useRef(null);

  useEffect(() => {
    fetchSession();
    const interval = setInterval(fetchSession, 2000);
    return () => clearInterval(interval);
  }, [sessionId]);

  async function fetchSession() {
    try {
      const res = await fetch(`/api/specify/sessions/${sessionId}`);
      if (!res.ok) throw new Error('Failed to load session');
      const data = await res.json();
      applySession(data);
      if (data.status === 'created' && !requestedNext.current.has(data.id)) {
        requestedNext.current.add(data.id);
        requestNext(data.id);
      }
      setLoading(false);
    } catch (e) {
      setError(e.message);
      setLoading(false);
    }
  }

  // Preselect the recommended option whenever a new question arrives.
  function applySession(data) {
    setSession(data);
    const openQ = (data?.clarifications || []).find(c => !c.answer);
    if (openQ && openQ.id !== lastQuestionId.current) {
      lastQuestionId.current = openQ.id;
      setSelectedOption(openQ.recommended ?? null);
      setAnswerText('');
    }
  }

  async function requestNext(id = sessionId) {
    try {
      const res = await fetch(`/api/specify/sessions/${id}/next`, { method: 'POST' });
      if (!res.ok) throw new Error('Failed to start analysis');
      const result = await res.json();
      applySession(result.session);
    } catch (e) {
      setError(e.message);
    }
  }

  async function postStep(path, body) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/specify/sessions/${sessionId}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Request failed (${path})`);
      }
      const result = await res.json();
      applySession(result.session);
      return result;
    } catch (e) {
      setError(e.message);
      return null;
    } finally {
      setLoading(false);
    }
  }

  async function handleAnswer() {
    const currentQ = session.clarifications.find(c => !c.answer);
    if (!currentQ) return;
    const option = (currentQ.options || []).find(o => o.key === selectedOption);
    const freeText = answerText.trim();
    // Free text overrides the selected option.
    const answer = freeText || (option ? `${option.key}: ${option.label}` : '');
    if (!answer) return;
    const result = await postStep('answer', { clarificationId: currentQ.id, answer });
    if (result) setAnswerText('');
  }

  async function handleSkipRemaining() {
    await postStep('skip');
  }

  async function handleRevise() {
    const feedback = reviseText.trim();
    if (!feedback) return;
    const result = await postStep('revise', { feedback });
    if (result) {
      setReviseText('');
      setShowRevise(false);
    }
  }

  async function handleRetry() {
    await postStep('retry');
  }

  async function handleConfirm(approved) {
    if (!approved) {
      await handleCancel();
      return;
    }
    const result = await postStep('confirm', {
      userApproval: true,
      customizations: { cleanupNotes },
    });
    if (result) {
      const tasks = result.createdTasks || [];
      setCreatedTasks(tasks);
      if (window.showToast && tasks.length > 0) {
        window.showToast(`Created ${tasks.length} task${tasks.length > 1 ? 's' : ''} (${tasks[0]}${tasks.length > 1 ? ', …' : ''})`, 'success');
      }
      // Stay on the success screen — closing/finishing is the user's call.
    }
  }

  function finish() {
    setIsOpen(false);
    setTimeout(() => onComplete?.({ createdTasks }), 100);
  }

  function viewInKanban() {
    if (createdTasks[0]) window._scrollToTaskId = createdTasks[0];
    window._switchTab?.('tasks');
    finish();
  }

  async function handleCancel() {
    try {
      const current = session?.status;
      if (current && !['done', 'error', 'aborted'].includes(current)) {
        await fetch(`/api/specify/sessions/${sessionId}/abort`, { method: 'POST' });
      }
    } catch {}
    setIsOpen(false);
    setTimeout(() => onCancel?.(), 100);
  }

  if (!session && loading) {
    return (
      <Modal open={isOpen} onClose={handleCancel} size="lg" title="Create tasks from ideas">
        <BusyState label="Starting Specify session..." />
      </Modal>
    );
  }

  if (!session) {
    return (
      <Modal open={isOpen} onClose={handleCancel} size="lg" title="Create tasks from ideas">
        <div className="flex items-start gap-3">
          <AlertCircle className="text-danger mt-0.5 shrink-0" size={20} />
          <div>
            <h3 className="font-semibold text-text m-0 mb-1">Failed to load session</h3>
            <p className="text-muted text-sm mb-4">{error}</p>
            <Button variant="secondary" size="sm" onClick={handleCancel}>Close</Button>
          </div>
        </div>
      </Modal>
    );
  }

  const clarifications = session.clarifications || [];
  const currentQ = clarifications.find(c => !c.answer) || null;
  const answered = clarifications.filter(c => c.answer);

  const isFailed = session.status === 'error';
  const isDone = session.status === 'done';
  const isProposalReady = session.status === 'proposal-ready' && !!session.draftProposal;
  const isAnswering = session.status === 'clarifying' && !!currentQ && !loading;
  // Covers: initial analysis, the worker generating the proposal after the
  // last answer (status stays 'clarifying' with no open question), and any
  // in-flight step — no state combination may render an empty dialog.
  const isBusy = !isFailed && !isDone && !isProposalReady && !isAnswering;

  const busyLabel = ['confirmed', 'persisting'].includes(session.status) ? 'Creating tasks...'
    : (session.revisionNotes || []).length > 0 && session.status === 'analyzing' ? 'Revising proposal...'
    : answered.length > 0 ? 'Generating proposal...'
    : 'Analyzing ideas...';

  const hasFreeText = answerText.trim().length > 0;
  const canSubmitAnswer = hasFreeText || (currentQ && (currentQ.options || []).some(o => o.key === selectedOption));

  const title = isDone ? 'Tasks created'
    : isFailed ? 'Specify failed'
    : isProposalReady ? 'Review proposal'
    : 'Create tasks from ideas';

  return (
    <Modal open={isOpen} onClose={isFailed || isDone ? handleCancel : null} size="lg" title={title}>
      <div className="pt-1">
        {isBusy && (
          <BusyState
            label={busyLabel}
            hint="The Specify worker is thinking — this can take a few seconds."
          />
        )}

        {isAnswering && (
          <div className="space-y-4">
            <div className="text-xs text-muted">
              Question {answered.length + 1} of max {session.maxQuestions || MAX_QUESTIONS}
            </div>

            {answered.length > 0 && (
              <div className="border border-border rounded-md">
                <button
                  type="button"
                  onClick={() => setShowAnswered(v => !v)}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm bg-transparent border-0 cursor-pointer text-muted hover:text-text"
                >
                  {showAnswered ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <span>{answered.length} answered question{answered.length > 1 ? 's' : ''}</span>
                </button>
                {showAnswered && (
                  <ul className="px-4 pb-3 m-0 space-y-2 list-none">
                    {answered.map(c => (
                      <li key={c.id} className="text-sm">
                        <p className="text-muted m-0">{c.question}</p>
                        <p className="text-text font-medium m-0">→ {c.answer}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <h4 className="text-base font-semibold text-text-strong m-0">{currentQ.question}</h4>

            <OptionList
              options={currentQ.options || []}
              value={hasFreeText ? null : selectedOption}
              onChange={(key) => { setSelectedOption(key); setAnswerText(''); }}
              recommendedKey={currentQ.recommended}
            />

            <Textarea
              value={answerText}
              onChange={(e) => setAnswerText(e.target.value)}
              placeholder={(currentQ.options || []).length > 0 ? 'Or type your own answer...' : 'Enter your answer'}
              rows={2}
              className="w-full"
            />

            {error && (
              <div className="p-3 rounded-md border border-danger bg-danger-subtle text-danger text-sm">
                {error}
              </div>
            )}

            <div className="flex gap-2">
              <Button onClick={handleAnswer} disabled={!canSubmitAnswer || loading} className="flex-1">
                {loading ? <Spinner size="sm" /> : <ChevronRight size={14} />}
                Answer
              </Button>
              <Button onClick={handleSkipRemaining} disabled={loading} variant="secondary" title="Use recommended answers and continue to the proposal">
                <FastForward size={14} />
                Skip remaining
              </Button>
              <Button onClick={handleCancel} variant="ghost">
                Cancel
              </Button>
            </div>
          </div>
        )}

        {isProposalReady && (
          <div className="space-y-4">
            <div className="p-4 rounded-md border border-border bg-bg-elevated space-y-3">
              <div>
                <p className="text-xs font-semibold text-muted uppercase tracking-wide m-0 mb-1">
                  Task structure
                </p>
                <p className="text-sm text-text m-0">{session.draftProposal.taskStructure || 'Single task'}</p>
              </div>
              <div>
                <p className="text-xs font-semibold text-muted uppercase tracking-wide m-0 mb-1">
                  Summary
                </p>
                <p className="text-sm text-text whitespace-pre-wrap m-0">{session.draftProposal.summary || ''}</p>
              </div>
              {(session.draftProposal.taskBreakdown || []).length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-muted uppercase tracking-wide m-0 mb-2">
                    Tasks
                  </p>
                  <ul className="space-y-1 m-0 list-none p-0">
                    {(() => {
                      const legacyParent = /^parent/i.test(session.draftProposal.taskStructure || '');
                      let topLevelCount = 0;
                      return session.draftProposal.taskBreakdown.map((t, idx) => {
                        const entry = typeof t === 'string' ? { title: t } : t;
                        const isSubtask = entry.role
                          ? entry.role === 'subtask'
                          : legacyParent && idx > 0;
                        // Number only top-level entries — subtasks don't count.
                        if (!isSubtask) topLevelCount += 1;
                        return (
                          <li key={idx} className={`text-sm text-text flex gap-2 ${isSubtask ? 'pl-5' : ''}`}>
                            <span className="text-muted">{isSubtask ? '└' : `${topLevelCount}.`}</span>
                            <span className={isSubtask ? '' : 'font-medium'}>{entry.title}</span>
                            {entry.specContent && (
                              <span className="text-xs text-accent-2 self-center">spec</span>
                            )}
                          </li>
                        );
                      });
                    })()}
                  </ul>
                </div>
              )}
              {session.draftProposal.specContent && (
                <div>
                  <button
                    type="button"
                    onClick={() => setShowSpecPreview(v => !v)}
                    className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide bg-transparent border-0 p-0 cursor-pointer text-muted hover:text-text"
                  >
                    {showSpecPreview ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    Spec preview
                  </button>
                  {showSpecPreview && (
                    <div className="mt-2 max-h-64 overflow-y-auto rounded-md border border-border bg-bg p-3">
                      <MarkdownPreview content={session.draftProposal.specContent} />
                    </div>
                  )}
                </div>
              )}
            </div>

            {(session.sourceNoteIds || []).length > 0 && (
              <Checkbox
                checked={cleanupNotes}
                onChange={(e) => setCleanupNotes(e.target.checked)}
                label={`Remove ${session.sourceNoteIds.length > 1 ? `${session.sourceNoteIds.length} source notes` : 'the source note'} from the canvas`}
              />
            )}

            {error && (
              <div className="p-3 rounded-md border border-danger bg-danger-subtle text-danger text-sm">
                {error}
              </div>
            )}

            {showRevise && (
              <div className="space-y-2">
                <Textarea
                  value={reviseText}
                  onChange={(e) => setReviseText(e.target.value)}
                  placeholder="What should change? (e.g. split this into two parent tasks, add a migration step, drop the export part)"
                  rows={3}
                  className="w-full"
                />
                <div className="flex gap-2">
                  <Button onClick={handleRevise} disabled={!reviseText.trim() || loading} size="sm">
                    {loading ? <Spinner size="sm" /> : <RotateCcw size={14} />}
                    Revise proposal
                  </Button>
                  <Button onClick={() => setShowRevise(false)} variant="ghost" size="sm">
                    Discard
                  </Button>
                </div>
              </div>
            )}

            <div className="flex gap-2">
              <Button onClick={() => handleConfirm(true)} disabled={loading} className="flex-1">
                {loading ? <Spinner size="sm" /> : <CheckCircle2 size={14} />}
                Create
              </Button>
              {!showRevise && (
                <Button onClick={() => setShowRevise(true)} disabled={loading} variant="secondary">
                  Request changes
                </Button>
              )}
              <Button onClick={() => handleConfirm(false)} disabled={loading} variant="ghost">
                Cancel
              </Button>
            </div>
          </div>
        )}

        {isDone && (
          <div className="text-center space-y-4 py-4">
            <CheckCircle2 className="text-accent-2 mx-auto" size={32} />
            <div>
              <p className="text-text m-0">
                {createdTasks.length > 0
                  ? `Created ${createdTasks.length} task${createdTasks.length > 1 ? 's' : ''}: ${createdTasks.join(', ')}`
                  : 'Your canvas ideas have been converted to tasks.'}
              </p>
              <p className="text-muted text-sm m-0 mt-1">New tasks start in the Backlog column.</p>
            </div>
            <div className="flex gap-2 justify-center">
              <Button onClick={viewInKanban}>View in Kanban</Button>
              <Button onClick={finish} variant="secondary">Close</Button>
            </div>
          </div>
        )}

        {isFailed && (
          <div className="space-y-4">
            <div className="flex items-start gap-3">
              <AlertCircle className="text-danger mt-0.5 shrink-0" size={20} />
              <div className="flex-1">
                <p className="text-text m-0 mb-1">
                  {session.failureState?.error || 'An unexpected error occurred'}
                </p>
                <p className="text-muted text-xs m-0">
                  Your canvas notes are untouched. You can retry or close this dialog.
                </p>
              </div>
            </div>
            {error && (
              <div className="p-3 rounded-md border border-danger bg-danger-subtle text-danger text-sm">
                {error}
              </div>
            )}
            <div className="flex gap-2">
              <Button onClick={handleRetry} disabled={loading} className="flex-1">
                {loading ? <Spinner size="sm" /> : <RotateCcw size={14} />}
                Retry
              </Button>
              <Button onClick={handleCancel} variant="secondary">
                Close
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
