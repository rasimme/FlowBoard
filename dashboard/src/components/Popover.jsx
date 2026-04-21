import { useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';

/**
 * Popover — Anchored floating panel with animation, viewport clamping, and auto-close.
 * Renders via portal at body level to avoid scroll-container clipping.
 * @param {boolean} open - Whether the popover is visible
 * @param {function} onClose - Called on click-outside, Escape, or scroll
 * @param {DOMRect} anchorRect - Anchor element's getBoundingClientRect() for positioning
 * @param {ReactNode} children - Popover content
 * @example
 * <Popover open={show} onClose={close} anchorRect={rect}>
 *   <Popover.Option onClick={handleA}>Option A</Popover.Option>
 *   <Popover.Option onClick={handleB}>Option B</Popover.Option>
 * </Popover>
 */
export default function Popover({ open, onClose, anchorRect, children }) {
  const ref = useRef(null);

  const handleClose = useCallback(() => {
    onClose?.();
  }, [onClose]);

  useEffect(() => {
    if (!open) return;

    const onClickOutside = (e) => {
      if (ref.current && !ref.current.contains(e.target)) handleClose();
    };
    const onEscape = (e) => {
      if (e.key === 'Escape') handleClose();
    };
    const onScroll = () => handleClose();

    document.addEventListener('mousedown', onClickOutside);
    document.addEventListener('keydown', onEscape);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onClickOutside);
      document.removeEventListener('keydown', onEscape);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, handleClose]);

  if (!open || !anchorRect) return null;

  // Position: default below anchor, flip above if overflows viewport
  const gap = 4;
  const popH = 200; // estimated max height for flip check
  const popW = 160; // estimated max width for clamp check

  let top = anchorRect.bottom + gap;
  let left = anchorRect.left;

  // Flip above if below overflows
  if (top + popH > window.innerHeight) {
    top = anchorRect.top - gap - popH;
    if (top < 0) top = anchorRect.bottom + gap; // fallback: stay below
  }

  // Clamp right edge
  if (left + popW > window.innerWidth) {
    left = window.innerWidth - popW - 8;
  }
  if (left < 8) left = 8;

  return createPortal(
    <div
      ref={ref}
      className="fixed bg-bg-elevated border border-border-strong rounded-lg shadow-lg py-1 w-max min-w-[120px] z-[1200] animate-pop-in"
      style={{ top, left }}
    >
      {children}
    </div>,
    document.body
  );
}

/**
 * Popover.Option — Standard option row inside a Popover.
 * @param {function} onClick - Click handler
 * @param {string} [className] - Extra classes
 * @param {ReactNode} children - Option label
 */
Popover.Option = function PopoverOption({ children, onClick, className = '' }) {
  // Reset classes (bg-transparent, border-0, appearance-none, text-inherit, font-[inherit])
  // restore what Tailwind preflight would normally do for <button>. Preflight is disabled
  // project-wide to avoid conflicts with legacy dashboard.css, so we apply the reset per-button.
  // Without this, browsers render buttons with `appearance: button` — light-gray bg, native
  // border, ~2px radius — which visually dominates the portaled popover interior.
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'w-full text-left text-sm px-3 py-1.5',
        'bg-transparent border-0 appearance-none text-inherit font-[inherit]',
        'hover:bg-bg-hover cursor-pointer transition-colors duration-fast',
        className,
      ].join(' ')}
    >
      {children}
    </button>
  );
};
