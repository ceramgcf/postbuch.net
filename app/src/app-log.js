import { query } from './db.js';

const MAX_APP_LOG_ENTRIES = 2000;

/**
 * Fire-and-forget helper to write a system-level log entry (errors, warnings, service events).
 * Never throws — logging failures must not interrupt the caller.
 *
 * @param {'INFO'|'WARN'|'ERROR'} level  - Severity level
 * @param {string} source                - Module/service name, e.g. 'doc-processor', 'onedrive', 'llm'
 * @param {string} message               - Short description (max 500 chars)
 * @param {object} [opts]
 * @param {string} [opts.details]        - Longer context / stack trace (max 2000 chars)
 * @param {string} [opts.entity]         - Related entity type: 'postbuch', 'akte', ...
 * @param {string} [opts.entityId]       - Related entity ID: PostID, AkteID, ...
 */
export async function appLog(level, source, message, { details, entity, entityId } = {}) {
  try {
    const shortMsg = message ? String(message).slice(0, 500) : '';
    const shortDetails = details ? String(details).slice(0, 2000) : null;
    await query(
      `INSERT INTO app_log (level, source, message, details, entity, entity_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [level, source, shortMsg, shortDetails, entity || null, entityId || null]
    );
    // Retention: keep only the newest MAX_APP_LOG_ENTRIES rows
    await query(
      `DELETE FROM app_log WHERE id <= (
         SELECT id FROM app_log ORDER BY id DESC OFFSET $1 LIMIT 1
       )`,
      [MAX_APP_LOG_ENTRIES - 1]
    );
  } catch (err) {
    console.error('appLog failed (non-critical):', err.message);
  }
}
