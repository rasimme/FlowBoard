import { useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import Button from './Button.jsx';

export default function Modal({
  open,
  onClose,
  title,
  children,
  actions,
}) {
  const overlayRef = useRef(null);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Escape') onClose?.();
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, handleKeyDown]);

  const handleOverlayClick = (e) => {
    if (e.target === overlayRef.current) onClose?.();
  };

  if (!open) return null;

  return createPortal(
    <div
      ref={overlayRef}
      onClick={handleOverlayClick}
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/60"
    >
      <div className="bg-[var(--card)] border border-[var(--border)] rounded-[var(--radius-lg)] shadow-[var(--shadow-lg)] w-full max-w-md mx-4 overflow-hidden">
        {title && (
          <div className="px-5 pt-5 pb-0">
            <h3 className="text-base font-semibold text-[var(--text-strong)] m-0">
              {title}
            </h3>
          </div>
        )}
        <div className="px-5 py-4 text-sm text-[var(--text)]">
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
