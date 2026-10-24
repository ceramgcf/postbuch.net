// Auto-Auslöser des Kamerascanners als reine Zustandsmaschine: Sie bekommt je
// analysiertem Vorschaubild die erkannten Ecken und das Schärfeminimum über
// das ganze Blatt und entscheidet, ob ausgelöst wird. Ohne Zeitgeber und ohne
// DOM, damit sie in Node testbar bleibt; die Zeit kommt als Argument herein.

import { eckBewegung } from './geometrie.js';

export const AUSLOESER_VORGABEN = {
  ruheSchwelle: 0.012, // max. Eckverschiebung je Bild relativ zur Diagonale
  ruheMs: 700, // so lange müssen Ecken ruhig liegen, bevor gezählt wird
  schaerfeMin: 0.38, // absolute Untergrenze des Kachelminimums
  plateauAnteil: 0.85, // Bild muss nahe am besten Wert des Ruhefensters liegen
  plateauBilder: 2, // so viele aufeinanderfolgende Bilder auf dem Plateau
  sicherheitMin: 0.6, // Kantenstütze des erkannten Vierecks
  sperreMs: 1500, // nach einer Auslösung bzw. Abbruch nicht sofort wieder
  wechselBewegung: 0.06, // so weit müssen Ecken springen, damit ein Blattwechsel zählt
};

/**
 * Erzeugt einen Auslöser. `schritt()` liefert den Zustand:
 *   'suche'   – kein Blatt erkannt
 *   'bewegt'  – Blatt erkannt, aber Handy noch unruhig
 *   'unscharf' – ruhig, aber das Blatt ist (noch) nicht überall scharf
 *   'bereit'  – ruhig und scharf, Schärfeplateau wird bestätigt
 *   'ausloesen' – genau einmal: jetzt aufnehmen
 *   'gesperrt' – kurz nach Auslösung oder Abbruch
 *   'wechsel' – nach einer Aufnahme: erst ein neues Blatt (Blatt kurz weg
 *               oder deutlich bewegt) wird wieder ausgelöst, sonst käme
 *               dieselbe Seite zweimal
 * plus `fortschritt` (0…1) für die Ringanzeige.
 */
export function erstelleAusloeser(optionen = {}) {
  const o = { ...AUSLOESER_VORGABEN, ...optionen };
  let letzteEcken = null;
  let ruheSeit = null;
  let besteSchaerfe = 0;
  let plateau = 0;
  let gesperrtBis = 0;
  let wartetAufWechsel = false;
  let wechselEcken = null;
  let fehlBilder = 0;

  function zuruecksetzen() {
    letzteEcken = null;
    ruheSeit = null;
    besteSchaerfe = 0;
    plateau = 0;
  }

  return {
    /** Sperrt für `sperreMs` (z. B. weil der Nutzer abbricht oder ausgelöst wurde). */
    sperren(jetzt) {
      gesperrtBis = jetzt + o.sperreMs;
      zuruecksetzen();
    },

    /** Nach einer Aufnahme: erst wieder auslösen, wenn ein anderes Blatt liegt. */
    neuesBlattAbwarten() {
      wartetAufWechsel = true;
      wechselEcken = null;
    },

    /**
     * @param {{ecken: Array|null, sicherheit?: number, schaerfe?: number|null,
     *          breite: number, hoehe: number, jetzt: number}} bild
     */
    schritt({ ecken, sicherheit = 0, schaerfe = null, breite, hoehe, jetzt }) {
      if (jetzt < gesperrtBis) return { zustand: 'gesperrt', fortschritt: 0 };
      if (!ecken || sicherheit < o.sicherheitMin) {
        zuruecksetzen();
        // Ein einzelnes verpasstes Bild ist kein Blattwechsel.
        if (++fehlBilder >= 3) wartetAufWechsel = false;
        return { zustand: 'suche', fortschritt: 0 };
      }
      fehlBilder = 0;
      if (wartetAufWechsel) {
        if (!wechselEcken) wechselEcken = ecken;
        if (eckBewegung(wechselEcken, ecken, breite, hoehe) < o.wechselBewegung) {
          letzteEcken = ecken;
          return { zustand: 'wechsel', fortschritt: 0 };
        }
        wartetAufWechsel = false;
      }
      const bewegung = letzteEcken ? eckBewegung(letzteEcken, ecken, breite, hoehe) : Infinity;
      letzteEcken = ecken;
      if (bewegung > o.ruheSchwelle) {
        ruheSeit = jetzt;
        besteSchaerfe = 0;
        plateau = 0;
        return { zustand: 'bewegt', fortschritt: 0 };
      }
      const ruhig = jetzt - ruheSeit;
      const ruheAnteil = Math.min(1, ruhig / o.ruheMs);
      if (schaerfe == null) return { zustand: 'bewegt', fortschritt: ruheAnteil * 0.5 };
      besteSchaerfe = Math.max(besteSchaerfe, schaerfe);
      if (schaerfe < o.schaerfeMin) {
        plateau = 0;
        return { zustand: 'unscharf', fortschritt: ruheAnteil * 0.5 };
      }
      if (ruhig < o.ruheMs) return { zustand: 'bereit', fortschritt: ruheAnteil * 0.5 };
      if (schaerfe >= besteSchaerfe * o.plateauAnteil) plateau++;
      else plateau = 0;
      if (plateau >= o.plateauBilder) {
        gesperrtBis = jetzt + o.sperreMs;
        zuruecksetzen();
        wartetAufWechsel = true;
        wechselEcken = null;
        return { zustand: 'ausloesen', fortschritt: 1 };
      }
      return { zustand: 'bereit', fortschritt: 0.5 + 0.5 * (plateau / o.plateauBilder) };
    },
  };
}
