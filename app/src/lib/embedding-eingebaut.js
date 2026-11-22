/**
 * lib/embedding-eingebaut.js — feste Wahl des eingebauten Embedding-Dienstes
 *
 * Eigene Datei ohne Abhängigkeiten, damit auch seed-settings.js sie lesen kann,
 * ohne den Datenbank-Pool von lib/embedding.js mitzuladen.
 */

/**
 * Der eingebaute Embedding-Dienst (Compose-Dienst `embedding`). Die Werte sind
 * fest, nicht aus dem Vorsilben-Katalog abgeleitet: die mitgelieferten
 * Hilfevektoren (app/hilfe-vektoren.json) gelten genau für diese Signatur.
 */
export const EINGEBAUTES_EMBEDDING = Object.freeze({
  providerId: 'eingebaut',
  model: 'snowflake-arctic-embed-m-v2.0',
  dim: 768,
  vorsilben: Object.freeze({ anfrage: 'query: ', dokument: '' }),
});


/**
 * Alle Modelle, die der eingebaute Dienst anbietet (embedding/server.py,
 * MODELLE). Arctic ist im Image und Vorgabe; Voyage 4 Nano und EmbeddingGemma 2
 * lädt der Dienst bei der ersten Nutzung herunter und bietet sie nur auf
 * Geräten mit mindestens 2 GB Arbeitsspeicher an (ramMinMb, gemessen an
 * MemTotal, das auf 2-GB-Geräten etwas unter 2048 liegt). Die Vorsilben sind
 * fest wie beim Standardmodell; sie entsprechen den Vorgaben der Modelle.
 */
export const EINGEBAUTE_MODELLE = Object.freeze([
  Object.freeze({ ...EINGEBAUTES_EMBEDDING, label: 'Snowflake Arctic Embed M v2.0', ramMinMb: 0 }),
  Object.freeze({
    providerId: 'eingebaut', model: 'voyage-4-nano', dim: 2048, label: 'Voyage 4 Nano', ramMinMb: 1800,
    vorsilben: Object.freeze({
      anfrage: 'Represent the query for retrieving supporting documents: ',
      dokument: 'Represent the document for retrieval: ',
    }),
  }),
  Object.freeze({
    providerId: 'eingebaut', model: 'embeddinggemma-2', dim: 768, label: 'EmbeddingGemma 2', ramMinMb: 1800,
    vorsilben: Object.freeze({ anfrage: 'task: search result | query: ', dokument: 'title: none | text: ' }),
  }),
]);

/** Eintrag eines Modells des eingebauten Dienstes oder null. */
export function eingebautesModell(model) {
  return EINGEBAUTE_MODELLE.find((m) => m.model === model) || null;
}
