import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDarstellung } from '@/hooks/useDarstellung';

/**
 * Seiten-Slots der mobilen Kopfleiste.
 *
 * Seiten beschreiben ihren Kopf einmal – Titel, Aktionen, Leiste – und die
 * AppShell entscheidet, wo er erscheint:
 *   - Desktop: <SeitenAktionen>/<SeitenLeiste> rendern ihre Kinder an Ort und Stelle.
 *   - Mobil:   sie werden per Portal in die Kopfleiste gehängt; der Titel
 *              erscheint in deren Titelzeile.
 *
 * Im Context liegen nur Strings und DOM-Knoten, nie JSX – Seiten-Inhalt
 * bleibt im Baum der Seite (Hooks, Context und State funktionieren normal).
 */
const SeiteContext = createContext(null);

export function SeiteProvider({ children }) {
  const [titel, setTitel] = useState('');
  const [aktionenKnoten, setAktionenKnoten] = useState(null);
  const [leisteKnoten, setLeisteKnoten] = useState(null);
  const [ohneTitel, setOhneTitel] = useState(false);
  const value = useMemo(
    () => ({ titel, setTitel, aktionenKnoten, setAktionenKnoten, leisteKnoten, setLeisteKnoten, ohneTitel, setOhneTitel }),
    [titel, aktionenKnoten, leisteKnoten, ohneTitel],
  );
  return <SeiteContext.Provider value={value}>{children}</SeiteContext.Provider>;
}

export function useSeiteSlots() {
  return useContext(SeiteContext);
}

/** Setzt den Titel der mobilen Kopfleiste, solange die Komponente lebt. */
export function useSeitenTitel(titel) {
  const ctx = useContext(SeiteContext);
  const setTitel = ctx?.setTitel;
  useEffect(() => {
    if (!setTitel || typeof titel !== 'string' || !titel) return;
    setTitel(titel);
    return () => setTitel((t) => (t === titel ? '' : t));
  }, [setTitel, titel]);
}

/** Kopfleiste ohne Titelzeile: die Seitenleiste nimmt die ganze Breite ein. */
export function useKopfOhneTitel() {
  const setOhneTitel = useContext(SeiteContext)?.setOhneTitel;
  useEffect(() => {
    if (!setOhneTitel) return;
    setOhneTitel(true);
    return () => setOhneTitel(false);
  }, [setOhneTitel]);
}

function Slot({ knoten, children }) {
  const { istMobil } = useDarstellung();
  if (!istMobil) return children;
  if (!knoten) return null;
  return createPortal(children, knoten);
}

/** Icon-Aktionen der Seite: mobil oben rechts in der Kopfleiste. */
export function SeitenAktionen({ children }) {
  const ctx = useContext(SeiteContext);
  return <Slot knoten={ctx?.aktionenKnoten}>{children}</Slot>;
}

/** Seitenbezogene Bedienleiste: mobil rechts neben dem Titel. */
export function SeitenLeiste({ children }) {
  const ctx = useContext(SeiteContext);
  return <Slot knoten={ctx?.leisteKnoten}>{children}</Slot>;
}

/** Nur im Desktop-Layout rendern (z. B. eine Überschrift, die mobil die Kopfleiste übernimmt). */
export function NurDesktop({ children }) {
  const { istMobil } = useDarstellung();
  return istMobil ? null : children;
}

/** Nur im Mobil-Layout rendern. */
export function NurMobil({ children }) {
  const { istMobil } = useDarstellung();
  return istMobil ? children : null;
}
