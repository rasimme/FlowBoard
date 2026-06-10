import { useState, useEffect, useRef } from 'react';
import { ChevronRight, ChevronDown, AlertCircle, RotateCcw, FastForward } from 'lucide-react';
import { Modal, Button, Textarea, Spinner } from './index.js';
import MarkdownPreview from './MarkdownPreview.jsx';

// Mirrors MAX_CLARIFICATIONS in specify-policy.js (server-enforced cap).
const MAX_QUESTIONS = 4;

export default function SpecifyStepper({ sessionId, onComplete, onCancel }) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [answerText, setAnswerText] = useState('');
  const [selectedOption, setSelectedOption] = useState(null);
  const [showSpecPreview, setShowSpecPreview] = useState(false);
  const [showAnswered, setShowAnswered] = useState(false);
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

  async function handleRetry() {
    await postStep('retry');
  }

  async function handleConfirm(approved) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/specify/sessions/${sessionId}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userApproval: approved }),
      });
      if (!res.ok) throw new Error('Failed to confirm proposal');
      const result = await res.json();
      applySession(result.session);
      if (approved) {
        onComplete?.(result);
      } else {
        await handleCancel();
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleCancel() {
    try {
      await fetch(`/api/specify/sessions/${sessionId}/abort`, { method: 'POST' });
    } catch {}
    setIsOpen(false);
    setTimeout(() => onCancel?.(), 100);
  }

  if (!session && loading) {
    return (
      <Modal open={isOpen} onClose={handleCancel}>
        <div className="flex items-center justify-center p-8 gap-3">
          <Spinner />
          <span className="text-text">Starting Specify session...</span>
        </div>
      </Modal>
    );
  }

  if (!session) {
    return (
      <Modal open={isOpen} onClose={handleCancel}>
        <div className="p-6 bg-bg-elevated rounded-lg">
          <div className="flex items-start gap-3">
            <AlertCircle className="text-danger mt-0.5" size={20} />
            <div>
              <h3 className="font-semibold text-text mb-1">Failed to load session</h3>
              <p className="text-text-muted text-sm mb-4">{error}</p>
              <Button onClick={handleCancel}>Close</Button>
            </div>
          </div>
        </div>
      </Modal>
    );
  }

  const isAnalyzing = (session.status === 'analyzing' || session.status === 'created') && !loading;
  const isAnswering = session.status === 'clarifying';
  const isProposalReady = session.status === 'proposal-ready';
  const isDone = session.status === 'done';
  const isFailed = session.status === 'error';

  const clarifications = session.clarifications || [];
  const currentQ = isAnswering ? clarifications.find(c => !c.answer) : null;
  const answered = clarifications.filter(c => c.answer);
  const hasFreeText = answerText.trim().length > 0;
  const canSubmitAnswer = hasFreeText || (currentQ && (currentQ.options || []).some(o => o.key === selectedOption));

  return (
    <Modal open={isOpen} onClose={isFailed || isDone ? handleCancel : null}>
      <div className="w-full max-w-2xl mx-auto p-6 bg-bg-elevated rounded-lg">
        {(isAnalyzing || (loading && !currentQ && !isProposalReady && !isDone && !isFailed)) && (
          <div className="flex flex-col items-center justify-center gap-3 py-8">
            <div className="flex items-center gap-3">
              <Spinner />
              <span className="text-text">Analyzing ideas...</span>
            </div>
            <p className="text-text-muted text-sm">
              The Specify worker is preparing the next step — this can take a few seconds.
            </p>
          </div>
        )}

        {isAnswering && currentQ && (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-sm text-text-muted mb-2">
              <span>Question {answered.length + 1} of max {MAX_QUESTIONS}</span>
            </div>

            {answered.length > 0 && (
              <div className="border border-border-subtle rounded">
                <button
                  type="button"
                  onClick={() => setShowAnswered(v => !v)}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-text-muted hover:text-text"
                >
                  {showAnswered ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <span>{answered.length} answered question{answered.length > 1 ? 's' : ''}</span>
                </button>
                {showAnswered && (
                  <ul className="px-4 pb-3 space-y-2">
                    {answered.map(c => (
                      <li key={c.id} className="text-sm">
                        <p className="text-text-muted">{c.question}</p>
                        <p className="text-text font-medium">→ {c.answer}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <h3 className="text-lg font-semibold text-text">{currentQ.question}</h3>

            {(currentQ.options || []).length > 0 && (
              <div className="space-y-2" role="radiogroup">
                {currentQ.options.map(opt => {
                  const isSelected = selectedOption === opt.key && !hasFreeText;
                  const isRecommended = currentQ.recommended === opt.key;
                  return (
                    <button
                      key={opt.key}
                      type="button"
                      role="radio"
                      aria-checked={isSelected}
                      onClick={() => { setSelectedOption(opt.key); setAnswerText(''); }}
                      className={`w-full text-left p-3 rounded border transition-colors ${
                        isSelected
                          ? 'border-accent bg-bg-hover'
                          : 'border-border-subtle hover:border-border hover:bg-bg-hover'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className={`inline-flex items-center justify-center w-4 h-4 rounded-full border ${
                          isSelected ? 'border-accent' : 'border-border'
                        }`}>
                          {isSelected && <span className="w-2 h-2 rounded-full bg-accent" />}
                        </span>
                        <span className="text-sm font-medium text-text">
                          {opt.key}: {opt.label}
                          {isRecommended && <span className="ml-2 text-xs text-accent">(recommended)</span>}
                        </span>
                      </div>
                      {opt.rationale && (
                        <p className="text-xs text-text-muted mt-1 ml-6">{opt.rationale}</p>
                      )}
                    </button>
                  );
                })}
              </div>
            )}

            <Textarea
              value={answerText}
              onChange={(e) => setAnswerText(e.target.value)}
              placeholder={(currentQ.options || []).length > 0 ? 'Or type your own answer...' : 'Enter your answer'}
              rows={2}
              className="w-full"
            />

            {error && (
              <div className="p-3 bg-danger-subtle rounded border border-danger text-danger text-sm">
                {error}
              </div>
            )}

            <div className="flex gap-2">
              <Button
                onClick={handleAnswer}
                disabled={!canSubmitAnswer || loading}
                className="flex-1"
              >
                {loading ? <Spinner size={16} /> : <ChevronRight size={16} />}
                Answer
              </Button>
              <Button onClick={handleSkipRemaining} disabled={loading} variant="secondary" title="Use recommended answers and continue to the proposal">
                <FastForward size={16} />
                Skip remaining
              </Button>
              <Button onClick={handleCancel} variant="secondary">
                Cancel
              </Button>
            </div>
          </div>
        )}

        {isProposalReady && session.draftProposal && (
          <div className="space-y-4">
            <h3 className="text-lg font-semibold text-text">Review proposal</h3>
            <div className="p-4 bg-bg-hover rounded border border-border space-y-3">
              <div>
                <p className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-1">
                  Task structure
                </p>
                <p className="text-sm text-text">{session.draftProposal.taskStructure || 'Single task'}</p>
              </div>
              <div>
                <p className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-1">
                  Summary
                </p>
                <p className="text-sm text-text whitespace-pre-wrap">{session.draftProposal.summary || ''}</p>
              </div>
              {(session.draftProposal.taskBreakdown || []).length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-2">
                    Tasks
                  </p>
                  <ul className="space-y-1">
                    {session.draftProposal.taskBreakdown.map((t, idx) => (
                      <li key={idx} className="text-sm text-text flex gap-2">
                        <span className="text-text-muted">{idx + 1}.</span>
                        <span>{typeof t === 'string' ? t : t.title}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {(session.draftProposal.subtasks || []).length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-2">
                    Subtasks
                  </p>
                  <ul className="space-y-1">
                    {session.draftProposal.subtasks.map((st, idx) => (
                      <li key={idx} className="text-sm text-text flex gap-2">
                        <span className="text-text-muted">{idx + 1}.</span>
                        <span>{st}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {session.draftProposal.specContent && (
                <div>
                  <button
                    type="button"
                    onClick={() => setShowSpecPreview(v => !v)}
                    className="flex items-center gap-1 text-xs font-semibold text-text-muted uppercase tracking-wide hover:text-text"
                  >
                    {showSpecPreview ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    Spec preview
                  </button>
                  {showSpecPreview && (
                    <div className="mt-2 max-h-64 overflow-y-auto border border-border-subtle rounded p-3 bg-bg">
                      <MarkdownPreview content={session.draftProposal.specContent} />
                    </div>
                  )}
                </div>
              )}
            </div>
            {error && (
              <div className="p-3 bg-danger-subtle rounded border border-danger text-danger text-sm">
                {error}
              </div>
            )}
            <div className="flex gap-2">
              <Button
                onClick={() => handleConfirm(true)}
                disabled={loading}
                className="flex-1"
              >
                {loading ? <Spinner size={16} /> : '✓ Create'}
              </Button>
              <Button
                onClick={() => handleConfirm(false)}
                disabled={loading}
                variant="secondary"
              >
                Cancel
              </Button>
            </div>
          </div>
        )}

        {isDone && (
          <div className="text-center space-y-4 py-6">
            <div className="text-4xl">✓</div>
            <h3 className="text-lg font-semibold text-text">Task created</h3>
            <p className="text-text-muted">Your canvas ideas have been converted to a task.</p>
            <Button onClick={handleCancel} className="w-full">
              Done
            </Button>
          </div>
        )}

        {isFailed && (
          <div className="space-y-4">
            <div className="flex items-start gap-3">
              <AlertCircle className="text-danger mt-0.5" size={20} />
              <div className="flex-1">
                <h3 className="font-semibold text-text mb-1">Specify step failed</h3>
                <p className="text-text-muted text-sm mb-1">
                  {session.failureState?.error || 'An unexpected error occurred'}
                </p>
                <p className="text-text-muted text-xs">
                  Your canvas notes are untouched. You can retry or close this dialog.
                </p>
              </div>
            </div>
            {error && (
              <div className="p-3 bg-danger-subtle rounded border border-danger text-danger text-sm">
                {error}
              </div>
            )}
            <div className="flex gap-2">
              <Button onClick={handleRetry} disabled={loading} className="flex-1">
                {loading ? <Spinner size={16} /> : <RotateCcw size={16} />}
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
