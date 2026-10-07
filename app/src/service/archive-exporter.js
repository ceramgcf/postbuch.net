/**
 * service/archive-exporter.js — Dokumentenübergabe-Export
 *
 * Baut pro Dokument ein offenes, selbstbeschreibendes JSON (x.json neben x.pdf)
 * sowie eine kleine manifest.json. Das Format transportiert dokumenteigene
 * Fachinhalte, aber keinen vollständigen Instanz-/Abrechnungskontext.
 *
 * Ziel: Dokumente ohne KI-Neuverarbeitung in eine andere postbuch.net-Instanz
 * übernehmen. Beziehungen zu nicht mitgenommenen Dokumenten werden beim Import
 * bewusst gelöst und nicht als scheinbare Perioden-, Akten- oder Workflowbeziehung
 * rekonstruiert.
 *
 * Es werden die ECHTEN DB-Spaltenwerte exportiert (inkl. Nutzer-Edits), NICHT nur
 * der ursprüngliche metadata-Blob. Der metadata-Blob (originale KI-Extraktion)
 * wird zusätzlich 1:1 mitgesichert.
 */

import { query } from '../db.js';
import { appVersion } from '../lib/app-version.js';

export const ARCHIVE_FORMAT = 'postbuch-archiv';
export const ARCHIVE_FORMAT_VERSION = 2;
export const ARCHIVE_SCOPE = 'dokumentenuebergabe';

// ── Embedding: halfvec::text ("[0.1,-0.2,...]") → Number-Array (oder null) ──────
function parseEmbedding(text) {
  if (!text || typeof text !== 'string') return null;
  try {
    const arr = JSON.parse(text);
    return Array.isArray(arr) && arr.length ? arr : null;
  } catch {
    return null;
  }
}

// ── Eine Postbuch-Zeile → stabiles JSON-Objekt ─────────────────────────────────
function pbToJson(row, embeddingText) {
  const vector = parseEmbedding(embeddingText);
  return {
    postid:          row.postid,
    briefdatum:      row.briefdatum ?? null,
    erfassungsdatum: row.erfassungsdatum ?? null,
    art:             row.art,
    lebensbereich:   row.lebensbereich ?? null,
    dokumentart:     row.dokumentart ?? null,
    kontakt:         row.kontakt ?? null,
    fremdes_zeichen: row.fremdes_zeichen ?? null,
    betreff:         row.betreff ?? null,
    zusammenfassung: row.zusammenfassung ?? null,
    schlagwoerter:   row.schlagwoerter ?? null,
    status:          row.status,
    confidence:      row.confidence != null ? Number(row.confidence) : null,
    notiz:           row.notiz ?? null,
    autoreview_instructions: row.autoreview_instructions ?? null,
    historisch:      row.historisch ?? false,
    familienmitglied: row.familienmitglied ?? null,
    richtung:        row.richtung,
    metadata:        row.metadata ?? null,   // originaler KI-extractedData-Blob, 1:1
    sha256:          row.sha256 ?? null,
    // Archivformat behält den Schlüsselnamen; Quelle ist die neue Spalte.
    onedrive_filename: row.storage_filename ?? row.onedrive_filename ?? null,
    ai: {
      model:        row.ai_model ?? null,
      pre_model:    row.ai_pre_model ?? null,
      tokens_in:    row.ai_tokens_in ?? null,
      tokens_out:   row.ai_tokens_out ?? null,
      pre_tokens_in:  row.ai_pre_tokens_in ?? null,
      pre_tokens_out: row.ai_pre_tokens_out ?? null,
      cost_usd:     row.ai_cost_usd != null ? Number(row.ai_cost_usd) : null,
      pre_cost_usd: row.ai_pre_cost_usd != null ? Number(row.ai_pre_cost_usd) : null,
    },
    data_repaired_at: row.data_repaired_at ?? null,
    data_repairs: row.data_repairs ?? null,
    qr_codes:        row.qr_codes ?? null,
    _vector: vector,  // intern; wird in das embedding-Feld der Doc-JSON gehoben
    _signature: row.embedding_signature ?? null,
  };
}

