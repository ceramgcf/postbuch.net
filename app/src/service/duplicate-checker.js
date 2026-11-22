/**
 * service/duplicate-checker.js – Embedding-basierte Duplikaterkennung
 *
 * Ablauf (internaldocs/plaene/DUPLIKATPRUEFUNG-PLAN.md):
 *   1. Kandidaten: alle Bestandsdokumente mit Cosinus-Ähnlichkeit ab der Schwelle
 *      (Default 0,80), nur technische Obergrenze.
 *   2. Je Kandidat die Anker zählen: Briefdatum, fremdes Zeichen, Betrag (beidseitig
 *      gesetzt und gleich). Die Person ist kein Anker.
 *   3. Voller Treffer (discriminatorsMatchStrict) → Duplikatverdacht ohne KI;
 *      bei mehreren der ähnlichste.
 *   4. Sonst, nur wenn eine KI-Prüfung übergeben wurde (Option „KI-Duplikatprüfung
 *      in Zweifelsfällen“): KI-Urteil, wenn ein Kandidat mindestens einen Anker
 *      teilt oder das neue Dokument ein Rezept ist. Die KI erhält höchstens drei
 *      Kandidaten (Anker absteigend, dann Ähnlichkeit) und hat das letzte Wort:
 *      Duplikatverdacht nur bei einem Ja mit Sicherheit ab 0,9.
 *   Fehlt die KI oder schlägt sie fehl, besteht kein Verdacht. Ein fälschlich
 *   gemeldetes Duplikat wiegt schwerer als ein übersehenes.
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

/**
 * Zahl der übereinstimmenden Anker (Briefdatum, fremdes Zeichen, Betrag), je nur
 * gezählt, wenn beide Seiten einen Wert haben und die Werte gleich sind.
 * @param {{ briefdatum, fremdesZeichen, betrag }} neu
 * @param {{ briefdatum, fremdes_zeichen, betrag }} alt  (DB-Row)
 * @returns {number} 0–3
 */
export function zaehleAnker(neu, alt) {
  const gesetzt = (v) => v != null && v !== '';
  let n = 0;
  if (gesetzt(neu.briefdatum) && gesetzt(alt.briefdatum)
    && toIsoDate(neu.briefdatum) === toIsoDate(alt.briefdatum)) n++;
  if (gesetzt(neu.fremdesZeichen) && gesetzt(alt.fremdes_zeichen)
    && eqZeichen(neu.fremdesZeichen, alt.fremdes_zeichen)) n++;
  if (gesetzt(neu.betrag) && gesetzt(alt.betrag) && eqBetrag(neu.betrag, alt.betrag)) n++;
  return n;
}

/**
 * Auswahl für das KI-Urteil: zuerst die meisten Anker, bei Gleichstand die höhere
 * Ähnlichkeit; höchstens `max` Kandidaten.
 * @param {Array<{ anker: number, similarity: number }>} kandidaten
 */
export function waehleFuerKi(kandidaten, max = 3) {
  return [...kandidaten]
    .sort((a, b) => (b.anker - a.anker) || (Number(b.similarity) - Number(a.similarity)))
    .slice(0, max);
}

/** KI fragen? Ja, wenn ein Kandidat mindestens einen Anker teilt oder ein Rezept vorliegt. */
export function brauchtKi(kandidaten, istRezept) {
  if (!kandidaten.length) return false;
  return istRezept || kandidaten.some((k) => k.anker >= 1);
}

/** Mindestsicherheit eines KI-Ja für einen Duplikatverdacht. */
export const KI_MIN_SICHERHEIT = 0.9;

/**
 * Wertet die Urteile der KI aus. Nur ein Ja mit Sicherheit ab 0,9 zählt; bei
 * mehreren gewinnt das sicherste. Alles andere heißt: kein Duplikat.
 * @param {Array<{ postid, urteil, sicherheit, grund }>} urteile
 * @returns {{ postid, sicherheit, grund }|null}
 */
