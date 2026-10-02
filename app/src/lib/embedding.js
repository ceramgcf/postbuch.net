/**
 * lib/embedding.js — Vektor-Embeddings (EINZIGE Implementierung im System)
 *
 * Vor 1.7.0 standen Modellname und Embeddings-URL an fünf Stellen (hier,
 * routes/search.js, service/chat-agent.js 2×, service/akten-service.js).
 * Solange das so war, brach jeder Provider-Wechsel Suche und Duplikat-Check
 * still an vier Stellen. `embedText()` ist jetzt der einzige Pfad.
 *
 * Konfiguration: _settings.llm_embedding = { providerId, model, dim }.
 * Der Default kommt aus der ersten Empfehlung der ausgelieferten
 * llm-empfehlungen.json (empfehlungs-standard.js), nicht aus einem Literal hier.
 *
 * ── Warum Zero-Padding statt ALTER COLUMN TYPE ───────────────────────────────
 * Die DB-Spalten sind halfvec(3072). Ein Wechsel auf ein 768er-Modell würde
 * einen Typwechsel auf drei Tabellen mit HNSW-Rebuild und langem Lock bedeuten
 * — auf einer Produktions-DB ohne Testumgebung die gefährlichste denkbare
 * Einzeloperation, nicht idempotent und nicht rückbaubar. Stattdessen füllt
 * toStorageVector() kürzere Vektoren mit Nullen auf.
 * Mathematisch sauber: bei identischem Padding beider Seiten sind Skalarprodukt
 * und Norm unverändert, die Cosinus-Distanz also exakt invariant.
 * Kosten: 6 kB statt 1,5 kB pro Zeile bei einem 768er-Modell.
 * Rückbaupfad: sobald ein Wartungsfenster existiert, kann die Spalte auf die
 * echte Dimension verkleinert und dieses Padding entfernt werden.
 *
 * ── Warum die Signatur ───────────────────────────────────────────────────────
 * `embedding_signature` = "<providerId>/<model>/<dim>". Suche und Duplikat-Check
 * berücksichtigen ausschließlich Zeilen mit der aktuellen Signatur; abweichende
 * gelten als „kein Embedding" — ein Zustand, den der Code über
 * embedding_failed_at/embedding_error bereits sauber behandelt. Damit ist
 * Mischbestand nach einem Modellwechsel strukturell unmöglich.
 */

import pool from '../db.js';
import { loadDynamicSettings } from '../config.js';
import { appLog } from '../app-log.js';
import { buildCostMap, calculateCost, logLlmCall, getProvider } from './llm.js';
import { fetchOpenAIEmbedding } from './llm/providers/openai.js';

/** Speicherbreite der halfvec-Spalten. Siehe Header. */
export const STORAGE_DIM = 3072;

// Es gibt bewusst KEINE Werkseinstellung für das Embedding-Modell. Ein Wechsel
// der Signatur entwertet den gesamten Vektorbestand, bis er neu berechnet ist —
// deshalb wird das Modell einmal ausdrücklich gewählt (Einrichtungsassistent,
// Einstellungen → KI oder „Modellempfehlungen übernehmen") statt vorbelegt.
// Ohne Wahl bleibt `model` leer: `embedText()` überspringt dann, und der
// Assistent meldet die offene Pflichtentscheidung, statt still ein Modell zu
// benutzen, das der Betreiber nie gesehen hat.
export const EMBEDDING_DEFAULT = {
  providerId: null,
  model: null,
  dim: STORAGE_DIM,
};

/** Aktive Embedding-Konfiguration aus den Settings (mit Default). */
export function embeddingConfig(settings) {
  const cfg = settings?.llm_embedding;
  if (!cfg || typeof cfg !== 'object' || !cfg.model) return { ...EMBEDDING_DEFAULT };
  const dim = Number(cfg.dim);
  return {
    providerId: cfg.providerId || EMBEDDING_DEFAULT.providerId,
    model: String(cfg.model),
    dim: Number.isInteger(dim) && dim >= 64 && dim <= STORAGE_DIM ? dim : STORAGE_DIM,
  };
}

export function signatureOf(cfg) {
  return `${cfg.providerId}/${cfg.model}/${cfg.dim}`;
}

/** Aktive Signatur — der Filterwert für alle Vektor-Queries. */
export async function activeSignature(settings = null) {
  const s = settings || await loadDynamicSettings();
  return signatureOf(embeddingConfig(s));
}

