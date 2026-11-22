/**
 * jobs/pipeline-auftrag.js – dauerhafte Spur angenommener Pipeline-Aufträge
 *
 * Die Warteschlange selbst lebt im Speicher. Was einen Neustart überstehen
 * muss, steht zusätzlich in postbuch._pipeline_auftrag:
 *   - Uploads und Scans, deren PDF erst im lokalen Puffer liegt
 *     (puffer_job_id → /data/scan_buffer/<id>.pdf),
 *   - zurückgestellte Aufträge (status 'wartet', faellig_ab).
 * Dateien aus der Inbox brauchen keine Zeile, solange sie nicht warten: der
 * Watcher findet sie nach einem Neustart von selbst wieder.
 */

import pool from '../db.js';

/** Pipeline-Input ohne Buffer und ohne flüchtige Steuerfelder. */
function eingangOhnePuffer(input) {
  const { pdfBuffer, preclaimedInFlight, _zurueckstellbar, _letzterVersuch, ...rest } = input || {};
  return rest;
}

export async function sichere({ jobId, label, stepOffset = 0, input, pufferJobId = null }) {
  await pool.query(
    `INSERT INTO postbuch._pipeline_auftrag (job_id, label, step_offset, eingang, puffer_job_id)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     ON CONFLICT (job_id) DO UPDATE
       SET eingang = EXCLUDED.eingang, puffer_job_id = EXCLUDED.puffer_job_id,
           status = 'eingereiht', geaendert_am = now()`,
    [jobId, label || 'Dokument', stepOffset, JSON.stringify(eingangOhnePuffer(input)), pufferJobId],
  );
}

export async function parke({ jobId, label, stepOffset = 0, input, pufferJobId = null, versuch, faelligAb, grund }) {
  await pool.query(
    `INSERT INTO postbuch._pipeline_auftrag
       (job_id, label, step_offset, eingang, puffer_job_id, status, versuch, faellig_ab, letzter_fehler)
     VALUES ($1, $2, $3, $4::jsonb, $5, 'wartet', $6, $7, $8)
     ON CONFLICT (job_id) DO UPDATE
       SET eingang = EXCLUDED.eingang, puffer_job_id = EXCLUDED.puffer_job_id,
           status = 'wartet', versuch = EXCLUDED.versuch, faellig_ab = EXCLUDED.faellig_ab,
           letzter_fehler = EXCLUDED.letzter_fehler, geaendert_am = now()`,
    [jobId, label || 'Dokument', stepOffset, JSON.stringify(eingangOhnePuffer(input)),
      pufferJobId, versuch, faelligAb, grund || null],
  );
}

/**
 * Phase 0 hat das PDF in die Inbox hochgeladen: der Auftrag zeigt ab jetzt auf
 * die Datei, nicht mehr auf den Puffer. Nach einem Neustart übernimmt dann der
 * Watcher die Datei, statt den Puffer ein zweites Mal hochzuladen.
 */
export async function merkeAblageId(jobId, storageId, storageBackend) {
  await pool.query(
    `UPDATE postbuch._pipeline_auftrag
        SET eingang = eingang || jsonb_build_object('onedriveFileId', $2::text, 'storageBackend', $3::text),
            geaendert_am = now()
      WHERE job_id = $1 AND status = 'eingereiht'`,
    [jobId, storageId, storageBackend || null],
  );
}

export async function entferne(jobId) {
  await pool.query('DELETE FROM postbuch._pipeline_auftrag WHERE job_id = $1', [jobId]);
}

export async function alle() {
  const { rows } = await pool.query(
    'SELECT * FROM postbuch._pipeline_auftrag ORDER BY erstellt_am ASC',
  );
  return rows;
}
