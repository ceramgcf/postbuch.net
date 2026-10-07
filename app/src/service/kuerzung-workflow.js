/**
 * service/kuerzung-workflow.js — Gesehen-Status und PKV-Prüfvormerkung für
 * Beihilfe-Kürzungen, plus die "Zuordnung offen"-Bestätigung für
 * Erstattungsbescheid-Einzelpositionen.
 *
 * Bündelt zentrale Validierung, Row Locks, fachliche Fehlercodes (siehe
 * internaldocs/FEATURE_KUERZUNGEN_GESEHEN_PKV_PRUEFUNG_PLAN.md, Abschnitt 6.2)
 * und UI-Log, damit Kürzungsseite, Beihilfebescheid und Periodenseite exakt
 * dieselben Regeln verwenden.
 *
 * Die fachliche Kernvalidierung der Vormerkung (Beihilfe/Tier/PKV/Periode)
 * lebt bewusst im DB-Trigger fn_bkpp_validate (base_schema.sql) und nicht
 * hier zusätzlich dupliziert — der Service übersetzt die dortigen Codes nur
 * in HTTP-Fehler.
 */

import pool from '../db.js';
import { uiLog } from '../log.js';
import { sperrePerioden } from './perioden-sperre.js';

const FACHCODES = new Set([
  'KEINE_OFFENE_PKV_PERIODE',
  'NICHT_BEIHILFE_KUERZUNG',
  'PERSON_FEHLT_ODER_UNGUELTIG',
  'PKV_NICHT_AKTIV',
  'BEREITS_EINGEREICHT',
  'ABRECHNUNG_SESSION_GESPERRT',
  'PERIODE_NICHT_MEHR_OFFEN',
]);

