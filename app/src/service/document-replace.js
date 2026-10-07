/**
 * service/document-replace.js — Direkter PDF-Austausch ohne KI-Pipeline.
 *
 * Tauscht das in der Ablage liegende PDF eines bestehenden Postbuch-Eintrags
 * gegen ein neues aus und schreibt nur die Ablage-Felder + sha256 + link um.
 * Alle anderen Metadaten (Betreff, Adressat, Detail-Tabellen, Aktenzuordnung,
 * Notizen, Wiedervorlagen) bleiben unverändert.
 *
 * Vollständig undo- und redo-fähig: Die jeweils alte Datei wandert mit ihrer
 * unveränderten Item-ID in den Papierkorb-Ordner. Über `restorePdf()`
 * lassen sich beide Richtungen symmetrisch wieder vertauschen.
 */

import { createHash, randomBytes } from 'node:crypto';
import db from '../db.js';
import { getAdapter, getActiveAdapterFor, legacyOnedriveWerte } from '../lib/storage/index.js';
import { appLog } from '../app-log.js';
import { uiLog } from '../log.js';
import { loadDynamicSettings, getActiveBackendName } from '../config.js';
import { ensureAblageOrdner, behandeltePersonSql } from './storage-setup.js';
import { istBestaetigterDateiFehlt } from './storage-missing.js';

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function randomSuffix() {
  // 6-stellige zufällige alphanumerische Zeichenkette (Großbuchstaben + Zahlen)
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  const bytes = randomBytes(6);
  for (let i = 0; i < 6; i++) {
    result += chars[bytes[i] % chars.length];
  }
  return result;
}

// Dateinamen sind auf 255 Zeichen begrenzt; Vorsichtsabstand einhalten
export function trashName(label, postid, filename) {
  const base = (filename || `${postid}.pdf`).replace(/\.pdf$/i, '');
  const prefix = `[${label} ${postid}] `;
  const suffix = randomSuffix();
  // maxBaseLen berücksichtigt: prefix + randomSuffix (6 Zeichen) + space + .pdf
  const maxBaseLen = 240 - prefix.length - suffix.length - 1 - 4; // 1 = space
  const trimmed = base.length > maxBaseLen ? base.slice(0, maxBaseLen) : base;
  return `${prefix}${trimmed} ${suffix}.pdf`;
}

/**
 * Ersetzt das PDF eines bestehenden Postbuch-Eintrags.
 *
 * @param {string} postid          Bestehender Postbuch-Eintrag
 * @param {Buffer} newPdfBuffer    Neuer PDF-Inhalt
 * @returns {Promise<{
 *   postid: string,
 *   parentId: string,
 *   filename: string,
 *   old: { onedriveId: string, sha256: string|null, onedriveModified: string|null, link: string|null },
 *   new: { onedriveId: string, sha256: string,      onedriveModified: string|null, link: string|null }
 * }>} bilateraler State für Undo/Redo
 */
