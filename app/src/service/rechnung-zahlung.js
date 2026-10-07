/**
 * service/rechnung-zahlung.js – Zahlungen zu Rechnungen
 *
 * Jede Zahlung auf eine Arzt-, Handwerker- oder generische Rechnung steht mit
 * Datum und Betrag in postbuch.rechnung_zahlung, auch eine gewöhnliche
 * Vollzahlung. Das ist die Quelle der Wahrheit für „was wurde gezahlt“.
 *
 * bezahlt_am an der Rechnung bleibt ein gespeicherter, hier abgeleiteter
 * Status: das Datum der Zahlung, mit der die kumulierte Summe den zu zahlenden
 * Betrag (Rechnungsbetrag − bestrittener Betrag) erreicht, sonst NULL. So
 * bleiben alle Filter auf „bezahlt_am IS NULL“ korrekt, und ein späterer
 * Wegfall des Bestritts macht aus einer Vollzahlung automatisch eine
 * Teilzahlung mit offenem Rest.
 *
 * Jede Nutzeraktion setzt bezahlt_am_manuell = true; damit überstehen die
 * Zahlungen eine Wiederverarbeitung (document-processor.js).
 *
 * Kollaps nur in der Anzeige: Eine einzelne Zahlung in Höhe des zu zahlenden
 * Betrags wird als schlichtes „Bezahlt am“ dargestellt (anzeige = 'voll').
 *
 * Beträge werden in ganzen Cent gerechnet, nie mit Gleitkomma verglichen.
 */

import { getClient } from '../db.js';

export const RECHNUNGSTABELLEN = ['arztrechnung', 'handwerkerrechnung', 'generische_rechnung'];

const MAX_ZAHLUNGEN = 100;
const MAX_CENT = 999_999_999_999; // numeric(12,2)