export function werteKiUrteileAus(urteile) {
  if (!Array.isArray(urteile)) return null;
  const ja = urteile
    .filter((u) => u && u.postid && u.urteil === 'duplikat'
      && Number.isFinite(Number(u.sicherheit)) && Number(u.sicherheit) >= KI_MIN_SICHERHEIT)
    .sort((a, b) => Number(b.sicherheit) - Number(a.sicherheit));
  return ja[0] ? { postid: ja[0].postid, sicherheit: Number(ja[0].sicherheit), grund: ja[0].grund || '' } : null;
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
    p.storage_backend,
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
  LIMIT 50
`;

// ── Hauptfunktion ────────────────────────────────────────────────────────────

/**
 * Prüft auf Duplikate per Embedding-Cosinus + strikte Diskriminator-Validierung.
 *
 * @param {object}      params
 * @param {object}      params.extractedData  - LLM-Ergebnis
 * @param {number[]|null} params.embedding    - Vorberechneter Vektor (null → kein OpenAI-Key)
 * @param {string|null} params.modifyPostID   - Korrektur-Modus: skip check
 * @param {number}      [params.threshold]    - Cosinus-Schwelle (default 0.80)
 * @param {Function|null} [params.kiPruefung] - async (kandidaten[]) → Urteile
 *   [{ postid, urteil, sicherheit, grund }] oder null. Nur übergeben, wenn die
 *   Option „KI-Duplikatprüfung in Zweifelsfällen“ an ist.
 * @param {object}      [pgClient]            - Optionaler PG-Client (default: pool)
 * @returns {Promise<{
 *   isDuplicate: boolean,
 *   matchID: string|null,
 *   finalPostID: string|null,
 *   match: { postid, similarity, confidence, onedriveId, webUrl, status, betreff, art }|null,
 *   begruendung?: string,
 *   quelle?: 'anker'|'ki'
 * }>}
 */
export async function check({ extractedData, embedding, modifyPostID, threshold = 0.80, kiPruefung = null }, pgClient) {
  const client = pgClient || pool;

  // Korrektur-Modus: kein Check nötig
  if (modifyPostID) {
    return { isDuplicate: true, matchID: modifyPostID, finalPostID: modifyPostID, match: null };
  }

  // Kein Embedding → kein Embedding-Provider konfiguriert → Check überspringen
  if (!embedding) {
    console.warn('[duplicate-checker] Embedding fehlt – Duplikat-Check übersprungen');
    return { isDuplicate: false, matchID: null, finalPostID: null, match: null };
  }

  // Nur Zeilen mit der AKTUELLEN Embedding-Signatur sind vergleichbar. Vektoren
  // aus einem anderen Modell liegen in einem anderen Raum — ihre Cosinus-Distanz
  // wäre bedeutungslos, nicht bloß ungenau.
  const signature = await activeSignature();
  const embLiteral = toVectorLiteral(embedding);
  const candidates = await client.query(CANDIDATE_QUERY, [embLiteral, 1 - threshold, signature]);

  return bewerteKandidaten(candidates.rows, extractedData, kiPruefung);
}

/**
 * Entscheidung über die Kandidaten aus der Ähnlichkeitssuche (ohne Datenbank,
 * exportiert für Unit-Tests). `rows` sind nach Ähnlichkeit absteigend sortiert.
 */
export async function bewerteKandidaten(rows, extractedData, kiPruefung = null) {
  const pb = extractedData.postbuch || {};
  const neu = {
    briefdatum: pb.briefdatum,
    familienmitglied: pb.familienmitglied,
    fremdesZeichen: pb.fremdesZeichen,
    betrag:     extractedData.arztrechnung?.gesamtbetrag
              ?? extractedData.generischeRechnung?.gesamtbetrag
              ?? extractedData.erstattungsbescheid?.erstattungsbetrag,
  };

  const treffer = (row, begruendung, quelle) => ({
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
    begruendung,
    quelle,
  });

  // Voller Treffer: Zeilen sind nach Ähnlichkeit sortiert, der erste gewinnt.
  for (const row of rows) {
    if (discriminatorsMatchStrict(neu, row)) {
      return treffer(row, 'Briefdatum, Person und die übrigen Merkmale stimmen überein.', 'anker');
    }
  }

  const keiner = { isDuplicate: false, matchID: null, finalPostID: null, match: null };
  if (typeof kiPruefung !== 'function') return keiner;

  const kandidaten = rows.map((row) => ({ ...row, anker: zaehleAnker(neu, row) }));
  const istRezept = String(extractedData.dokumentart || '').toLowerCase() === 'rezept';
  if (!brauchtKi(kandidaten, istRezept)) return keiner;

  const auswahl = waehleFuerKi(kandidaten);
  let urteile = null;
  try {
    urteile = await kiPruefung(auswahl);
  } catch (err) {
    console.warn(`[duplicate-checker] KI-Duplikatprüfung fehlgeschlagen – kein Duplikatverdacht: ${err.message}`);
    return keiner;
  }
  const ja = werteKiUrteileAus(urteile);
  if (!ja) return keiner;
  const row = auswahl.find((k) => k.postid === ja.postid);
  if (!row) return keiner;
  const pct = Math.round(ja.sicherheit * 100);
  return treffer(row, `KI-Prüfung (Sicherheit ${pct} %): ${ja.grund || 'dasselbe Schreiben'}`, 'ki');
}