export async function replacePdf(postid, newPdfBuffer) {
  const r = await db.query(
    `SELECT p.storage_id, p.storage_backend, p.storage_filename, p.sha256, p.storage_modified, p.link,
            p.lebensbereich, p.dokumentart, p.familienmitglied, p.briefdatum, p.richtung::text AS richtung,
            ${behandeltePersonSql('p')} AS behandelte_person
       FROM postbuch.postbuch p
      WHERE p.postid = $1`,
    [postid]
  );
  if (r.rows.length === 0) {
    const err = new Error('Dokument nicht gefunden');
    err.statusCode = 404;
    throw err;
  }
  const row = r.rows[0];

  // Die Datei bleibt in ihrem eigenen Backend, auch wenn inzwischen umgeschaltet wurde.
  // storage_backend ist NOT NULL und bleibt auch nach markiereDateiFehlend() stehen.
  const storage = getAdapter(row.storage_backend);

  // War die Datei schon vorher als fehlend bekannt (storage_id bereits genullt,
  // z. B. durch markiereDateiFehlend() nach einem bestätigten 404), oder stellt
  // sich das erst jetzt beim Metadaten-Abruf heraus? Beide Fälle laufen auf den
  // gleichen Reimport-Pfad hinaus: es gibt keine alte Datei mehr zu verschieben,
  // nur einen Zielordner über Lebensbereich/Dokumentart neu aufzulösen.
  let meta = null;
  let fehltBereits = !row.storage_id;
  if (row.storage_id) {
    try {
      meta = await storage.getMeta(row.storage_id);
    } catch (err) {
      if (!istBestaetigterDateiFehlt(err)) throw err;
      fehltBereits = true;
    }
  }

  if (fehltBereits && (!row.lebensbereich || !row.dokumentart)) {
    const err = new Error(
      'Die Datei ist in der Ablage nicht mehr vorhanden und es ist kein Ablageziel bekannt ' +
      '(Lebensbereich/Dokumentart fehlt) — Reimport nicht möglich.'
    );
    err.statusCode = 422;
    throw err;
  }

  // Fehlt die Datei bereits, gibt es kein Backend mehr zu respektieren — sie
  // landet neu im AKTUELL AKTIVEN Backend statt im alten, das nach einem
  // abgeschlossenen Ablage-Umzug gar nicht mehr verbunden sein muss (genau das
  // löste den "Nextcloud ist nicht verbunden"-Fehler beim Reimport aus).
  const settings = fehltBereits ? await loadDynamicSettings() : null;
  const uploadBackend = fehltBereits ? getActiveBackendName(settings) : row.storage_backend;
  const uploadStorage = fehltBereits ? getActiveAdapterFor(settings) : storage;

  const filename = meta?.name || row.storage_filename || `${postid}.pdf`;
  let parentId;
  if (fehltBereits) {
    parentId = await ensureAblageOrdner(settings, row, uploadBackend, { force: true });
  } else {
    parentId = meta.parentId;
  }
  if (!parentId) {
    throw new Error('Ablage: Parent-Ordner-ID nicht ermittelbar');
  }

  const oldOnedriveId = fehltBereits ? null : row.storage_id;
  const oldSha256 = row.sha256 || null;
  const oldOnedriveModified = row.storage_modified
    ? new Date(row.storage_modified).toISOString()
    : null;
  const oldLink = fehltBereits ? null : (row.link || null);

  const newSha256 = sha256Hex(newPdfBuffer);

  // Alte Datei → Papierkorb (Original-File-ID bleibt erhalten, nur Parent + Name
  // ändern sich). Fehlt sie bereits bestätigt, gibt es nichts zu verschieben.
  if (!fehltBereits) {
    await storage.moveToTrash(oldOnedriveId, trashName('Ersetzt', postid, filename));
  }

  // Neue Datei mit identischem Namen in den Original-Parent hochladen
  let newFile;
  try {
    newFile = await uploadStorage.uploadNew(newPdfBuffer, filename, parentId);
  } catch (uploadErr) {
    // Best-effort-Rollback: alte Datei zurückholen, damit der DB-Stand kongruent bleibt.
    // War sie schon vorher fehlend, gibt es nichts zurückzuholen.
    if (!fehltBereits) {
      try {
        await storage.move(oldOnedriveId, parentId, filename);
      } catch (rollbackErr) {
        appLog('ERROR', 'document-replace',
          `Rollback nach Upload-Fehler fehlgeschlagen für ${postid}: ${rollbackErr.message}`,
          { entity: 'postbuch', entityId: postid }
        );
      }
    }
    throw uploadErr;
  }

  // Änderungszeitpunkt des neuen Items abrufen (für DR-Fingerprint-Sync)
  let newOnedriveModified = null;
  try {
    const newMeta = await uploadStorage.getMeta(newFile.id);
    newOnedriveModified = newMeta.lastModified
      ? new Date(newMeta.lastModified).toISOString()
      : null;
  } catch (e) {
    appLog('WARN', 'document-replace',
      `Konnte den Änderungszeitpunkt nicht abrufen: ${e.message}`,
      { entity: 'postbuch', entityId: postid }
    );
  }

  // Legacy-Spalten nur bei OneDrive füllen (siehe legacyOnedriveWerte).
  const legacyOd = legacyOnedriveWerte(uploadStorage.name, {
    id: newFile.id,
    modified: newOnedriveModified,
  });

  await db.query(
    `UPDATE postbuch.postbuch
        SET storage_id = $1, onedrive_id = $6,
            sha256 = $2,
            storage_modified = $3::timestamptz, onedrive_modified = $7::timestamptz,
            link = $4, storage_backend = $8
      WHERE postid = $5`,
    [newFile.id, newSha256, newOnedriveModified, newFile.webUrl || null, postid,
     legacyOd.id, legacyOd.modified, uploadBackend]
  );

  // PDF-Cache aktualisieren — wir haben den neuen Buffer ohnehin in der Hand
  await db.query(
    `INSERT INTO postbuch.post_files (postid, file)
     VALUES ($1, $2)
     ON CONFLICT (postid) DO UPDATE SET file = EXCLUDED.file, stored_at = NOW()`,
    [postid, newPdfBuffer]
  ).catch(e => {
    appLog('WARN', 'document-replace',
      `PDF-Cache-Update fehlgeschlagen für ${postid}: ${e.message}`,
      { entity: 'postbuch', entityId: postid }
    );
  });

  // Volltext/Vision-Cache des Büroassistenten verwerfen — er bezieht sich auf
  // den Inhalt des jetzt ausgetauschten PDFs und würde sonst stillschweigend
  // Text/Antworten der ALTEN Datei ausliefern (kein eigener TTL, siehe
  // text-extractor.js).
  await db.query(`DELETE FROM postbuch.document_text_cache WHERE postid = $1`, [postid])
    .catch(() => {});
  await db.query(`DELETE FROM postbuch.document_vision_cache WHERE postid = $1`, [postid])
    .catch(() => {});

  appLog('INFO', 'document-replace',
    `PDF ersetzt: ${postid} · ${filename} · ${(newPdfBuffer.length / 1024).toFixed(1)} KB`,
    { entity: 'postbuch', entityId: postid }
  );
  uiLog('REPLACE_PDF', 'postbuch', postid,
    `${filename} · ${(newPdfBuffer.length / 1024).toFixed(1)} KB · sha256 ${newSha256.slice(0, 12)}…`
  );

  return {
    postid,
    parentId,
    filename,
    old: {
      onedriveId: oldOnedriveId,
      sha256: oldSha256,
      onedriveModified: oldOnedriveModified,
      link: oldLink,
    },
    new: {
      onedriveId: newFile.id,
      sha256: newSha256,
      onedriveModified: newOnedriveModified,
      link: newFile.webUrl || null,
    },
  };
}

