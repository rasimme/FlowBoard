import { createContext, useContext, useState, useCallback } from 'react';
import SpecifyStepper from '../components/SpecifyStepper.jsx';
import { getEmbed } from '../embed/embedRuntime.js';

const SpecifyContext = createContext(null);

export function SpecifyProvider({ children }) {
  const [sessionId, setSessionId] = useState(null);
  const [isOpen, setIsOpen] = useState(false);

  const show = useCallback((id) => {
    setSessionId(id);
    setIsOpen(true);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
    setTimeout(() => setSessionId(null), 100);
  }, []);

  // T-499: a framed host is told when the stepper closes (embed mode only).
  const hide = useCallback(() => {
    close();
    getEmbed()?.specifyClosed({ completed: false });
  }, [close]);

  const complete = useCallback((result) => {
    close();
    getEmbed()?.specifyClosed({ completed: true, tasks: result?.createdTasks || [] });
    if ((result?.createdTasks || []).length > 0) {
      // CanvasView listens for this and refetches canvas data so promoted
      // (deleted) notes disappear without a manual reload.
      window.dispatchEvent(new CustomEvent('flowboard:canvas-reload'));
      // Kanban data refresh so the new tasks are visible without reload
      window.appState?._refreshBoard?.();
    }
  }, [close]);

  return (
    <SpecifyContext.Provider value={{ show, hide, sessionId }}>
      {children}
      {isOpen && sessionId && (
        <SpecifyStepper
          sessionId={sessionId}
          onComplete={complete}
          onCancel={hide}
        />
      )}
    </SpecifyContext.Provider>
  );
}

export function useSpecify() {
  const ctx = useContext(SpecifyContext);
  if (!ctx) throw new Error('useSpecify must be used inside SpecifyProvider');
  return ctx;
}
