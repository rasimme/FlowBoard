import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

/**
 * UndoToast — sticky notification with an Undo action.
 *
 * Used for soft-delete operations (T-161-4). Auto-dismisses after
 * `duration` ms if the user doesn't click Undo. Hovering pauses the
 * timer so the user can read the message. Click ✕ to dismiss early.
 *
 * Props:
 *   message   — short text, e.g. "T-42 moved to Trash"
 *   onUndo    — invoked when user clicks "Undo"; toast dismisses
 *   onDismiss — invoked on auto-dismiss or manual close
 *   duration  — auto-dismiss timeout in ms (default 8000)
 */
export default function UndoToast({ message, onUndo, onDismiss, duration = 8000 }) {
  const [remaining, setRemaining] = useState(duration);
  const timerRef = useRef(null);
  const startRef = useRef(Date.now());
  const hoverRef = useRef(false);

  useEffect(() => {
    startTimer(duration);
    return () => clearTimeout(timerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function startTimer(ms) {
    clearTimeout(timerRef.current);
    startRef.current = Date.now();
    setRemaining(ms);
    timerRef.current = setTimeout(() => { if (!hoverRef.current) onDismiss?.(); }, ms);
  }

  function pause() {
    hoverRef.current = true;
    clearTimeout(timerRef.current);
    setRemaining((r) => Math.max(0, r - (Date.now() - startRef.current)));
  }
  function resume() {
    hoverRef.current = false;
    startTimer(remaining);
  }

  return createPortal(
    <div
      role="status"
      aria-live="polite"
      onMouseEnter={pause}
      onMouseLeave={resume}
      className="fixed bottom-6 right-6 z-[1700] flex items-center gap-3 px-4 py-2.5 rounded-lg bg-card-highlight border border-border-strong shadow-lg text-sm text-text animate-slide-in-right"
      style={{ minWidth: 260 }}
    >
      <span className="flex-1">{message}</span>
      <button
        type="button"
        onClick={() => { clearTimeout(timerRef.current); onUndo?.(); }}
        className="text-accent hover:text-accent-hover font-semibold px-2 py-1 rounded bg-transparent border-0 cursor-pointer"
      >
        Undo
      </button>
      <button
        type="button"
        onClick={() => { clearTimeout(timerRef.current); onDismiss?.(); }}
        className="text-muted hover:text-text p-1 rounded bg-transparent border-0 cursor-pointer"
        title="Dismiss"
        aria-label="Dismiss"
      >
        <X size={14} />
      </button>
    </div>,
    document.body
  );
}
