/**
 * service/document-inserter.js — Typ-spezifische DB-Inserts
 *
 * Ersetzt: Switch-Node + 6 typ-spezifische Postgres-Insert-Nodes in n8n.
 * Führt nach dem Postbuch-Insert den passenden Detailtabellen-Insert durch.
 *
 * Erstattungsbescheid: wird asynchron nach dem Pipeline-Abschluss verarbeitet
 * über service/erstattungsbescheid.js.
 */

import pool from '../db.js';
import { processErstattungsbescheid } from './erstattungsbescheid.js';
import { appLog } from '../app-log.js';
import { toDate, toNumeric, toStr } from '../lib/coerce.js';
import { effektiveGruppe } from '../lib/taxonomie.js';
import * as tracker from '../jobs/tracker.js';

const laufendeErstattungsbescheide = new Map();

// ── Arztrechnung + Einzelpositionen ──────────────────────────────────────────

async function insertArztrechnung(postid, data, client) {
  const ar = data.arztrechnung || {};
  const pb = data.postbuch || {};

  // Einreichungsseiten: von der KI gesetzt und bereits durch extract-validator.js
  // (SEITE) als einzelne Ganzzahlen formatgeprüft — hier nur noch die
  // Kombination der beiden Felder plausibilisieren. Eine einzelne gesetzte
  // Seite gilt als Einzelseite (von=bis); eine unplausible Kombination
  // (bis < von) wird sicherheitshalber verworfen statt geraten.
  const nVon = toNumeric(ar.einreichungSeiteVon);
  const nBis = toNumeric(ar.einreichungSeiteBis);
  let einreichungVon = Number.isInteger(nVon) ? nVon : null;
  let einreichungBis = Number.isInteger(nBis) ? nBis : null;
  if (einreichungVon != null && einreichungBis == null) einreichungBis = einreichungVon;
  if (einreichungBis != null && einreichungVon == null) einreichungVon = einreichungBis;
  if (einreichungVon != null && einreichungBis != null && (einreichungVon < 1 || einreichungBis < einreichungVon)) {
    appLog('WARN', 'document-inserter',
      `Einreichungsseiten ${einreichungVon}-${einreichungBis} für ${postid} unplausibel, verwerfe (ganzes Dokument bleibt Fallback).`,
      { entity: 'postbuch', entityId: postid });
    einreichungVon = null;
    einreichungBis = null;
  }

  await client.query(
    `INSERT INTO arztrechnung
       (postid, typ, re_nr, rechnungsdatum, faelligkeit, bezahlt_am,
        name_arzt, behandelte_person, leistung, gesamtbetrag,
        iban, verwendungszweck, kontoinhaber,
        einreichung_seite_von, einreichung_seite_bis)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      postid,
      data.dokumentart,
      toStr(ar.reNr),
      toDate(ar.rechnungsdatum),
      toDate(ar.zahlungstermin),                     // faelligkeit ← zahlungstermin
      toDate(pb.bezahlStatus?.bezahltAm),
      toStr(ar.nameArzt),
      toStr(ar.behandeltePerson),
      toStr(ar.leistung),
      toNumeric(ar.gesamtbetrag),
      toStr(ar.iban),
      toStr(ar.verwendungszweck),
      toStr(ar.kontoinhaber),
      einreichungVon,
      einreichungBis,
    ]
  );

  // Einzelpositionen
  const positionen = ar.einzelpositionen || [];
  for (let i = 0; i < positionen.length; i++) {
    const ep = positionen[i];
    await client.query(
      `INSERT INTO arztrechnung_einzelposition
         (postid, subid, behandlungs_datum, goa_goz_gebueh_pzn,
          leistung, begruendung, faktor, betrag)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        postid,
        i + 1,
        toDate(ep.behandlungsDatum || ep.Datum),
        toStr(ep.ziffer || ep.gotZiffer || ep.goäZiffer || ep.goaZiffer || ep.pzn),
        toStr(ep.leistung),
        toStr(ep.begründung || ep.begruendung),
        // Medikamente/Material haben oft weder GOT/PZN noch Faktor. NULL erhält
        // diese Information; nur ein ausdrücklich vorhandener Wert wird gespeichert.
        toNumeric(ep.faktor),
        toNumeric(ep.betrag),
      ]
    );
  }
}

// ── Handwerkerrechnung ───────────────────────────────────────────────────────

