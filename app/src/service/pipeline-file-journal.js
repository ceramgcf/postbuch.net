/**
 * Crashfeste Saga-Brücke für den nicht atomaren Übergang Ablage → Postgres.
 *
 * Die Pipeline persistiert ihre Dateiabsicht vor dem finalen Move. Bleibt nach
 * Prozessabbruch ein Eintrag stehen, stellt die Start-Recovery je nach Modus
 * die gültige Altzeile wieder her, startet einen ausstehenden Fachjob oder führt
 * eine neue/duplizierte Kandidatendatei laut nach _failed über.
 */
import pool from '../db.js';
import { getFolders } from '../config.js';
import { getAdapter, legacyOnedriveWerte } from '../lib/storage/index.js';
import { appLog } from '../app-log.js';
import * as failedHandler from './failed-handler.js';
import { isActive as isJobActive } from '../jobs/tracker.js';

let recoveryLaeuft = false;

export async function prepare({ jobId, postid, storageId, storageBackend, replacementMode = null }) {
  if (!jobId || !postid || !storageId || !storageBackend) {
    throw new Error('Pipeline-Journal braucht Job, PostID, Storage-ID und Backend.');
  }
  await pool.query(
    `INSERT INTO postbuch._pipeline_file_journal
       (job_id, postid, storage_id, source_storage_id, storage_backend, replacement_mode, state, updated_at)
     VALUES ($1,$2,$3,$3,$4,$5,'prepared',NOW())
     ON CONFLICT (job_id) DO UPDATE SET
       postid=EXCLUDED.postid, storage_id=EXCLUDED.storage_id,
       source_storage_id=EXCLUDED.source_storage_id,
       storage_backend=EXCLUDED.storage_backend, target_folder_id=NULL,
       replacement_mode=EXCLUDED.replacement_mode,
       replaced_storage_id=NULL, replaced_filename=NULL,
       desired_filename=NULL, actual_filename=NULL, state='prepared', updated_at=NOW()`,
    [jobId, postid, storageId, storageBackend, replacementMode],
  );
}

export async function noteMoveIntent(jobId, targetFolderId, desiredFilename) {
  const r = await pool.query(
    `UPDATE postbuch._pipeline_file_journal
        SET target_folder_id=$2, desired_filename=$3, state='move_intent', updated_at=NOW()
      WHERE job_id=$1`,
    [jobId, targetFolderId, desiredFilename],
  );
  if (r.rowCount !== 1) throw new Error(`Pipeline-Journal für Job ${jobId} fehlt.`);
}

export async function noteMoved(jobId, storageId, actualFilename) {
  const r = await pool.query(
    `UPDATE postbuch._pipeline_file_journal
        SET storage_id=$2, actual_filename=$3, state='moved', updated_at=NOW()
      WHERE job_id=$1`,
    [jobId, storageId, actualFilename],
  );
  if (r.rowCount !== 1) throw new Error(`Pipeline-Journal für Job ${jobId} fehlt.`);
}

export async function noteReplacementSource(jobId, storageId, filename, db = pool) {
  const r = await db.query(
    `UPDATE postbuch._pipeline_file_journal
        SET replaced_storage_id=$2, replaced_filename=$3, updated_at=NOW()
      WHERE job_id=$1`,
    [jobId, storageId, filename || null],
  );
  if (r.rowCount !== 1) throw new Error(`Pipeline-Journal für Job ${jobId} fehlt.`);
}

export async function noteReplacementCleaned(jobId) {
  const r = await pool.query(
    `UPDATE postbuch._pipeline_file_journal
        SET replaced_storage_id=NULL, replaced_filename=NULL, updated_at=NOW()
      WHERE job_id=$1`,
    [jobId],
  );
  if (r.rowCount !== 1) throw new Error(`Pipeline-Journal für Job ${jobId} fehlt.`);
}

