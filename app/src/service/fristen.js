/**
 * service/fristen.js — Wiedervorlagen & Fälligkeiten (Single Source of Truth)
 *
 * Zwei reine SELECT-Funktionen, modelliert nach den erprobten Queries im
 * Reminder-Cron (jobs/reminder-job.js: fetchDueWiedervorlagen /
 * fetchUpcomingDueInvoices). Bewusst OHNE die Push-Dedup-Logik jenes Jobs —
 * die bleibt dort als Cron-spezifischer Wrapper. Diese Funktionen liefern rein
 * lesend die fachlichen Listen und dienen sowohl dem internen Chat-Agenten
 * (Tools list_wiedervorlagen / list_faelligkeiten) als auch dem MCP-Adapter.
 *
 * IDs werden mit dem Betreff (post/akte) angereichert, damit sowohl das Modell
 * als auch ein externer Client die Treffer benennen und verlinken kann.
 *
 * DATE-Spalten kommen als YYYY-MM-DD-Strings zurück (globaler Typ-Parser in
 * db.js), daher hier keine Zeitzonen-Umrechnung nötig.
 */

import { query } from '../db.js';

function todayISO() {
  return new Date().toISOString().split('T')[0];
}

/**
 * Fällige/anstehende Wiedervorlagen bis zu einem Stichtag.
 *
 * @param {object}  [opts]
 * @param {string}  [opts.bis]              - ISO-Datum (YYYY-MM-DD); Default heute.
 * @param {boolean} [opts.includeErledigt]  - erledigte WV mit einschließen (Default false).
 * @returns {Promise<Array<{wv_id, postid, akteid, faellig_am, aktion, erledigt, betreff, ref}>>}
 */
export async function listWiedervorlagen({ bis = todayISO(), includeErledigt = false } = {}) {
  const result = await query(
    `SELECT w.wv_id,
            w.postid,
            w.akteid,
            w.faellig_am,
            w.aktion,
            w.erledigt,
            COALESCE(p.betreff, a.betreff) AS betreff
       FROM postbuch.wiedervorlage w
       LEFT JOIN postbuch.postbuch p ON p.postid = w.postid
       LEFT JOIN postbuch.akte     a ON a.akteid = w.akteid
      WHERE w.faellig_am <= $1::date
        AND ($2::boolean OR w.erledigt = false)
      ORDER BY w.faellig_am ASC, w.wv_id ASC`,
    [bis, includeErledigt],
  );
  return result.rows.map((r) => ({
    wv_id: r.wv_id,
    ref: r.postid || r.akteid,   // die zugehörige Post-/AkteID (XOR)
    postid: r.postid,
    akteid: r.akteid,
    faellig_am: r.faellig_am,
    aktion: r.aktion,
    erledigt: r.erledigt,
    betreff: r.betreff || null,
  }));
}

/**
 * Offene Zahlungsfälligkeiten (Arzt- + Handwerker- + generische Rechnungen),
 * deren Fälligkeit bis zu einem Stichtag liegt.
 *
 * @param {object}  [opts]
 * @param {string}  [opts.bis]             - ISO-Datum (YYYY-MM-DD); Default heute + 30 Tage.
 * @param {boolean} [opts.includeBezahlt]  - bereits bezahlte Rechnungen mit einschließen (Default false).
 * @returns {Promise<Array<{postid, typ, faelligkeit, gesamtbetrag, bezahlt_am, betreff}>>}
 */
export async function listFaelligkeiten({ bis = null, includeBezahlt = false } = {}) {
  // Default-Stichtag: heute + 30 Tage.
  const bisDate = bis || (() => {
    const d = new Date();
    d.setDate(d.getDate() + 30);
    return d.toISOString().split('T')[0];
  })();

  const result = await query(
    `WITH cand AS (
       SELECT ar.postid, ar.faelligkeit, ar.bezahlt_am, ar.gesamtbetrag - COALESCE(ar.bestritten_betrag, 0) AS gesamtbetrag,
              p.betreff, 'arztrechnung'::text AS typ
         FROM postbuch.arztrechnung ar
         JOIN postbuch.postbuch p ON p.postid = ar.postid
        WHERE ar.gesamtbetrag IS NOT NULL AND ar.gesamtbetrag > COALESCE(ar.bestritten_betrag, 0)
          AND ar.faelligkeit IS NOT NULL AND ar.faelligkeit <= $1::date
       UNION ALL
       SELECT hr.postid, hr.faelligkeit, hr.bezahlt_am, hr.gesamtbetrag - COALESCE(hr.bestritten_betrag, 0) AS gesamtbetrag,
              p.betreff, 'handwerkerrechnung'
         FROM postbuch.handwerkerrechnung hr
         JOIN postbuch.postbuch p ON p.postid = hr.postid
        WHERE hr.gesamtbetrag IS NOT NULL AND hr.gesamtbetrag > COALESCE(hr.bestritten_betrag, 0)
          AND hr.faelligkeit IS NOT NULL AND hr.faelligkeit <= $1::date
       UNION ALL
       SELECT gr.postid, gr.faelligkeit, gr.bezahlt_am, gr.gesamtbetrag - COALESCE(gr.bestritten_betrag, 0) AS gesamtbetrag,
              p.betreff, 'rechnung'
         FROM postbuch.generische_rechnung gr
         JOIN postbuch.postbuch p ON p.postid = gr.postid
        WHERE gr.gesamtbetrag IS NOT NULL AND gr.gesamtbetrag > COALESCE(gr.bestritten_betrag, 0)
          AND gr.faelligkeit IS NOT NULL AND gr.faelligkeit <= $1::date
     )
     SELECT c.* FROM cand c
      WHERE ($2::boolean OR c.bezahlt_am IS NULL)
      ORDER BY c.faelligkeit ASC, c.postid ASC`,
    [bisDate, includeBezahlt],
  );
  return result.rows.map((r) => ({
    postid: r.postid,
    typ: r.typ,
    faelligkeit: r.faelligkeit,
    gesamtbetrag: r.gesamtbetrag,
    bezahlt_am: r.bezahlt_am,
    betreff: r.betreff || null,
  }));
}
