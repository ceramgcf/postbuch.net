/**
 * Schutz fachlicher Zustände vor der destruktiven Wiederverarbeitung.
 *
 * Die aktuelle Pipeline ersetzt ein Dokument per DELETE + INSERT. Dieser Guard
 * sperrt nicht pauschal nach Dokumentart, sondern nur wenn dabei ein Zustand
 * verloren ginge, den die Pipeline nicht zuverlässig wiederherstellt.
 */

import pool from '../db.js';

export const REPROCESS_PROTECTED_CODE = 'REPROCESS_GESCHUETZTER_ZUSTAND';

/**
 * @param {string} postid
 * @param {object} [db] pg-Pool oder Transaktions-Client
 * @returns {Promise<{geschuetzt: boolean, gruende: string[], erstattungsbescheide: string[]}>}
 */
export async function ermittleReprocessSchutz(postid, db = pool) {
  const result = await db.query(
    `SELECT
       COALESCE((
         SELECT json_agg(x.eb_postid ORDER BY x.eb_postid)
         FROM (
           SELECT ep.postid AS eb_postid
             FROM postbuch.erstattungsbescheid_einzelposition ep
            WHERE ep.arz_postid = p.postid
           UNION
           SELECT k.postid AS eb_postid
             FROM postbuch.erstattungsbescheid_kuerzung k
            WHERE k.arz_postid = p.postid
         ) x
       ), '[]'::json) AS erstattungsbescheide
       , EXISTS (
         SELECT 1
           FROM postbuch.erstattungsbescheid_einzelposition ep
          WHERE ep.postid = p.postid AND ep.arz_postid IS NOT NULL
       ) AS eb_hat_rechnungszuordnung
       , EXISTS (
         SELECT 1
           FROM postbuch.erstattungsbescheid_kuerzung k
          WHERE k.postid = p.postid
            AND (k.arz_postid IS NOT NULL OR k.arz_subid IS NOT NULL)
       ) AS eb_hat_positionszuordnung
       , EXISTS (
         SELECT 1
           FROM postbuch.abrechnungsperiode_buch ab
          WHERE ab.eb_postid = p.postid
       ) AS eb_hat_periodenbindung
       , EXISTS (
         SELECT 1
           FROM postbuch._storage_migration_items smi
           JOIN postbuch._storage_migration_runs smr ON smr.id = smi.run_id
          WHERE smi.postid = p.postid
            AND smr.status IN ('trockenlauf', 'laeuft', 'pausiert')
            AND smi.status IN ('offen', 'kopiert')
       ) AS storage_migration_aktiv
       , EXISTS (
         SELECT 1
           FROM postbuch.beihilfe_kuerzung_pkv_pruefung bkpp
          WHERE bkpp.eb_postid = p.postid
       ) AS eb_hat_pkv_pruefvormerkung
       , (p.art = 'erstattungsbescheid') AS ist_erstattungsbescheid
       -- Die Delete-and-Reinsert-Logik vergibt neue kuerzung_id-Werte; ein
       -- gesetztes gesehen_am würde dabei unbemerkt verloren gehen.
       , EXISTS (
         SELECT 1
           FROM postbuch.erstattungsbescheid_kuerzung k
          WHERE k.postid = p.postid AND k.gesehen_am IS NOT NULL
       ) AS eb_hat_gesehene_kuerzung
       , EXISTS (
         SELECT 1
           FROM postbuch.erstattungsbescheid_einzelposition ep
          WHERE ep.postid = p.postid AND ep.ohne_rechnungsbezug_bestaetigt_am IS NOT NULL
       ) AS eb_hat_bestaetigte_ohne_rechnungsbezug
     FROM postbuch.postbuch p
     WHERE p.postid = $1`,
    [postid],
  );

  if (result.rows.length === 0) {
    return { geschuetzt: false, gruende: [], erstattungsbescheide: [] };
  }

  const row = result.rows[0];
  const gruende = [];
  const erstattungsbescheide = Array.isArray(row.erstattungsbescheide)
    ? row.erstattungsbescheide
    : JSON.parse(row.erstattungsbescheide || '[]');

  if (erstattungsbescheide.length > 0) {
    gruende.push(`mit Erstattungsbescheid(en) verknüpft: ${erstattungsbescheide.join(', ')}`);
  }

  // Die Bescheid-Wiederverarbeitung ist ein ausdrücklich bestätigter
  // Korrekturweg. processErstattungsbescheid() nimmt ihre eigene
  // Periodenwirkung vor dem Neuaufbau atomar zurück; die UI warnt den Nutzer
  // deshalb bereits, dass manuelle Zuordnungen/Kürzungen überschrieben werden.
  // Diese eigenen EB-Zustände dürfen den Korrekturweg nicht selbst sperren.
  // Die PKV-Prüfvormerkung bleibt darunter als separater FK-Schutz bestehen.
  // Für Rechnungen bleibt der Schutz vollständig bestehen.
  if (!row.ist_erstattungsbescheid) {
    if (row.eb_hat_rechnungszuordnung || row.eb_hat_positionszuordnung) {
      gruende.push('Erstattungsbescheid enthält Rechnungs- oder Positionszuordnungen');
    }
    if (row.eb_hat_periodenbindung) {
      gruende.push('Erstattungsbescheid schließt eine Abrechnungsperiode ab');
    }
    if (row.eb_hat_gesehene_kuerzung) {
      gruende.push('Erstattungsbescheid enthält eine als gesehen markierte Kürzung');
    }
    if (row.eb_hat_bestaetigte_ohne_rechnungsbezug) {
      gruende.push('Erstattungsbescheid enthält eine als „ohne Rechnungsbezug" bestätigte Position');
    }
  }
  // Dieser Zustand bleibt auch beim ausdrücklich erlaubten Reprocess eines
  // eigenen Bescheids geschützt: Die Prüfvormerkung referenziert die
  // Kürzungszeile mit ON DELETE RESTRICT. Ohne diesen Guard würde der Reprocess
  // zuerst die Periodenwirkung zurücknehmen und anschließend beim Löschen der
  // alten Positionen an der FK scheitern – ein vermeidbarer Recovery-Zustand.
  if (row.eb_hat_pkv_pruefvormerkung) {
    gruende.push('Erstattungsbescheid enthält eine PKV-Prüfvormerkung');
  }
  if (row.storage_migration_aktiv) {
    gruende.push('Dokument befindet sich in einer laufenden Ablage-Migration');
  }
  return {
    geschuetzt: gruende.length > 0,
    gruende,
    erstattungsbescheide,
  };
}

