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

  return (
    <SpecifyContext.Provider value={{ show, hide, sessionId }}>
      {children}
      {isOpen && sessionId && (
        <SpecifyStepper
          sessionId={sessionId}
          onComplete={hide}
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