export class ZahlungFehler extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** numeric-String/Zahl → ganze Cent, null bei fehlendem Wert. */
export function zuCent(wert) {
  if (wert === null || wert === undefined || wert === '') return null;
  const n = Number(wert);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

const ausCent = (cent) => (cent === null ? null : (cent / 100).toFixed(2));

function formatEuro(cent) {
  return `${(cent / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}

/**
 * Lädt die Rechnungszeile einer PostID aus der zuständigen Detailtabelle.
 * @returns {Promise<null|{tabelle:string, postid:string, gesamtbetrag:string|null,
 *   bestritten_betrag:string|null, bezahlt_am:string|null, bezahlt_am_manuell:boolean}>}
 */
export async function ladeRechnung(db, postid, { sperren = false } = {}) {
  for (const tabelle of RECHNUNGSTABELLEN) {
    const { rows } = await db.query(
      `SELECT postid, gesamtbetrag, bestritten_betrag, bezahlt_am, bezahlt_am_manuell
         FROM postbuch.${tabelle} WHERE postid = $1${sperren ? ' FOR UPDATE' : ''}`,
      [postid],
    );
    if (rows[0]) return { tabelle, ...rows[0] };
  }
  return null;
}

export async function ladeZahlungen(db, postid) {
  const { rows } = await db.query(
    `SELECT zahlung_id, datum, betrag
       FROM postbuch.rechnung_zahlung
      WHERE postid = $1
      ORDER BY datum, zahlung_id`,
    [postid],
  );
  return rows;
}

/**
 * Reine Berechnung der Zahlungslage aus Rechnung und Zahlungen.
 * anzeige: 'ohne' = keine Zahlung erfasst, 'voll' = genau eine Zahlung in
 * Höhe des zu zahlenden Betrags (wie gewöhnliche Vollzahlung darstellen),
 * 'teil' = Zahlungstabelle zeigen.
 */
export function berechneLage(rechnung, zahlungen) {
  const gesamt = zuCent(rechnung?.gesamtbetrag);
  const bestritten = zuCent(rechnung?.bestritten_betrag) || 0;
  const zuZahlen = gesamt === null ? null : Math.max(gesamt - bestritten, 0);

  let gezahlt = 0;
  let ausgleichDatum = null;
  for (const z of zahlungen) {
    gezahlt += zuCent(z.betrag);
    if (ausgleichDatum === null && zuZahlen !== null && gezahlt >= zuZahlen) ausgleichDatum = z.datum;
  }

  const rest = zuZahlen === null ? null : zuZahlen - gezahlt;
  let anzeige = 'teil';
  if (zahlungen.length === 0) anzeige = 'ohne';
  else if (zahlungen.length === 1 && zuZahlen !== null && gezahlt === zuZahlen) anzeige = 'voll';

  return {
    anzeige,
    zahlungen: zahlungen.map((z) => ({
      zahlung_id: Number(z.zahlung_id),
      datum: z.datum,
      betrag: ausCent(zuCent(z.betrag)),
    })),
    zu_zahlen: ausCent(zuZahlen),
    gezahlt: ausCent(gezahlt),
    offen: rest === null ? null : ausCent(Math.max(rest, 0)),
    ueberzahlt: rest !== null && rest < 0 ? ausCent(-rest) : null,
    ausgleich_datum: ausgleichDatum,
  };
}

/** Zahlungslage einer PostID für Lese-Endpunkte; null ohne Rechnungsblock. */
export async function ermittleZahlungslage(db, postid) {
  const rechnung = await ladeRechnung(db, postid);
  if (!rechnung) return null;
  const lage = berechneLage(rechnung, await ladeZahlungen(db, postid));
  return { ...lage, bezahlt_am: rechnung.bezahlt_am };
}

/**
 * Leitet bezahlt_am aus den Zahlungen ab. Ist ein positiver Betrag zu zahlen,
 * folgt der Status ausschließlich den Zahlungen: Ohne Zahlung ist die Rechnung
 * offen – etwa wenn bei einer vollständig bestrittenen, als erledigt
 * vermerkten Rechnung der Bestritt wegfällt. Ohne zu zahlenden Betrag
 * (unbekannt, 0, Gutschrift) bleibt bezahlt_am ein reiner Erledigt-Vermerk.
 */
export async function aktualisiereZahlstatus(db, postid) {
  const rechnung = await ladeRechnung(db, postid, { sperren: true });
  if (!rechnung) return null;
  const zahlungen = await ladeZahlungen(db, postid);
  const lage = berechneLage(rechnung, zahlungen);
  if (lage.zu_zahlen === null || (zahlungen.length === 0 && (zuCent(lage.zu_zahlen) <= 0 || !rechnung.bezahlt_am))) {
    return { ...lage, bezahlt_am: rechnung.bezahlt_am };
  }
  await db.query(
    `UPDATE postbuch.${rechnung.tabelle}
        SET bezahlt_am = $1::date, bezahlt_am_manuell = true
      WHERE postid = $2`,
    [lage.ausgleich_datum, postid],
  );
  return { ...lage, bezahlt_am: lage.ausgleich_datum };
}

/**
 * Legt für eine von der KI als bezahlt erkannte Rechnung die Zahlung über den
 * zu zahlenden Betrag an, sofern noch keine erfasst ist. Dieselbe Regel wie
 * der Bestandsabgleich am Ende von base_schema.sql.
 */
export async function ergaenzeErkannteZahlung(db, postid) {
  await db.query(
    `INSERT INTO postbuch.rechnung_zahlung (postid, datum, betrag)
     SELECT r.postid, r.bezahlt_am, r.gesamtbetrag - COALESCE(r.bestritten_betrag, 0)
       FROM (
             SELECT postid, bezahlt_am, gesamtbetrag, bestritten_betrag FROM postbuch.arztrechnung WHERE postid = $1
             UNION ALL
             SELECT postid, bezahlt_am, gesamtbetrag, bestritten_betrag FROM postbuch.handwerkerrechnung WHERE postid = $1
             UNION ALL
             SELECT postid, bezahlt_am, gesamtbetrag, bestritten_betrag FROM postbuch.generische_rechnung WHERE postid = $1
            ) r
      WHERE r.bezahlt_am IS NOT NULL
        AND r.gesamtbetrag IS NOT NULL
        AND r.gesamtbetrag - COALESCE(r.bestritten_betrag, 0) > 0
        AND NOT EXISTS (SELECT 1 FROM postbuch.rechnung_zahlung z WHERE z.postid = r.postid)
        AND NOT EXISTS (SELECT 1 FROM postbuch.dokument_beziehung db
                         WHERE db.zu_postid = r.postid AND db.art = 'ersetzt')`,
    [postid],
  );
}

/**
 * Nach einer Änderung des Rechnungsbetrags: Zahlstatus neu ableiten. Wurde
 * bei einer bezahlten Rechnung ohne Zahlung erstmals ein zu zahlender Betrag
 * erfasst, entsteht die Zahlung über diesen Betrag.
 */
export async function gleicheZahlungenAn(db, postid) {
  const rechnung = await ladeRechnung(db, postid, { sperren: true });
  if (!rechnung) return;
  const zahlungen = await ladeZahlungen(db, postid);
  if (zahlungen.length === 0) {
    await ergaenzeErkannteZahlung(db, postid);
    return;
  }
  if (zuCent(rechnung.gesamtbetrag) === null) {
    throw new ZahlungFehler(409, 'Für diese Rechnung sind Zahlungen erfasst – der Rechnungsbetrag kann nicht entfernt werden.');
  }
  await aktualisiereZahlstatus(db, postid);
}

function pruefeEingabe(tranchen) {
  if (!Array.isArray(tranchen)) throw new ZahlungFehler(400, 'Zahlungen fehlen.');
  if (tranchen.length > MAX_ZAHLUNGEN) throw new ZahlungFehler(400, `Höchstens ${MAX_ZAHLUNGEN} Zahlungen je Rechnung.`);
  return tranchen.map((t) => {
    const datum = typeof t?.datum === 'string' ? t.datum : '';
    const d = new Date(`${datum}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(datum) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== datum) {
      throw new ZahlungFehler(400, 'Jede Zahlung braucht ein gültiges Datum.');
    }
    const roh = typeof t?.betrag === 'number' ? t.betrag : Number(String(t?.betrag ?? '').replace(',', '.'));
    const cent = Math.round(roh * 100);
    if (!Number.isFinite(roh) || cent <= 0 || cent > MAX_CENT || Math.abs(roh * 100 - cent) > 1e-6) {
      throw new ZahlungFehler(400, 'Jeder Betrag muss größer als 0 sein und darf höchstens zwei Nachkommastellen haben.');
    }
    return { datum, cent };
  });
}

