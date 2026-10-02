/**
 * Harter Löschschutz für Arztrechnungen mit Erstattungsbezug.
 *
 * Die API-Prüfung liefert einen verständlichen 409er und hält den Parent-/
 * Rechnungs-Lock bis nach Datei-Move und DB-DELETE. Ein DB-Trigger in
 * base_schema.sql bildet zusätzlich die nicht umgehbare letzte Schutzlinie für
 * alle internen, Import-, Recovery- und Administrationspfade.
 */
import pool from '../db.js';

export const DELETE_PROTECTED_CODE = 'ARZTRECHNUNG_HAT_ERSTATTUNGSBEZUEGE';
export const DELETE_GUARD_CONSTRAINT = 'arztrechnung_eb_delete_guard';
export const DELETE_PROTECTED_HINT = 'Bitte die Zuordnungen in den genannten Erstattungsbescheiden zuerst fachlich lösen oder die Bescheide löschen.';

export class DocumentDeleteProtectedError extends Error {
  constructor(postid, erstattungsbescheide) {
    const ids = erstattungsbescheide.join(', ');
    super(`Arztrechnung ${postid} kann nicht gelöscht werden: Erstattungsbescheid-Verknüpfung ${ids}. Bitte die Zuordnung zuerst im Erstattungsbescheid lösen.`);
    this.name = 'DocumentDeleteProtectedError';
    this.code = DELETE_PROTECTED_CODE;
    this.status = 409;
    this.statusCode = 409;
    this.postid = postid;
    this.erstattungsbescheide = erstattungsbescheide;
    this.hinweis = DELETE_PROTECTED_HINT;
  }
}

export const BESCHEID_DELETE_PROTECTED_CODE = 'BESCHEID_HAT_PKV_PRUEFVORMERKUNG';
export const BESCHEID_DELETE_PROTECTED_HINT = 'Die PKV-Prüfvormerkungen der Kürzungen dieses Bescheids zuerst entfernen oder einreichen lassen.';

export class BescheidDeleteProtectedError extends Error {
  constructor(postid, anzahl) {
    super(`Dokument ${postid} kann nicht gelöscht werden: ${anzahl} PKV-Prüfvormerkung(en) sind noch offen oder eingereicht.`);
    this.name = 'BescheidDeleteProtectedError';
    this.code = BESCHEID_DELETE_PROTECTED_CODE;
    this.status = 409;
    this.statusCode = 409;
    this.postid = postid;
    this.anzahl = anzahl;
    this.hinweis = BESCHEID_DELETE_PROTECTED_HINT;
  }
}

export const DOKUMENT_PIN_DELETE_PROTECTED_CODE = 'DOKUMENT_HAT_PINS';
export const DOKUMENT_PIN_DELETE_PROTECTED_HINT = 'Die Dokument-Pins zuerst in den betroffenen Perioden lösen oder fachlich abschließen.';

export class DokumentPinDeleteProtectedError extends Error {
  constructor(postid, anzahl) {
    super(`Dokument ${postid} kann nicht gelöscht werden: ${anzahl} Dokument-Pin(s) sind noch aktiv. Bitte die Pins zuerst lösen oder fachlich abschließen.`);
    this.name = 'DokumentPinDeleteProtectedError';
    this.code = DOKUMENT_PIN_DELETE_PROTECTED_CODE;
    this.status = 409;
    this.statusCode = 409;
    this.postid = postid;
    this.anzahl = anzahl;
    this.hinweis = DOKUMENT_PIN_DELETE_PROTECTED_HINT;
  }
}

export async function pruefeMehrereDokumentPinLoeschschutzUnterLock(postids, db) {
  const ids = [...new Set(postids || [])].sort();
  if (!ids.length) return;
  await db.query(
    `SELECT id FROM postbuch.dokument_pin
      WHERE postid = ANY($1::varchar[])
      ORDER BY postid, id
      FOR UPDATE`,
    [ids],
  );
  const { rows } = await db.query(
    `SELECT postid, count(*)::int AS anzahl
       FROM postbuch.dokument_pin
      WHERE postid = ANY($1::varchar[])
      GROUP BY postid
      ORDER BY postid`,
    [ids],
  );
  if (rows.length > 0) {
    throw new DokumentPinDeleteProtectedError(rows[0].postid, rows[0].anzahl);
  }
}

