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
  // Einfache Modellwahl: nur diese beiden. Welche Aufgaben dahinter stecken,
  // sagt `aufgabe` an den Klassen der Einzelwahl (Gegenstück im Backend).
  { key: 'routine', modus: 'einfach', settingKey: 'llm_aufgabe_routine', label: 'Einfach & Routine',
    desc: 'Prüfung der gelesenen Angaben, Ersatz bei einer gescheiterten Analyse, Recherche und Gesprächstitel im Büroassistenten, Vorschläge für Akten. Ein schnelles, günstiges Modell genügt.' },
  { key: 'komplex', modus: 'einfach', settingKey: 'llm_aufgabe_komplex', label: 'Anspruchsvoll & Komplex',
    desc: 'Analyse jedes Dokuments, Nachlese bei Unstimmigkeiten, Erstattungsbescheide und die Antworten des Büroassistenten. Hier lohnt ein starkes Modell.' },

  { key: 'preanalysis', modus: 'gestaffelt', aufgabe: 'routine', settingKey: 'llm_model_preanalysis', label: 'Voranalyse',
    desc: 'Schwierigkeitseinschätzung – Kette: Voranalyse → Leicht → Letzter Fallback' },
  { key: 'large', modus: 'gestaffelt', aufgabe: 'komplex', settingKey: 'llm_model_large', label: 'Langes Dokument',
    desc: 'Dokumente mit mehr als 10 Seiten' },
  { key: 'leicht', modus: 'gestaffelt', aufgabe: 'routine', settingKey: 'llm_model_leicht', label: 'Leicht',
    desc: 'Einfache Dokumente (difficulty ≤ 0.25)' },
  { key: 'mittel', modus: 'gestaffelt', aufgabe: 'komplex', settingKey: 'llm_model_mittel', label: 'Mittel',
    desc: 'Mittelschwere Dokumente (difficulty 0.25–0.5) – fällt auf Leicht zurück' },
  { key: 'schwierig', modus: 'gestaffelt', aufgabe: 'komplex', settingKey: 'llm_model_schwierig', label: 'Schwierig',
    desc: 'Komplexe Dokumente (difficulty ≥ 0.5) – fällt auf Mittel → Leicht zurück' },
  { key: 'fallback', modus: 'gestaffelt', aufgabe: 'routine', settingKey: 'llm_model_fallback', label: 'Letzter Fallback',
    desc: 'Notfallmodell am Ende jeder Kette, wenn alle anderen Modelle fehlschlagen' },
  { key: 'nachlese', modus: 'gestaffelt', aufgabe: 'komplex', settingKey: 'llm_model_nachlese', label: 'Nachlese',
    desc: 'Starkes Modell, das nachliest, wenn eine Plausibilitätsprüfung scheitert (z. B. Positionssumme einer Arztrechnung)' },

  { key: 'chat_research', group: 'chat', modus: 'gestaffelt', aufgabe: 'routine', settingKey: 'chat_model_research', label: 'Assistent: Recherche',
    desc: 'Research-Agent des Büroassistenten (Tool-Use-Loop: Suche + Dokumente lesen)' },
  { key: 'chat_synthesis', group: 'chat', modus: 'gestaffelt', aufgabe: 'komplex', settingKey: 'chat_model_synthesis', label: 'Assistent: Antwort',
    desc: 'Synthese-Modell des Büroassistenten (formuliert die finale Antwort, gestreamt)' },
  { key: 'chat_title', group: 'chat', modus: 'gestaffelt', aufgabe: 'routine', settingKey: 'chat_model_title', label: 'Assistent: Titel',
    desc: 'Erzeugt den Gesprächstitel nach der ersten Antwort (sehr kurzer Aufruf)' },
  { key: 'akte_vorschlag', group: 'chat', modus: 'gestaffelt', aufgabe: 'routine', settingKey: 'akte_model_vorschlag', label: 'Akte: Metadaten-Vorschlag',
    desc: 'Schlägt Betreff, Beschreibung und Schlagwörter einer Akte vor (JSON-Antwort)' },
];

/**
 * Modellwahl der Dokumentanalyse, Gegenstück zu `modellwahl()` in
 * `app/src/lib/llm/model-classes.js`. Ohne gespeicherten Wert bleibt es wie
 * im Backend bei der Staffelung.
 */
export function modellwahlAus(settings) {
  return settings?.llm_modellwahl?.value === 'einfach' ? 'einfach' : 'gestaffelt';
}

/** Klassen, die in der gegebenen Modellwahl benutzt werden. */
export function klassenFuer(modellwahl) {
  return MODEL_CLASSES.filter((c) => !c.modus || c.modus === modellwahl);
}
