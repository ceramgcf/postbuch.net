import { createPortal } from 'react-dom';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { Dialog, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';

// Schutz gegen das stille Verlieren ungespeicherter Einstellungen.
//
// Jede Karte mit eigenem Formular meldet über useUngespeichert(), ob sie
// ungespeicherte Änderungen hat, und wie man sie speichert oder verwirft. Der
// Provider (um die Einstellungsseite gelegt)
//   – zeigt dann eine Statuszeile „Speichern / Verwerfen“, fest am unteren
//     Rand des Inhaltsbereichs (Platz STATUSLEISTE_ID im AppShell-Rahmen),
//   – fragt vor einem Reiterwechsel (wechsle()) und vor dem Klick auf einen
//     Link zu einer anderen Seite nach,
//   – lässt beim Neuladen oder Schließen des Tabs die Rückfrage des Browsers
//     erscheinen (eigene Knöpfe erlaubt der Browser dort nicht).
// Die App nutzt <BrowserRouter> ohne Data-Router, useBlocker steht daher
// nicht zur Verfügung; Links werden deshalb in der Capture-Phase abgefangen,
// bevor React Router sie verarbeitet.

const Ctx = createContext(null);

/** DOM-Platz der festen Statuszeile im AppShell-Rahmen (Desktop und mobil). */
export const STATUSLEISTE_ID = 'rahmen-statusleiste';

export function UngespeichertProvider({ children }) {
  const navigate = useNavigate();
  const [eintraege, setEintraege] = useState({}); // id → Beschriftung
  const aktionen = useRef({}); // id → { speichern, verwerfen }
  const [frage, setFrage] = useState(null); // ausstehende Aktion nach der Rückfrage
  const [laeuft, setLaeuft] = useState(false);
  const [fehler, setFehler] = useState(null);
  const [rahmen, setRahmen] = useState(null);
  useEffect(() => { setRahmen(document.getElementById(STATUSLEISTE_ID)); }, []);

  const melden = useCallback((id, eintrag) => {
    if (eintrag) aktionen.current[id] = eintrag; else delete aktionen.current[id];
    setEintraege((alt) => {
      if (eintrag ? alt[id] === eintrag.label : !(id in alt)) return alt;
      const neu = { ...alt };
      if (eintrag) neu[id] = eintrag.label; else delete neu[id];
      return neu;
    });
  }, []);

  const offen = Object.keys(eintraege).length > 0;
  const offenRef = useRef(offen);
  offenRef.current = offen;

  async function alleSpeichern() {
    for (const a of Object.values(aktionen.current)) await a.speichern();
  }
  function alleVerwerfen() {
    for (const a of Object.values(aktionen.current)) a.verwerfen();
  }

  // Führt eine Aktion aus, die die aktuelle Ansicht verlässt – bei
  // ungespeicherten Änderungen erst nach der Rückfrage.
  const wechsle = useCallback((aktion) => {
    if (offenRef.current) { setFehler(null); setFrage(() => aktion); } else aktion();
  }, []);

  useEffect(() => {
    if (!offen) return undefined;
    const vorEntladen = (e) => { e.preventDefault(); e.returnValue = ''; };
    const beiKlick = (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target instanceof Element ? e.target.closest('a[href]') : null;
      if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      e.preventDefault();
      e.stopPropagation();
      setFehler(null);
      setFrage(() => () => navigate(url.pathname + url.search + url.hash));
    };
    window.addEventListener('beforeunload', vorEntladen);
    document.addEventListener('click', beiKlick, true);
    return () => {
      window.removeEventListener('beforeunload', vorEntladen);
      document.removeEventListener('click', beiKlick, true);
    };
  }, [offen, navigate]);

  async function speichernUndWeiter(weiter) {
    setLaeuft(true); setFehler(null);
    try {
      await alleSpeichern();
      setFrage(null);
      weiter?.();
    } catch (err) {
      setFehler(err?.message || 'Speichern fehlgeschlagen.');
    } finally {
      setLaeuft(false);
    }
  }
  function verwerfenUndWeiter(weiter) {
    alleVerwerfen();
    setFrage(null);
    weiter?.();
  }

  const wert = useMemo(() => ({ melden, wechsle }), [melden, wechsle]);
  const namen = Object.values(eintraege).join(', ');

  return (
    <Ctx.Provider value={wert}>
      {children}
      {offen && (() => {
        // Volle Breite am Rahmen; Inhalt in derselben Spalte wie die Karten
        // (max-w-3xl mit p-4/md:p-6 wie die Einstellungsseite).
        const leiste = (
          <div className="border-t border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950">
            <div className="statuszeile-spalte mx-auto flex max-w-3xl flex-wrap items-center gap-2 px-4 py-2.5 md:px-6">
              <p className="min-w-0 flex-1 text-sm">
                <span className="font-medium">Ungespeicherte Änderungen</span>
                <span className="text-muted-foreground"> – {namen}</span>
              </p>
              {!frage && fehler && <p className="order-last w-full text-sm text-destructive">{fehler}</p>}
              <Button size="sm" variant="ghost" disabled={laeuft} onClick={() => verwerfenUndWeiter()}>Verwerfen</Button>
              <Button size="sm" disabled={laeuft} onClick={() => speichernUndWeiter()}>
                {laeuft ? 'Speichern…' : 'Speichern'}
              </Button>
            </div>
          </div>
        );
        // Ohne AppShell-Rahmen (sollte nicht vorkommen) klebt sie unten an der Seite.
        return rahmen ? createPortal(leiste, rahmen) : <div className="sticky bottom-0 z-30">{leiste}</div>;
      })()}
      <Dialog open={!!frage} onOpenChange={(o) => { if (!o && !laeuft) setFrage(null); }}>
        <DialogTitle>Änderungen speichern?</DialogTitle>
        <DialogDescription className="mt-3">
          Nicht gespeichert: {namen}. Ohne Speichern gehen diese Änderungen verloren.
        </DialogDescription>
        {fehler && <p className="mt-3 text-sm text-destructive">{fehler}</p>}
        <DialogFooter>
          <Button variant="outline" disabled={laeuft} onClick={() => setFrage(null)}>Abbrechen</Button>
          <Button variant="ghost" className="text-red-600 hover:text-red-700" disabled={laeuft} onClick={() => verwerfenUndWeiter(frage)}>Verwerfen</Button>
          <Button disabled={laeuft} onClick={() => speichernUndWeiter(frage)}>{laeuft ? 'Speichern…' : 'Speichern'}</Button>
        </DialogFooter>
      </Dialog>
    </Ctx.Provider>
  );
}

/**
 * Meldet ungespeicherte Änderungen einer Karte an den Provider.
 * @param {string} id  eindeutig je Karte
 * @param {{ aktiv: boolean, label: string, speichern: () => Promise<unknown>, verwerfen: () => void }} opts
 *   speichern muss bei einem Fehler werfen (z. B. mutateAsync), damit die Rückfrage offen bleibt.
 */
export function useUngespeichert(id, { aktiv, label, speichern, verwerfen }) {
  const ctx = useContext(Ctx);
  const melden = ctx?.melden;
  const ref = useRef({ speichern, verwerfen });
  ref.current = { speichern, verwerfen };
  useEffect(() => {
    if (!melden) return;
    melden(id, aktiv ? {
      label,
      speichern: () => ref.current.speichern(),
      verwerfen: () => ref.current.verwerfen(),
    } : null);
  }, [melden, id, aktiv, label]);
  useEffect(() => () => melden?.(id, null), [melden, id]);
}

/** Aktion mit Rückfrage bei ungespeicherten Änderungen (ohne Provider: sofort). */
export function useWechsel() {
  const ctx = useContext(Ctx);
  return ctx?.wechsle ?? ((aktion) => aktion());
}

/**
 * Merkt sich den geladenen Stand eines Formulars und sagt, ob es davon abweicht.
 * merken(f) beim Befüllen aus den Einstellungen und nach erfolgreichem Speichern.
 */
export function useAusgangsstand(form) {
  const ausgang = useRef(null);
  return {
    merken: (f) => { ausgang.current = f == null ? null : JSON.stringify(f); },
    // Felder, die der Server schon selbst gespeichert hat, zählen nicht als Änderung.
    merkeTeil: (teil) => {
      if (ausgang.current !== null) ausgang.current = JSON.stringify({ ...JSON.parse(ausgang.current), ...teil });
    },
    geaendert: form != null && ausgang.current !== null && JSON.stringify(form) !== ausgang.current,
  };
}
