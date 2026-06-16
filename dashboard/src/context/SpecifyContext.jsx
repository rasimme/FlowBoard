import { createContext, useContext, useState, useCallback } from 'react';
import SpecifyStepper from '../components/SpecifyStepper.jsx';

const SpecifyContext = createContext(null);

export function SpecifyProvider({ children }) {
  const [sessionId, setSessionId] = useState(null);
  const [isOpen, setIsOpen] = useState(false);

  const show = useCallback((id) => {
    setSessionId(id);
    setIsOpen(true);
  }, []);

  const hide = useCallback(() => {
    setIsOpen(false);
    setTimeout(() => setSessionId(null), 100);
  }, []);

  const complete = useCallback((result) => {
    hide();
    if ((result?.createdTasks || []).length > 0) {
      // CanvasView listens for this and refetches canvas data so promoted
      // (deleted) notes disappear without a manual reload.
      window.dispatchEvent(new CustomEvent('flowboard:canvas-reload'));
      // Kanban data refresh so the new tasks are visible without reload
      window.appState?._refreshBoard?.();
    }
  }, [hide]);

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
