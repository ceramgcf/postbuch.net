/**
 * service/storage-scan.js — Manueller Scan auf fehlende Dateien in der Ablage.
 *
 * Fragt für jedes Dokument mit gesetzter storage_id die Ablage direkt nach den
 * Metadaten. Nur ein bestätigter 404 löst markiereDateiFehlend() aus — jeder
 * andere Fehler (Netzwerk, Auth, Timeout) wird geloggt und übersprungen, damit
 * eine vorübergehende Störung der Ablage nie fälschlich Dokumente als fehlend
 * markiert (siehe storage-missing.js).
 */

import db from '../db.js';
import { loadDynamicSettings, getActiveBackendName } from '../config.js';
import { getAdapter } from '../lib/storage/index.js';
import { appLog } from '../app-log.js';
import { istBestaetigterDateiFehlt, markiereDateiFehlend } from './storage-missing.js';

export async function scanForMissingFiles(onProgress) {
  const settings = await loadDynamicSettings();
  const backend = getActiveBackendName(settings);
  const storage = getAdapter(backend);

  const rows = await db.query(
    `SELECT postid, storage_id
       FROM postbuch.postbuch
      WHERE storage_id IS NOT NULL AND storage_backend = $1
      ORDER BY postid`,
    [backend]
  );

  const total = rows.rows.length;
  onProgress?.({ schritt: 0, gesamt: Math.max(1, total), name: total ? 'Dateien werden geprüft' : 'Keine Dateien zu prüfen' });
  appLog('INFO', 'storage-scan', `Fehlende-Dateien-Scan gestartet — ${total} Dokument(e) mit Ablage-ID`);

  let checked = 0, missing = 0, errors = 0;
  let schritt = 0;
  for (const row of rows.rows) {
    try {
      await storage.getMeta(row.storage_id);
      checked++;
    } catch (err) {
      if (istBestaetigterDateiFehlt(err)) {
        await markiereDateiFehlend(row.postid, 'storage-scan');
        missing++;
      } else {
        errors++;
        appLog('WARN', 'storage-scan',
          `${row.postid}: Prüfung übersprungen (kein bestätigter 404): ${err.message}`);
      }
    } finally {
      schritt++;
      onProgress?.({ schritt, gesamt: Math.max(1, total), name: row.postid });
    }
  }

  appLog('INFO', 'storage-scan',
    `Fehlende-Dateien-Scan abgeschlossen — geprüft: ${checked}, fehlend markiert: ${missing}, übersprungen: ${errors}`);

  return { total, checked, missing, errors };
}