export async function noteDbComplete(jobId) {
  const r = await pool.query(
    `UPDATE postbuch._pipeline_file_journal
        SET state='db_complete', updated_at=NOW()
      WHERE job_id=$1`,
    [jobId],
  );
  if (r.rowCount !== 1) throw new Error(`Pipeline-Journal für Job ${jobId} fehlt.`);
}

/**
 * Merkt den EB-Fachjob vor. Korrekturanweisung und Modellstufe der auslösenden
 * Wiederverarbeitung werden mitgespeichert, damit eine spätere Wiederholung
 * durch recoverPending() denselben Auftrag ausführt und nicht ohne sie.
 */
export async function noteEbPending(jobId, db = pool, { korrekturAnweisung = '', modelTier = null } = {}) {
  const r = await db.query(
    `UPDATE postbuch._pipeline_file_journal
        SET state='eb_pending', updated_at=NOW(),
            eb_korrektur_anweisung=$2, eb_model_tier=$3
      WHERE job_id=$1`,
    [jobId, korrekturAnweisung || null, modelTier || null],
  );
  if (r.rowCount !== 1) throw new Error(`Pipeline-Journal für Job ${jobId} fehlt.`);
}

export async function clear(jobId) {
  if (!jobId) return;
  await pool.query('DELETE FROM postbuch._pipeline_file_journal WHERE job_id=$1', [jobId]);
}

/**
 * Bestätigt einen fachlich abgeschlossenen EB. Muss noch eine ersetzte
 * Duplikat-Altdatei aufgeräumt werden, bleibt der Auftrag als db_complete stehen.
 */
export async function acknowledgeEbComplete(jobId) {
  const r = await pool.query(
    `UPDATE postbuch._pipeline_file_journal
        SET state='db_complete', updated_at=NOW()
      WHERE job_id=$1 AND state='eb_complete' AND replaced_storage_id IS NOT NULL
      RETURNING job_id`,
    [jobId],
  );
  if (r.rowCount === 0) {
    await pool.query(
      `DELETE FROM postbuch._pipeline_file_journal
        WHERE job_id=$1 AND state='eb_complete'`,
      [jobId],
    );
  }
}

function postidImNamen(name, postid) {
  return typeof name === 'string'
    && new RegExp(`(?:^|\\s)${postid}(?:\\.pdf|\\s|$)`, 'i').test(name);
}

async function findeDatei(storage, row) {
  try {
    const meta = await storage.getMeta(row.storage_id);
    if (meta && !meta.isFolder) return meta;
  } catch { /* nach Crash kann sich die Nextcloud-ID beim MOVE geändert haben */ }

  if (!row.target_folder_id) return null;
  const treffer = (await storage.listChildren(row.target_folder_id))
    .filter((item) => !item.isFolder && postidImNamen(item.name, row.postid));
  return treffer.length === 1 ? treffer[0] : null;
}

/** Hält die gültige Altzeile nach einem bereits erfolgten Same-File-Move aktuell. */
export async function reconcileReplacementFile({ postid, storageBackend, meta }, db = pool) {
  if (!postid || !storageBackend || !meta?.id) {
    throw new Error('Datei-Reconciliation braucht PostID, Backend und Datei-Metadaten.');
  }
  const legacy = legacyOnedriveWerte(storageBackend, {
    id: meta.id,
    name: meta.name || null,
    modified: meta.lastModified || null,
  });
  const r = await db.query(
    `UPDATE postbuch.postbuch
        SET storage_id=$2, storage_backend=$3,
            storage_filename=COALESCE($4, storage_filename),
            storage_modified=COALESCE($5, storage_modified),
            link=COALESCE($6, link),
            onedrive_id=$7,
            onedrive_filename=$8,
            onedrive_modified=$9
      WHERE postid=$1`,
    [postid, meta.id, storageBackend, meta.name || null, meta.lastModified || null,
      meta.webUrl || null, legacy.id, legacy.name, legacy.modified],
  );
  if (r.rowCount !== 1) throw new Error(`Altzeile ${postid} für Datei-Reconciliation fehlt.`);
}

