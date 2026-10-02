/**
 * service/document-retriever.js — Dokument abrufen (Cache + Ablage)
 *
 * Ersetzt: "Dokument abrufen — Core" (10 Nodes → 1 Funktion).
 *
 * Funktion: retrieveDocument(postid) → { pdf: Buffer, filename: string }
 *   1. Cache-Lookup in post_files
 *   2. Falls kein Cache: Download aus dem Backend der Zeile (storage_backend)
 *   3. Cache speichern
 *   4. Buffer + Filename zurückgeben
 */

import pool from '../db.js';
import { getAdapter } from '../lib/storage/index.js';
import { appLog } from '../app-log.js';

// ── In-Memory Fetch-Tracking (rein ephemer, kein DB-State) ──────────────────
//
// Dedupliziert parallele Downloads pro postid (z. B. wenn der Nutzer
// dasselbe Dokument erneut öffnet, während der erste Download noch läuft) und
// hält den Fortschritt für den Poll-Endpoint GET /pdf/fetch-progress bereit.
const inflightFetches = new Map(); // postid -> Promise
const fetchProgress = new Map();   // postid -> { status, receivedBytes, totalBytes }
const PROGRESS_GRACE_MS = 30_000;  // Eintrag bleibt nach Abschluss kurz abrufbar

export function getFetchProgress(postid) {
  return fetchProgress.get(postid) || null;
}

/**
 * Ruft das PDF eines Dokuments ab — zuerst aus dem Cache, dann aus der Ablage.
 *
 * @param {string} postid - PostID (P000000)
 * @returns {Promise<{ pdf: Buffer, filename: string, storageId: string, storageBackend: string, onedriveId: string }>}
 */
export async function retrieveDocument(postid) {
  // 1. Postbuch-Eintrag laden (Ablage-Referenz + dateiname)
  const docResult = await pool.query(
    `SELECT storage_id, storage_backend, betreff, dokumentart AS art FROM postbuch WHERE postid = $1`,
    [postid]
  );
  if (docResult.rows.length === 0) {
    throw new Error(`Dokument ${postid} nicht in postbuch gefunden`);
  }

  const { storage_id, storage_backend, betreff, art } = docResult.rows[0];
  // onedriveId bleibt im Rückgabewert, solange Aufrufer beide Namen kennen dürfen.
  const ref = { storageId: storage_id, storageBackend: storage_backend, onedriveId: storage_id };
  const filename = `${betreff || art || 'Dokument'} ${postid}.pdf`;

  // 2. Cache-Lookup in post_files
  const cacheResult = await pool.query(
    `SELECT file FROM post_files WHERE postid = $1`,
    [postid]
  );

  if (cacheResult.rows.length > 0 && cacheResult.rows[0].file) {
    return { pdf: cacheResult.rows[0].file, filename, ...ref };
  }

  // 3. Cache-Miss → Download aus der Ablage (dedupliziert: ein laufender Download
  //    pro postid wird von allen gleichzeitigen Aufrufern geteilt statt mehrfach
  //    gestartet zu werden)
  if (!storage_id) {
    throw new Error(`Dokument ${postid} hat keine Ablage-ID — kann nicht heruntergeladen werden`);
  }

  if (inflightFetches.has(postid)) {
    const pdf = await inflightFetches.get(postid);
    return { pdf, filename, ...ref };
  }

  const fetchPromise = (async () => {
    fetchProgress.set(postid, { status: 'fetching', receivedBytes: 0, totalBytes: null });

    const pdf = await getAdapter(storage_backend).download(storage_id, ({ receivedBytes, totalBytes }) => {
      fetchProgress.set(postid, { status: 'fetching', receivedBytes, totalBytes });
    });

    // 4. Cache speichern — awaited, damit der Aufrufer sicher ist, dass der Cache-Eintrag
    //    existiert bevor er antwortet (verhindert Race-Condition beim sofortigen Retry).
    const base64 = pdf.toString('base64');
    try {
      await pool.query(
        `INSERT INTO post_files (postid, file) VALUES ($1, decode($2, 'base64'))
         ON CONFLICT (postid) DO UPDATE SET file = decode($2, 'base64')`,
        [postid, base64]
      );
    } catch (e) {
      console.error(`[document-retriever] Cache-Speicherung fehlgeschlagen für ${postid}: ${e.message}`);
      appLog('WARN', 'document-retriever', `Cache-Speicherung fehlgeschlagen für ${postid}: ${e.message}`, { entity: 'postbuch', entityId: postid });
      // Cache-Fehler nicht weiterwerfen — pdf-Buffer ist noch verwertbar (z. B. für rotate)
    }

    appLog('INFO', 'document-retriever', `PDF aus der Ablage geholt und gecacht: ${postid}`, { entity: 'postbuch', entityId: postid });
    return pdf;
  })();

  inflightFetches.set(postid, fetchPromise);

  try {
    const pdf = await fetchPromise;
    fetchProgress.set(postid, { status: 'done', receivedBytes: pdf.length, totalBytes: pdf.length });
    return { pdf, filename, ...ref };
  } catch (err) {
    fetchProgress.set(postid, { status: 'error', receivedBytes: 0, totalBytes: null });
    throw err;
  } finally {
    inflightFetches.delete(postid);
    setTimeout(() => fetchProgress.delete(postid), PROGRESS_GRACE_MS);
  }
}
