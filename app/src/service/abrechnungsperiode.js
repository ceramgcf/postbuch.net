/**
 * service/abrechnungsperiode.js — Manuelle Perioden-Operationen
 *
 * Der Session-Lifecycle (Start/Bestätigen/Ablehnen/Cleanup der Abrechnungs-
 * sessions) lebt seit der Härtung (E4) in service/abrechnung-session.js —
 * dort liegen auch die vier relationalen Session-Tabellen als Wahrheit.
 * Diese Datei bleibt bewusst nur für die Perioden-Operationen zuständig:
 *   - setPeriodeStatus()     — SUBMITTED↔COLLECTING umschalten (auch generisch nutzbar)
 *   - omitPeriode()          — COLLECTING→OMITTED + neue COLLECTING+1
 *   - restorePeriode()       — Generisches Status-Restore (Undo-Helper)
 *   - deletePeriodeHighest() — Höchste COLLECTING löschen (Rechnungen → nächsthöhere COLLECTING)
 *   - mergePerioden()        — Source-COLLECTING in Target-COLLECTING mergen
 */

import pool from '../db.js';
import { appLog } from '../app-log.js';

// ── Manuelle Perioden-Operationen ─────────────────────────────────────────────

/**
 * Räumt das Herkunftsfeld `ursprungsperiode` auf, wenn eine Periode manuell
 * gelöscht oder zusammengeführt wird.
 *
 * Bewusst ohne lückenlose Mehrfachherkunft: Nach einem Merge stammen die
 * Rechnungen der Zielperiode aus zwei Quellen — eine einzelne Ursprungsnummer
 * wäre dann schlicht falsch. Das Feld entfällt deshalb, die Beziehung bleibt
 * nur noch im Anwendungsprotokoll nachvollziehbar.
 *
 * @param {number} geloeschtePeriode  Periode, die verschwindet (verwaiste Kinder)
 * @param {number|null} zielPeriode   Periode, die deren Rechnungen übernimmt
 */
async function loeseHerkunftAuf(client, person, kostentraeger, geloeschtePeriode, zielPeriode) {
  const entityId = `${person}/${kostentraeger}/${geloeschtePeriode}`;

  const eigene = await client.query(
    `SELECT ursprungsperiode FROM abrechnungsperiode_buch
     WHERE person = $1 AND kostentraeger = $2 AND periode = $3`,
    [person, kostentraeger, geloeschtePeriode]
  );
  const eigeneHerkunft = eigene.rows[0]?.ursprungsperiode ?? null;
  if (eigeneHerkunft != null) {
    appLog('INFO', 'abrechnungsperiode',
      `Herkunft entfällt: Periode ${geloeschtePeriode} (aus ${eigeneHerkunft}) wird aufgelöst`,
      { entity: 'abrechnungsperiode', entityId });
  }

  const verwaist = await client.query(
    `UPDATE abrechnungsperiode_buch SET ursprungsperiode = NULL
     WHERE person = $1 AND kostentraeger = $2 AND ursprungsperiode = $3
     RETURNING periode`,
    [person, kostentraeger, geloeschtePeriode]
  );
  for (const r of verwaist.rows) {
    appLog('INFO', 'abrechnungsperiode',
      `Herkunft entfällt: Periode ${r.periode} verliert ihre Ursprungsperiode ${geloeschtePeriode} (aufgelöst)`,
      { entity: 'abrechnungsperiode', entityId });
  }

  if (zielPeriode != null) {
    const ziel = await client.query(
      `UPDATE abrechnungsperiode_buch SET ursprungsperiode = NULL
       WHERE person = $1 AND kostentraeger = $2 AND periode = $3 AND ursprungsperiode IS NOT NULL
       RETURNING ursprungsperiode AS alt`,
      [person, kostentraeger, zielPeriode]
    );
    if (ziel.rows.length > 0) {
      appLog('INFO', 'abrechnungsperiode',
        `Herkunft entfällt: Zielperiode ${zielPeriode} (bisher aus ${ziel.rows[0].alt}) übernimmt Rechnungen aus Periode ${geloeschtePeriode}`,
        { entity: 'abrechnungsperiode', entityId });
    }
  }
}