/** Kürzere Vektoren auf die Speicherbreite auffüllen (siehe Header). */
export function toStorageVector(vec) {
  if (!Array.isArray(vec)) throw new Error('toStorageVector: kein Array');
  if (vec.length > STORAGE_DIM) {
    throw new Error(`Embedding-Dimension ${vec.length} überschreitet das Speicherformat (${STORAGE_DIM}).`);
  }
  if (vec.length === STORAGE_DIM) return vec;
  return vec.concat(new Array(STORAGE_DIM - vec.length).fill(0));
}

/** halfvec-Literal '[n,n,…]' aus einem Vektor. */
export function toVectorLiteral(vec) {
  return `[${toStorageVector(vec).join(',')}]`;
}

/**
 * DER einzige Embedding-Aufruf im System.
 *
 * @param {string} inputText
 * @param {object} [settings]
 * @param {object} [meta]  - { entity, entityId, correlationId, username, kategorie }
 * @returns {Promise<{ vector: number[], literal: string, signature: string, cfg: object }|null>}
 *          null, wenn kein Embedding-Provider konfiguriert/erreichbar ist.
 */
export async function embedText(inputText, settings = null, meta = null) {
  const s = settings || await loadDynamicSettings();
  const cfg = embeddingConfig(s);
  // Ohne gewähltes Modell gibt es kein Embedding — es gibt keine
  // Werkseinstellung, auf die hier still zurückgefallen werden könnte.
  if (!cfg.model) return null;
  const provider = getProvider(s, cfg.providerId);
  if (!provider) {
    console.warn(`[embedding] Provider "${cfg.providerId}" nicht konfiguriert, Embedding übersprungen`);
    return null;
  }
  // Der Built-in OpenAI braucht zwingend einen Key; lokale Provider laufen ohne.
  if (provider.id === 'openai' && (!provider.apiKey || provider.apiKey === 'sk-...')) return null;
  if (!inputText || !String(inputText).trim()) return null;

  const t0 = Date.now();
  const costMap = buildCostMap(s);
  const log = (usage, error) => {
    const tokensIn = usage?.prompt_tokens ?? usage?.total_tokens ?? null;
    logLlmCall({
      username:      meta?.username      ?? null,
      kategorie:     meta?.kategorie     ?? 'embedding',
      provider:      cfg.providerId,
      model:         cfg.model,
      tokensIn,
      tokensOut:     null,
      costUsd:       costMap && tokensIn != null ? calculateCost(cfg.model, tokensIn, 0, costMap) : null,
      durationMs:    Date.now() - t0,
      success:       !error,
      errorMessage:  error?.message ?? null,
      entity:        meta?.entity        ?? null,
      entityId:      meta?.entityId      ?? null,
      correlationId: meta?.correlationId ?? null,
    });
  };

  let result;
  try {
    result = await fetchOpenAIEmbedding(cfg.model, String(inputText), provider);
  } catch (err) {
    log(null, err);
    throw err;
  }

  const vector = result.vektor;
  if (vector.length !== cfg.dim) {
    const err = new Error(
      `Embedding-Dimension passt nicht zur Konfiguration: ${vector.length} statt ${cfg.dim}. `
      + 'Bitte den Embedding-Provider in den Einstellungen neu testen.',
    );
    log(result.usage, err);
    throw err;
  }
  log(result.usage, null);

  return { vector, literal: toVectorLiteral(vector), signature: signatureOf(cfg), cfg };
}

/**
 * Probing-Aufruf beim Konfigurieren: ermittelt die tatsächliche Dimension.
 * Das ist die EINZIGE Stelle mit Capability-Probing — hier ist es richtig, weil
 * die Dimension eine harte, prüfbare Zahl ist (anders als „kann PDF").
 */
export async function probeEmbeddingDimension(providerId, model, settings = null) {
  const s = settings || await loadDynamicSettings();
  const provider = getProvider(s, providerId);
  if (!provider) throw new Error(`Provider "${providerId}" nicht gefunden.`);
  const { vektor } = await fetchOpenAIEmbedding(model, 'test', provider);
  const dim = vektor.length;
  if (!Number.isInteger(dim) || dim < 64 || dim > STORAGE_DIM) {
    throw new Error(
      `Dimension ${dim} wird nicht unterstützt (erlaubt: 64–${STORAGE_DIM}). `
      + `Modelle über ${STORAGE_DIM} Dimensionen passen nicht in das Speicherformat.`,
    );
  }
  return dim;
}

// ── Eingabetexte ─────────────────────────────────────────────────────────────

function buildInputTextFromPipelineData(doc) {
  const pb = doc.postbuch || {};
  const parts = [
    pb.briefdatum,
    doc.lebensbereich,
    doc.dokumentart,
    pb.betreff,
    pb.kontakt,
    pb.fremdesZeichen,
    pb.zusammenfassung,
    Array.isArray(pb.schlagwörter) && pb.schlagwörter.length
      ? pb.schlagwörter.join(', ')
      : null,
  ].filter(Boolean);
  return parts.join(' | ');
}

