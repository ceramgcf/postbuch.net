import { useEffect, useLayoutEffect, useRef } from 'react';
import { useLocation, useNavigationType } from 'react-router';
import { mobilScroller } from '@/lib/mobilScroller';

const PREFIX = 'postbuch-scroll:';

/**
 * Scrollposition des mobilen Scrollbereichs (lib/mobilScroller.js) je
 * Verlaufseintrag (location.key) merken und beim Zurückkehren wiederherstellen –
 * Ersatz für <ScrollRestoration>, das es mit BrowserRouter nicht gibt. Nur im
 * Mobil-Layout aktiv.
 *
 * Neue Einträge starten oben – außer bei Rücksprüngen (`state.zurueck`, etwa
 * „Zurück“ aus dem Dokument in die Liste): Die legen einen neuen Eintrag an
 * und übernehmen die zuletzt gesicherte Position desselben Pfads.
 *
 * Ersetzt eine Seite nur ihre eigene URL (replace auf demselben Pfad, etwa
 * Standard-Sortierung in die Adresse schreiben), bleibt die Position stehen und
 * eine laufende Wiederherstellung läuft weiter.
 *
 * Bei bekannten Einträgen wird wiederholt
 * versucht, bis der Inhalt hoch genug ist (Endlosliste aus dem Query-Cache).
 */
export function useScrollWiederherstellung(aktiv) {
  const location = useLocation();
  // Der Listener schreibt immer auf den aktuellen Eintrag – auch wenn das
  // Scroll-Event des Seitenwechsels erst nach dem Wechsel ankommt.
  const keyRef = useRef(location.key);
  const pfadRef = useRef(location.pathname + location.search);
  const pathnameRef = useRef(location.pathname);
  const navigationsTyp = useNavigationType();
  // Ziel einer laufenden Wiederherstellung (null = keine)
  const laufendRef = useRef(null);

  useEffect(() => {
    if (!aktiv || !('scrollRestoration' in history)) return;
    const vorher = history.scrollRestoration;
    history.scrollRestoration = 'manual';
    return () => { history.scrollRestoration = vorher; };
  }, [aktiv]);

  // Position laufend sichern (gedrosselt per rAF)
  useEffect(() => {
    if (!aktiv) return;
    let geplant = false;
    const sichern = () => {
      if (geplant) return;
      geplant = true;
      requestAnimationFrame(() => {
        geplant = false;
        const pos = String(Math.round(mobilScroller().scrollTop));
        try {
          sessionStorage.setItem(PREFIX + keyRef.current, pos);
          sessionStorage.setItem(PREFIX + 'pfad:' + pfadRef.current, pos);
        } catch { /* voll/gesperrt */ }
      });
    };
    const el = mobilScroller();
    el.addEventListener('scroll', sichern, { passive: true });
    return () => el.removeEventListener('scroll', sichern);
  }, [aktiv]);

  useLayoutEffect(() => {
    const gleicherPfad = pathnameRef.current === location.pathname;
    keyRef.current = location.key;
    pfadRef.current = location.pathname + location.search;
    pathnameRef.current = location.pathname;
    if (!aktiv) return;
    const el = mobilScroller();
    let ziel = null;
    if (navigationsTyp === 'REPLACE' && gleicherPfad) {
      ziel = laufendRef.current;
      if (!ziel) return;
    } else {
      try {
        ziel = Number(sessionStorage.getItem(PREFIX + location.key));
        if (!ziel && location.state?.zurueck) ziel = Number(sessionStorage.getItem(PREFIX + 'pfad:' + pfadRef.current));
      } catch { /* ohne Speicher: oben */ }
    }
    laufendRef.current = null;
    if (!ziel) { el.scrollTo(0, 0); return; }

    let abgebrochen = false;
    laufendRef.current = ziel;
    const ende = Date.now() + 2000;
    const versuch = () => {
      if (abgebrochen) return;
      const max = el.scrollHeight - el.clientHeight;
      el.scrollTo(0, Math.min(ziel, max));
      if (max < ziel && Date.now() < ende) requestAnimationFrame(versuch);
      else laufendRef.current = null;
    };
    versuch();
    // Wer selbst scrollt, beendet die Wiederherstellung
    const stopp = () => { abgebrochen = true; laufendRef.current = null; };
    window.addEventListener('touchstart', stopp, { once: true, passive: true });
    window.addEventListener('wheel', stopp, { once: true, passive: true });
    return () => {
      abgebrochen = true;
      window.removeEventListener('touchstart', stopp);
      window.removeEventListener('wheel', stopp);
    };
  }, [aktiv, location.key]);
}
