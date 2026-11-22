/**
 * service/failed-handler.js — Zentralisierter Failed-Dokument-Handler
 *
 * Verschiebt eine Datei in den _failed-Ordner der Ablage und persistiert
 * den Fehlergrund in postbuch._failed_documents.
 */

import pool from '../db.js';
import { getAdapter } from '../lib/storage/index.js';
import { getActiveBackendName, getFolders } from '../config.js';

/**
 * Verschiebt eine Datei nach _failed und schreibt sie in die DB.
 *
 * @param {object} params
 * @param {string}  params.onedriveFileId  - Item-ID in der Ablage
 * @param {string}  params.reason          - Kurztext z.B. "KI-Fehler"
 * @param {string}  [params.detail]        - Ausführlicher Fehler (Stack etc.)
 * @param {string}  [params.sourceJobId]
 * @param {string}  [params.betreff]       - Betreff falls bereits bekannt
 * @param {string}  [params.documentType]  - Dokumenttyp falls bereits bekannt
 * @param {string}  [params.originalFilename] - Name des Eingangs vor der Umbenennung
 * @param {object}  params.settings        - Geladene Settings-Objekt
 * @returns {{ onedriveId: string, failedFilename: string, webUrl: string|null }}
 */
export async function moveToFailed({ onedriveFileId, storageBackend, reason, detail, sourceJobId, betreff, documentType, originalFilename, settings }) {
  const backend = storageBackend || getActiveBackendName(settings);
  const failedFolderId = getFolders(settings, backend).failed;
  // Wunschname. Der Adapter darf davon abweichen (Sanitisierung, oder ein
  // "(2)"-Suffix bei Namenskollision) — deshalb wird unten der tatsaechlich
  // vergebene Name uebernommen, nicht dieser hier.
  let failedFilename = `FAILED_${Date.now()}.pdf`;
  if (!failedFolderId) throw new Error(`_failed-Ordner für Backend "${backend}" fehlt.`);
  if (!onedriveFileId) throw new Error('Storage-ID für _failed-Move fehlt.');

  // Nicht verschlucken: Nur ein bestätigter Move darf als „in _failed" gelten.
  const moved = await getAdapter(backend).move(onedriveFileId, failedFolderId, failedFilename);
  const failedId = moved.id || onedriveFileId;
  const webUrl = moved.webUrl || null;
  if (moved.name) failedFilename = moved.name;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Der Eingangsname überlebt wiederholte Fehlschläge – auch wenn der Move
    // die ID ändert und die Zeile deshalb neu entsteht.
    const alt = await client.query(
      'SELECT original_filename FROM postbuch._failed_documents WHERE onedrive_id = ANY($1::text[]) AND original_filename IS NOT NULL LIMIT 1',
      [[onedriveFileId, failedId]]);
    const eingangsname = originalFilename || alt.rows[0]?.original_filename || null;
    if (failedId !== onedriveFileId) {
      await client.query('DELETE FROM postbuch._failed_documents WHERE onedrive_id=$1', [onedriveFileId]);
    }
    await client.query(
    `INSERT INTO postbuch._failed_documents
       (onedrive_id, storage_id, storage_backend, failed_filename, web_url, reason, detail, source_job_id, betreff, document_type, original_filename)
     VALUES ($1, $1, $9, $2, $3, $4, $5,
             (SELECT id FROM postbuch._jobs WHERE id=$6), $7, $8, $10)
     ON CONFLICT (onedrive_id) DO UPDATE SET
       storage_id = EXCLUDED.storage_id,
       storage_backend = EXCLUDED.storage_backend,
       failed_filename = EXCLUDED.failed_filename,
       web_url = EXCLUDED.web_url,
       reason = EXCLUDED.reason,
       detail = EXCLUDED.detail,
       source_job_id = EXCLUDED.source_job_id,
       betreff = EXCLUDED.betreff,
       document_type = EXCLUDED.document_type,
       original_filename = COALESCE(EXCLUDED.original_filename, postbuch._failed_documents.original_filename),
       failed_at = now()`,
      [failedId, failedFilename, webUrl, reason, detail ?? null, sourceJobId ?? null, betreff ?? null, documentType ?? null, backend, eingangsname]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // Der Storage-Move ist bereits erfolgt und nicht rückrollbar. Diese Daten
    // braucht das Journal besonders bei Nextcloud, wo ein MOVE die ID ändern
    // kann; ohne sie würde die spätere Recovery am alten Ort suchen.
    const persistErr = new Error(`_failed-Datei verschoben, Fehlerstatus aber nicht persistiert: ${err.message}`);
    persistErr.storageMoved = { id: failedId, name: failedFilename, webUrl };
    throw persistErr;
  } finally {
    client.release();
  }

  return { onedriveId: failedId, failedFilename, webUrl };
}

/**
 * S2: moveToFailed() schlug fehl — Datei liegt noch an ihrem bisherigen Ort.
 * Legt trotzdem einen DB-Eintrag an, damit die Datei in der Failed-Liste
 * sichtbar ist und manuell behandelt werden kann.
 */
export async function recordOrphanedFailed({ onedriveFileId, reason, detail, sourceJobId, note, backend }) {
  await pool.query(
    `INSERT INTO postbuch._failed_documents
       (onedrive_id, storage_id, storage_backend, failed_filename, reason, detail, source_job_id)
     VALUES ($1, $1, $6, $2, $3, $4,
             (SELECT id FROM postbuch._jobs WHERE id=$5))
     ON CONFLICT (onedrive_id) DO UPDATE SET
       reason        = EXCLUDED.reason,
       detail        = EXCLUDED.detail,
       source_job_id = EXCLUDED.source_job_id,
       failed_at     = now()`,
    [
      onedriveFileId,
      `orphaned_${sourceJobId || Date.now()}`,
      `[Datei nicht nach _failed verschoben] ${reason}`,
      note ? `${note}\n${detail || ''}` : (detail || null),
      sourceJobId || null,
      backend || 'onedrive',
    ]
  );
}
