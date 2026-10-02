/**
 * lib/llm/empfehlungs-standard.js — Werkseinstellung = erste Release-Empfehlung
 *
 * Bis 2.8.9 standen die Standard-Modelle als Literale im Code: einmal in
 * `model-classes.js`, einmal als `TIER_DEFAULTS`/`selectModelChain` in
 * `lib/llm.js` und einmal als `EMBEDDING_DEFAULT` in `lib/embedding.js`. Drei
 * Orte, die niemand gemeinsam gepflegt hat — eine frische Instanz startete
 * deshalb mit Modellen, die es teils gar nicht mehr gibt.
 *
 * Ab jetzt gibt es genau eine Quelle: die mit dem Release ausgelieferte
 * `llm-empfehlungen.json`. Der jeweils **erste** Kandidat einer Klasse ist die
 * Werkseinstellung. Bewusst synchron gelesen (`readFileSync`, einmal beim
 * Modulstart): `model-classes.js` wird an vielen Stellen synchron importiert,
 * ein `await` dort würde die halbe Importkette asynchron machen.
 *
 * Die Datei liegt neben dieser hier und geht mit ins Release-Tarball; fehlt sie
 * wider Erwarten, bleibt der Standard leer statt falsch — resolveModelConfig
 * liefert dann `{providerId: undefined, model: undefined}` und die Klasse gilt
 * im Einrichtungsassistenten als „noch nicht konfiguriert".
 */

import { readFileSync } from 'node:fs';

let KLASSEN = {};
try {
  const roh = JSON.parse(readFileSync(new URL('./llm-empfehlungen.json', import.meta.url), 'utf8'));
  if (roh && typeof roh.klassen === 'object') KLASSEN = roh.klassen;
} catch (err) {
  console.error('[empfehlungs-standard] llm-empfehlungen.json nicht lesbar:', err.message);
}

/**
 * Erste Empfehlung einer Klasse als `{ providerId, model }` — oder `null`,
 * wenn die Klasse in der Empfehlungsdatei fehlt.
 */
export function standardFuer(klasse) {
  const erste = Array.isArray(KLASSEN[klasse]) ? KLASSEN[klasse][0] : null;
  if (!erste?.model) return null;
  return { providerId: erste.providerId || undefined, model: erste.model };
}

/**
 * Werkseinstellung jeder Sprachmodell-Aufgabe: die erste Empfehlung der Klasse
 * `leicht`.
 *
 * Bewusst NICHT die Empfehlung der jeweiligen Klasse. Sonst stünde eine frische
 * Instanz exakt so da, wie „Modellempfehlungen übernehmen" sie einrichten
 * würde — der Knopf hätte nichts mehr zu tun und die Empfehlungen wären
 * unsichtbar. Das günstigste empfohlene Modell arbeitet überall, bis der
 * Betreiber die Empfehlungen übernimmt oder von Hand wählt.
 *
 * Das Embedding-Modell hat bewusst gar keine Werkseinstellung: ein späterer
 * Wechsel entwertet den gesamten Vektorbestand, deshalb wird es einmal bewusst
 * gewählt statt vorbelegt.
 */
export const WERKSKLASSE = 'leicht';
export const werkseinstellung = () => standardFuer(WERKSKLASSE);
export const werkseinstellungFuerProvider = (providerId) => standardFuerProvider(WERKSKLASSE, providerId);

/** Bequemer Zugriff für Aufrufer, die nur eines der beiden Felder brauchen. */
export const standardProvider = (klasse) => standardFuer(klasse)?.providerId;
export const standardModell    = (klasse) => standardFuer(klasse)?.model;

/**
 * Erste Empfehlung einer Klasse **für einen bestimmten Provider** — z. B. um
 * beim Seeding das Modell zu wählen, für das der Installer wirklich einen
 * Schlüssel mitgegeben hat. Fällt auf die allgemeine erste Empfehlung zurück,
 * wenn der Provider in der Klasse nicht vorkommt.
 */
export function standardFuerProvider(klasse, providerId) {
  const liste = Array.isArray(KLASSEN[klasse]) ? KLASSEN[klasse] : [];
  const treffer = liste.find((k) => k.providerId === providerId && k.model);
  if (treffer) return { providerId: treffer.providerId, model: treffer.model };
  return standardFuer(klasse);
}