function httpError(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// Übersetzt einen von fn_bkpp_validate geworfenen Postgres-Fehler in einen
// HTTP-422-Fachfehler. Andere Fehler (z. B. echte Constraint-Verletzungen)
// laufen unverändert durch.
function mapTriggerError(err) {
  const msg = String(err && err.message || '').trim();
  if (FACHCODES.has(msg)) return httpError(msg, 422);
  return err;
}

async function assertKeineAktiveSession(db, person, periode) {
  const r = await db.query(
    `SELECT 1 FROM _abrechnung_session_ziel
      WHERE person = $1 AND kostentraeger = 'PKV' AND periode = $2 AND aktiv`,
    [person, periode]
  );
  if (r.rows.length > 0) throw httpError('ABRECHNUNG_SESSION_GESPERRT', 422);
}

/**
 * Setzt oder löst den instanzweiten Gesehen-Status einer Kürzung. Reine
 * Arbeitserleichterung — hat keine Sperrwirkung auf Reprocess oder Löschen.
 */
export async function setGesehen(ebPostid, ebSubid, kuerzungId, gesehen, akteur) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await client.query(
      `UPDATE erstattungsbescheid_kuerzung
          SET gesehen_am = CASE WHEN $4 THEN COALESCE(gesehen_am, now()) ELSE NULL END,
              gesehen_von = CASE WHEN $4 THEN COALESCE(gesehen_von, $5) ELSE NULL END
        WHERE postid = $1 AND eb_subid = $2 AND kuerzung_id = $3
        RETURNING gesehen_am, gesehen_von`,
      [ebPostid, ebSubid, kuerzungId, !!gesehen, akteur || null]
    );
    if (res.rows.length === 0) throw httpError('Kürzung nicht gefunden', 404);
    await client.query('COMMIT');
    uiLog('UPDATE', 'erstattungsbescheid', ebPostid,
      `Kürzung ${kuerzungId} (EBP ${ebSubid}) als ${gesehen ? 'gesehen' : 'ungesehen'} markiert`);
    return res.rows[0];
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Merkt eine einzelne Beihilfe-Kürzung für die aktuell offene PKV-Periode
 * der betroffenen Person zur Prüfung nach dem Beihilfeergänzungstarif vor.
 * Idempotent: eine bereits vorgemerkte Kürzung bleibt unverändert vorgemerkt.
 */
export async function vormerkenFuerAktuellePkvPeriode(ebPostid, ebSubid, kuerzungId, akteur, erlaeuterung = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Periodensperre vor jeder Zeilensperre (service/perioden-sperre.js):
    // eine gleichzeitige Einreichung oder ein PKV-Bescheidabschluss bucht
    // Vormerkungen derselben Person um.
    const vorab = await client.query(
      `SELECT ep.behandelte_person AS person
         FROM erstattungsbescheid_kuerzung k
         JOIN erstattungsbescheid_einzelposition ep ON ep.postid = k.postid AND ep.subid = k.eb_subid
        WHERE k.postid = $1 AND k.eb_subid = $2 AND k.kuerzung_id = $3`,
      [ebPostid, ebSubid, kuerzungId]
    );
    await sperrePerioden(client, vorab.rows.map(({ person }) => ({ person, kostentraeger: 'PKV' })));

    const kRes = await client.query(
      `SELECT ep.behandelte_person AS person
         FROM erstattungsbescheid_kuerzung k
         JOIN erstattungsbescheid_einzelposition ep ON ep.postid = k.postid AND ep.subid = k.eb_subid
        WHERE k.postid = $1 AND k.eb_subid = $2 AND k.kuerzung_id = $3
        FOR UPDATE OF k`,
      [ebPostid, ebSubid, kuerzungId]
    );
    if (kRes.rows.length === 0) throw httpError('Kürzung nicht gefunden', 404);
    const person = kRes.rows[0].person;
    if (!person) throw httpError('PERSON_FEHLT_ODER_UNGUELTIG', 422);

    const bestehend = await client.query(
      `SELECT status, periode FROM beihilfe_kuerzung_pkv_pruefung
        WHERE eb_postid = $1 AND eb_subid = $2 AND kuerzung_id = $3
        FOR UPDATE`,
      [ebPostid, ebSubid, kuerzungId]
    );
    if (bestehend.rows.length > 0) {
      if (bestehend.rows[0].status === 'EINGEREICHT') throw httpError('BEREITS_EINGEREICHT', 422);
      await client.query('COMMIT');
      return { status: bestehend.rows[0].status, periode: bestehend.rows[0].periode };
    }

    const periodeRes = await client.query(
      `SELECT periode FROM abrechnungsperiode_buch
        WHERE person = $1 AND kostentraeger = 'PKV' AND status = 'COLLECTING'
        ORDER BY periode DESC LIMIT 1
        FOR UPDATE`,
      [person]
    );
    if (periodeRes.rows.length === 0) throw httpError('KEINE_OFFENE_PKV_PERIODE', 422);
    const periode = periodeRes.rows[0].periode;

    await assertKeineAktiveSession(client, person, periode);

    let ins;
    try {
      ins = await client.query(
        `INSERT INTO beihilfe_kuerzung_pkv_pruefung
           (eb_postid, eb_subid, kuerzung_id, person, kostentraeger, periode, vorgemerkt_von, erlaeuterung)
         VALUES ($1, $2, $3, $4, 'PKV', $5, $6, $7)
         RETURNING status, periode`,
        [ebPostid, ebSubid, kuerzungId, person, periode, akteur || null, erlaeuterung || null]
      );
    } catch (err) {
      throw mapTriggerError(err);
    }

    await client.query('COMMIT');
    uiLog('CREATE', 'erstattungsbescheid', ebPostid,
      `Kürzung ${kuerzungId} (EBP ${ebSubid}) für PKV-Prüfung Periode ${periode} vorgemerkt`);
    return ins.rows[0];
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Setzt, ändert oder entfernt (erlaeuterung = null) die optionale Erläuterung
 * einer bestehenden Vormerkung. Wie jede Änderung an der Zeile durch
 * tg_block_bkpp_write_during_session gesperrt, solange eine Abrechnungssession
 * für diese Periode läuft.
 */
export async function setErlaeuterung(ebPostid, ebSubid, kuerzungId, erlaeuterung) {
  const res = await pool.query(
    `UPDATE beihilfe_kuerzung_pkv_pruefung
        SET erlaeuterung = $4
      WHERE eb_postid = $1 AND eb_subid = $2 AND kuerzung_id = $3
      RETURNING erlaeuterung`,
    [ebPostid, ebSubid, kuerzungId, erlaeuterung || null]
  );
  if (res.rows.length === 0) throw httpError('Vormerkung nicht gefunden', 404);
  return res.rows[0];
}

/**
 * Zieht eine noch nicht eingereichte PKV-Prüfvormerkung zurück. Eine bereits
 * eingereichte Vormerkung kann hierüber nicht entfernt werden — dafür ist die
 * Abrechnungssession zuständig.
 */
export async function entferneVormerkung(ebPostid, ebSubid, kuerzungId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await client.query(
      `SELECT status FROM beihilfe_kuerzung_pkv_pruefung
        WHERE eb_postid = $1 AND eb_subid = $2 AND kuerzung_id = $3
        FOR UPDATE`,
      [ebPostid, ebSubid, kuerzungId]
    );
    if (res.rows.length === 0) throw httpError('Vormerkung nicht gefunden', 404);
    if (res.rows[0].status === 'EINGEREICHT') throw httpError('BEREITS_EINGEREICHT', 422);

    await client.query(
      `DELETE FROM beihilfe_kuerzung_pkv_pruefung
        WHERE eb_postid = $1 AND eb_subid = $2 AND kuerzung_id = $3`,
      [ebPostid, ebSubid, kuerzungId]
    );
    await client.query('COMMIT');
    uiLog('DELETE', 'erstattungsbescheid', ebPostid,
      `PKV-Prüfvormerkung für Kürzung ${kuerzungId} (EBP ${ebSubid}) zurückgezogen`);
    return { entfernt: true };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Bestätigt oder widerruft, dass eine Erstattungsbescheid-Position
 * absichtlich ohne Rechnungsbezug bleibt (Gegenstück zur manuellen
 * Rechnungszuordnung in setEbpZuordnung).
 */
export async function setOhneRechnungsbezug(ebPostid, ebSubid, bestaetigt, akteur) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const epRes = await client.query(
      `SELECT arz_postid FROM erstattungsbescheid_einzelposition
        WHERE postid = $1 AND subid = $2 FOR UPDATE`,
      [ebPostid, ebSubid]
    );
    if (epRes.rows.length === 0) throw httpError('Erstattungsbescheid-Position nicht gefunden', 404);
    if (bestaetigt && epRes.rows[0].arz_postid) {
      throw httpError('Position ist bereits einer Rechnung zugeordnet', 400);
    }

    const res = await client.query(
      `UPDATE erstattungsbescheid_einzelposition
          SET ohne_rechnungsbezug_bestaetigt_am = CASE WHEN $3 THEN now() ELSE NULL END,
              ohne_rechnungsbezug_bestaetigt_von = CASE WHEN $3 THEN $4 ELSE NULL END
        WHERE postid = $1 AND subid = $2
        RETURNING ohne_rechnungsbezug_bestaetigt_am, ohne_rechnungsbezug_bestaetigt_von`,
      [ebPostid, ebSubid, !!bestaetigt, akteur || null]
    );
    await client.query('COMMIT');
    uiLog('UPDATE', 'erstattungsbescheid', ebPostid,
      `EBP ${ebSubid}: ohne Rechnungsbezug ${bestaetigt ? 'bestätigt' : 'zurückgenommen'}`);
    return res.rows[0];
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
