/**
 * service/dokument-umbenennen.js – Dateinamen eines abgelegten Dokuments ändern
 *
 * Bearbeitet wird nur der Namensstamm; PostID und `.pdf` fügt das System an
 * (lib/storage/paths.js). Die Datei bleibt in ihrem Ordner: Backend und
 * Elternordner stammen aus der Dokumentzeile und den Metadaten der Ablage, nie
 * vom Client. Ablauf wie beim Umzug an den Sollort: getMeta → move → Zeile
 * aktualisieren.
 */

import pool from '../db.js';
import { getAdapter, legacyOnedriveWerte } from '../lib/storage/index.js';
import { baueDokumentDateiname, stammAusDateiname } from '../lib/storage/paths.js';
import { leseAuftraege } from '../jobs/pipeline-queue.js';
import { claimInFlight, releaseInFlight } from './document-processor.js';
import { laeuftErstattungsbescheid } from './document-inserter.js';
import { wirfBeiGeschuetztemReprocess } from './reprocess-protection.js';
import { appLog } from '../app-log.js';

function fehler(status, text) {
  return Object.assign(new Error(text), { status });
}

async function ladeZeile(postid) {
  const { rows } = await pool.query(
    `SELECT postid, storage_id, storage_backend, storage_filename, link
       FROM postbuch.postbuch WHERE postid = $1`, [postid]);
  if (!rows[0]) throw fehler(404, 'Dokument nicht gefunden');
  if (!rows[0].storage_id) throw fehler(409, 'Zu diesem Dokument liegt keine Datei in der Ablage.');
  return rows[0];
}

async function schreibeDatei(postid, backend, { id, name, webUrl, lastModified }) {
  const legacy = legacyOnedriveWerte(backend, { id, name, modified: lastModified || null });
  await pool.query(
    `UPDATE postbuch.postbuch
        SET storage_id = $2, storage_filename = $3, link = COALESCE($4, link),
            storage_modified = COALESCE($5, storage_modified),
            onedrive_id = $6, onedrive_filename = $7,
            onedrive_modified = COALESCE($8, onedrive_modified)
      WHERE postid = $1`,
    [postid, id, name, webUrl || null, lastModified || null, legacy.id, legacy.name, legacy.modified]);
}

/**
 * Aktueller Dateiname aus der Ablage. Weicht er vom gespeicherten ab (etwa
 * nach einer Unterbrechung zwischen Umbenennen und Speichern), wird die Zeile
 * dabei angeglichen.
 */
export async function leseDateiname(postid) {
  const zeile = await ladeZeile(postid);
  let name = zeile.storage_filename;
  try {
    const meta = await getAdapter(zeile.storage_backend).getMeta(zeile.storage_id);
    if (meta?.name && meta.name !== zeile.storage_filename) {
      await pool.query('UPDATE postbuch.postbuch SET storage_filename = $2 WHERE postid = $1', [postid, meta.name]);
      name = meta.name;
    }
  } catch (err) {
    // Ablage nicht erreichbar: der gespeicherte Name genügt zur Anzeige.
    console.warn(`[umbenennen] Metadaten für ${postid} nicht lesbar: ${err.message}`);
  }
  return { dateiname: name, stamm: stammAusDateiname(name, postid) };
}

/**
 * Benennt die Datei eines Dokuments um.
 * @returns {Promise<{ dateiname: string, stamm: string, geaendert: boolean }>}
 */
export async function benenneUm(postid, rohStamm) {
  if (typeof rohStamm !== 'string' || !rohStamm.trim()) throw fehler(400, 'Bitte einen Namen eingeben.');
  if (rohStamm.length > 300) throw fehler(400, 'Der Name ist zu lang.');
  const neuerName = baueDokumentDateiname(rohStamm, postid, { ersatz: null });
  if (!neuerName) throw fehler(400, 'Der Name enthält keine zulässigen Zeichen.');

  const zeile = await ladeZeile(postid);
  try {
    await wirfBeiGeschuetztemReprocess(postid);
  } catch (err) {
    throw fehler(409, 'Das Dokument ist gerade gesperrt (Prüfvormerkung oder Ablage-Umzug). Bitte später erneut versuchen.');
  }
  if (laeuftErstattungsbescheid(postid) || leseAuftraege().some((a) => a.bestehendesDokument === postid)) {
    throw fehler(409, 'Das Dokument wird gerade verarbeitet. Bitte danach erneut versuchen.');
  }
  if (!claimInFlight(zeile.storage_id)) {
    throw fehler(409, 'Die Datei wird gerade verarbeitet. Bitte danach erneut versuchen.');
  }
  try {
    const storage = getAdapter(zeile.storage_backend);
    const meta = await storage.getMeta(zeile.storage_id);
    if (meta.name === neuerName) {
      if (zeile.storage_filename !== neuerName) {
        await pool.query('UPDATE postbuch.postbuch SET storage_filename = $2 WHERE postid = $1', [postid, neuerName]);
      }
      return { dateiname: neuerName, stamm: stammAusDateiname(neuerName, postid), geaendert: false };
    }
    let moved;
    try {
      moved = await storage.move(zeile.storage_id, meta.parentId, neuerName);
    } catch (err) {
      if (err.status === 409 || /nameAlreadyExists|already exists|existiert bereits/i.test(err.message || '')) {
        throw fehler(409, 'In diesem Ordner gibt es bereits eine Datei mit diesem Namen.');
      }
      throw fehler(502, `Die Ablage hat das Umbenennen abgelehnt: ${err.message}`);
    }
    const id = moved.id || zeile.storage_id;
    const name = moved.name || neuerName;
    let lastModified = null;
    try { lastModified = (await storage.getMeta(id)).lastModified || null; } catch { /* folgt beim nächsten Abgleich */ }
    await schreibeDatei(postid, zeile.storage_backend, { id, name, webUrl: moved.webUrl, lastModified });
    appLog('INFO', 'ablage', `${postid} umbenannt: ${name}`, { entity: 'postbuch', entityId: postid });
    return { dateiname: name, stamm: stammAusDateiname(name, postid), geaendert: true };
  } finally {
    releaseInFlight(zeile.storage_id);
  }
}
