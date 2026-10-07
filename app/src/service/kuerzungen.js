/**
 * service/kuerzungen.js – Analyse → Kürzungen PKV & Beihilfe
 *
 * Eine Quelle für die Seite und den Excel-Export. Die Seite lädt alle Kürzungen
 * und filtert im Browser; der Export filtert hier mit denselben Regeln, damit
 * die Datei genau das enthält, was die Seite zeigt.
 *
 * Filterschlüssel: Person = Kurzname der behandelten Person oder `_ohne`,
 * Kostenträger = 'PKV' | 'Beihilfe', Jahr = Jahr des Bescheiddatums ('YYYY')
 * oder `ohne` für Bescheide ohne Datum, Periode = Nummer der PKV-Prüfperiode.
 */

import { query } from '../db.js';
import { neueMappe, neuesBlatt, summenZeile, fmtDatum, zahl } from '../lib/excel.js';

export const PERSON_OHNE = '_ohne';
export const JAHR_OHNE = 'ohne';

const GESEHEN_SQL = {
  offen: 'AND k.gesehen_am IS NULL',
  gesehen: 'AND k.gesehen_am IS NOT NULL',
  alle: '',
};

/** 'offen' (Standard) | 'gesehen' | 'alle' */
export function parseGesehen(wert) {
  return Object.hasOwn(GESEHEN_SQL, wert) ? wert : 'offen';
}

/** @param {'offen'|'gesehen'|'alle'} gesehen */
export async function ladeKuerzungen(gesehen = 'offen') {
  const result = await query(`
      SELECT
        k.postid AS eb_postid,
        e.kostentraeger,
        e.bescheiddatum,
        ep.subid AS eb_subid,
        ep.arz_postid,
        ep.behandelte_person,
        ep.rechnungsbetrag,
        ep.erstattungsbetrag,
        ep.ohne_rechnungsbezug_bestaetigt_am,
        (ep.arz_postid IS NULL AND ep.ohne_rechnungsbezug_bestaetigt_am IS NULL) AS zuordnung_offen,
        k.kuerzung_id,
        k.kuerzungsbetrag,
        k.gesehen_am,
        k.gesehen_von,
        bkpp.status AS pkv_pruefung_status,
        bkpp.periode AS pkv_pruefung_periode,
        bkpp.erlaeuterung AS pkv_pruefung_erlaeuterung,
        CASE
          WHEN COALESCE(
            CASE WHEN e.kostentraeger = 'PKV' THEN arz_ep.pkv_satz_override ELSE arz_ep.beihilfe_satz_override END,
            ab.satz,
            CASE WHEN e.kostentraeger = 'PKV' THEN per.pkv_satz ELSE per.beihilfe_satz END
          ) IS NOT NULL
            THEN ROUND(k.kuerzungsbetrag * COALESCE(
              CASE WHEN e.kostentraeger = 'PKV' THEN arz_ep.pkv_satz_override ELSE arz_ep.beihilfe_satz_override END,
              ab.satz,
              CASE WHEN e.kostentraeger = 'PKV' THEN per.pkv_satz ELSE per.beihilfe_satz END
            ) / 100, 2)
          ELSE k.kuerzungsbetrag
        END AS kuerzungsbetrag_effektiv,
        k.begruendung,
        k.arz_subid,
        a.name_arzt,
        a.re_nr AS arz_re_nr,
        ae.leistung AS arz_leistung,
        ae.goa_goz_gebueh_pzn AS arz_ziffer,
        ae.betrag AS arz_betrag
      FROM erstattungsbescheid_kuerzung k
      JOIN erstattungsbescheid_einzelposition ep ON ep.postid = k.postid AND ep.subid = k.eb_subid
      JOIN erstattungsbescheid e ON e.postid = k.postid
      JOIN postbuch p ON p.postid = k.postid
      LEFT JOIN arztrechnung a ON a.postid = k.arz_postid
      LEFT JOIN arztrechnung_einzelposition ae ON ae.postid = k.arz_postid AND ae.subid = k.arz_subid
      LEFT JOIN postbuch.mensch per ON per.kurzname = ep.behandelte_person
      LEFT JOIN arztrechnung arz_ep ON arz_ep.postid = ep.arz_postid
      LEFT JOIN abrechnungsperiode_buch ab ON ab.person = ep.behandelte_person
        AND ab.kostentraeger = e.kostentraeger
        AND ab.periode = CASE
          WHEN e.kostentraeger = 'PKV' THEN arz_ep.abrechnungsperiode_pkv
          ELSE arz_ep.abrechnungsperiode_beihilfe
        END
      LEFT JOIN beihilfe_kuerzung_pkv_pruefung bkpp
        ON bkpp.eb_postid = k.postid AND bkpp.eb_subid = k.eb_subid AND bkpp.kuerzung_id = k.kuerzung_id
      WHERE p.historisch = false ${GESEHEN_SQL[gesehen]}
      ORDER BY e.bescheiddatum DESC, k.postid, k.eb_subid, k.kuerzung_id
  `);
  return result.rows;
}

const jahrSchluessel = (datum) => (datum ? String(datum).slice(0, 4) : JAHR_OHNE);

