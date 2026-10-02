import { useCallback, useEffect, useRef, useState } from 'react';

const INTERVALL_MS = 2000;
const ZEITLIMIT_MS = 120000;

/**
 * Wartet nach einem Restore auf den Wiederanlauf der App und leitet dann zur
 * Anmeldung. Während des Neustarts liefert nginx 502/503 statt eines
 * Netzwerkfehlers – jede Antwort außer OK gilt deshalb als „noch nicht
 * bereit“. Nach dem Zeitlimit wechselt der Zustand auf 'zeitueberschritten',
 * damit der Dialog einen Ausweg anbieten kann, statt endlos zu warten.
 *
 * Zustände: 'aus' · 'wartet' · 'zeitueberschritten'
 */
export function useNeustartWarten() {
  const [zustand, setZustand] = useState('aus');
  const timer = useRef(null);

  const stoppen = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  }, []);

  const starten = useCallback(() => {
    stoppen();
    const start = Date.now();
    setZustand('wartet');
    timer.current = setInterval(async () => {
      let bereit = false;
      try {
        const res = await fetch('/api/health', { credentials: 'include', cache: 'no-store' });
        bereit = res.ok;
      } catch { /* Neustart läuft noch */ }
      if (bereit) {
        stoppen();
        window.location.href = '/login';
      } else if (Date.now() - start > ZEITLIMIT_MS) {
        stoppen();
        setZustand('zeitueberschritten');
      }
    }, INTERVALL_MS);
  }, [stoppen]);

  useEffect(() => stoppen, [stoppen]);

  return { zustand, starten };
}