/** Auf einer ersetzten Rechnung wird nichts mehr gezahlt (service/rechnung-ersetzung.js). */
export async function pruefeNichtErsetzt(db, postid) {
  const { rows } = await db.query(
    `SELECT von_postid FROM postbuch.dokument_beziehung WHERE art = 'ersetzt' AND zu_postid = $1`,
    [postid],
  );
  if (rows[0]) {
    throw new ZahlungFehler(409,
      `Diese Rechnung ist durch ${rows[0].von_postid} ersetzt – Zahlungen und Streitfall werden auf der Korrekturrechnung geführt.`);
  }
}

/**
 * Ersetzt alle Zahlungen einer Rechnung (Teilzahlungstabelle). Eine leere
 * Liste macht die Rechnung wieder offen.
 */
export async function ersetzeZahlungen(db, postid, tranchen) {
  const neu = pruefeEingabe(tranchen);
  const rechnung = await ladeRechnung(db, postid, { sperren: true });
  if (!rechnung) throw new ZahlungFehler(404, 'Keine Rechnung für diese PostID gefunden.');
  await pruefeNichtErsetzt(db, postid);
  const alt = berechneLage(rechnung, await ladeZahlungen(db, postid));
  if (alt.zu_zahlen === null && neu.length > 0) {
    throw new ZahlungFehler(400, 'Ohne Rechnungsbetrag lassen sich keine Zahlungen erfassen.');
  }

  // Eine Überzahlung, die erst durch einen nachträglichen Bestritt entstanden
  // ist, darf stehen bleiben; neu erfassen lässt sie sich nicht.
  const summeNeu = neu.reduce((s, t) => s + t.cent, 0);
  const zuZahlen = zuCent(alt.zu_zahlen) ?? 0;
  if (summeNeu > zuZahlen && summeNeu > zuCent(alt.gezahlt)) {
    throw new ZahlungFehler(400, `Die Zahlungen übersteigen den zu zahlenden Betrag von ${formatEuro(zuZahlen)}.`);
  }

  await db.query('DELETE FROM postbuch.rechnung_zahlung WHERE postid = $1', [postid]);
  neu.sort((a, b) => a.datum.localeCompare(b.datum));
  for (const t of neu) {
    await db.query(
      'INSERT INTO postbuch.rechnung_zahlung (postid, datum, betrag) VALUES ($1, $2::date, $3::numeric)',
      [postid, t.datum, ausCent(t.cent)],
    );
  }

  if (neu.length === 0) {
    await db.query(
      `UPDATE postbuch.${rechnung.tabelle} SET bezahlt_am = NULL, bezahlt_am_manuell = true WHERE postid = $1`,
      [postid],
    );
  }
  await aktualisiereZahlstatus(db, postid);
  return ermittleZahlungslage(db, postid);
}

