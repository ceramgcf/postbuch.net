/**
 * service/suspension-store.js — CRUD für _pipeline_suspensions
 */

import pool from '../db.js';

/**
 * @typedef {object} SuspensionRow
 * @property {string}  jobId
 * @property {string}  reason
 * @property {string}  onedriveId       Item-ID in der Ablage
 * @property {string}  [storageBackend] Default 'onedrive'
 * @property {string}  [onedriveWeburl]
 * @property {string}  reservedPostid
 * @property {string}  matchPostid
 * @property {string}  [matchWeburl]
 * @property {number}  [matchConfidence]
 * @property {number}  [similarity]
 * @property {number}  [newConfidence]
 * @property {number[] | null} embedding
 * @property {string | null} [embeddingSignature]
 * @property {object}  payload
 * @property {number}  stepOffset
 * @property {Date}    expiresAt
 * @property {string}  [discordMessageId]
 */

/**
 * Erstellt eine neue Suspension.
 * @param {SuspensionRow} row
 */
export async function create(row) {
  const embeddingLiteral = row.embedding
    ? '[' + row.embedding.join(',') + ']'
    : null;

  const result = await pool.query(
    `INSERT INTO postbuch._pipeline_suspensions
       (job_id, reason, onedrive_id, storage_id, storage_backend, onedrive_weburl,
        reserved_postid, match_postid,
        match_weburl, match_confidence, similarity, new_confidence, embedding,
        embedding_signature, payload, step_offset, expires_at)
     VALUES ($1,$2,$3,$3,$16,$4,$5,$6,$7,$8,$9,$10,$11::halfvec,$12,$13,$14,$15)
     RETURNING *`,
    [
      row.jobId,
      row.reason,
      row.onedriveId,
      row.onedriveWeburl ?? null,
      row.reservedPostid,
      row.matchPostid,
      row.matchWeburl ?? null,
      row.matchConfidence ?? null,
      row.similarity ?? null,
      row.newConfidence ?? null,
      embeddingLiteral,
      row.embeddingSignature ?? null,
      JSON.stringify(row.payload),
      row.stepOffset ?? 0,
      row.expiresAt,
      row.storageBackend ?? 'onedrive',
    ]
  );
  return result.rows[0];
}

/**
 * Lädt eine Suspension anhand der Job-ID.
 * @param {string} jobId
 */
export async function get(jobId) {
  const result = await pool.query(
    'SELECT * FROM postbuch._pipeline_suspensions WHERE job_id = $1',
    [jobId]
  );
  return result.rows[0] || null;
}

/**
 * Löscht eine Suspension.
 * @param {string} jobId
 */
export async function deleteOne(jobId) {
  await pool.query(
    'DELETE FROM postbuch._pipeline_suspensions WHERE job_id = $1',
    [jobId]
  );
}

/**
 * Sucht die aktuell offene Suspension zu einer Ablage-ID.
 *
 * Das ist die Objektberechtigung für /api/files/suspended/:fileId/pdf: nur die
 * Datei, über die gerade eine Duplikat-Entscheidung aussteht, darf gestreamt
 * werden — sonst wäre jede beliebige Datei der Ablage abrufbar.
 *
 * Kulanzfenster: der Timeout-Sweeper läuft im 60-Sekunden-Takt, eine gerade
 * abgelaufene Suspension ist also kurzzeitig noch in der UI sichtbar. 5 Minuten
 * Nachlauf verhindern, dass die Vorschau in diesem Fenster ins Leere läuft.
 *
 * @param {string} storageId
 * @returns {Promise<{ storage_backend: string }|null>}
 */
export async function findOpenByStorageId(storageId) {
  const result = await pool.query(
    `SELECT storage_backend FROM postbuch._pipeline_suspensions
      WHERE storage_id = $1
        AND expires_at > NOW() - INTERVAL '5 minutes'
      LIMIT 1`,
    [storageId]
  );
  return result.rows[0] || null;
}

/**
 * Gibt alle abgelaufenen Suspensions zurück.
 * @param {Date} [now]
 */
export async function listExpired(now = new Date()) {
  const result = await pool.query(
    'SELECT * FROM postbuch._pipeline_suspensions WHERE expires_at <= $1 ORDER BY expires_at ASC',
    [now]
  );
  return result.rows;
}

/**
 * Gibt alle Suspensions zurück (für Dashboard).
 */
export async function listAll() {
  const result = await pool.query(
    'SELECT * FROM postbuch._pipeline_suspensions ORDER BY created_at DESC'
  );
  return result.rows;
}