export async function ermittleArzLoeschschutz(postid, db = pool) {
  const { rows } = await db.query(
    `SELECT COALESCE(json_agg(x.eb_postid ORDER BY x.eb_postid), '[]'::json) AS erstattungsbescheide
       FROM (
         SELECT ep.postid AS eb_postid
           FROM postbuch.erstattungsbescheid_einzelposition ep
          WHERE ep.arz_postid = $1
         UNION
         SELECT k.postid AS eb_postid
           FROM postbuch.erstattungsbescheid_kuerzung k
          WHERE k.arz_postid = $1
       ) x`,
    [postid],
  );
  const raw = rows[0]?.erstattungsbescheide;
  const erstattungsbescheide = Array.isArray(raw) ? raw : JSON.parse(raw || '[]');
  return { geschuetzt: erstattungsbescheide.length > 0, erstattungsbescheide };
}

export async function ermittleArzLoeschschutzMehrere(postids, db = pool) {
  if (!postids?.length) return [];
  const { rows } = await db.query(
    `SELECT x.arz_postid AS postid,
            json_agg(DISTINCT x.eb_postid ORDER BY x.eb_postid) AS erstattungsbescheide
       FROM (
         SELECT ep.arz_postid, ep.postid AS eb_postid
           FROM postbuch.erstattungsbescheid_einzelposition ep
          WHERE ep.arz_postid = ANY($1::varchar[])
         UNION
         SELECT k.arz_postid, k.postid AS eb_postid
           FROM postbuch.erstattungsbescheid_kuerzung k
          WHERE k.arz_postid = ANY($1::varchar[])
       ) x
      GROUP BY x.arz_postid
      ORDER BY x.arz_postid`,
    [postids],
  );
  return rows;
}

export async function pruefeMehrereArzLoeschschutzUnterLock(postids, db) {
  const ids = [...new Set(postids || [])].sort();
  if (!ids.length) return [];
  await db.query(
    `SELECT postid FROM postbuch.arztrechnung
      WHERE postid = ANY($1::varchar[]) ORDER BY postid FOR UPDATE`,
    [ids],
  );
  const geschuetzte = await ermittleArzLoeschschutzMehrere(ids, db);
  if (geschuetzte.length) {
    const erster = geschuetzte[0];
    throw new DocumentDeleteProtectedError(erster.postid, erster.erstattungsbescheide);
  }
  return geschuetzte;
}

export async function pruefeArzLoeschschutzUnterLock(postid, db) {
  await db.query(
    'SELECT postid FROM postbuch.arztrechnung WHERE postid=$1 FOR UPDATE',
    [postid],
  );
  const schutz = await ermittleArzLoeschschutz(postid, db);
  if (schutz.geschuetzt) {
    throw new DocumentDeleteProtectedError(postid, schutz.erstattungsbescheide);
  }
  return schutz;
}

/**
 * Schützt einen Erstattungs-/Beihilfebescheid selbst vor dem Löschen, solange
 * eine seiner Kürzungen eine PKV-Prüfvormerkung trägt (offen oder eingereicht).
 * Ohne diese Prüfung würde das DELETE erst an bkpp_kuerzung_fkey (RESTRICT)
 * bzw. am Trigger fn_block_kuerzung_delete_with_pruefung scheitern — technisch
 * sicher, aber als rohe DB-Exception statt als verständlicher 409.
 */
