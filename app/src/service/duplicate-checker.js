/**
 * service/duplicate-checker.js — Embedding-basierte Duplikaterkennung
 *
 * Ersetzt die alte OCR/SimHash/Levenshtein-Logik komplett.
 *
 * Algorithmus:
 *   1. Cosinus-Ähnlichkeit via HNSW-Index (pgvector <=> Operator) > Threshold (Default 0.9)
 *   2. Strikte Diskriminator-Validierung: Briefdatum + Adressat + fremdesZeichen + Betrag
 *   3. Erster valider Treffer gewinnt
 */

import pool from '../db.js';
import { activeSignature, toVectorLiteral } from '../lib/embedding.js';

// ── Hilfsfunktionen ──────────────────────────────────────────────────────────

function toIsoDate(val) {
  if (val == null || val === '') return '';
  if (val instanceof Date && !isNaN(val)) return val.toISOString().split('T')[0];
  if (typeof val === 'number' && isFinite(val)) return new Date(val).toISOString().split('T')[0];
  if (typeof val === 'string') {
    const trimmed = val.trim();
    const isoMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
    if (isoMatch) return isoMatch[1];
    if (/^\d{2}\.\d{2}\.\d{4}$/.test(trimmed)) {
      const parts = trimmed.split('.');
      return `${parts[2]}-${parts[1]}-${parts[0]}`;
    }
    const parsed = Date.parse(trimmed);
    if (!isNaN(parsed)) return new Date(parsed).toISOString().split('T')[0];
    return trimmed;
  }
  if (val && typeof val.toISOString === 'function') {
    try { return new Date(val.toISOString()).toISOString().split('T')[0]; } catch { return ''; }
  }
  return '';
}

function eqZeichen(a, b) {
  const norm = (s) => String(s).toLowerCase().replace(/[-/._\s]/g, '');
  return norm(a) === norm(b);
}

function eqBetrag(a, b) {
  return Math.abs(Number(a) - Number(b)) <= 0.01;
}

function sameOrBothEmpty(a, b, eqFn) {
  const aEmpty = a == null || a === '';
  const bEmpty = b == null || b === '';
  if (aEmpty && bEmpty) return true;
  if (aEmpty || bEmpty) return false; // XOR: einer gesetzt, einer leer → kein Match
  return eqFn(a, b);
}

/** Nur vergleichen, wenn beide Seiten einen Wert haben. Fehlt einer → ignorieren. */
function ifBothSet(a, b, eqFn) {
  const aEmpty = a == null || a === '';
  const bEmpty = b == null || b === '';
  if (aEmpty || bEmpty) return true; // einseitig fehlend → kein Ausschlusskriterium
  return eqFn(a, b);
}

/**
 * Strikte Diskriminator-Validierung (exportiert für Unit-Tests).
 * @param {{ briefdatum, familienmitglied, fremdesZeichen, betrag }} neu
 * @param {{ briefdatum, familienmitglied, fremdes_zeichen, betrag }} alt  (DB-Row)
 * @returns {boolean}
 */
export function discriminatorsMatchStrict(neu, alt) {
  // Briefdatum: muss in beiden vorhanden und gleich sein
  if (!neu.briefdatum || !alt.briefdatum) return false;
  if (toIsoDate(neu.briefdatum) !== toIsoDate(alt.briefdatum)) return false;

  // Familienmitglied, fremdesZeichen, Betrag
  if (!sameOrBothEmpty(neu.familienmitglied, alt.familienmitglied, (a, b) => String(a).trim() === String(b).trim())) return false;
  if (!ifBothSet(neu.fremdesZeichen, alt.fremdes_zeichen, eqZeichen)) return false;
  if (!ifBothSet(neu.betrag, alt.betrag, eqBetrag)) return false;

  // Mindestens 1 weiterer Diskriminator (außer Briefdatum) muss in BEIDEN gesetzt sein
  const sharedDiscriminators =
    (neu.familienmitglied && alt.familienmitglied ? 1 : 0) +
    (neu.fremdesZeichen != null && neu.fremdesZeichen !== '' && alt.fremdes_zeichen != null && alt.fremdes_zeichen !== '' ? 1 : 0) +
    (neu.betrag != null && alt.betrag != null ? 1 : 0);
  if (sharedDiscriminators === 0) return false;

  return true;
}