/**
 * @param {object[]} zeilen  aus ladeKuerzungen
 * @param {{personen?:Set<string>|null, kostentraeger?:Set<string>|null,
 *          jahre?:Set<string>|null, periode?:string|number|null}} filter
 *   null/fehlend = kein Filter
 */
export function filtereKuerzungen(zeilen, { personen = null, kostentraeger = null, jahre = null, periode = null } = {}) {
  const periodeNr = periode == null || periode === '' ? null : Number(periode);
  return zeilen.filter((k) =>
    (!personen || personen.has(k.behandelte_person || PERSON_OHNE))
    && (!kostentraeger || kostentraeger.has(k.kostentraeger))
    && (!jahre || jahre.has(jahrSchluessel(k.bescheiddatum)))
    && (periodeNr == null || k.pkv_pruefung_periode === periodeNr));
}

const PKV_STATUS = { VORGEMERKT: 'für PKV-Prüfung vorgemerkt', EINGEREICHT: 'bei der PKV eingereicht' };

function statusText(k) {
  const teile = [k.gesehen_am ? `gesehen am ${fmtDatum(k.gesehen_am)}` : 'offen'];
  if (k.pkv_pruefung_status) {
    teile.push(`${PKV_STATUS[k.pkv_pruefung_status] || k.pkv_pruefung_status}`
      + (k.pkv_pruefung_periode != null ? ` (Periode ${k.pkv_pruefung_periode})` : ''));
  }
  if (k.zuordnung_offen) teile.push('Zuordnung offen');
  return teile.join(', ');
}

/** @param {object[]} zeilen  gefiltert, Reihenfolge wie auf der Seite */
export async function kuerzungenExcel(zeilen) {
  const wb = neueMappe();
  const detail = neuesBlatt(wb, 'Kürzungen', [
    { header: 'Bescheid', key: 'eb_postid', width: 10 },
    { header: 'Kostenträger', key: 'kostentraeger', width: 12 },
    { header: 'Bescheiddatum', key: 'bescheiddatum', width: 14 },
    { header: 'Arztrechnung', key: 'arz_postid', width: 13 },
    { header: 'Re.-Nr.', key: 're_nr', width: 16 },
    { header: 'Patient', key: 'person', width: 16 },
    { header: 'Arzt', key: 'arzt', width: 28 },
    { header: 'Leistung', key: 'leistung', width: 36 },
    { header: 'Ziffer', key: 'ziffer', width: 10 },
    { header: 'Gekürzter Betrag', key: 'gekuerzt', width: 16, euro: true },
    { header: 'Kürzungsbetrag', key: 'kuerzung', width: 15, euro: true },
    { header: 'Begründung', key: 'begruendung', width: 48 },
    { header: 'Status', key: 'status', width: 40 },
  ]);
  for (const k of zeilen) {
    detail.addRow({
      eb_postid: k.eb_postid,
      kostentraeger: k.kostentraeger || '',
      bescheiddatum: fmtDatum(k.bescheiddatum),
      arz_postid: k.arz_postid || '',
      re_nr: k.arz_re_nr || '',
      person: k.behandelte_person || '',
      arzt: k.name_arzt || '',
      leistung: k.arz_leistung || '',
      ziffer: k.arz_ziffer || '',
      gekuerzt: zahl(k.kuerzungsbetrag),
      kuerzung: zahl(k.kuerzungsbetrag_effektiv ?? k.kuerzungsbetrag),
      begruendung: k.begruendung || '',
      status: statusText(k),
    });
  }
  detail.autoFilter = { from: 'A1', to: { row: 1, column: detail.columns.length } };

  // Summen je Person und Kostenträger, in Cent gerechnet
  const summen = new Map();
  for (const k of zeilen) {
    const person = k.behandelte_person || 'Ohne Person';
    const schluessel = `${person}\u0000${k.kostentraeger || ''}`;
    const s = summen.get(schluessel) || { person, kostentraeger: k.kostentraeger || '', anzahl: 0, cent: 0 };
    s.anzahl += 1;
    s.cent += Math.round(Number(k.kuerzungsbetrag_effektiv ?? k.kuerzungsbetrag ?? 0) * 100);
    summen.set(schluessel, s);
  }
  const blatt = neuesBlatt(wb, 'Summen', [
    { header: 'Patient', key: 'person', width: 18 },
    { header: 'Kostenträger', key: 'kostentraeger', width: 12 },
    { header: 'Kürzungen', key: 'anzahl', width: 11 },
    { header: 'Kürzungsbetrag', key: 'summe', width: 15, euro: true },
  ]);
  const sortiert = [...summen.values()].sort((a, b) =>
    a.person.localeCompare(b.person, 'de') || a.kostentraeger.localeCompare(b.kostentraeger, 'de'));
  let gesamt = 0;
  for (const s of sortiert) {
    blatt.addRow({ person: s.person, kostentraeger: s.kostentraeger, anzahl: s.anzahl, summe: s.cent / 100 });
    gesamt += s.cent;
  }
  summenZeile(blatt, { person: 'Summe', anzahl: zeilen.length, summe: gesamt / 100 });
  return wb.xlsx.writeBuffer();
}
