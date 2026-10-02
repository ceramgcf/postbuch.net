import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';

/**
 * Erlaubt einzelnen Komponenten, der AppShell mitzuteilen, dass Hochformat
 * an ihrer aktuellen Position zulässig ist (z. B. für Fullscreen-PDF-Viewer).
 *
 * Der Zustand wird als Counter geführt: mehrere Komponenten können sich gleichzeitig
 * registrieren; Portrait ist erlaubt, solange mindestens eine aktiv ist.
 */
const PortraitAllowedContext = createContext(null);

export function PortraitAllowedProvider({ children }) {
  const [count, setCount] = useState(0);
  const increment = useCallback(() => setCount((c) => c + 1), []);
  const decrement = useCallback(() => setCount((c) => Math.max(0, c - 1)), []);
  const value = useMemo(
    () => ({ isAllowed: count > 0, increment, decrement }),
    [count, increment, decrement],
  );
  return (
    <PortraitAllowedContext.Provider value={value}>
      {children}
    </PortraitAllowedContext.Provider>
  );
}

export function useIsPortraitAllowed() {
  const ctx = useContext(PortraitAllowedContext);
  return ctx ? ctx.isAllowed : false;
}

/**
 * Während die Komponente gemountet ist (und enabled=true), meldet sie der
 * AppShell, dass Portrait erlaubt ist.
 */
export function useAllowPortrait(enabled = true) {
  const ctx = useContext(PortraitAllowedContext);
  useEffect(() => {
    if (!enabled || !ctx) return;
    ctx.increment();
    return () => ctx.decrement();
  // ctx.increment/decrement sind stabil (useCallback mit [] im Provider)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
}
