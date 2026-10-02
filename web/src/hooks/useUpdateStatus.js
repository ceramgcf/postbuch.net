/**
 * useUpdateStatus – Update-Zustand, der einen Neustart der App überlebt
 *
 * Der Knackpunkt: während eines Updates werden `app` und `web` **neu erstellt**.
 * Ein Polling, das jeden Verbindungsabbruch als Fehler auffasst, würde mitten
 * im normalen Ablauf „fehlgeschlagen" behaupten – und ein Zustand im React-State
 * wäre nach dem Browser-Reload weg. Deshalb:
 *
 *   • Der wahre Zustand liegt in `status.json` auf der Platte des Hosts. Diese
 *     Datei überlebt beide Container. Ein Reload mitten im Lauf rekonstruiert
 *     die Anzeige daraus korrekt.
 *   • Fehlgeschlagene Anfragen werden gezählt, nicht angezeigt. Erst wenn
 *     `UNERREICHBAR_SCHWELLE` Versuche in Folge scheitern, geht die Anzeige in
 *     „Anwendung startet neu …" – und selbst das ist kein Fehler.
 *   • Der Timeout ist großzügig: ein vite-Build im Safe-Mode auf einem RPi kann
 *     25+ Minuten dauern.
 */

import { useEffect, useRef, useState } from 'react';
import { api } from '@/api/client';

const POLL_MS = 4000;
const UNERREICHBAR_SCHWELLE = 3;
/** Ab hier gilt eine nicht abgeholte Anforderung als „liegen geblieben". */
export const NICHT_ABGEHOLT_MS = 3 * 60 * 1000;
/** Nach dieser Zeit ohne Endstatus gibt das UI auf und verweist aufs Log. */
export const LAUF_TIMEOUT_MS = 60 * 60 * 1000;

export function useUpdateStatus(aktiv) {
  const [daten, setDaten] = useState(null);
  const [unerreichbar, setUnerreichbar] = useState(false);
  const fehlerZaehler = useRef(0);

  useEffect(() => {
    if (!aktiv) return undefined;
    let abgebrochen = false;

    async function tick() {
      try {
        const d = await api.updates.get();
        if (abgebrochen) return;
        fehlerZaehler.current = 0;
        setUnerreichbar(false);
        setDaten(d);
      } catch {
        if (abgebrochen) return;
        fehlerZaehler.current += 1;
        // Kein setDaten(null): die letzte bekannte Wahrheit bleibt stehen,
        // sonst flackert die Anzeige bei jedem Container-Neustart auf leer.
        if (fehlerZaehler.current >= UNERREICHBAR_SCHWELLE) setUnerreichbar(true);
      }
    }

    tick();
    const id = setInterval(tick, POLL_MS);
    return () => { abgebrochen = true; clearInterval(id); };
  }, [aktiv]);

  return { daten, unerreichbar };
}

/**
 * Übersetzt den Rohzustand in genau eine Anzeige-Phase. Bewusst hier und nicht
 * im JSX: dieselbe Ableitung braucht sowohl die Karte als auch der Dialog.
 */
export function leiteLaufPhaseAb(daten, unerreichbar) {
  const lauf = daten?.lauf;
  // Ein bereits empfangener Endstatus ist endgültiger als ein späterer,
  // vorübergehender Reconnect-Fehler nach dem Containerwechsel.
  if (lauf?.status === 'erfolgreich')     return { art: 'erfolgreich',    text: lauf.meldung || 'Update abgeschlossen.' };
  if (lauf?.status === 'fehlgeschlagen')  return { art: 'fehlgeschlagen', text: lauf.meldung || 'Das Update ist fehlgeschlagen.' };
  if (lauf?.status === 'abgelehnt')       return { art: 'abgelehnt',      text: lauf.meldung || 'Der Agent hat die Anforderung abgelehnt.' };
  if (unerreichbar) return { art: 'neustart', text: 'Anwendung startet neu …' };
  if (!daten) return { art: 'laden', text: 'Lade …' };

  if (lauf?.status === 'laeuft') {
    return { art: 'laeuft', text: phasenText(lauf.phase), phase: lauf.phase };
  }
  if (daten.anforderung) {
    const seit = daten.anforderung.angefordertAm ? Date.parse(daten.anforderung.angefordertAm) : NaN;
    const alt = Number.isFinite(seit) && Date.now() - seit > NICHT_ABGEHOLT_MS;
    return alt
      ? { art: 'nicht_abgeholt', text: 'Der Update-Agent hat die Anforderung nicht abgeholt.' }
      : { art: 'wartet', text: 'Warte auf den Update-Agenten …' };
  }
  // Die Anforderung wird vor dem ersten Laufstatus atomar entfernt. In diesem
  // kurzen Übergabefenster darf der Dialog nicht als leerer Spinner erscheinen.
  return { art: 'wartet', text: 'Warte auf den Update-Agenten …' };
}

/** Die Phasenmarker, die `install.sh` ins Log schreibt (##PHASE:…). */
const PHASEN = {
  download: 'Lade neue Version herunter …',
  verify:   'Prüfe Prüfsumme …',
  backup:   'Sichere aktuelle Installation …',
  extract:  'Entpacke neue Version …',
  build:    'Baue Container – das kann auf schwacher Hardware 20–35 Minuten dauern …',
  up:       'Starte Container neu …',
  fertig:   'Fertig.',
};

export function phasenText(phase) {
  return PHASEN[phase] || 'Update läuft …';
}
