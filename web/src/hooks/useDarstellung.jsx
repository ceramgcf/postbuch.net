import { createContext, useContext, useMemo, useSyncExternalStore } from 'react';
import { entscheideLayout, leseUmgebung } from '@/lib/darstellung';

/**
 * Einzige Quelle für Layout und Eingabeart (siehe lib/darstellung.js).
 *
 *   layout          'mobil' | 'desktop'  – Struktur der Oberfläche, folgt der Breite
 *   istMobil        layout === 'mobil'
 *   istTouch        Gerät mit grobem Zeiger (Hover/Zieh-Griffe sinnlos)
 */
const DarstellungContext = createContext(null);

let letzteUmgebung = null;
function umgebungSnapshot() {
  const neu = leseUmgebung();
  // useSyncExternalStore verlangt bei unverändertem Zustand dieselbe Referenz.
  if (letzteUmgebung && letzteUmgebung.istTouch === neu.istTouch && letzteUmgebung.breite === neu.breite) {
    return letzteUmgebung;
  }
  letzteUmgebung = neu;
  return neu;
}

function abonniereUmgebung(callback) {
  window.addEventListener('resize', callback);
  const zeiger = window.matchMedia?.('(pointer: coarse)');
  zeiger?.addEventListener?.('change', callback);
  return () => {
    window.removeEventListener('resize', callback);
    zeiger?.removeEventListener?.('change', callback);
  };
}

export function DarstellungProvider({ children }) {
  const umgebung = useSyncExternalStore(abonniereUmgebung, umgebungSnapshot, umgebungSnapshot);

  const value = useMemo(() => {
    const layout = entscheideLayout(umgebung.breite);
    return { layout, istMobil: layout === 'mobil', istTouch: umgebung.istTouch };
  }, [umgebung]);

  return <DarstellungContext.Provider value={value}>{children}</DarstellungContext.Provider>;
}

export function useDarstellung() {
  const ctx = useContext(DarstellungContext);
  if (!ctx) throw new Error('useDarstellung außerhalb von DarstellungProvider');
  return ctx;
}