export async function ermittleBescheidLoeschschutz(postid, db = pool) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS anzahl
       FROM postbuch.beihilfe_kuerzung_pkv_pruefung WHERE eb_postid = $1`,
    [postid],
  );
  const anzahl = rows[0]?.anzahl || 0;
  return { geschuetzt: anzahl > 0, anzahl };
}

export async function pruefeBescheidLoeschschutzUnterLock(postid, db) {
  await db.query(
    `SELECT eb_postid FROM postbuch.beihilfe_kuerzung_pkv_pruefung
      WHERE eb_postid = $1 ORDER BY eb_subid, kuerzung_id FOR UPDATE`,
    [postid],
  );
  const schutz = await ermittleBescheidLoeschschutz(postid, db);
  if (schutz.geschuetzt) {
    throw new BescheidDeleteProtectedError(postid, schutz.anzahl);
  }
  return schutz;
}

/** Bulk-Variante für mehrere Bescheid-Postids (z. B. Mensch-Löschung). */
export async function pruefeMehrereBescheidLoeschschutzUnterLock(postids, db) {
  const ids = [...new Set(postids || [])].sort();
  if (!ids.length) return;
  await db.query(
    `SELECT eb_postid FROM postbuch.beihilfe_kuerzung_pkv_pruefung
      WHERE eb_postid = ANY($1::varchar[]) ORDER BY eb_postid, eb_subid, kuerzung_id FOR UPDATE`,
    [ids],
  );
  const { rows } = await db.query(
    `SELECT eb_postid, count(*)::int AS anzahl
       FROM postbuch.beihilfe_kuerzung_pkv_pruefung
      WHERE eb_postid = ANY($1::varchar[])
      GROUP BY eb_postid ORDER BY eb_postid`,
    [ids],
  );
  if (rows.length > 0) {
    throw new BescheidDeleteProtectedError(rows[0].eb_postid, rows[0].anzahl);
  }
}

/** Öffnet eine Löschtransaktion und hält alle für neue EB-FKs relevanten Locks. */
export async function oeffneSichereDokumentloeschung(postid) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const docResult = await client.query(
      `SELECT postid, storage_id, storage_backend, betreff
         FROM postbuch.postbuch WHERE postid=$1 FOR UPDATE`,
      [postid],
    );
    if (!docResult.rowCount) {
      const err = new Error('Dokument nicht gefunden');
      err.status = 404;
      throw err;
    }

    // Dokument-Pins referenzieren die Postzeile mit ON DELETE RESTRICT. Ein
    // roher FK-Fehler wäre für jede Dokumentart ein vermeidbarer Stuck-Zustand;
    // die fachliche Lösung ist eine klare 409-Antwort mit dem Ausweg, den Pin
    // zuerst zu lösen oder regulär abzuschließen.
    const pinResult = await client.query(
      `SELECT id FROM postbuch.dokument_pin
        WHERE postid = $1
        ORDER BY id
        FOR UPDATE`,
      [postid],
    );
    if (pinResult.rowCount > 0) {
      throw new DokumentPinDeleteProtectedError(postid, pinResult.rowCount);
    }

    // FOR UPDATE kollidiert mit dem KEY SHARE, den eine neue FK-Zuordnung
    // benötigt. Damit kann zwischen Prüfung und DELETE kein neuer EB-Bezug
    // entstehen.
    await pruefeArzLoeschschutzUnterLock(postid, client);
    await pruefeBescheidLoeschschutzUnterLock(postid, client);
    return { client, document: docResult.rows[0] };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    throw err;
  }
}

export function istLoeschschutzFehler(err) {
  return err instanceof DocumentDeleteProtectedError
    || err instanceof BescheidDeleteProtectedError
    || err instanceof DokumentPinDeleteProtectedError
    || err?.code === DELETE_PROTECTED_CODE
    || err?.code === BESCHEID_DELETE_PROTECTED_CODE
    || err?.code === DOKUMENT_PIN_DELETE_PROTECTED_CODE
    || (err?.code === '23503' && err?.constraint === DELETE_GUARD_CONSTRAINT);
}

export function loeschschutzAntwort(err) {
  return {
    error: err.message,
    code: err.code || DELETE_PROTECTED_CODE,
    postid: err.postid || null,
    erstattungsbescheide: err.erstattungsbescheide || [],
    hinweis: err.hinweis || DELETE_PROTECTED_HINT,
  };
}