// ── Detail-Tabellen lesen (genau eine Form pro Dokument, sonst null) ───────────
async function loadDetail(postid) {
  // Das Schema hat je Spezialtabelle einen FK auf postbuch, aber keine
  // exklusive Verknüpfung „genau eine Detailart“. Erst alle fünf möglichen
  // Wurzeln prüfen, damit ein inkonsistenter Bestand nicht still nur nach der
  // Reihenfolge dieser Funktion exportiert wird.
  const [arz, hw, gr, ab, eb] = await Promise.all([
    query(`SELECT * FROM postbuch.arztrechnung WHERE postid = $1`, [postid]),
    query(`SELECT * FROM postbuch.handwerkerrechnung WHERE postid = $1`, [postid]),
    query(`SELECT * FROM postbuch.generische_rechnung WHERE postid = $1`, [postid]),
    query(`SELECT * FROM postbuch.arztbericht WHERE postid = $1`, [postid]),
    query(`SELECT * FROM postbuch.erstattungsbescheid WHERE postid = $1`, [postid]),
  ]);
  const detailRoots = [
    ['arztrechnung', arz.rows],
    ['handwerkerrechnung', hw.rows],
    ['generische_rechnung', gr.rows],
    ['arztbericht', ab.rows],
    ['erstattungsbescheid', eb.rows],
  ].filter(([, rows]) => rows.length);
  if (detailRoots.length > 1) {
    throw new Error(`Dokument ${postid} hat mehrere Detailarten: ${detailRoots.map(([type]) => type).join(', ')}`);
  }

  // Arztrechnung (+ Einzelpositionen)
  if (arz.rows.length) {
    const pos = await query(
      `SELECT * FROM postbuch.arztrechnung_einzelposition WHERE postid = $1 ORDER BY subid`,
      [postid]
    );
    return { type: 'arztrechnung', fields: arz.rows[0], einzelpositionen: pos.rows, zahlungen: await ladeZahlungenExport(postid), ersetzt: await ladeErsetztExport(postid) };
  }

  // Handwerkerrechnung
  if (hw.rows.length) return { type: 'handwerkerrechnung', fields: hw.rows[0], zahlungen: await ladeZahlungenExport(postid), ersetzt: await ladeErsetztExport(postid) };

  // Generische Rechnung
  if (gr.rows.length) return { type: 'generische_rechnung', fields: gr.rows[0], zahlungen: await ladeZahlungenExport(postid), ersetzt: await ladeErsetztExport(postid) };

  // Arztbericht
  if (ab.rows.length) return { type: 'arztbericht', fields: ab.rows[0] };

  // Erstattungsbescheid (+ Positionen + Kürzungen)
  if (eb.rows.length) {
    const pos = await query(
      `SELECT * FROM postbuch.erstattungsbescheid_einzelposition WHERE postid = $1 ORDER BY subid`,
      [postid]
    );
    const ku = await query(
      `SELECT * FROM postbuch.erstattungsbescheid_kuerzung WHERE postid = $1 ORDER BY eb_subid, kuerzung_id`,
      [postid]
    );
    return { type: 'erstattungsbescheid', fields: eb.rows[0], einzelpositionen: pos.rows, kuerzungen: ku.rows };
  }

  return null;
}

// Zahlungen einer Rechnung (Datum, Betrag) in fachlicher Reihenfolge.
async function ladeZahlungenExport(postid) {
  const r = await query(
    `SELECT datum, betrag FROM postbuch.rechnung_zahlung WHERE postid = $1 ORDER BY datum, zahlung_id`,
    [postid]
  );
  return r.rows;
}

// Ersetzt diese Rechnung eine andere (Korrekturrechnung)? Die Kante wird an
// der ersetzenden Rechnung geführt; der Import stellt sie wieder her, wenn
// beide Dokumente im selben Lauf neu angelegt werden.
async function ladeErsetztExport(postid) {
  const r = await query(
    `SELECT zu_postid, umgezogene_zahlungen, alt_bezahlt_am_manuell, neu_bezahlt_am_manuell FROM postbuch.dokument_beziehung
      WHERE art = 'ersetzt' AND von_postid = $1`,
    [postid]
  );
  const k = r.rows[0];
  return k ? { postid: k.zu_postid, umgezogene_zahlungen: k.umgezogene_zahlungen, alt_bezahlt_am_manuell: k.alt_bezahlt_am_manuell, neu_bezahlt_am_manuell: k.neu_bezahlt_am_manuell } : null;
}