/**
 * Blockiert konkurrierende Ziel-/Dokument-/Vormerkungsoperationen, solange für
 * (person, kostentraeger, periode) eine aktive Abrechnungssession existiert.
 * `client` muss die Periodenzeile bereits FOR UPDATE gesperrt haben.
 */
async function throwIfSessionLocked(client, person, kostentraeger, periode) {
  const locked = await client.query(
    `SELECT 1 FROM _abrechnung_session_ziel
     WHERE person = $1 AND kostentraeger = $2 AND periode = $3 AND aktiv LIMIT 1`,
    [person, kostentraeger, periode]
  );
  if (locked.rows.length > 0) {
    const err = new Error('Für diese Periode läuft bereits eine Abrechnungssession. Bitte zuerst abschließen oder abbrechen.');
    err.code = 'ABRECHNUNG_SESSION_GESPERRT';
    throw err;
  }
}

/**
 * Entfernt erledigte Session-Reservierungen, bevor ihre referenzierte
 * Periode gelöscht wird. Abgebrochene, verworfene oder abgelaufene Sessions
 * setzen ihre Zielzeilen bewusst nur auf `aktiv = false`, damit die Session
 * selbst als Historie bestehen bleiben kann. Die FK auf die Periode ist aber
 * RESTRICT; ohne diese lokale Bereinigung würde eine fachlich freigegebene
 * Periode beim Merge/Löschen trotzdem an einer rein historischen
 * Reservierungszeile hängen bleiben.
 *
 * Aktive Reservierungen werden hier absichtlich nicht angerührt. Der Aufrufer
 * hat sie unmittelbar zuvor über throwIfSessionLocked geprüft und bricht bei
 * einer solchen Session ab.
 */
async function entferneInaktiveSessionZiele(client, person, kostentraeger, periode) {
  await client.query(
    `DELETE FROM _abrechnung_session_ziel
     WHERE person = $1 AND kostentraeger = $2 AND periode = $3 AND NOT aktiv`,
    [person, kostentraeger, periode]
  );
}

/**
 * Blockiert Operationen, die eine offene ('VORGEMERKT') PKV-Prüfvormerkung als
 * Nebeneffekt verlieren lassen würden. Vormerkungen existieren ausschließlich
 * für kostentraeger='PKV' (Schema-CHECK), daher no-op für Beihilfe.
 */
async function throwIfOffenePruefvormerkung(client, person, kostentraeger, periode, meldung) {
  if (kostentraeger !== 'PKV') return;
  const offen = await client.query(
    `SELECT 1 FROM beihilfe_kuerzung_pkv_pruefung
     WHERE person = $1 AND kostentraeger = 'PKV' AND periode = $2 AND status = 'VORGEMERKT' LIMIT 1`,
    [person, periode]
  );
  if (offen.rows.length > 0) {
    const err = new Error(meldung);
    err.code = 'PKV_PRUEFUNG_OFFEN';
    throw err;
  }
}

/**
 * Setzt eine Periode auf einen neuen Status.
 * Erlaubte Übergänge (sonst Fehler):
 *   - SUBMITTED → COLLECTING   (manuelle Rückstufung)
 *   - COLLECTING → SUBMITTED   (Undo von SUBMITTED→COLLECTING)
 *   - OMITTED → COLLECTING     (Undo von COLLECTING→OMITTED)
 *   - COLLECTING → OMITTED     (Redo nach OMITTED-Undo)
 */
