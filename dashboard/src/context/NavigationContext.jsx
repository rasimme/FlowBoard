import { createContext, useContext, useCallback, useMemo, useState } from 'react';

const NavigationContext = createContext(null);

/**
 * NavigationContext (T-356 Step 3) — deterministic cross-view navigation intents
 * that replace the imperative window._scrollTo* / window._pendingNew* globals.
 *
 * An intent set by one component (global search, an overview widget, the detail
 * panel, the Specify stepper) persists in React state until the target surface
 * actually CONSUMES it. That fixes the "consumer not mounted yet" class of bug:
 * the old globals were deleted on the first effect run regardless of whether the
 * target tab/element had rendered, so an intent fired before its view mounted
 * was silently lost (see T-355's search→Tasks fix). Here the consumer clears the
 * intent only once it has acted on it.
 *
 * Shape:
 *   scrollToTask:   taskId | null     (consumed by TasksView ScrollToTask)
 *   scrollToNote:   noteId | null     (consumed by CanvasView)
 *   scrollToColumn: status | null     (consumed by TasksView ScrollToColumn)
 *   pendingNewTask/Note/File: boolean (consumed by AddTaskForm / CanvasView / FilesView)
 */
export function NavigationProvider({ children }) {
  const [intent, setIntent] = useState({
    scrollToTask: null,
    scrollToNote: null,
    scrollToColumn: null,
    pendingNewTask: false,
    pendingNewNote: false,
    pendingNewFile: false,
  });

  const set = useCallback((patch) => setIntent(prev => ({ ...prev, ...patch })), []);

  const value = useMemo(() => ({
    intent,
    // setters (cross-view requests)
    goToTask: (id) => set({ scrollToTask: id }),
    goToNote: (id) => set({ scrollToNote: id }),
    goToColumn: (col) => set({ scrollToColumn: col }),
    requestNewTask: () => set({ pendingNewTask: true }),
    requestNewNote: () => set({ pendingNewNote: true }),
    requestNewFile: () => set({ pendingNewFile: true }),
    // clearers (consumer calls once it has acted)
    clearScrollToTask: () => set({ scrollToTask: null }),
    clearScrollToNote: () => set({ scrollToNote: null }),
    clearScrollToColumn: () => set({ scrollToColumn: null }),
    clearPendingNewTask: () => set({ pendingNewTask: false }),
    clearPendingNewNote: () => set({ pendingNewNote: false }),
    clearPendingNewFile: () => set({ pendingNewFile: false }),
  }), [intent, set]);

  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}

export function useNavigation() {
  const ctx = useContext(NavigationContext);
  if (!ctx) throw new Error('useNavigation must be used within NavigationProvider');
  return ctx;
}

export default NavigationContext;
