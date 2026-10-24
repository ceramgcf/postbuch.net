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

