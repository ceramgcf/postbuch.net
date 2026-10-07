/**
 * service/chat-references.js — #P/#A-Referenzen aus Chat-Nachrichten auflösen.
 *
 * Der Nutzer kann Dokumente (#P000123) und Akten (#A000045) direkt in seiner
 * Nachricht referenzieren. Die referenzierten Objekte werden hier VOR dem
 * Agenten-Lauf geladen und als kompakter Kontextblock aufbereitet, den
 * runChatAgent in beide Pfade injiziert (Research-Messages bzw. Abo-System-
 * Prompt). Dokument-Volltexte sind durch extractDocumentText hart auf 16.000
 * Zeichen gekappt; "große" Dokumente (kein extrahierbarer Text) liefern nur
 * Metadaten plus Hinweis auf get_document_pdf_vision.
 */

import pool from '../db.js';
import { retrieveDocument } from './document-retriever.js';
import { extractDocumentText } from '../lib/text-extractor.js';
import { getAkteWithDocuments } from './akten-service.js';
import { ermittleZahlungslage } from './rechnung-zahlung.js';
import { ladeErsetzung } from './rechnung-ersetzung.js';

// Obergrenze pro Nachricht — begrenzt Token-Kosten (max. ~5 × 16.000 Zeichen Volltext)
const MAX_REFS = 5;