// ── Kandidaten-Query ─────────────────────────────────────────────────────────

const CANDIDATE_QUERY = `
  SELECT
    p.postid,
    p.briefdatum,
    p.familienmitglied,
    p.fremdes_zeichen,
    p.confidence,
    p.storage_id,
    p.link,
    p.status,
    p.dokumentart AS art,
    p.betreff,
    COALESCE(a.gesamtbetrag, g.gesamtbetrag, e.erstattungsbetrag, h.gesamtbetrag) AS betrag,
    1 - (p.embedding <=> $1::halfvec) AS similarity
  FROM postbuch.postbuch p
  LEFT JOIN postbuch.arztrechnung        a ON p.postid = a.postid
  LEFT JOIN postbuch.handwerkerrechnung  h ON p.postid = h.postid
  LEFT JOIN postbuch.erstattungsbescheid e ON p.postid = e.postid
  LEFT JOIN postbuch.generische_rechnung g ON p.postid = g.postid
  WHERE p.embedding IS NOT NULL
    AND p.embedding_signature = $3
    AND (p.embedding <=> $1::halfvec) < $2
  ORDER BY p.embedding <=> $1::halfvec ASC
  LIMIT 5
`;

// ── Hauptfunktion ────────────────────────────────────────────────────────────

/**
 * Prüft auf Duplikate per Embedding-Cosinus + strikte Diskriminator-Validierung.
 *
 * @param {object}      params
 * @param {object}      params.extractedData  - LLM-Ergebnis
 * @param {number[]|null} params.embedding    - Vorberechneter Vektor (null → kein OpenAI-Key)
 * @param {string|null} params.modifyPostID   - Korrektur-Modus: skip check
 * @param {number}      [params.threshold]    - Cosinus-Schwelle (default 0.90)
 * @param {object}      [pgClient]            - Optionaler PG-Client (default: pool)
 * @returns {Promise<{
 *   isDuplicate: boolean,
 *   matchID: string|null,
 *   finalPostID: string|null,
 *   match: { postid, similarity, confidence, onedriveId, webUrl, status, betreff, art }|null
 * }>}
 */
export async function check({ extractedData, embedding, modifyPostID, threshold = 0.90 }, pgClient) {
  const client = pgClient || pool;

  // Korrektur-Modus: kein Check nötig
  if (modifyPostID) {
    return { isDuplicate: true, matchID: modifyPostID, finalPostID: modifyPostID, match: null };
  }

  // Kein Embedding → kein Embedding-Provider konfiguriert → Check überspringen
  if (!embedding) {
    console.warn('[duplicate-checker] Embedding fehlt — Duplikat-Check übersprungen');
    return { isDuplicate: false, matchID: null, finalPostID: null, match: null };
  }

  // Nur Zeilen mit der AKTUELLEN Embedding-Signatur sind vergleichbar. Vektoren
  // aus einem anderen Modell liegen in einem anderen Raum — ihre Cosinus-Distanz
  // wäre bedeutungslos, nicht bloß ungenau.
  const signature = await activeSignature();
  const embLiteral = toVectorLiteral(embedding);
  const candidates = await client.query(CANDIDATE_QUERY, [embLiteral, 1 - threshold, signature]);

  const pb = extractedData.postbuch || {};
  const neu = {
    briefdatum: pb.briefdatum,
    familienmitglied: pb.familienmitglied,
    fremdesZeichen: pb.fremdesZeichen,
    betrag:     extractedData.arztrechnung?.gesamtbetrag
              ?? extractedData.generischeRechnung?.gesamtbetrag
              ?? extractedData.erstattungsbescheid?.erstattungsbetrag,
  };

  for (const row of candidates.rows) {
    if (discriminatorsMatchStrict(neu, row)) {
      return {
        isDuplicate: true,
        matchID: row.postid,
        finalPostID: null,
        match: {
          postid:      row.postid,
          similarity:  Number(row.similarity),
          confidence:  Number(row.confidence),
          onedriveId:  row.storage_id,
          webUrl:      row.link,
          status:      row.status,
          betreff:     row.betreff,
          art:         row.art,
        },
      };
    }
  }

  return { isDuplicate: false, matchID: null, finalPostID: null, match: null };
}
