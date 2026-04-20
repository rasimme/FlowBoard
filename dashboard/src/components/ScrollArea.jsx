import { forwardRef } from 'react';
import { useCustomScroll } from '../hooks/useCustomScroll.js';

/**
 * ScrollArea — reusable scrollable container with the project's custom
 * dark-mode scrollbar (track + draggable thumb, no native-browser chrome).
 *
 * Wraps the existing `useCustomScroll` hook + `.cscroll-wrap` / `.cscroll-inner`
 * CSS pattern from dashboard.css. Use this anywhere a scrollable panel is
 * needed so every scroll surface in the app looks identical.
 *
 * Because native scrollbars are globally hidden (see the `*::-webkit-scrollbar`
 * rules in dashboard.css) and the custom scrollbar is absolutely positioned,
 * content NEVER shifts horizontally when the scrollbar appears — unlike with
 * a native scrollbar, which consumes layout width.
 *
 * @param {string} [className]       - extra classes on the outer wrap
 * @param {string} [innerClassName]  - extra classes on the inner scroll surface
 * @param {object} [style]           - style for the outer wrap
 * @param {object} [innerStyle]      - style for the inner scroll surface
 * @param {ReactNode} children       - content to render inside the scroll surface
 * @example
 *   <ScrollArea className="flex-1" innerClassName="p-4">
 *     <BigList />
 *   </ScrollArea>
 */
const ScrollArea = forwardRef(function ScrollArea(
  { className = '', innerClassName = '', style, innerStyle, children, ...rest },
  ref,
) {
  const scrollRef = useCustomScroll();
  return (
    <div className={`cscroll-wrap ${className}`.trim()} style={style}>
      <div
        ref={(node) => {
          scrollRef.current = node;
          if (typeof ref === 'function') ref(node);
          else if (ref) ref.current = node;
        }}
        className={`cscroll-inner ${innerClassName}`.trim()}
        style={innerStyle}
        {...rest}
      >
        {children}
      </div>
    </div>
  );
});

export default ScrollArea;
