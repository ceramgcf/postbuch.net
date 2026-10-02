/**
 * lib/llm/model-classes.js — die zehn Modellklassen an einer Stelle
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
  // Dokument-Pipeline — hängen an der Fallback-Kette in selectModelChain()
  klasse('preanalysis', 'llm_model_preanalysis', 'Voranalyse'),
  klasse('large',       'llm_model_large',       'Lange Dokumente'),
  klasse('leicht',      'llm_model_leicht',      'Leicht'),
  klasse('mittel',      'llm_model_mittel',      'Mittel'),
  klasse('schwierig',   'llm_model_schwierig',   'Schwierig'),
  klasse('fallback',    'llm_model_fallback',    'Letzter Fallback'),

  // Büroassistent und Akten — eigene Modellwahl, unabhängig von der Kette
  klasse('chat_research',  'chat_model_research',  'Büroassistent · Recherche', { group: 'chat' }),
  klasse('chat_synthesis', 'chat_model_synthesis', 'Büroassistent · Antwort',   { group: 'chat' }),
  klasse('chat_title',     'chat_model_title',     'Büroassistent · Titel',     { group: 'chat' }),
  klasse('akte_vorschlag', 'akte_model_vorschlag', 'Akte · Metadaten-Vorschlag',{ group: 'chat' }),
];

/** settingKey → Klassendefinition (für den Löschschutz in routes/settings.js). */
export const MODEL_CLASS_BY_SETTING = Object.fromEntries(
  MODEL_CLASSES.map((c) => [c.settingKey, c])
);