/**
 * Tauscht zwei Dateien der Ablage für einen Postbuch-Eintrag.
 * Nutzbar für Undo (active=neu, restore=alt) wie auch Redo (active=alt, restore=neu).
 *
 * @param {string} postid
 * @param {object} params
 * @param {string} params.activeOnedriveId          aktuell in der DB stehende Ablage-ID (Concurrency-Schutz)
 * @param {string} params.restoreOnedriveId         Ablage-ID, die nach dem Tausch in der DB steht
 * @param {string} params.parentId                  Original-Parent-Ordner-ID
 * @param {string} params.filename                  Original-Dateiname (mit .pdf)
 * @param {string|null} [params.restoreSha256]
 * @param {string|null} [params.restoreOnedriveModified]
 */
export async function restorePdf(postid, params) {
  const {
    activeOnedriveId,
    restoreOnedriveId,
    parentId,
    filename,
    restoreSha256 = null,
    restoreOnedriveModified = null,
  } = params;

  if (!activeOnedriveId || !restoreOnedriveId || !parentId || !filename) {
    const err = new Error('Restore-Parameter unvollständig');
    err.statusCode = 400;
    throw err;
  }

  // Concurrency-Check: aktueller DB-Stand muss zur erwarteten activeId passen
  const r = await db.query(
    `SELECT storage_id, storage_backend FROM postbuch.postbuch WHERE postid = $1`,
    [postid]
  );
  if (r.rows.length === 0) {
    const err = new Error('Dokument nicht gefunden');
    err.statusCode = 404;
    throw err;
  }
  if (r.rows[0].storage_id !== activeOnedriveId) {
    const err = new Error('Dokument-Zustand hat sich seitdem verändert — Restore nicht möglich');
    err.statusCode = 409;
    throw err;
  }

  const storage = getAdapter(r.rows[0].storage_backend);

  // Aktive Datei → Papierkorb (markiert als "Verworfen", File-ID bleibt erhalten)
  await storage.moveToTrash(activeOnedriveId, trashName('Verworfen', postid, filename));

  // Wiederherzustellende Datei zurück in den Original-Parent (gleichzeitig umbenennen)
  const moved = await storage.move(restoreOnedriveId, parentId, filename);

  // Legacy-Spalten nur bei OneDrive füllen (siehe legacyOnedriveWerte).
  const legacyOdRestore = legacyOnedriveWerte(storage.name, {
    id: restoreOnedriveId,
    modified: restoreOnedriveModified,
  });

  await db.query(
    `UPDATE postbuch.postbuch
        SET storage_id = $1, onedrive_id = $6,
            sha256 = $2,
            storage_modified = $3::timestamptz, onedrive_modified = $7::timestamptz,
            link = $4
      WHERE postid = $5`,
    [
      restoreOnedriveId,
      restoreSha256,
      restoreOnedriveModified,
      moved.webUrl || null,
      postid,
      legacyOdRestore.id,
      legacyOdRestore.modified,
    ]
  );

  // PDF-Cache invalidieren — wird beim nächsten Anzeigen frisch aus der Ablage geladen
  await db.query(
    `DELETE FROM postbuch.post_files WHERE postid = $1`,
    [postid]
  ).catch(() => {});

  // Derselbe Grund wie in replacePdf: der Inhalt hat sich geändert (zurück auf
  // die vorherige Version), ein stehengebliebener Volltext/Vision-Cache wäre
  // für den Büroassistenten falsch.
  await db.query(`DELETE FROM postbuch.document_text_cache WHERE postid = $1`, [postid])
    .catch(() => {});
  await db.query(`DELETE FROM postbuch.document_vision_cache WHERE postid = $1`, [postid])
    .catch(() => {});

  appLog('INFO', 'document-replace',
    `PDF-Restore: ${postid} → Ablage-ID ${restoreOnedriveId.slice(0, 16)}…`,
    { entity: 'postbuch', entityId: postid }
  );
  uiLog('REPLACE_PDF_RESTORE', 'postbuch', postid,
    `${activeOnedriveId.slice(0, 12)}… → ${restoreOnedriveId.slice(0, 12)}…`
  );
}