async function insertHandwerkerrechnung(postid, data, client) {
  const hw = data.handwerkerrechnung || {};
  const pb = data.postbuch || {};

  await client.query(
    `INSERT INTO handwerkerrechnung
       (postid, re_nr, rechnungsdatum, leistungsdatum, leistungsjahr, faelligkeit, bezahlt_am,
        name_unternehmen, leistung, gesamtbetrag, lohnkosten,
        iban, verwendungszweck)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      postid,
      toStr(hw.reNr),
      toDate(hw.rechnungsdatum),
      toStr(hw.leistungsdatum),
      toNumeric(hw.leistungsjahr),
      toDate(hw.zahlungstermin),                     // faelligkeit ← zahlungstermin
      toDate(pb.bezahlStatus?.bezahltAm),
      toStr(hw.nameUnternehmen),
      toStr(hw.leistung),
      toNumeric(hw.gesamtbetrag),
      toNumeric(hw.lohnkosten),
      toStr(hw.iban),
      toStr(hw.verwendungszweck),
    ]
  );
}

// ── Generische Rechnung ──────────────────────────────────────────────────────

async function insertGenerischeRechnung(postid, data, client) {
  const gr = data.generischeRechnung || {};

  await client.query(
    `INSERT INTO generische_rechnung
       (postid, re_nr, rechnungsdatum, faelligkeit, gesamtbetrag,
        absender, bezahlt_am, iban, verwendungszweck, kontoinhaber)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      postid,
      toStr(gr.reNr),
      toDate(gr.rechnungsdatum),
      toDate(gr.faelligkeit || gr.zahlungstermin),   // faelligkeit || zahlungstermin
      toNumeric(gr.gesamtbetrag),
      toStr(gr.absender),
      toDate(gr.bezahltAm),
      toStr(gr.iban),
      toStr(gr.verwendungszweck),
      toStr(gr.kontoinhaber),
    ]
  );
}

// ── Arztbericht ──────────────────────────────────────────────────────────────

async function insertArztbericht(postid, data, client) {
  const ab = data.arztbericht || {};

  await client.query(
    `INSERT INTO arztbericht
       (postid, behandelte_person, anlass, norm_befunde, pathologische_befunde)
     VALUES ($1,$2,$3,$4,$5)`,
    [
      postid,
      toStr(ab.behandeltePerson),
      toStr(ab.anlass),
      toStr(ab.normBefunde),
      toStr(ab.pathologischeBefunde),
    ]
  );
}

// ── Hauptfunktion ────────────────────────────────────────────────────────────

/**
 * Führt den typ-spezifischen Detail-Insert durch.
 * MUSS innerhalb derselben Transaktion wie der Postbuch-Insert aufgerufen werden,
 * oder mit einem eigenen Client, der die Transaktion verwaltet.
 *
 * @param {string}   postid        - PostID (P000000)
 * @param {object}   extractedData - LLM-Ergebnis
 * @param {object}   [client]      - Optional: pg Client für Transaktionen. Falls nicht übergeben, wird pool verwendet.
 */
export async function insert(postid, extractedData, client, korrekturAnweisung = '', options = {}) {
  const c = client || pool;
  if (!extractedData.lebensbereich || !extractedData.dokumentart) {
    throw new Error(`L×D-Einordnung fehlt für ${postid}`);
  }

  const gruppe = await effektiveGruppe(extractedData.lebensbereich, extractedData.dokumentart);
  if (gruppe === 'arztrechnung') return insertArztrechnung(postid, extractedData, c);
  if (gruppe === 'erstattungsbescheid') {
    if (options.deferErstattungsbescheid) {
      return { erstattungsbescheidAusstehend: true };
    }
    starteErstattungsbescheidVerarbeitung(postid, korrekturAnweisung).catch(() => {});
    return { erstattungsbescheidAusstehend: true };
  }
  if (gruppe === 'handwerker') return insertHandwerkerrechnung(postid, extractedData, c);
  if (gruppe === 'arztbericht') return insertArztbericht(postid, extractedData, c);
  if (extractedData.istRechnung) return insertGenerischeRechnung(postid, extractedData, c);
}

/** Startet den bewusst separaten Fachjob erst nach einem ggf. offenen DB-Commit. */
export function starteErstattungsbescheidVerarbeitung(postid, korrekturAnweisung = '') {
    if (laufendeErstattungsbescheide.has(postid)) {
      return laufendeErstattungsbescheide.get(postid);
    }
    // Läuft bewusst nicht im Haupt-Pipeline-Job mit (der ist zu diesem Zeitpunkt
    // bereits "fertig" gemeldet) — sondern als eigener, im Job-Log sichtbarer
    // Hintergrundjob, damit ein Nutzer der auf ein frisch "fertiges" EB-Dokument
    // klickt sieht, dass der Matching-Fachblock noch aussteht statt einfach zu fehlen.
    const jobId = tracker.create('eb-matching', `Erstattungsbescheid-Abgleich ${postid}`, 0, false);
    const lauf = processErstattungsbescheid(postid, korrekturAnweisung).then((result) => {
      tracker.complete(jobId, { postid, betreff: result?.matchingSummary || null });
      return result;
    }).catch(err => {
      console.error(`[document-inserter] EB-Verarbeitung fehlgeschlagen für ${postid}: ${err.message}`);
      appLog('ERROR', 'document-inserter', `EB-Verarbeitung fehlgeschlagen für ${postid}: ${err.message}`, { entity: 'postbuch', entityId: postid });
      tracker.fail(jobId, err.message);
      throw err;
    }).finally(() => {
      laufendeErstattungsbescheide.delete(postid);
    });
    laufendeErstattungsbescheide.set(postid, lauf);
    return lauf;
}
