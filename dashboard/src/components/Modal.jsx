import { useEffect, useRef, useCallback, useId } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import Button from './Button.jsx';

const widths = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-2xl',
};

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal — Portal-based dialog with overlay, dialog semantics, and focus management.
 * Focus moves into the dialog on open (unless a child already grabbed it),
 * Tab cycles within the dialog, and focus returns to the opener on close.
 * @param {boolean} open - Whether the modal is visible
 * @param {function} onClose - Called on overlay click, Escape key, or close button
 * @param {string} [title] - Header title (also labels the dialog for screen readers)
 * @param {'sm'|'md'|'lg'} [size='md'] - Dialog max width (384/448/672px)
 * @param {boolean} [dismissible=true] - Allow overlay/Escape/close-button dismissal
 * @param {boolean} [showClose=false] - Render an X close button in the header
 * @param {ReactNode} [actions] - Footer action buttons
 * @param {ReactNode} children - Modal body content
 * @example <Modal open={show} onClose={close} title="Confirm">{body}</Modal>
 */
export default function Modal({
  open,
  onClose,
  title,
  children,
  actions,
  size = 'md',
  dismissible = true,
  showClose = false,
}) {
  const overlayRef = useRef(null);
  const panelRef = useRef(null);
  const titleId = useId();

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Escape' && dismissible) {
      onClose?.();
      return;
    }
    if (e.key === 'Tab') {
      const focusables = panelRef.current?.querySelectorAll(FOCUSABLE);
      if (!focusables || focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !panelRef.current.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !panelRef.current.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    }
  }, [onClose, dismissible]);

  useEffect(() => {
    if (!open) return;
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, handleKeyDown]);

  // Move focus into the dialog on open, restore it to the opener on close.
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement;
    const timer = setTimeout(() => {
      if (panelRef.current && !panelRef.current.contains(document.activeElement)) {
        panelRef.current.focus();
      }
    }, 0);
    return () => {
      clearTimeout(timer);
      opener?.focus?.();
    };
  }, [open]);

  const handleOverlayClick = (e) => {
    if (e.target === overlayRef.current && dismissible) onClose?.();
  };

  if (!open) return null;

  return createPortal(
    <div
      ref={overlayRef}
      onClick={handleOverlayClick}
      className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/60"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        className={`bg-card border border-border rounded-lg shadow-lg w-full ${widths[size] || widths.md} mx-4 overflow-hidden animate-scale-in outline-none`}
      >
        {(title || showClose) && (
          <div className="flex items-start justify-between px-5 pt-5 pb-0">
            {title && (
              <h3 id={titleId} className="text-base font-semibold text-text-strong m-0">
                {title}
              </h3>
            )}
            {showClose && (
              <button
                type="button"
                onClick={onClose}
                disabled={!dismissible}
                aria-label="Close"
                className="inline-flex items-center justify-center w-7 h-7 -mt-1 -mr-1 ml-auto rounded-md border-0 bg-transparent text-muted cursor-pointer hover:bg-bg-hover hover:text-text disabled:opacity-50 disabled:cursor-default"
              >
                <X size={16} />
              </button>
            )}
          </div>
        )}
        <div className="px-5 py-4 text-sm text-text">
          {children}
        </div>
        {actions && (
          <div className="flex justify-end gap-2 px-5 pb-4">
            {actions}
          </div>
        )}
      </div>
    </div>,
    document.getElementById('modalRoot') || document.body
  );
}

// Re-export Button for convenience in modal action slots
Modal.Button = Button;
