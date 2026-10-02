import { useState, useEffect } from 'react';

function canLock() {
  return (
    typeof window !== 'undefined' &&
    typeof window.screen?.orientation?.lock === 'function'
  );
}

function diagInfo() {
  return {
    secureContext: window.isSecureContext,
    displayMode: window.matchMedia('(display-mode: standalone)').matches ? 'standalone' : 'browser',
    orientationType: window.screen?.orientation?.type ?? 'n/a',
    canLock: canLock(),
  };
}

export async function lockLandscape() {
  const info = diagInfo();
  console.log('[orientation] lockLandscape() called', info);
  if (!canLock()) {
    console.warn('[orientation] screen.orientation.lock not available – skipping');
    return;
  }
  try {
    await window.screen.orientation.lock('landscape');
    console.log('[orientation] lock("landscape") succeeded ✓');
  } catch (e) {
    console.warn('[orientation] lock("landscape") FAILED:', e.name, e.message);
  }
}

export function unlockOrientation() {
  console.log('[orientation] unlockOrientation() called, type before:', window.screen?.orientation?.type);
  if (!canLock()) {
    console.warn('[orientation] screen.orientation.unlock not available – skipping');
    return;
  }
  try {
    window.screen.orientation.unlock();
    console.log('[orientation] unlock() called ✓');
  } catch (e) {
    console.warn('[orientation] unlock() FAILED:', e.name, e.message);
  }
}

/**
 * Reaktiver Hook: gibt true zurück wenn Gerät im Hochformat steht.
 * Reagiert auf screen.orientation-Änderungen.
 */
export function useIsPortrait() {
  const [isPortrait, setIsPortrait] = useState(() => {
    if (typeof window === 'undefined' || !window.screen?.orientation) return false;
    const portrait = window.screen.orientation.type.startsWith('portrait');
    console.log('[orientation] useIsPortrait init – type:', window.screen.orientation.type, '→ isPortrait:', portrait);
    return portrait;
  });

  useEffect(() => {
    const check = () => {
      if (!window.screen?.orientation) return;
      const portrait = window.screen.orientation.type.startsWith('portrait');
      console.log('[orientation] screen orientation changed → type:', window.screen.orientation.type, '→ isPortrait:', portrait);
      setIsPortrait(portrait);
    };
    window.screen.orientation?.addEventListener('change', check);
    return () => window.screen.orientation?.removeEventListener('change', check);
  }, []);

  return isPortrait;
}
