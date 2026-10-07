/**
 * service/dokument-pin.js — "Dokument anpinnen": ein beliebiges Dokument als
 * informelle Zusatzanlage an eine PKV- und/oder Beihilfe-Abrechnungsperiode
 * hängen (z. B. ein Kostenvoranschlag, den der Kostenträger zur Kenntnis
 * bekommen soll, ohne dass er Teil der eigentlichen Einreichung ist).
 *
 * Bewusst schlank gehalten, analog zu kuerzung-workflow.js, aber ohne eigene
 * DB-Validierungs-/Sperr-Trigger: die Prüfung (offene COLLECTING-Periode,
 * Pflichtfeld Grund) läuft hier im Service, das FK/CHECK-Set in base_schema.sql
 * sichert nur die harten Invarianten ab.
 */

import pool from '../db.js';
import { uiLog } from '../log.js';
import { sperrePerioden } from './perioden-sperre.js';

function httpError(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/**
 * Pinnt ein Dokument an die aktuell offene Periode einer Person/eines
 * Kostenträgers. Idempotent bei gleichem Grund; ein erneuter Aufruf mit
 * anderem Grund aktualisiert die noch nicht eingereichte Vormerkung.
 */
export async function pinDokument(postid, { person, kostentraeger, grund, akteur }) {
  const g = (grund || '').trim();
  if (!g) throw httpError('Grund ist erforderlich', 400);
  if (!['PKV', 'Beihilfe'].includes(kostentraeger)) throw httpError('Ungültiger Kostenträger', 400);
  if (!person) throw httpError('Person fehlt', 400);

  // Prüfen und Schreiben unter der Periodensperre der Person: Ohne sie
  // könnte eine gleichzeitige Einreichung die gelesene Periode schließen,
  // und die Anpinnung bliebe in einer eingereichten Periode liegen, ohne je
  // im Paket gestanden zu haben (service/perioden-sperre.js).
  const client = await pool.connect();
  let periode;
  try {
    await client.query('BEGIN');
    await sperrePerioden(client, [{ person, kostentraeger }]);

    const docRes = await client.query(`SELECT 1 FROM postbuch WHERE postid = $1`, [postid]);
    if (docRes.rows.length === 0) throw httpError('Dokument nicht gefunden', 404);

    const periodeRes = await client.query(
      `SELECT periode FROM abrechnungsperiode_buch
        WHERE person = $1 AND kostentraeger = $2 AND status = 'COLLECTING'
        ORDER BY periode DESC LIMIT 1`,
      [person, kostentraeger]
    );
    if (periodeRes.rows.length === 0) throw httpError('KEINE_OFFENE_PERIODE', 422);
    periode = periodeRes.rows[0].periode;

    const bestehend = await client.query(
      `SELECT status FROM dokument_pin WHERE postid = $1 AND person = $2 AND kostentraeger = $3
          FOR UPDATE`,
      [postid, person, kostentraeger]
    );
    if (bestehend.rows.length > 0) {
      if (bestehend.rows[0].status === 'EINGEREICHT') throw httpError('BEREITS_EINGEREICHT', 422);
      await client.query(
        `UPDATE dokument_pin SET grund = $4, periode = $5
          WHERE postid = $1 AND person = $2 AND kostentraeger = $3`,
        [postid, person, kostentraeger, g, periode]
      );
    } else {
      await client.query(
        `INSERT INTO dokument_pin (postid, person, kostentraeger, periode, grund, vorgemerkt_von)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [postid, person, kostentraeger, periode, g, akteur || null]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  uiLog('CREATE', 'postbuch', postid, `Dokument an ${kostentraeger}-Periode ${periode} (${person}) angepinnt`);
  return { status: 'VORGEMERKT', periode };
}

/** Löst eine noch nicht eingereichte Anpinnung. */
export async function unpinDokument(postid, person, kostentraeger) {
  const res = await pool.query(
    `DELETE FROM dokument_pin
      WHERE postid = $1 AND person = $2 AND kostentraeger = $3 AND status = 'VORGEMERKT'
      RETURNING id`,
    [postid, person, kostentraeger]
  );
  if (res.rows.length === 0) throw httpError('Anpinnung nicht gefunden oder bereits eingereicht', 404);
  uiLog('DELETE', 'postbuch', postid, `Anpinnung an ${kostentraeger} (${person}) entfernt`);
  return { entfernt: true };
}

/** Alle Anpinnungen eines Dokuments (für die Detailansicht). */
export async function listePins(postid) {
  const r = await pool.query(
    `SELECT person, kostentraeger, periode, grund, status
       FROM dokument_pin WHERE postid = $1 ORDER BY person, kostentraeger`,
    [postid]
  );
  return r.rows;
}
