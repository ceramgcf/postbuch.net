/**
 * service/storage-missing.js — Datei in der Ablage bestätigt verschwunden.
 *
 * Ein einziger Helfer für alle Stellen, die auf eine Ablage-Operation mit
 * einem HARTEN 404 reagieren (nicht auf Netzwerk-/Auth-/Timeout-Fehler — die
 * dürfen niemals als "Datei weg" missverstanden werden, sonst verliert ein
 * Dokument bei einer kurzen Störung der Ablage seine Verknüpfung). Bündelt
 * das Feld-Nullen, das bisher an zwei Stellen (storage-migration.js
 * restOhneDatei(), dr-recovery.js resolveLeaveUnlinked()) redundant
 * implementiert war.
 *
 * storage_backend bleibt stehen (NOT NULL, Default 'onedrive') — nur die
 * Verknüpfung zur (verschwundenen) Datei wird gelöst. sha256 bleibt ebenfalls
 * stehen: er beschreibt den zuletzt bekannten Inhalt, nicht den Ablageplatz,
 * und hilft beim späteren Wiederfinden/Reimportieren.
 */

import db from '../db.js';
import { appLog } from '../app-log.js';

/** War das ein bestätigter „Datei nicht gefunden"-Fehler der Ablage?
 *  Beide Adapter (onedrive.js, nextcloud.js) tragen dafür `.status` — ein
 *  Netzwerkfehler, Timeout oder Auth-Fehler hat dieses Feld nicht (oder einen
 *  anderen Wert) und darf hier NIE als "Datei weg" durchgehen. */
export function istBestaetigterDateiFehlt(err) {
  return err?.status === 404;
}

/**
 * Löst die Ablage-Verknüpfung eines Dokuments, weil die Ablage selbst mit
 * einem bestätigten 404 geantwortet hat. Wirft nie — ein Fehler beim Nullen
 * ist immer schwerwiegender als der ursprüngliche Aufrufkontext und wird nur
 * geloggt.
 *
 * @param {string} postid
 * @param {string} quelle  Kontext fürs Log (z. B. 'relocate', 'storage-scan')
 */
export async function markiereDateiFehlend(postid, quelle) {
  try {
    await db.query(
      `UPDATE postbuch.postbuch
          SET storage_id = NULL, onedrive_id = NULL,
              storage_filename = NULL, onedrive_filename = NULL,
              storage_modified = NULL, onedrive_modified = NULL,
              link = NULL
        WHERE postid = $1`,
      [postid]
    );
    appLog('WARN', quelle,
      `${postid}: Datei in der Ablage nicht mehr gefunden (404) — Verknüpfung gelöst`,
      { entity: 'postbuch', entityId: postid });
  } catch (err) {
    appLog('ERROR', quelle,
      `${postid}: Verknüpfung konnte nach bestätigtem 404 nicht gelöst werden: ${err.message}`,
      { entity: 'postbuch', entityId: postid });
  }
}