// Abrechnungskontext und manuelle Workflowmarker gehören nicht zum
// Dokumentenübergabepaket. Die fachlichen Detaildaten des Dokuments bleiben
// erhalten; bloße Verweise auf nicht übertragene Kontexte werden entfernt.
export function portableDetail(detail) {
  if (!detail) return null;
  if (detail.type === 'arztrechnung') {
    const fields = { ...detail.fields };
    delete fields.abrechnungsperiode_pkv;
    delete fields.abrechnungsperiode_beihilfe;
    return { ...detail, fields };
  }
  if (detail.type === 'erstattungsbescheid') {
    const fields = { ...detail.fields };
    const einzelpositionen = (detail.einzelpositionen || []).map((row) => {
      const copy = { ...row };
      delete copy.ohne_rechnungsbezug_bestaetigt_am;
      delete copy.ohne_rechnungsbezug_bestaetigt_von;
      return copy;
    });
    const kuerzungen = (detail.kuerzungen || []).map((row) => {
      const copy = { ...row };
      delete copy.gesehen_am;
      delete copy.gesehen_von;
      return copy;
    });
    return { ...detail, fields, einzelpositionen, kuerzungen };
  }
  return detail;
}

/**
 * Baut das vollständige Doc-JSON für ein Dokument.
 * @returns {object|null} null, wenn das Dokument nicht existiert
 */
export async function buildDocJson(postid) {
  const pbRes = await query(
    `SELECT *, embedding::text AS embedding_text FROM postbuch.postbuch WHERE postid = $1`,
    [postid]
  );
  if (!pbRes.rows.length) return null;
  const row = pbRes.rows[0];

  const pb = pbToJson(row, row.embedding_text);
  const vector = pb._vector;
  const signature = pb._signature;
  delete pb._vector;
  delete pb._signature;

  const detail = portableDetail(await loadDetail(postid));

  return {
    _format: ARCHIVE_FORMAT,
    _v:      ARCHIVE_FORMAT_VERSION,
    postbuch:       pb,
    detail,
    // Signatur statt hartcodiertem Modellnamen: seit 1.7.0 ist der Embedding-
    // Provider frei konfigurierbar, ein Export muss sagen, WOMIT gerechnet wurde.
    embedding: vector
      ? { signature, dim: vector.length, vector }
      : null,
  };
}

/**
 * Personenlegende: nur die im Paket tatsächlich vorkommenden Kurznamen mit
 * Anzeigename und Tier-Kennzeichen — damit die Zielinstanz beim Import die
 * Personen zuordnen kann. Positivliste: Sätze, Kostenträger, Farbe, E-Mail
 * und Zugangsdaten gehören nicht dazu.
 */
async function buildPersonenlegende(postids) {
  if (!postids.length) return [];
  const r = await query(
    `WITH namen AS (
       SELECT familienmitglied AS name FROM postbuch.postbuch WHERE postid = ANY($1)
       UNION SELECT behandelte_person FROM postbuch.arztrechnung WHERE postid = ANY($1)
       UNION SELECT behandelte_person FROM postbuch.arztbericht WHERE postid = ANY($1)
       UNION SELECT behandelte_person FROM postbuch.erstattungsbescheid_einzelposition WHERE postid = ANY($1)
     )
     SELECT m.kurzname, m.anzeigename, m.ist_tier
       FROM postbuch.mensch m
       JOIN namen n ON n.name = m.kurzname
      ORDER BY m.kurzname`,
    [postids],
  );
  return r.rows.map((m) => ({
    kurzname: m.kurzname,
    anzeigename: m.anzeigename ?? null,
    istTier: !!m.ist_tier,
  }));
}

/** Baut die manifest.json für eine reine Dokumentenübergabe. */
export async function buildManifest(postids, { instanceName = '', exportedAt = new Date() } = {}) {
  return {
    _format:        ARCHIVE_FORMAT,
    formatVersion:  ARCHIVE_FORMAT_VERSION,
    scope:          ARCHIVE_SCOPE,
    generator:      'postbuch-unified',
    appVersion:     appVersion(),
    exportedAt:     exportedAt.toISOString(),
    instanceName:   instanceName || null,
    documentCount:  postids.length,
    included: [
      'pdf',
      'document-fields',
      'document-detail-fields',
      'invoice-line-items',
      'document-provenance',
      'embedding',
      'personenlegende',
    ],
    personenlegende: await buildPersonenlegende(postids),
    omitted: [
      'abrechnungsperioden',
      'abrechnungssessions',
      'akten-und-aktenlinks',
      'wiedervorlagen',
      'verbleib-referenzen',
      'personenstammdaten',
      'salden',
      'logs-und-caches',
      'pkv-pruefungen',
    ],
  };
}