// Referenzen in Reihenfolge ihres Auftretens, dedupliziert
export function parseReferences(text) {
  const seen = new Set();
  const refs = [];
  for (const m of (text || '').matchAll(/#([PpAa])(\d{6})\b/g)) {
    const id = m[1].toUpperCase() + m[2];
    if (!seen.has(id)) {
      seen.add(id);
      refs.push({ type: id[0], id });
    }
  }
  return refs;
}

async function loadDocumentSection(postid, ctx) {
  const r = await pool.query(`
    SELECT p.postid, p.briefdatum, p.kontakt, p.dokumentart AS art, p.betreff,
           p.zusammenfassung, p.schlagwoerter, p.notiz, p.familienmitglied,
           p.richtung::text AS richtung, p.status::text AS status,
           p.fremdes_zeichen, p.historisch,
           COALESCE(a.gesamtbetrag, h.gesamtbetrag, g.gesamtbetrag, e.erstattungsbetrag) AS betrag
    FROM postbuch.postbuch p
    LEFT JOIN postbuch.arztrechnung a ON a.postid = p.postid
    LEFT JOIN postbuch.handwerkerrechnung h ON h.postid = p.postid
    LEFT JOIN postbuch.generische_rechnung g ON g.postid = p.postid
    LEFT JOIN postbuch.erstattungsbescheid e ON e.postid = p.postid
    WHERE p.postid = $1
  `, [postid]);

  if (r.rows.length === 0) return `=== Dokument [${postid}] ===\nNicht gefunden — die Referenz existiert nicht (weise den Nutzer darauf hin).`;
  const d = r.rows[0];

  // Quelle registrieren (read=true) → erscheint automatisch in der Sources-Liste
  if (!ctx.usedSources.has(postid)) {
    ctx.usedSources.set(postid, {
      postid, betreff: d.betreff, briefdatum: d.briefdatum, art: d.art,
      searched: false, read: true,
    });
  } else {
    ctx.usedSources.get(postid).read = true;
  }

  // Zahlungen stehen in rechnung_zahlung, nicht im PDF. Ohne diese Zeilen
  // liest das Modell einen Zahlungsvermerk im Volltext als Stand und nennt
  // einen falschen offenen Rest; get_document_metadata soll es hier ja
  // gerade nicht mehr aufrufen.
  const zahlungLines = await ladeZahlungLines(postid);

  const metaLines = [
    `Datum: ${d.briefdatum || '?'} · Art: ${d.art || '?'} · Kontakt: ${d.kontakt || '?'} · Status: ${d.status || '?'}${d.historisch ? ' · ARCHIVIERT' : ''}`,
    d.betrag != null ? `Betrag: ${d.betrag} EUR` : null,
    ...zahlungLines,
    d.familienmitglied ? `Familienmitglied: ${d.familienmitglied}${d.richtung ? ` · Richtung: ${d.richtung}` : ''}` : null,
    d.schlagwoerter?.length ? `Schlagwörter: ${d.schlagwoerter.join(', ')}` : null,
    d.fremdes_zeichen ? `Fremdes Zeichen: ${d.fremdes_zeichen}` : null,
    d.zusammenfassung ? `Zusammenfassung: ${d.zusammenfassung}` : null,
    d.notiz ? `Notiz: ${d.notiz}` : null,
  ].filter(Boolean);

  let textPart;
  try {
    const { pdf } = await retrieveDocument(postid);
    const result = await extractDocumentText(postid, pdf, { settings: ctx.settings, meta: ctx.meta });
    if (result.text && result.method !== 'not_extractable' && result.method !== 'too_long') {
      textPart = `Volltext:\n${result.text}`;
    } else {
      textPart = `Volltext nicht verfügbar (${result.pageCount || '?'} Seiten, ${result.method}) — bei Bedarf get_document_pdf_vision mit gezielter Frage nutzen.`;
    }
  } catch (err) {
    textPart = `Volltext konnte nicht geladen werden (${err.message}) — Metadaten oben sind vollständig.`;
  }

  return `=== Dokument [${postid}] — ${d.betreff || d.kontakt || d.art || ''} ===\n${metaLines.join('\n')}\n${textPart}`;
}

async function ladeZahlungLines(postid) {
  const lage = await ermittleZahlungslage(pool, postid);
  if (!lage) return [];
  const { ersetzt, ersetzt_durch: ersetztDurch } = await ladeErsetzung(pool, postid);
  if (ersetztDurch) {
    return [`Zahlungsstand (Datenbank): Rechnung ist durch die Korrekturrechnung [${ersetztDurch.postid}] ersetzt und erledigt; Zahlungen und offener Rest stehen dort.`];
  }
  const zahlungen = lage.zahlungen.length
    ? lage.zahlungen.map(z => `${z.datum || '?'}: ${z.betrag} EUR`).join('; ')
    : 'keine erfasst';
  return [
    ersetzt
      ? `Korrekturrechnung: ersetzt die Rechnung [${ersetzt.postid}] (dort erledigt); deren Zahlungen sind hier mitgezählt. Bei Fragen zu dieser Rechnung immer erwähnen.`
      : null,
    `Zahlungsstand (Datenbank, maßgeblich – Zahlungsvermerke im Volltext können veraltet sein): zu zahlen ${lage.zu_zahlen ?? '?'} EUR · gezahlt ${lage.gezahlt} EUR · offen ${lage.offen ?? '?'} EUR${lage.ueberzahlt ? ` · überzahlt ${lage.ueberzahlt} EUR` : ''}`,
    `Erfasste Zahlungen: ${zahlungen}`,
  ].filter(Boolean);
}

async function loadAkteSection(akteid, ctx) {
  let akte, dokumente;
  try {
    ({ akte, dokumente } = await getAkteWithDocuments(akteid));
  } catch (err) {
    return `=== Akte [${akteid}] ===\n${err.message} (weise den Nutzer ggf. darauf hin).`;
  }

  if (!ctx.usedSources.has(akteid)) {
    ctx.usedSources.set(akteid, { akteid, betreff: akte.betreff, read: true });
  }

  const lines = [
    akte.beschreibung ? `Beschreibung: ${akte.beschreibung}` : null,
    akte.schlagwoerter?.length ? `Schlagwörter: ${akte.schlagwoerter.join(', ')}` : null,
    akte.notiz ? `Notiz: ${akte.notiz}` : null,
    akte.historisch ? 'Status: ARCHIVIERT' : null,
    dokumente.length
      ? `Enthaltene Dokumente:\n${dokumente.map(d => `- [${d.postid}] ${d.briefdatum || '?'} · ${d.art || '?'} · ${d.betreff || d.kontakt || ''}`).join('\n')}`
      : 'Enthaltene Dokumente: (keine)',
  ].filter(Boolean);

  return `=== Akte [${akteid}] — ${akte.betreff || ''} (${dokumente.length} Dokumente) ===\n${lines.join('\n')}`;
}

/**
 * Löst alle #-Referenzen der Nutzernachricht auf und baut den Kontextblock.
 * Fehler je Referenz werden als Hinweiszeile aufgenommen statt den Lauf
 * abzubrechen. Referenzierte Objekte landen in ctx.usedSources (read=true)
 * und damit in der Sources-Liste beider Pfade.
 *
 * @returns {{ block: string|null, refs: Array<{type:'P'|'A', id:string}> }}
 */
export async function buildReferenceContext(userMessage, ctx) {
  const allRefs = parseReferences(userMessage);
  if (allRefs.length === 0) return { block: null, refs: [] };

  const refs = allRefs.slice(0, MAX_REFS);
  const sections = [];
  for (const ref of refs) {
    ctx.onProgress(`Lade referenziertes Objekt ${ref.id}…`);
    try {
      sections.push(ref.type === 'P'
        ? await loadDocumentSection(ref.id, ctx)
        : await loadAkteSection(ref.id, ctx));
    } catch (err) {
      sections.push(`=== ${ref.type === 'P' ? 'Dokument' : 'Akte'} [${ref.id}] ===\nKonnte nicht geladen werden: ${err.message}`);
    }
  }
  if (allRefs.length > MAX_REFS) {
    sections.push(`Hinweis: ${allRefs.length - MAX_REFS} weitere Referenz(en) wurden ignoriert (max. ${MAX_REFS} pro Nachricht): ${allRefs.slice(MAX_REFS).map(r => r.id).join(', ')}.`);
  }

  const block = `Vom Nutzer explizit referenzierte Objekte (#-Syntax). Die Inhalte sind bereits vollständig geladen — rufe sie NICHT erneut per Tool ab:\n\n${sections.join('\n\n')}`;
  return { block, refs };
}
