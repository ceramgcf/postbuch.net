/**
 * modelClasses.js – Reihenfolge, Label und Beschreibung der Modellklassen
 *
 * Gegenstück zu `app/src/lib/llm/model-classes.js`. Hier steht bewusst NUR,
 * was Anzeige ist: `key`, `settingKey`, Beschriftung, Gruppierung.
 *
 * Was hier NICHT mehr steht – und auch nicht wieder hineingehört: die
 * Auflösung eines gespeicherten Werts auf `{providerId, model}`. Die kam
 * früher aus `resolveModelValue()`, das den Provider am Modellnamen erraten
 * hat („beginnt mit claude- → anthropic"). Mit frei konfigurierbaren Providern
 * ist das prinzipiell nicht mehr auflösbar: zwei Ollama-Hosts mit demselben
 * `llama3.3` sind über den Namen nicht unterscheidbar. Die aufgelöste Wahrheit
 * kommt aus `/api/settings/ai/health` → `models[key]`.
 */

export const MODEL_CLASSES = [
  { key: 'preanalysis', settingKey: 'llm_model_preanalysis', label: 'Voranalyse',
    desc: 'Schwierigkeitseinschätzung – Kette: Voranalyse → Leicht → Letzter Fallback' },
  { key: 'large', settingKey: 'llm_model_large', label: 'Langes Dokument',
    desc: 'Dokumente mit mehr als 10 Seiten' },
  { key: 'leicht', settingKey: 'llm_model_leicht', label: 'Leicht',
    desc: 'Einfache Dokumente (difficulty ≤ 0.25)' },
  { key: 'mittel', settingKey: 'llm_model_mittel', label: 'Mittel',
    desc: 'Mittelschwere Dokumente (difficulty 0.25–0.5) – fällt auf Leicht zurück' },
  { key: 'schwierig', settingKey: 'llm_model_schwierig', label: 'Schwierig',
    desc: 'Komplexe Dokumente (difficulty ≥ 0.5) – fällt auf Mittel → Leicht zurück' },
  { key: 'fallback', settingKey: 'llm_model_fallback', label: 'Letzter Fallback',
    desc: 'Notfallmodell am Ende jeder Kette, wenn alle anderen Modelle fehlschlagen' },

  { key: 'chat_research', group: 'chat', settingKey: 'chat_model_research', label: 'Assistent: Recherche',
    desc: 'Research-Agent des Büroassistenten (Tool-Use-Loop: Suche + Dokumente lesen)' },
  { key: 'chat_synthesis', group: 'chat', settingKey: 'chat_model_synthesis', label: 'Assistent: Antwort',
    desc: 'Synthese-Modell des Büroassistenten (formuliert die finale Antwort, gestreamt)' },
  { key: 'chat_title', group: 'chat', settingKey: 'chat_model_title', label: 'Assistent: Titel',
    desc: 'Erzeugt den Gesprächstitel nach der ersten Antwort (sehr kurzer Aufruf)' },
  { key: 'akte_vorschlag', group: 'chat', settingKey: 'akte_model_vorschlag', label: 'Akte: Metadaten-Vorschlag',
    desc: 'Schlägt Betreff, Beschreibung und Schlagwörter einer Akte vor (JSON-Antwort)' },
];
