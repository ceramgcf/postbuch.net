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
import { enqueueDocument, pufferInArbeit } from './pipeline-queue.js';
import { readScanBuffer, scanBufferVorhanden } from '../lib/scan-buffer.js';
import { appLog } from '../app-log.js';

const BASE_INTERVAL_MIN = 30;
const MAX_INTERVAL_MIN = 10080; // 7 Tage
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

/**
 * Übernimmt einen fälligen Eintrag für genau einen Versuch: zählt ihn und
 * schiebt den nächsten Termin hinaus. Wer keine Zeile zurückbekommt, hat gegen
 * einen anderen Auslöser verloren.
 *
 * Bei einem ausgeschöpften Eintrag (`manual_only`) gibt es keinen nächsten
 * Termin; `next_retry_at` wirkt dort nur als Sperrfrist gegen Doppelauslösung.
 *
 * „Jetzt erneut versuchen“ an einem noch wartenden Eintrag übergeht den
 * Termin (`sofortBeiVersuch`). Gegen Doppelauslösung wirkt dann der gesehene
 * Versuchszähler: Nur wer ihn unverändert vorfindet, übernimmt.
 *
 * @param {string} jobId
 * @param {{ auchAusgeschoepft?: boolean, sofortBeiVersuch?: number|null }} [opts]
 * @returns {Promise<object|null>} die übernommene Zeile
 */
export async function uebernimmVersuch(jobId, { auchAusgeschoepft = false, sofortBeiVersuch = null } = {}) {
  const { rows } = await pool.query(
    `UPDATE postbuch._scan_retry_queue
        SET retry_count = retry_count + 1,
            next_retry_at = now() + make_interval(mins =>
              LEAST($3::int * power(2, LEAST(retry_count + 1, 20))::int, $4::int))
      WHERE job_id = $1
        AND (next_retry_at <= now()
             OR (status = 'pending' AND retry_count = $5::int))
        AND (status = 'pending' OR ($2::boolean AND status = 'manual_only'))
      RETURNING *`,
    [jobId, auchAusgeschoepft, BASE_INTERVAL_MIN, MAX_INTERVAL_MIN, sofortBeiVersuch],
  );
  return rows[0] || null;
}

/** Reiht den übernommenen Versuch als Pipeline-Lauf ein. */
export async function starteVersuch(row, { manuelleErfassung = null } = {}) {
  const pdfBuffer = await readScanBuffer(row.job_id);
  const newJobId = tracker.create(
    'scan-retry',
    manuelleErfassung
      ? `Manuelle Ablage: ${row.original_filename}`
      : `Retry: ${row.original_filename} (Versuch ${row.retry_count})`,
    10
  );
  enqueueDocument(
    // fromScanner: true – dies ist ein erneuter Anlauf eines echten Scans, dessen
    // OCR-Textebene (Tesseract) vor der KI-Analyse verworfen werden soll.
    {
      pdfBuffer, filename: row.original_filename, fromScanner: true, _retrySourceJobId: row.job_id,
      ...(manuelleErfassung ? { manuelleErfassung } : {}),
    },
    newJobId,
    0,
    { label: row.original_filename, pufferJobId: row.job_id }
  );
  return newJobId;
}

/** Der Versuch kam nicht zustande (PDF nicht lesbar): Fehler am Eintrag vermerken. */
export async function vermerkeFehlversuch(row, err) {
  const reachedMax = row.retry_count >= row.max_retries;
  appLog('WARN', 'scan-retry-job',
    `Retry fehlgeschlagen: ${row.original_filename} (Versuch ${row.retry_count}${reachedMax ? ' – max_retries erreicht' : ''}): ${err.message}`
  );
  await pool.query(
    `UPDATE postbuch._scan_retry_queue
        SET last_error = $2,
            status = CASE WHEN retry_count >= max_retries THEN 'manual_only' ELSE status END,
            next_retry_at = CASE WHEN status = 'manual_only' OR retry_count >= max_retries
                                 THEN now() ELSE next_retry_at END
      WHERE job_id = $1`,
    [row.job_id, err.message],
  ).catch(e => console.error(`[scan-retry-job] UPDATE nach Fehlversuch fehlgeschlagen: ${e.message}`));
}

async function sweep() {
  let rows;
  try {
    const result = await pool.query(
      `SELECT job_id FROM postbuch._scan_retry_queue
       WHERE status = 'pending' AND next_retry_at <= now()
       ORDER BY next_retry_at ASC
       LIMIT 5`
    );
    rows = result.rows;
  } catch (e) {
    console.error(`[scan-retry-job] DB-Abfrage fehlgeschlagen: ${e.message}`);
    return;
  }

  for (const { job_id: jobId } of rows) {
    // Ein früherer Versuch steht noch in der Warteschlange (etwa bei
    // angehaltener Pipeline): kein zweiter Lauf für dasselbe PDF.
    if (pufferInArbeit(jobId)) continue;
    let row = null;
    try {
      row = await uebernimmVersuch(jobId);
      if (!row) continue;
      const newJobId = await starteVersuch(row);
      appLog('INFO', 'scan-retry-job',
        `Retry gestartet: ${row.original_filename} (Versuch ${row.retry_count}, newJobId=${newJobId})`,
        { details: `originalJobId=${row.job_id}` }
      );
    } catch (err) {
      if (!row) {
        console.error(`[scan-retry-job] Übernahme von ${jobId} fehlgeschlagen: ${err.message}`);
        continue;
      }
      if (err.code === 'ENOENT') {
        await entferneEintrag(row, 'gepufferte Scan-Datei fehlt')
          .catch(e => console.error(`[scan-retry-job] DELETE fehlgeschlagen: ${e.message}`));
        continue;
      }
      await vermerkeFehlversuch(row, err);
    }
  }
}

/**
 * Nach einem Neustart läuft kein Versuch mehr. Eine Sperrfrist an einem
 * ausgeschöpften Eintrag würde ihn sonst grundlos blockieren.
 */
async function loeseSperrfristen() {
  await pool.query(
    `UPDATE postbuch._scan_retry_queue SET next_retry_at = now()
      WHERE status = 'manual_only' AND next_retry_at > now()`);
}

export function startScanRetryJob() {
  entferneVerwaiste()
    .then(() => loeseSperrfristen())
    .catch(e => console.error(`[scan-retry-job] Aufräumen verwaister Einträge fehlgeschlagen: ${e.message}`))
    .then(() => sweep())
    .catch(e => console.error(`[scan-retry-job] Initialer Sweep fehlgeschlagen: ${e.message}`));
  setInterval(
    () => sweep().catch(e => console.error(`[scan-retry-job] Sweep fehlgeschlagen: ${e.message}`)),
    SWEEP_INTERVAL_MS
  );
  console.log('[scan-retry-job] Gestartet (Intervall: 5 Minuten)');
}