/**
 * „Bezahlt am“ im Normalmodus setzen oder entfernen.
 * - Datum bei Rechnung ohne Zahlung: Zahlung über den offenen Betrag anlegen.
 * - Datum bei einzelner Vollzahlung: deren Datum ändern.
 * - Datum bei Teilzahlungen mit Rest: Restzahlung anlegen.
 * - null: einzelne Vollzahlung entfernen; bei Teilzahlungen 409.
 */
export async function setzeBezahltAm(db, postid, datum) {
  const rechnung = await ladeRechnung(db, postid, { sperren: true });
  if (!rechnung) return null;
  await pruefeNichtErsetzt(db, postid);
  const zahlungen = await ladeZahlungen(db, postid);
  const lage = berechneLage(rechnung, zahlungen);
  const setzeStatus = (wert) => db.query(
    `UPDATE postbuch.${rechnung.tabelle} SET bezahlt_am = $1::date, bezahlt_am_manuell = true WHERE postid = $2`,
    [wert, postid],
  );

  if (datum === null) {
    if (lage.anzeige === 'teil') {
      throw new ZahlungFehler(409, 'Für diese Rechnung sind Teilzahlungen erfasst – bitte in der Zahlungstabelle bearbeiten.');
    }
    await db.query('DELETE FROM postbuch.rechnung_zahlung WHERE postid = $1', [postid]);
    await setzeStatus(null);
  } else if (lage.anzeige === 'voll') {
    await db.query('UPDATE postbuch.rechnung_zahlung SET datum = $1::date WHERE zahlung_id = $2', [datum, zahlungen[0].zahlung_id]);
    await setzeStatus(datum);
  } else if (lage.anzeige === 'ohne') {
    const offen = zuCent(lage.offen);
    if (offen) {
      await db.query(
        'INSERT INTO postbuch.rechnung_zahlung (postid, datum, betrag) VALUES ($1, $2::date, $3::numeric)',
        [postid, datum, ausCent(offen)],
      );
    }
    await setzeStatus(datum);
  } else {
    const offen = zuCent(lage.offen);
    if (!offen) {
      throw new ZahlungFehler(409, 'Die Rechnung ist bereits vollständig bezahlt – Zahldaten bitte in der Zahlungstabelle ändern.');
    }
    await db.query(
      'INSERT INTO postbuch.rechnung_zahlung (postid, datum, betrag) VALUES ($1, $2::date, $3::numeric)',
      [postid, datum, ausCent(offen)],
    );
  }
  await aktualisiereZahlstatus(db, postid);
  return ermittleZahlungslage(db, postid);
}

/** Führt fn(client) in einer eigenen Transaktion aus. */
export async function inTransaktion(fn) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const ergebnis = await fn(client);
    await client.query('COMMIT');
    return ergebnis;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
