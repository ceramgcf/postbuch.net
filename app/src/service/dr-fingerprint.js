/**
 * service/dr-fingerprint.js — SHA256-Fingerabdrücke für Disaster Recovery
 *
 * Pflegt für jede Postbuch-Datei mit Ablage-ID drei Felder:
 *   - sha256             Hex-Digest des Dateiinhalts
 *   - storage_filename   Aktueller Dateiname in der Ablage
 *   - storage_modified   Änderungszeitpunkt in der Ablage
 *
 * Damit kann im Disaster-Fall (ein Restore in der Ablage ändert die FileIDs)
 * über den SHA256-Match die korrekte File-ID wiederhergestellt werden.
 *
 * Zwei Operationen:
 *   - syncFingerprints({ jobId }) — vollständiger Lauf (Initial + Wartung in einem)
 *     Iteriert über alle postbuch-Zeilen mit storage_id; gleicht storage_modified ab,
 *     lädt nur dann neu herunter und hasht, wenn sich das Änderungsdatum geändert hat
 *     oder noch kein sha256 vorhanden ist. Aktualisiert auch storage_filename.
 */

import { createHash } from 'node:crypto';
import db from '../db.js';
import { getAdapter } from '../lib/storage/index.js';
import * as tracker from '../jobs/tracker.js';
import { appLog } from '../app-log.js';
import { istBestaetigterDateiFehlt, markiereDateiFehlend } from './storage-missing.js';

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Synchronisiert die Fingerprint-Felder für alle postbuch-Zeilen mit storage_id.
 * Jede Zeile wird gegen ihr eigenes Backend geprüft (storage_backend), damit ein
 * Mischbestand während einer Migration korrekt behandelt wird.
 *
 * Ablauf pro Zeile:
 *   1. Metadaten holen (name, lastModified).
 *   2. Wenn sha256 fehlt ODER lastModified sich geändert hat:
 *      → Datei herunterladen, sha256 berechnen, alle drei Felder aktualisieren.
 *   3. Wenn nur der Dateiname sich geändert hat:
 *      → Nur storage_filename aktualisieren (kein Download).
 *   4. Bei einem bestätigten 404 gilt die Datei als endgültig verschwunden: die
 *      Verknüpfung wird über markiereDateiFehlend() gelöst (siehe
 *      storage-missing.js), damit ein wöchentlicher Lauf dasselbe leistet wie
 *      der manuelle "Ablage auf fehlende Dateien prüfen"-Scan, ohne die Ablage
 *      dafür ein zweites Mal komplett abzufragen. Jeder andere Fehler
 *      (Netzwerk/Auth/Timeout) wird nur übersprungen und geloggt.
 *
 * @param {object}   options
 * @param {string?}  options.jobId    Optionale Job-ID für Fortschrittsanzeige
 * @returns {Promise<{ scanned: number, hashed: number, renamed: number, missing: number, skipped: number, errors: number }>}
 */
export async function syncFingerprints({ jobId = null } = {}) {
  const rows = await db.query(
    `SELECT postid, storage_id, storage_backend, sha256, storage_modified, storage_filename
       FROM postbuch.postbuch
      WHERE storage_id IS NOT NULL
      ORDER BY postid`
  );

  const total = rows.rows.length;
  if (jobId) tracker.setStep(jobId, 0, `0 / ${total} geprüft`);

  let scanned = 0;
  let hashed = 0;
  let renamed = 0;
  let missing = 0;
  let skipped = 0;
  let errors = 0;

  for (const row of rows.rows) {
    if (jobId && tracker.isCancelled(jobId)) break;

    scanned++;
    try {
      const storage = getAdapter(row.storage_backend);
      const meta = await storage.getMeta(row.storage_id);

      const oldModified = row.storage_modified ? new Date(row.storage_modified).toISOString() : null;
      const newModified = meta.lastModified ? new Date(meta.lastModified).toISOString() : null;
      const needsHash = !row.sha256 || (newModified && newModified !== oldModified);

      if (needsHash) {
        const buf = await storage.download(row.storage_id);
        const digest = sha256Hex(buf);
        await db.query(
          `UPDATE postbuch.postbuch
              SET sha256 = $2,
                  storage_filename = $3, onedrive_filename = $3,
                  storage_modified = $4, onedrive_modified = $4
            WHERE postid = $1`,
          [row.postid, digest, meta.name, meta.lastModified]
        );
        hashed++;
      } else if (row.storage_filename !== meta.name) {
        await db.query(
          `UPDATE postbuch.postbuch
              SET storage_filename = $2, onedrive_filename = $2
            WHERE postid = $1`,
          [row.postid, meta.name]
        );
        renamed++;
      } else {
        skipped++;
      }
    } catch (err) {
      if (istBestaetigterDateiFehlt(err)) {
        await markiereDateiFehlend(row.postid, 'dr-fingerprint');
        missing++;
      } else {
        errors++;
        appLog('WARN', 'dr-fingerprint',
          `Fingerprint-Sync ${row.postid} fehlgeschlagen: ${err.message}`,
          { entity: 'postbuch', entityId: row.postid }
        );
      }
    }

    if (jobId) {
      tracker.setStep(jobId, scanned, `${scanned} / ${total} geprüft (${hashed} neu gehasht)`);
    }
  }

  return { scanned, hashed, renamed, missing, skipped, errors, total };
}

/**
 * Gibt zurück, wie viele postbuch-Zeilen einen sha256 haben bzw. fehlen.
 * Wird für Status-Anzeige im DR-Wizard genutzt.
 */
export async function getFingerprintStats() {
  const result = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE storage_id IS NOT NULL) AS with_onedrive,
       COUNT(*) FILTER (WHERE storage_id IS NOT NULL AND sha256 IS NOT NULL) AS with_sha256,
       COUNT(*) FILTER (WHERE storage_id IS NOT NULL AND sha256 IS NULL) AS missing_sha256
     FROM postbuch.postbuch`
  );
  const r = result.rows[0];
  return {
    withOnedrive: Number(r.with_onedrive),
    withSha256: Number(r.with_sha256),
    missingSha256: Number(r.missing_sha256),
  };
}
