import { useState, useEffect } from 'react';

// Erkennung via "pointer: coarse" – trifft auf alle Touch-Geräte (Smartphones, Tablets) zu.
// Desktop-Mäuse haben "pointer: fine" → isMobile gibt false zurück, keine Desktop-Auswirkungen.
const mql =
  typeof window !== 'undefined' ? window.matchMedia('(pointer: coarse)') : null;

export function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() => mql?.matches ?? false);

  useEffect(() => {
    if (!mql) return;
    const handler = (e) => setIsMobile(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);

  return isMobile;
}
