import { query } from './db.js';

const MAX_LOG_ENTRIES = 1000;

/**
 * Fire-and-forget helper to write a ui_log entry and trim to MAX_LOG_ENTRIES.
 * Never throws — logging failures must not interrupt the request.
 *
 * @param {string} action    - Short verb: CREATE, UPDATE, DELETE, AI_EMBEDDING, AI_CALL, WEBHOOK
 * @param {string} entity    - Table/domain: postbuch, akte, arztrechnung, …
 * @param {string|null} entityId - Primary key value (postid, akteid, …)
 * @param {string|null} details  - One-liner with key fields (truncated to 200 chars)
 */
export async function uiLog(action, entity, entityId = null, details = null) {
  try {
    const shortDetails = details ? String(details).slice(0, 500) : null;
    await query(
      `INSERT INTO ui_log (action, entity, entity_id, details) VALUES ($1, $2, $3, $4)`,
      [action, entity, entityId, shortDetails]
    );
    // Retention: keep only the newest MAX_LOG_ENTRIES rows
    await query(
      `DELETE FROM ui_log WHERE id <= (
         SELECT id FROM ui_log ORDER BY id DESC OFFSET $1 LIMIT 1
       )`,
      [MAX_LOG_ENTRIES - 1]
    );
  } catch (err) {
    console.error('uiLog failed (non-critical):', err.message);
  }
}
