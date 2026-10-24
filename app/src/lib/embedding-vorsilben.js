/**
 * lib/embedding-vorsilben.js — Vorschläge für Embedding-Vorsilben je Modell
 *
 * Viele offene Embedding-Modelle sind asymmetrisch trainiert: Suchanfragen und
 * gespeicherte Texte bekommen unterschiedliche Vorsilben (etwa „query: " und
 * „passage: "). Ohne sie liefern diese Modelle messbar schlechtere Treffer.
 * OpenAI, Mistral und Bedrock-Titan brauchen keine.
 *
 * Der Katalog wird nur beim SPEICHERN der Embedding-Wahl befragt (Einstellungen,
 * Modellempfehlungen); das Ergebnis steht danach ausdrücklich in
 * `_settings.llm_embedding.vorsilben`. Zur Laufzeit wird nie nachgeschlagen.
 * Sonst würde eine geänderte Katalogzeile in einem Update die Vektoren neuer
 * Dokumente still anders berechnen als den vorhandenen Bestand.
 *
 * Erkennung über den Modellnamen, weil derselbe Gewichtssatz je nach Server
 * anders heißt (Ollama-Tag, GGUF-Dateiname, Hugging-Face-ID).
 */

const KATALOG = [
  {
    // Qwen3-Embedding: Anweisung nur vor der Anfrage, englisch empfohlen;
    // der Text folgt ohne Leerzeichen direkt auf „Query:".
    muster: /qwen3[-_.]?embedding/i,
    anfrage: 'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:',
    dokument: '',
  },
  {
    muster: /arctic[-_.]?embed/i,
    anfrage: 'query: ',
    dokument: '',
  },
  {
    muster: /embedding[-_.]?gemma/i,
    anfrage: 'task: search result | query: ',
    dokument: 'title: none | text: ',
  },
  {
    muster: /nomic[-_.]?embed/i,
    anfrage: 'search_query: ',
    dokument: 'search_document: ',
  },
  {
    muster: /mxbai[-_.]?embed/i,
    anfrage: 'Represent this sentence for searching relevant passages: ',
    dokument: '',
  },
  {
    // multilingual-e5-*, e5-large-v2 usw.; nicht „gte-…" oder Namen, in
    // denen „e5" nur zufällig vorkommt.
    muster: /(^|[/:_-])(multilingual-)?e5[-_]/i,
    anfrage: 'query: ',
    dokument: 'passage: ',
  },
];

/** Vorgeschlagene Vorsilben für einen Modellnamen; leer, wenn keine nötig. */
export function vorsilbenVorschlag(model) {
  const name = String(model || '');
  const treffer = KATALOG.find((k) => k.muster.test(name));
  return treffer
    ? { anfrage: treffer.anfrage, dokument: treffer.dokument }
    : { anfrage: '', dokument: '' };
}