/** Verarbeitet ausschließlich persistierte Journalzeilen; kein Storage-Scan. */
export async function recoverPending(settings, { onEbPending } = {}) {
  if (recoveryLaeuft) return { skipped: true };
  recoveryLaeuft = true;
  const summary = { found: 0, completed: 0, failed: 0, unresolved: 0 };
  try {
    const { rows } = await pool.query(
      `SELECT j.*, p.storage_id AS db_storage_id
         FROM postbuch._pipeline_file_journal j
         LEFT JOIN postbuch.postbuch p ON p.postid=j.postid
        ORDER BY j.created_at`,
    );
    summary.found = rows.length;
    // Dieser Sweep läuft nicht nur einmal nach einem Absturz, sondern auch alle
    // 5 Minuten während des laufenden Betriebs (index.js pipelineRecoveryTimer).
    // Eine frisch angelegte Journalzeile ('prepared'/'move_intent') hat noch
    // keine zugehörige postbuch-Zeile (db_storage_id ist NULL) — das ist bei
    // einem noch laufenden Job normal, nicht nur nach einem Crash. Ohne diese
    // Prüfung wurde eine solche Zeile fälschlich als "durch Prozessabbruch
    // unterbrochen" behandelt, während der zugehörige Job im selben Prozess
    // noch aktiv war: die Datei landete live unter den Augen der Pipeline in
    // _failed, und der eigentliche Job brach kurz danach mit "Pipeline-Journal
    // fehlt" ab, weil seine Zeile schon gelöscht war.
    //
    // Die Prüfung darf keine zu Schleifenbeginn eingefrorene Momentaufnahme
    // sein: Jede Zeile braucht Storage-Aufrufe (findeDatei), die Schleife kann
    // also mehrere Sekunden laufen. isActive() fragt deshalb bewusst live und
    // pro Zeile ab, unmittelbar bevor sie angefasst wird — nicht einmal vorab
    // für alle Zeilen zusammen.
    for (const row of rows) {
      if (isJobActive(row.job_id)) continue;
      // Basis- und Spezialinsert des Dokuments sind vollständig committed; nur
      // der bewusst separate EB-Matchingjob steht noch aus. Der Marker bleibt
      // bis zu dessen Erfolg bestehen und ist damit eine persistente Outbox.
      if (row.state === 'eb_pending' && row.db_storage_id) {
        if (onEbPending) {
          onEbPending(row.postid, row.job_id, {
            korrekturAnweisung: row.eb_korrektur_anweisung || '',
            modelTier: row.eb_model_tier || null,
          });
        }
        summary.completed++;
        continue;
      }
      if (row.state === 'eb_complete') {
        await acknowledgeEbComplete(row.job_id);
        if (!row.replaced_storage_id) {
          summary.completed++;
          continue;
        }
        // Mit ausstehender Duplikat-Altdatei fällt die weitere Behandlung in
        // denselben Cleanup-Pfad wie db_complete.
        row.state = 'db_complete';
      }
      const storage = getAdapter(row.storage_backend);
      let meta;
      try {
        meta = await findeDatei(storage, row);
      } catch (err) {
        summary.unresolved++;
        appLog('ERROR', 'pipeline-recovery',
          `Unterbrochene Pipeline ${row.postid}: Ablage nicht prüfbar`,
          { details: err.message, entity: 'postbuch', entityId: row.postid });
        continue;
      }

      // Vollständiger Haupt- UND Spezialinsert wurde vor dem Absturz bestätigt.
      // Bei einer Duplikat-Ersetzung gehört auch das Aufräumen der ersetzten
      // Altdatei zum persistenten Abschluss.
      if (row.state === 'db_complete' && row.db_storage_id && meta?.id === row.db_storage_id) {
        if (row.replacement_mode === 'duplicate' && row.replaced_storage_id
            && row.replaced_storage_id !== row.db_storage_id) {
          try {
            await storage.moveToTrash(
              row.replaced_storage_id,
              `Ersetzt ${row.postid} ${row.replaced_filename || ''}`.trim(),
            );
          } catch (err) {
            summary.unresolved++;
            appLog('ERROR', 'pipeline-recovery',
              `Ersetzte Altdatei ${row.postid} konnte nicht aufgeräumt werden`,
              { details: err.message, entity: 'postbuch', entityId: row.postid });
            continue;
          }
        }
        await clear(row.job_id);
        summary.completed++;
        continue;
      }

      // Same-File-Moves können bei OneDrive dieselbe ID behalten. Trotzdem
      // müssen Name, Link und Änderungszeit nach einem Crash zwischen MOVE und
      // noteMoved abgeglichen werden; daher vor dem generischen Gleichheitsfall.
      if ((row.state === 'move_intent' || row.state === 'moved')
          && row.db_storage_id && row.replacement_mode === 'same_file') {
        await reconcileReplacementFile({
          postid: row.postid,
          storageBackend: row.storage_backend,
          meta,
        });
        await clear(row.job_id);
        summary.completed++;
        continue;
      }

      // Wiederverarbeitung brach ab, bevor die alte Zeile gelöscht oder die
      // Datei bewegt wurde. Das unveränderte Original bleibt gültig.
      if ((row.state === 'prepared' || row.state === 'move_intent')
          && row.db_storage_id && meta?.id === row.db_storage_id) {
        await clear(row.job_id);
        summary.completed++;
        continue;
      }

      if (!meta?.id) {
        summary.unresolved++;
        appLog('ERROR', 'pipeline-recovery',
          `Unterbrochene Pipeline ${row.postid}: Datei nicht eindeutig auffindbar`,
          { entity: 'postbuch', entityId: row.postid });
        continue;
      }


      // Eine Hauptzeile ohne db_complete kann nach einem Kill zwischen Basis-
      // und Spezialinsert existieren. Nur im Zustand "moved" ist sie sicher
      // eine von dieser Pipeline erzeugte Teilzeile; alte Ersetzungsziele in
      // prepared/move_intent bleiben unangetastet.
      if (row.state === 'moved' && row.db_storage_id && !row.replacement_mode) {
        await pool.query('DELETE FROM postbuch.postbuch WHERE postid=$1', [row.postid]);
      }

      const reason = `Pipeline durch Prozessabbruch unterbrochen (${row.postid})`;
      try {
        await failedHandler.moveToFailed({
          onedriveFileId: meta.id,
          storageBackend: row.storage_backend,
          reason,
          detail: `Recovery aus Journalstatus ${row.state}`,
          sourceJobId: row.job_id,
          documentType: null,
          settings,
        });
        await clear(row.job_id);
        summary.failed++;
        appLog('ERROR', 'pipeline-recovery', `${reason} → _failed verschoben`,
          { entity: 'postbuch', entityId: row.postid });
      } catch (err) {
        summary.unresolved++;
        const orphanId = err.storageMoved?.id || meta.id;
        if (err.storageMoved?.id) {
          await noteMoved(row.job_id, err.storageMoved.id, err.storageMoved.name || null)
            .catch(() => {});
        }
        await failedHandler.recordOrphanedFailed({
          onedriveFileId: orphanId,
          reason,
          detail: `Recovery aus Journalstatus ${row.state}`,
          sourceJobId: row.job_id,
          note: `_failed-Move fehlgeschlagen: ${err.message}`,
          backend: row.storage_backend,
        }).catch(() => {});
        appLog('ERROR', 'pipeline-recovery',
          `${reason}: _failed-Move fehlgeschlagen`,
          { details: err.message, entity: 'postbuch', entityId: row.postid });
      }
    }
    return summary;
  } finally {
    recoveryLaeuft = false;
  }
}
