/**
 * lib/llm/model-classes.js — die Modellklassen an einer Stelle
 *
 * Bis 1.7.3 stand dieselbe Liste dreimal im Code: als `KLASSEN` in
 * `lib/ai-health.js` (nur sechs Einträge — die vier Chat-/Akten-Klassen fehlten
 * dort still), als `KLASSEN` im Löschschutz von `routes/settings.js` und als
 * `MODEL_CLASSES` im Frontend. Jede neue Klasse musste an drei Stellen
 * nachgezogen werden, und genau das ist zweimal vergessen worden.
 *
 * Diese Datei ist ab jetzt die Quelle. Das Frontend hält nur noch Label,
 * Beschreibung und Reihenfolge — die Auflösung `settingKey → {providerId,model}`
 * passiert ausschließlich serverseitig über `resolveModelConfig`.
 *
 * **Provider und Modell stehen hier nicht als Literal**, sondern kommen aus der
 * ausgelieferten `llm-empfehlungen.json` (`empfehlungs-standard.js`) — für
 * jede Klasse aus der Empfehlung für `leicht`. Die Werkseinstellung ist damit
 * bewusst NICHT identisch mit dem, was „Modellempfehlungen übernehmen"
 * einrichtet; siehe `werkseinstellung()`.
 *
 * `group` trennt die Dokument-Pipeline (undefined) von den Klassen, die nicht
 * an der Klassifikationskette hängen ('chat').
 */

import { werkseinstellung } from './empfehlungs-standard.js';

/** Klassendefinition + Werkseinstellung aus der Empfehlungsdatei. */
function klasse(key, settingKey, label, extra = {}) {
  const std = werkseinstellung();
  return { key, settingKey, label, provider: std?.providerId, model: std?.model, ...extra };
}

export const MODEL_CLASSES = [
  // Vereinfachte Modellwahl: nur zwei Aufgabentypen. Jede Klasse der
  // Einzelwahl gehört über `aufgabe` zu genau einem davon; im einfachen Modus
  // lenkt resolveKlassenModell sie dorthin um.
  klasse('routine', 'llm_aufgabe_routine', 'Einfach & Routine', { modus: 'einfach' }),
  klasse('komplex', 'llm_aufgabe_komplex', 'Anspruchsvoll & Komplex', { modus: 'einfach' }),

  // Dokument-Pipeline in der Einzelwahl (gestaffelt).
  klasse('preanalysis', 'llm_model_preanalysis', 'Voranalyse',      { modus: 'gestaffelt', aufgabe: 'routine' }),
  klasse('large',       'llm_model_large',       'Lange Dokumente', { modus: 'gestaffelt', aufgabe: 'komplex' }),
  klasse('leicht',      'llm_model_leicht',      'Leicht',          { modus: 'gestaffelt', aufgabe: 'routine' }),
  klasse('mittel',      'llm_model_mittel',      'Mittel',          { modus: 'gestaffelt', aufgabe: 'komplex' }),
  klasse('schwierig',   'llm_model_schwierig',   'Schwierig',       { modus: 'gestaffelt', aufgabe: 'komplex' }),
  klasse('fallback',    'llm_model_fallback',    'Letzter Fallback', { modus: 'gestaffelt', aufgabe: 'routine' }),
  // Liest nach, wenn eine Plausibilitätsprüfung scheitert (Arztrechnungs-
  // positionen, Kürzungszerlegung). Bewusst vom günstigen Notfallmodell
  // „Letzter Fallback“ getrennt.
  klasse('nachlese',    'llm_model_nachlese',    'Nachlese',        { modus: 'gestaffelt', aufgabe: 'komplex' }),

  // Büroassistent und Akten — in der Einzelwahl eigene Modelle
  klasse('chat_research',  'chat_model_research',  'Büroassistent · Recherche', { group: 'chat', modus: 'gestaffelt', aufgabe: 'routine' }),
  klasse('chat_synthesis', 'chat_model_synthesis', 'Büroassistent · Antwort',   { group: 'chat', modus: 'gestaffelt', aufgabe: 'komplex' }),
  klasse('chat_title',     'chat_model_title',     'Büroassistent · Titel',     { group: 'chat', modus: 'gestaffelt', aufgabe: 'routine' }),
  klasse('akte_vorschlag', 'akte_model_vorschlag', 'Akte · Metadaten-Vorschlag',{ group: 'chat', modus: 'gestaffelt', aufgabe: 'routine' }),
];

/** Die beiden Aufgabentypen der vereinfachten Modellwahl. */
export const AUFGABENTYPEN = ['routine', 'komplex'];

/**
 * Früher kannte die einfache Modellwahl ein „Analysemodell“
 * (`llm_model_analyse`) und daneben Fallback, Nachlese und die Assistenten-
 * Modelle einzeln. Diese Klassen galten damals in der einfachen Wahl; aus
 * ihnen leitet die Umstellung (service/aufgabentypen-umstellung.js) die
 * beiden Aufgabentypen ab. Das Analysemodell war die Dokumentanalyse und
 * gehört deshalb zu „komplex“.
 */
export const ALTE_EINFACHE_KLASSEN = [
  { settingKey: 'llm_model_analyse', label: 'Analysemodell', aufgabe: 'komplex' },
  ...['fallback', 'nachlese', 'chat_research', 'chat_synthesis', 'chat_title', 'akte_vorschlag']
    .map((key) => MODEL_CLASSES.find((c) => c.key === key)),
];

/**
 * Modellwahl der Dokumentanalyse:
 *   'einfach'    — zwei Aufgabentypen („Einfach & Routine“, „Anspruchsvoll &
 *                  Komplex“) decken alle Aufgaben ab. Die Dokumentanalyse läuft
 *                  über „komplex“, dahinter springt „routine“ ein. Keine
 *                  Voranalyse, Prompt-Caching immer an.
 *   'gestaffelt' — jede Aufgabe einzeln: Voranalyse schätzt die Schwierigkeit,
 *                  danach Leicht/Mittel/Schwierig bzw. Lange Dokumente;
 *                  Fallback, Nachlese, Büroassistent und Akten je eigenes Modell.
 * Neuinstallationen starten einfach, bestehende Instanzen behalten die
 * Staffelung (seed-settings.js). Fehlt der Schlüssel trotzdem, bleibt es beim
 * bisherigen Verhalten.
 */
export const MODELLWAHLEN = ['einfach', 'gestaffelt'];
export function modellwahl(settings) {
  return settings?.llm_modellwahl === 'einfach' ? 'einfach' : 'gestaffelt';
}

/** Klassen, die in der aktuellen Modellwahl tatsächlich benutzt werden. */
export function aktiveModellklassen(settings) {
  const m = modellwahl(settings);
  return MODEL_CLASSES.filter((c) => !c.modus || c.modus === m);
}

/** settingKey → Klassendefinition (für den Löschschutz in routes/settings.js). */
export const MODEL_CLASS_BY_SETTING = Object.fromEntries(
  MODEL_CLASSES.map((c) => [c.settingKey, c])
);