export async function setPeriodeStatus({ person, kostentraeger, periode, targetStatus, expectedCurrentStatus }) {
  const VALID = new Set(['COLLECTING', 'SUBMITTED', 'COMPLETED', 'OMITTED']);
  if (!VALID.has(targetStatus)) throw new Error(`Ungültiger Zielstatus: ${targetStatus}`);
  if (!['PKV', 'Beihilfe'].includes(kostentraeger)) throw new Error('Ungültiger Kostenträger');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const cur = await client.query(
      `SELECT status FROM abrechnungsperiode_buch WHERE person = $1 AND kostentraeger = $2 AND periode = $3 FOR UPDATE`,
      [person, kostentraeger, periode]
    );
    if (cur.rows.length === 0) throw new Error('Periode nicht gefunden');
    const currentStatus = cur.rows[0].status;

    if (expectedCurrentStatus && currentStatus !== expectedCurrentStatus) {
      throw new Error(`Aktueller Status ist '${currentStatus}', erwartet '${expectedCurrentStatus}'`);
    }

    // Übergangsregeln
    const allowed = {
      SUBMITTED:   ['COLLECTING'],
      COLLECTING:  ['SUBMITTED', 'OMITTED'],
      OMITTED:     ['COLLECTING'],
    };
    if (currentStatus === 'COMPLETED') {
      throw new Error('COMPLETED-Perioden können nur durch Löschen des Erstattungsbescheids zurückgesetzt werden');
    }
    if (!allowed[currentStatus]?.includes(targetStatus)) {
      throw new Error(`Übergang ${currentStatus} → ${targetStatus} nicht erlaubt`);
    }

    await throwIfSessionLocked(client, person, kostentraeger, periode);

    if (currentStatus === 'COLLECTING' && (targetStatus === 'SUBMITTED' || targetStatus === 'OMITTED')) {
      await throwIfOffenePruefvormerkung(client, person, kostentraeger, periode,
        targetStatus === 'SUBMITTED'
          ? 'Periode enthält offene PKV-Prüfvormerkungen. Einreichung nur über den erweiterten Abrechnungsassistenten möglich.'
          : 'Periode enthält offene PKV-Prüfvormerkungen. Bitte zuerst verschieben oder entfernen.');
    }

    await client.query(
      `UPDATE abrechnungsperiode_buch SET status = $4
       WHERE person = $1 AND kostentraeger = $2 AND periode = $3`,
      [person, kostentraeger, periode, targetStatus]
    );

    // SUBMITTED → COLLECTING (manuelle Rückstufung): eingereichte Prüfvormerkungen
    // wieder vormerkbar machen. Das frühere Einreichungsdatum bleibt als Audit stehen.
    if (currentStatus === 'SUBMITTED' && targetStatus === 'COLLECTING' && kostentraeger === 'PKV') {
      await client.query(
        `UPDATE beihilfe_kuerzung_pkv_pruefung SET status = 'VORGEMERKT'
         WHERE person = $1 AND kostentraeger = 'PKV' AND periode = $2 AND status = 'EINGEREICHT'`,
        [person, periode]
      );
    }

    await client.query('COMMIT');
    appLog('INFO', 'abrechnungsperiode',
      `Status ${currentStatus}→${targetStatus}: ${person}/${kostentraeger}/${periode}`,
      { entity: 'abrechnungsperiode', entityId: `${person}/${kostentraeger}/${periode}` });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Setzt eine COLLECTING-Periode auf OMITTED und legt neue COLLECTING+1 an,
 * sofern noch keine höhere COLLECTING für (person, kt) existiert.
 *
 * Gibt {createdPeriode} zurück — die neu angelegte COLLECTING-Periode (oder null).
 */
export async function omitPeriode({ person, kostentraeger, periode }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const cur = await client.query(
      `SELECT status FROM abrechnungsperiode_buch WHERE person = $1 AND kostentraeger = $2 AND periode = $3 FOR UPDATE`,
      [person, kostentraeger, periode]
    );
    if (cur.rows.length === 0) throw new Error('Periode nicht gefunden');
    if (cur.rows[0].status !== 'COLLECTING') throw new Error('Nur COLLECTING kann auf OMITTED gesetzt werden');

    await throwIfSessionLocked(client, person, kostentraeger, periode);
    await throwIfOffenePruefvormerkung(client, person, kostentraeger, periode,
      'Periode enthält offene PKV-Prüfvormerkungen. Bitte zuerst verschieben oder entfernen.');

    await client.query(
      `UPDATE abrechnungsperiode_buch SET status = 'OMITTED'
       WHERE person = $1 AND kostentraeger = $2 AND periode = $3`,
      [person, kostentraeger, periode]
    );

    // Neue COLLECTING nur anlegen, wenn keine weitere existiert
    const stillColl = await client.query(
      `SELECT 1 FROM abrechnungsperiode_buch WHERE person = $1 AND kostentraeger = $2 AND status = 'COLLECTING' LIMIT 1`,
      [person, kostentraeger]
    );
    let createdPeriode = null;
    if (stillColl.rows.length === 0) {
      const ins = await client.query(
        `INSERT INTO abrechnungsperiode_buch (person, kostentraeger, periode, status, satz)
         SELECT $1, $2, COALESCE(MAX(periode), 0) + 1, 'COLLECTING',
                CASE $2::text
                  WHEN 'PKV' THEN (SELECT pkv_satz FROM postbuch.mensch WHERE kurzname = $1)
                  ELSE (SELECT beihilfe_satz FROM postbuch.mensch WHERE kurzname = $1)
                END
         FROM abrechnungsperiode_buch WHERE person = $1 AND kostentraeger = $2
         RETURNING periode`,
        [person, kostentraeger]
      );
      createdPeriode = ins.rows[0]?.periode ?? null;
    }

    await client.query('COMMIT');
    appLog('INFO', 'abrechnungsperiode',
      `OMITTED: ${person}/${kostentraeger}/${periode}${createdPeriode ? ` (neue COLLECTING=${createdPeriode})` : ''}`,
      { entity: 'abrechnungsperiode', entityId: `${person}/${kostentraeger}/${periode}` });
    return { createdPeriode };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Löscht die höchste COLLECTING-Periode für (person, kt). Zulässig nur,
 * wenn mindestens 2 COLLECTING existieren und die Zielperiode die höchste ist.
 * Vor dem Löschen werden alle Rechnungen dieser Periode auf die
 * nächst-niedrigere COLLECTING umgebucht.
 *
 * Gibt Snapshot {deletedPeriode, movedPostIds, targetPeriode} zurück (für Undo).
 */
export async function deleteHighestCollecting({ person, kostentraeger, periode }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const colls = await client.query(
      `SELECT periode FROM abrechnungsperiode_buch
       WHERE person = $1 AND kostentraeger = $2 AND status = 'COLLECTING'
       ORDER BY periode DESC FOR UPDATE`,
      [person, kostentraeger]
    );
    if (colls.rows.length < 2) throw new Error('Mindestens zwei COLLECTING-Perioden nötig');
    const highest = colls.rows[0].periode;
    const nextLower = colls.rows[1].periode;
    if (periode !== highest) throw new Error(`Nur die höchste COLLECTING (${highest}) darf gelöscht werden`);

    await throwIfSessionLocked(client, person, kostentraeger, highest);
    await throwIfSessionLocked(client, person, kostentraeger, nextLower);

    const periodeCol = kostentraeger === 'PKV' ? 'abrechnungsperiode_pkv' : 'abrechnungsperiode_beihilfe';

    // Rechnungen der zu löschenden Periode umbuchen auf nextLower
    const moved = await client.query(
      `UPDATE arztrechnung SET ${periodeCol} = $1
       WHERE behandelte_person = $2 AND ${periodeCol} = $3
       RETURNING postid`,
      [nextLower, person, highest]
    );

    // Offene/eingereichte PKV-Prüfvormerkungen dieser Periode auf die
    // verbleibende Zielperiode umhängen — dürfen nie als Nebeneffekt verlorengehen.
    let movedKuerzungen = [];
    if (kostentraeger === 'PKV') {
      const movedK = await client.query(
        `UPDATE beihilfe_kuerzung_pkv_pruefung
         SET periode = $1, vorherige_periode = $3
         WHERE person = $2 AND kostentraeger = 'PKV' AND periode = $3
         RETURNING eb_postid, eb_subid, kuerzung_id`,
        [nextLower, person, highest]
      );
      movedKuerzungen = movedK.rows;
    }

    await loeseHerkunftAuf(client, person, kostentraeger, highest, nextLower);

    await entferneInaktiveSessionZiele(client, person, kostentraeger, highest);

    await client.query(
      `DELETE FROM abrechnungsperiode_buch WHERE person = $1 AND kostentraeger = $2 AND periode = $3`,
      [person, kostentraeger, highest]
    );

    await client.query('COMMIT');
    appLog('INFO', 'abrechnungsperiode',
      `Höchste COLLECTING gelöscht: ${person}/${kostentraeger}/${highest} — ${moved.rows.length} Rg., ${movedKuerzungen.length} Prüfvormerkung(en) → Periode ${nextLower}`,
      { entity: 'abrechnungsperiode', entityId: `${person}/${kostentraeger}/${highest}` });
    return {
      deletedPeriode: highest,
      movedPostIds: moved.rows.map(r => r.postid),
      targetPeriode: nextLower,
      movedKuerzungen,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Merged eine Source-Periode in die höchste COLLECTING-Periode.
 * Source darf COLLECTING oder OMITTED sein (für OMITTED-Merge).
 * Alle Rechnungen werden umgebucht, die Source-Periode wird gelöscht.
 *
 * Gibt Snapshot {mergedPeriode, movedPostIds, targetPeriode, sourceStatus} zurück (für Undo).
 */
export async function mergePerioden({ person, kostentraeger, sourcePeriode, targetPeriode }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const src = await client.query(
      `SELECT status FROM abrechnungsperiode_buch
       WHERE person = $1 AND kostentraeger = $2 AND periode = $3 FOR UPDATE`,
      [person, kostentraeger, sourcePeriode]
    );
    if (src.rows.length === 0) throw new Error('Source-Periode nicht gefunden');
    const sourceStatus = src.rows[0].status;
    if (!['COLLECTING', 'OMITTED'].includes(sourceStatus)) {
      throw new Error(`Source darf nur COLLECTING oder OMITTED sein (ist ${sourceStatus})`);
    }
    if (sourcePeriode === targetPeriode) throw new Error('Source und Target sind identisch');

    const colls = await client.query(
      `SELECT periode FROM abrechnungsperiode_buch
       WHERE person = $1 AND kostentraeger = $2 AND status = 'COLLECTING'
       ORDER BY periode DESC FOR UPDATE`,
      [person, kostentraeger]
    );
    const collPerioden = colls.rows.map(r => r.periode);
    if (collPerioden.length === 0) throw new Error('Keine COLLECTING-Periode als Target vorhanden');
    const highest = collPerioden[0];
    if (targetPeriode !== highest) throw new Error(`Target muss die höchste COLLECTING (${highest}) sein`);

    await throwIfSessionLocked(client, person, kostentraeger, sourcePeriode);
    await throwIfSessionLocked(client, person, kostentraeger, targetPeriode);

    const periodeCol = kostentraeger === 'PKV' ? 'abrechnungsperiode_pkv' : 'abrechnungsperiode_beihilfe';
    const moved = await client.query(
      `UPDATE arztrechnung SET ${periodeCol} = $1
       WHERE behandelte_person = $2 AND ${periodeCol} = $3
       RETURNING postid`,
      [targetPeriode, person, sourcePeriode]
    );

    // Offene/eingereichte PKV-Prüfvormerkungen der Source transaktional auf das
    // Ziel umhängen — dürfen nie als Nebeneffekt des Merges verlorengehen.
    let movedKuerzungen = [];
    if (kostentraeger === 'PKV') {
      const movedK = await client.query(
        `UPDATE beihilfe_kuerzung_pkv_pruefung
         SET periode = $1, vorherige_periode = $3
         WHERE person = $2 AND kostentraeger = 'PKV' AND periode = $3
         RETURNING eb_postid, eb_subid, kuerzung_id`,
        [targetPeriode, person, sourcePeriode]
      );
      movedKuerzungen = movedK.rows;
    }

    await loeseHerkunftAuf(client, person, kostentraeger, sourcePeriode, targetPeriode);

    await entferneInaktiveSessionZiele(client, person, kostentraeger, sourcePeriode);

    await client.query(
      `DELETE FROM abrechnungsperiode_buch WHERE person = $1 AND kostentraeger = $2 AND periode = $3`,
      [person, kostentraeger, sourcePeriode]
    );

    await client.query('COMMIT');
    appLog('INFO', 'abrechnungsperiode',
      `Merged (${sourceStatus}): ${person}/${kostentraeger}/${sourcePeriode} → ${targetPeriode} (${moved.rows.length} Rg., ${movedKuerzungen.length} Prüfvormerkung(en))`,
      { entity: 'abrechnungsperiode', entityId: `${person}/${kostentraeger}/${sourcePeriode}` });
    return {
      mergedPeriode: sourcePeriode,
      movedPostIds: moved.rows.map(r => r.postid),
      targetPeriode,
      sourceStatus,
      movedKuerzungen,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Löscht eine COLLECTING-Periode und setzt die AP-Zuordnung ihrer Rechnungen
 * auf NULL (Rechnungen sind dann keiner Abrechnungsperiode mehr zugeordnet).
 * Im Gegensatz zu mergePerioden/deleteHighestCollecting werden die Rechnungen
 * NICHT auf eine andere Periode umgebucht.
 *
 * Anwendung: wenn die User explizit "AP entfernen" wählen (gefährliche Option).
 *
 * Gibt Snapshot {deletedPeriode, clearedPostIds} zurück (für Undo).
 */
export async function nullAPForCollectingPeriode({ person, kostentraeger, periode }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const cur = await client.query(
      `SELECT status FROM abrechnungsperiode_buch
       WHERE person = $1 AND kostentraeger = $2 AND periode = $3 FOR UPDATE`,
      [person, kostentraeger, periode]
    );
    if (cur.rows.length === 0) throw new Error('Periode nicht gefunden');
    if (cur.rows[0].status !== 'COLLECTING') {
      throw new Error('Nur COLLECTING-Perioden können so entfernt werden');
    }

    await throwIfSessionLocked(client, person, kostentraeger, periode);
    if (kostentraeger === 'PKV') {
      // Jede Vormerkung (offen oder eingereicht) referenziert diese Periode fachlich
      // fest — ohne Zielperiode gäbe es keinen gültigen Bezug mehr für den Prüffall.
      const offen = await client.query(
        `SELECT 1 FROM beihilfe_kuerzung_pkv_pruefung
         WHERE person = $1 AND kostentraeger = 'PKV' AND periode = $2 LIMIT 1`,
        [person, periode]
      );
      if (offen.rows.length > 0) {
        const err = new Error('Periode enthält PKV-Prüfvormerkungen, die dadurch ihren notwendigen Periodenbezug verlieren würden. Bitte zuerst verschieben oder entfernen.');
        err.code = 'PKV_PRUEFUNG_OFFEN';
        throw err;
      }
    }

    const periodeCol = kostentraeger === 'PKV' ? 'abrechnungsperiode_pkv' : 'abrechnungsperiode_beihilfe';
    const cleared = await client.query(
      `UPDATE arztrechnung SET ${periodeCol} = NULL
       WHERE behandelte_person = $1 AND ${periodeCol} = $2
       RETURNING postid`,
      [person, periode]
    );

    await loeseHerkunftAuf(client, person, kostentraeger, periode, null);

    await entferneInaktiveSessionZiele(client, person, kostentraeger, periode);

    await client.query(
      `DELETE FROM abrechnungsperiode_buch WHERE person = $1 AND kostentraeger = $2 AND periode = $3`,
      [person, kostentraeger, periode]
    );

    await client.query('COMMIT');
    appLog('INFO', 'abrechnungsperiode',
      `AP genullt + Periode gelöscht: ${person}/${kostentraeger}/${periode} (${cleared.rows.length} Rg.)`,
      { entity: 'abrechnungsperiode', entityId: `${person}/${kostentraeger}/${periode}` });
    return {
      deletedPeriode: periode,
      clearedPostIds: cleared.rows.map(r => r.postid),
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Undo-Helper: Legt eine zuvor gelöschte/gemergte Periode neu an
 * und bucht die Rechnungen zurück. Nur für Undo gedacht.
 * `status` default COLLECTING, kann OMITTED sein wenn Source vor dem Merge OMITTED war.
 *
 * Das Herkunftsfeld `ursprungsperiode` wird bewusst NICHT wiederhergestellt:
 * Es entfällt beim Merge endgültig (siehe loeseHerkunftAuf) und bleibt nur im
 * Anwendungsprotokoll erhalten.
 */
export async function restoreCollectingFromMerge({ person, kostentraeger, periode, postIds, status, movedKuerzungen }) {
  const targetStatus = status === 'OMITTED' ? 'OMITTED' : 'COLLECTING';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO abrechnungsperiode_buch (person, kostentraeger, periode, status, satz)
       SELECT $1, $2, $3, $4,
              CASE $2::text
                WHEN 'PKV' THEN p.pkv_satz
                ELSE p.beihilfe_satz
              END
       FROM postbuch.mensch p WHERE p.kurzname = $1
       ON CONFLICT (person, kostentraeger, periode) DO UPDATE SET status = $4`,
      [person, kostentraeger, periode, targetStatus]
    );

    if (Array.isArray(postIds) && postIds.length > 0) {
      const periodeCol = kostentraeger === 'PKV' ? 'abrechnungsperiode_pkv' : 'abrechnungsperiode_beihilfe';
      await client.query(
        `UPDATE arztrechnung SET ${periodeCol} = $1
         WHERE postid = ANY($2::text[]) AND behandelte_person = $3`,
        [periode, postIds, person]
      );
    }

    // Exakt die im Snapshot enthaltenen Vormerkungen zurückhängen (Undo von
    // Merge/Delete-highest). Kein Erraten — nur die übergebenen Schlüssel.
    let restoredKuerzungen = 0;
    if (kostentraeger === 'PKV' && Array.isArray(movedKuerzungen) && movedKuerzungen.length > 0) {
      for (const k of movedKuerzungen) {
        const r = await client.query(
          `UPDATE beihilfe_kuerzung_pkv_pruefung
           SET periode = $1, vorherige_periode = NULL
           WHERE eb_postid = $2 AND eb_subid = $3 AND kuerzung_id = $4 AND person = $5`,
          [periode, k.eb_postid, k.eb_subid, k.kuerzung_id, person]
        );
        restoredKuerzungen += r.rowCount;
      }
    }

    await client.query('COMMIT');
    appLog('INFO', 'abrechnungsperiode',
      `Restore (${targetStatus}): ${person}/${kostentraeger}/${periode} (${postIds?.length || 0} Rg., ${restoredKuerzungen} Prüfvormerkung(en))`,
      { entity: 'abrechnungsperiode', entityId: `${person}/${kostentraeger}/${periode}` });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Undo-Helper für omitPeriode: Setzt OMITTED→COLLECTING zurück UND entfernt
 * optional die bei omit() automatisch angelegte Folge-COLLECTING.
 */
export async function undoOmit({ person, kostentraeger, periode, autoCreatedPeriode }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE abrechnungsperiode_buch SET status = 'COLLECTING'
       WHERE person = $1 AND kostentraeger = $2 AND periode = $3 AND status = 'OMITTED'`,
      [person, kostentraeger, periode]
    );

    if (Number.isInteger(autoCreatedPeriode)) {
      // Nur löschen, wenn leer (keine Rechnungen) und COLLECTING
      const periodeCol = kostentraeger === 'PKV' ? 'abrechnungsperiode_pkv' : 'abrechnungsperiode_beihilfe';
      const rgCount = await client.query(
        `SELECT 1 FROM arztrechnung WHERE behandelte_person = $1 AND ${periodeCol} = $2 LIMIT 1`,
        [person, autoCreatedPeriode]
      );
      if (rgCount.rows.length === 0) {
        await loeseHerkunftAuf(client, person, kostentraeger, autoCreatedPeriode, null);
        await entferneInaktiveSessionZiele(client, person, kostentraeger, autoCreatedPeriode);
        await client.query(
          `DELETE FROM abrechnungsperiode_buch
           WHERE person = $1 AND kostentraeger = $2 AND periode = $3 AND status = 'COLLECTING'`,
          [person, kostentraeger, autoCreatedPeriode]
        );
      }
    }

    await client.query('COMMIT');
    appLog('INFO', 'abrechnungsperiode',
      `Undo OMIT: ${person}/${kostentraeger}/${periode}`,
      { entity: 'abrechnungsperiode', entityId: `${person}/${kostentraeger}/${periode}` });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
