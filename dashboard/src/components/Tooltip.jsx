import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';

export default function Tooltip({ content, placement = 'top', children }) {
  const [visible, setVisible] = useState(false);
  const [coords, setCoords] = useState({ top: 0, left: 0 });
  const triggerRef = useRef(null);
  const tooltipRef = useRef(null);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    const tooltip = tooltipRef.current;
    if (!trigger || !tooltip) return;

    const rect = trigger.getBoundingClientRect();
    const tipRect = tooltip.getBoundingClientRect();
    const gap = 6;

    let top, left;
    switch (placement) {
      case 'bottom':
        top = rect.bottom + gap;
        left = rect.left + (rect.width - tipRect.width) / 2;
        break;
      case 'left':
        top = rect.top + (rect.height - tipRect.height) / 2;
        left = rect.left - tipRect.width - gap;
        break;
      case 'right':
        top = rect.top + (rect.height - tipRect.height) / 2;
        left = rect.right + gap;
        break;
      default: // top
        top = rect.top - tipRect.height - gap;
        left = rect.left + (rect.width - tipRect.width) / 2;
    }

    setCoords({ top, left: Math.max(4, left) });
  }, [placement]);

  useEffect(() => {
    if (visible) updatePosition();
  }, [visible, updatePosition]);

  if (!content) return children;

  return (
    <>
      <span
        ref={triggerRef}
        onMouseEnter={() => setVisible(true)}
        onMouseLeave={() => setVisible(false)}
        onFocus={() => setVisible(true)}
        onBlur={() => setVisible(false)}
        className="inline-flex"
      >
        {children}
      </span>
      {visible && createPortal(
        <div
          ref={tooltipRef}
          role="tooltip"
          className="fixed z-[1100] px-2 py-1 text-[11px] font-medium text-text-strong bg-bg-elevated border border-border-strong rounded-sm shadow-md pointer-events-none animate-scale-in"
          style={{ top: coords.top, left: coords.left }}
        >
          {content}
        </div>,
        document.body
      )}
    </>
  );
}
