/**
 * jobs/scan-retry-job.js — Exponentieller Backoff-Retry für fehlgeschlagene Scan-Uploads.
 *
 * Wenn Phase 0 (OneDrive-Upload) scheitert, liegt das PDF im lokalen Scan-Buffer
 * (/data/scan_buffer/<jobId>.pdf) und ein Eintrag in _scan_retry_queue wartet auf Retry.
 *
 * Dieser Job läuft alle 5 Minuten und verarbeitet fällige Einträge (next_retry_at <= now()).
 * Backoff: 30min → 1h → 2h → 4h → 8h → 16h → 32h → 64h → 128h → 256h (ca. 10,7 Tage)
 * Nach max_retries: status = 'manual_only', prominentes Dashboard-Banner.
 *
 * Fehlt die gepufferte Datei (Restore auf eine andere Maschine – die Sicherung
 * enthält die Tabelle, aber nicht den Scan-Buffer – oder ein geleerter Buffer),
 * gibt es nichts mehr zu wiederholen: Der Eintrag wird entfernt, statt tagelang
 * als „wartet auf Upload“ im Dashboard zu stehen.
 */

import pool from '../db.js';
import * as tracker from './tracker.js';
import { enqueueDocument } from './pipeline-queue.js';
import { readScanBuffer, scanBufferVorhanden } from '../lib/scan-buffer.js';
import { appLog } from '../app-log.js';

const BASE_INTERVAL_MIN = 30;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

async function entferneEintrag(row, grund) {
  await pool.query('DELETE FROM postbuch._scan_retry_queue WHERE job_id = $1', [row.job_id]);
  appLog('WARN', 'scan-retry-job',
    `Retry-Eintrag entfernt: ${row.original_filename} – ${grund}`,
    { details: `jobId=${row.job_id}` }
  );
}

/** Einträge ohne gepufferte Datei entfernen (beim Start, z. B. nach einem Restore). */
async function entferneVerwaiste() {
  const { rows } = await pool.query('SELECT job_id, original_filename FROM postbuch._scan_retry_queue');
  for (const row of rows) {
    if (!(await scanBufferVorhanden(row.job_id))) {
      await entferneEintrag(row, 'gepufferte Scan-Datei fehlt');
    }
  }
}

async function sweep() {
  let rows;
  try {
    const result = await pool.query(
      `SELECT * FROM postbuch._scan_retry_queue
       WHERE status = 'pending' AND next_retry_at <= now()
       ORDER BY next_retry_at ASC
       LIMIT 5`
    );
    rows = result.rows;
  } catch (e) {
    console.error(`[scan-retry-job] DB-Abfrage fehlgeschlagen: ${e.message}`);
    return;
  }

  for (const row of rows) {
    try {
      const pdfBuffer = await readScanBuffer(row.job_id);

      const newJobId = tracker.create(
        'scan-retry',
        `Retry: ${row.original_filename} (Versuch ${row.retry_count + 1})`,
        10
      );

      enqueueDocument(
        // fromScanner: true — dies ist ein erneuter Anlauf eines echten Scans, dessen
        // OCR-Textebene (Tesseract) vor der KI-Analyse verworfen werden soll.
        { pdfBuffer, filename: row.original_filename, fromScanner: true, _retrySourceJobId: row.job_id },
        newJobId,
        0
      );

      appLog('INFO', 'scan-retry-job',
        `Retry gestartet: ${row.original_filename} (Versuch ${row.retry_count + 1}, newJobId=${newJobId})`,
        { details: `originalJobId=${row.job_id}` }
      );
    } catch (err) {
      if (err.code === 'ENOENT') {
        await entferneEintrag(row, 'gepufferte Scan-Datei fehlt')
          .catch(e => console.error(`[scan-retry-job] DELETE fehlgeschlagen: ${e.message}`));
        continue;
      }
      const newRetryCount = row.retry_count + 1;
      const reachedMax = newRetryCount >= row.max_retries;

      appLog('WARN', 'scan-retry-job',
        `Retry fehlgeschlagen: ${row.original_filename} (Versuch ${newRetryCount}${reachedMax ? ' — max_retries erreicht' : ''}): ${err.message}`
      );

      if (reachedMax) {
        await pool.query(
          `UPDATE postbuch._scan_retry_queue
           SET status = 'manual_only', retry_count = $1, last_error = $2
           WHERE job_id = $3`,
          [newRetryCount, err.message, row.job_id]
        ).catch(e => console.error(`[scan-retry-job] UPDATE manual_only fehlgeschlagen: ${e.message}`));
      } else {
        const backoffMin = Math.min(
          BASE_INTERVAL_MIN * Math.pow(2, newRetryCount),
          10080 // 7 Tage in Minuten
        );
        await pool.query(
          `UPDATE postbuch._scan_retry_queue
           SET retry_count = $1,
               next_retry_at = now() + ($2 || ' minutes')::interval,
               last_error = $3
           WHERE job_id = $4`,
          [newRetryCount, Math.round(backoffMin), err.message, row.job_id]
        ).catch(e => console.error(`[scan-retry-job] UPDATE retry fehlgeschlagen: ${e.message}`));
      }
    }
  }
}

export function startScanRetryJob() {
  entferneVerwaiste()
    .catch(e => console.error(`[scan-retry-job] Aufräumen verwaister Einträge fehlgeschlagen: ${e.message}`))
    .then(() => sweep())
    .catch(e => console.error(`[scan-retry-job] Initialer Sweep fehlgeschlagen: ${e.message}`));
  setInterval(
    () => sweep().catch(e => console.error(`[scan-retry-job] Sweep fehlgeschlagen: ${e.message}`)),
    SWEEP_INTERVAL_MS
  );
  console.log('[scan-retry-job] Gestartet (Intervall: 5 Minuten)');
}