function buildInputTextFromDbRow(row) {
  const parts = [
    row.briefdatum ? new Date(row.briefdatum).toISOString().split('T')[0] : null,
    row.lebensbereich,
    row.dokumentart,
    row.betreff,
    row.kontakt,
    row.fremdes_zeichen,
    row.zusammenfassung,
    Array.isArray(row.schlagwoerter) && row.schlagwoerter.length
      ? row.schlagwoerter.join(', ')
      : null,
  ].filter(Boolean);
  return parts.join(' | ');
}

// ── Persistenz ───────────────────────────────────────────────────────────────

async function storeEmbedding(postid, literal, signature) {
  // Gleichzeitig Fehler-Tracking-Felder leeren (Soft-Fail wurde behoben)
  await pool.query(
    `UPDATE postbuch SET embedding = $1::halfvec,
                         embedding_signature = $2,
                         embedding_failed_at = NULL,
                         embedding_error = NULL
     WHERE postid = $3`,
    [literal, signature, postid]
  );
}

/**
 * Generiert ein Embedding aus Pipeline-Daten und speichert es in der DB.
 */
export async function generateAndStoreEmbedding(postid, extractedData, settings = null) {
  const s = settings || await loadDynamicSettings();
  const inputText = buildInputTextFromPipelineData(extractedData);
  if (!inputText) {
    console.warn(`[embedding] Leerer Eingabetext für PostID ${postid}, übersprungen`);
    appLog('WARN', 'embedding', `Leerer Eingabetext für PostID ${postid}, übersprungen`, { entity: 'postbuch', entityId: postid });
    return;
  }

  const erg = await embedText(inputText, s, { entity: 'postbuch', entityId: postid });
  if (!erg) {
    console.warn('[embedding] Kein Embedding-Provider konfiguriert, Embedding übersprungen');
    appLog('WARN', 'embedding', 'Kein Embedding-Provider konfiguriert, Embedding übersprungen', { entity: 'postbuch', entityId: postid });
    return;
  }
  await storeEmbedding(postid, erg.literal, erg.signature);
  console.log(`[embedding] Embedding gespeichert für ${postid} (${erg.signature})`);
}

/**
 * Generiert ein Embedding aus DB-Metadaten und speichert es.
 * Für GUI-Aufrufe wenn Metadaten geändert werden.
 */
export async function regenerateEmbedding(postid, settings = null) {
  const s = settings || await loadDynamicSettings();

  const result = await pool.query(
    `SELECT briefdatum, lebensbereich, dokumentart, betreff, kontakt, fremdes_zeichen,
            zusammenfassung, schlagwoerter
     FROM postbuch
     WHERE postid = $1`,
    [postid]
  );

  if (result.rows.length === 0) {
    throw new Error(`[embedding] PostID ${postid} nicht gefunden`);
  }

  const inputText = buildInputTextFromDbRow(result.rows[0]);
  if (!inputText) {
    console.warn(`[embedding] Leerer Eingabetext für PostID ${postid}, übersprungen`);
    return;
  }

  const erg = await embedText(inputText, s, { entity: 'postbuch', entityId: postid });
  if (!erg) {
    console.warn('[embedding] Kein Embedding-Provider konfiguriert, Embedding übersprungen');
    appLog('WARN', 'embedding', 'Kein Embedding-Provider konfiguriert, Embedding übersprungen', { entity: 'postbuch', entityId: postid });
    return;
  }
  await storeEmbedding(postid, erg.literal, erg.signature);
  console.log(`[embedding] Embedding neu generiert für ${postid} (${erg.signature})`);
}

/**
 * Generiert einen Embedding-Vektor aus Pipeline-Daten OHNE ihn zu speichern.
 * Wird in Phase 3 der Pipeline für den Duplikat-Check verwendet.
 *
 * @returns {Promise<number[]|null>} Vektor in Speicherbreite oder null
 */
export async function fetchEmbeddingForExtractedData(extractedData, settings = null, meta = null) {
  const s = settings || await loadDynamicSettings();
  const inputText = buildInputTextFromPipelineData(extractedData);
  if (!inputText) return null;
  // meta durchreichen, damit der Embedding-Call dieselbe correlation_id (Pipeline-Job)
  // trägt und im Token-Log mit Voranalyse/Analyse zu EINEM Vorgang gruppiert wird.
  const erg = await embedText(inputText, s, meta || {});
  return erg ? toStorageVector(erg.vector) : null;
}