export function reprocessSchutzAntwort(schutz) {
  return {
    error: `Wiederverarbeitung gesperrt: ${schutz.gruende.join('; ')}. Bitte die betroffenen Daten direkt korrigieren.`,
    code: REPROCESS_PROTECTED_CODE,
    gruende: schutz.gruende,
    erstattungsbescheide: schutz.erstattungsbescheide,
  };
}

export class ReprocessProtectedError extends Error {
  constructor(schutz) {
    super(reprocessSchutzAntwort(schutz).error);
    this.name = 'ReprocessProtectedError';
    this.code = REPROCESS_PROTECTED_CODE;
    this.schutz = schutz;
  }
}

export async function wirfBeiGeschuetztemReprocess(postid, db = pool) {
  const schutz = await ermittleReprocessSchutz(postid, db);
  if (schutz.geschuetzt) throw new ReprocessProtectedError(schutz);
  return schutz;
}

/**
 * Sperrt die Elternzeile, prüft alle Abhängigkeiten und löscht atomar.
 * Neue FK-Verknüpfungen warten am Parent-Lock und können daher nicht zwischen
 * Schutzprüfung und DELETE entstehen.
 */
export async function oeffneSichereErsetzung(postid) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query(
      'SELECT 1 FROM postbuch.postbuch WHERE postid = $1 FOR UPDATE',
      [postid],
    );
    if (locked.rows.length === 0) {
      throw new Error(`Dokument ${postid} wurde zwischenzeitlich gelöscht`);
    }

    // Die fachlichen FKs und manuellen Zustände hängen an den Spezialzeilen,
    // nicht unmittelbar an postbuch.postbuch. In stabiler Reihenfolge sperren:
    // So warten neue EB-/Periodenverknüpfungen und parallele Fach-Updates bis
    // nach dem DELETE und können das Prüffen-→Löschen-Fenster nicht umgehen.
    for (const tabelle of [
      'arztrechnung',
      'erstattungsbescheid',
      'handwerkerrechnung',
      'generische_rechnung',
    ]) {
      await client.query(
        `SELECT postid FROM postbuch.${tabelle} WHERE postid = $1 FOR UPDATE`,
        [postid],
      );
    }

    // Eine Ablage-Migration ändert dieselbe Dateiidentität. Item und Lauf
    // müssen bis nach Schutzprüfung und Commit stabil bleiben.
    await client.query(
      `SELECT smi.run_id
         FROM postbuch._storage_migration_items smi
         JOIN postbuch._storage_migration_runs smr ON smr.id = smi.run_id
        WHERE smi.postid = $1
        ORDER BY smi.run_id
        FOR UPDATE OF smi, smr`,
      [postid],
    );

    // PKV-Prüfvormerkungen dieses Bescheids sperren, bevor die Schutzprüfung
    // läuft — sonst könnte zwischen Prüfung und DELETE eine neue Vormerkung
    // entstehen und das Prüfen→Löschen-Fenster umgehen.
    await client.query(
      `SELECT eb_postid FROM postbuch.beihilfe_kuerzung_pkv_pruefung
        WHERE eb_postid = $1
        ORDER BY eb_subid, kuerzung_id
        FOR UPDATE`,
      [postid],
    );

    // Dokument-Pins referenzieren die zu ersetzende Postzeile mit ON DELETE
    // RESTRICT. Der Reprocess kann sie fachlich identitätstreu sichern und
    // nach dem neuen Postbuch-Insert wieder an dieselbe PostID hängen; dafür
    // müssen sie bis zum Commit gegen parallele Änderungen gesperrt sein.
    await client.query(
      `SELECT id FROM postbuch.dokument_pin
        WHERE postid = $1
        ORDER BY id
        FOR UPDATE`,
      [postid],
    );

    await wirfBeiGeschuetztemReprocess(postid, client);
    return client;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    throw err;
  }
}
