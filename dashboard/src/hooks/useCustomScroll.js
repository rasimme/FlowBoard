import { useRef, useEffect } from 'react';

/**
 * useCustomScroll — Attaches a custom scrollbar (track + draggable thumb)
 * to the element referenced by the returned ref.
 *
 * Uses the existing CSS classes from dashboard.css:
 *   .cscroll-track, .cscroll-thumb, .cscroll-track.hidden
 *
 * The parent element must be position:relative (set automatically).
 * Native scrollbars are globally hidden via dashboard.css.
 *
 * @returns {React.RefObject} — attach to the scrollable element
 * @example
 *   const scrollRef = useCustomScroll();
 *   <div ref={scrollRef} style={{ overflowY: 'auto' }}>{content}</div>
 */
export function useCustomScroll() {
  const ref = useRef(null);

  useEffect(() => {
    const scrollEl = ref.current;
    if (!scrollEl) return;

    const parent = scrollEl.parentNode;
    if (!parent) return;
    parent.style.position = 'relative';

    // Create track + thumb DOM
    const track = document.createElement('div');
    track.className = 'cscroll-track';
    const thumb = document.createElement('div');
    thumb.className = 'cscroll-thumb';
    track.appendChild(thumb);
    parent.appendChild(track);

    const abort = new AbortController();
    const signal = abort.signal;
    let dragging = false, startY = 0, startScroll = 0;

    function update() {
      const sh = scrollEl.scrollHeight, ch = scrollEl.clientHeight;
      if (sh <= ch + 1) { track.classList.add('hidden'); return; }
      track.classList.remove('hidden');
      const trackH = track.clientHeight;
      const thumbH = Math.max(24, trackH * (ch / sh));
      const scrollRatio = scrollEl.scrollTop / (sh - ch);
      thumb.style.height = thumbH + 'px';
      thumb.style.top = (scrollRatio * (trackH - thumbH)) + 'px';
    }

    scrollEl.addEventListener('scroll', update, { passive: true, signal });

    const ro = new ResizeObserver(update);
    ro.observe(scrollEl);
    const mo = new MutationObserver(update);
    mo.observe(scrollEl, { childList: true, subtree: true });

    // Thumb drag
    thumb.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation();
      dragging = true; startY = e.clientY; startScroll = scrollEl.scrollTop;
      thumb.classList.add('dragging');
    }, { signal });

    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const sh = scrollEl.scrollHeight, ch = scrollEl.clientHeight, trackH = track.clientHeight;
      const thumbH = Math.max(24, trackH * (ch / sh));
      scrollEl.scrollTop = startScroll + (e.clientY - startY) * ((sh - ch) / (trackH - thumbH));
    }, { signal });

    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false; thumb.classList.remove('dragging');
    }, { signal });

    // Track click → jump
    track.addEventListener('mousedown', (e) => {
      if (e.target === thumb) return;
      const rect = track.getBoundingClientRect();
      scrollEl.scrollTop = ((e.clientY - rect.top) / rect.height) * (scrollEl.scrollHeight - scrollEl.clientHeight);
    }, { signal });

    // Initial update (double rAF ensures layout is complete)
    requestAnimationFrame(() => requestAnimationFrame(update));

    return () => {
      abort.abort();
      ro.disconnect();
      mo.disconnect();
      track.remove();
    };
  }, []);

  return ref;
}
