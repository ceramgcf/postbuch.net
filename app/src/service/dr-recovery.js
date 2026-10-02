/**
 * service/dr-recovery.js — Disaster Recovery für die Ablage-Verknüpfungen
 *
 * Anwendungsfall: Nach einem Restore der Ablage (externes Backup) sind alle
 * File-IDs neu vergeben. Die Postbuch-DB enthält weiterhin gültige sha256-
 * Fingerabdrücke, weiß aber nicht mehr, welche Datei zu welcher Postbuch-
 * Zeile gehört. Dieser Service stellt die Verknüpfungen wieder her.
 *
 * Der Lauf ist ein *Rematch*-Werkzeug, keine Kopier-Engine: er arbeitet gegen
 * genau ein Backend, das in _dr_sessions.backend festgehalten wird.
 *
 * Sicherheitsprinzipien:
 *   • Keine zerstörerische Operation ohne explizite User-Bestätigung.
 *   • Zeilen ohne sha256 werden niemals automatisch verändert.
 *   • Bei mehrdeutigen sha256-Treffern (selten — z. B. Duplikat-Uploads)
 *     wird der erste Treffer genommen, alle weiteren bleiben "extra".
 *   • Korrekte Links bleiben unverändert (Update setzt denselben Wert).
 *   • Bei Fehlern wird der Job abgebrochen, nicht stillschweigend fortgesetzt.
 *
 * Ablauf (in Phasen):
 *   1. Scan-Phase: Rekursiv den vom User gewählten Stamm-Ordner abklappern,
 *      jede Datei herunterladen, sha256 berechnen.
 *   2. Hash-Match-Phase: Für jede DB-Zeile mit sha256 die passende Datei
 *      suchen, storage_id/link/storage_filename/storage_modified setzen.
 *   3. Filename-Fallback-Phase: Für noch ungematchte DB-Zeilen den Dateinamen
 *      vergleichen (case-insensitive). Hier wird sha256 nachträglich berechnet
 *      und in die DB geschrieben.
 *   4. Report-Phase: Statistik + Liste der ungematchten Zeilen ans Frontend.
 *
 * Manuelle Auflösung danach:
 *   - resolveManualLink(postid, fileId) — User wählt eine Datei für eine Zeile
 *   - resolveLeaveUnlinked(postid)      — Zeile bleibt ohne Verknüpfung
 *   - resolveDeletePostbuchEntry(postid) — Zeile wird komplett gelöscht
 *
 * Sessions werden in postbuch._dr_sessions gespeichert (jsonb), damit das UI
 * den aktuellen Stand pollen und die Manual-Phase auch nach Tab-Wechsel
 * fortsetzen kann.
 */

import { createHash, randomUUID } from 'node:crypto';
import db from '../db.js';
import * as tracker from '../jobs/tracker.js';
import { appLog } from '../app-log.js';
import { getAdapter, getActiveBackend, legacyOnedriveWerte } from '../lib/storage/index.js';
import { oeffneSichereDokumentloeschung } from './document-delete-protection.js';

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function normalizeName(name) {
  if (!name) return '';
  return String(name).trim().toLowerCase();
}

async function updateSession(sessionId, patch) {
  const fields = Object.keys(patch);
  if (fields.length === 0) return;
  const set = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
  const values = fields.map(f => patch[f]);
  await db.query(
    `UPDATE postbuch._dr_sessions SET ${set}, updated_at = NOW() WHERE id = $1`,
    [sessionId, ...values]
  );
}

/**
 * Löst einen Stamm-Ordner-Pfad (oder Item-ID) gegen die Ablage auf.
 * Akzeptiert sowohl Pfade ('Postbuch') als auch Item-IDs.
 *
 * Ob eine Eingabe wie eine ID aussieht, weiß nur der Adapter — OneDrive-IDs
 * sind lang und alphanumerisch, Nextcloud-Fileids kurze Integer.
 *
 * @returns {{ id: string, label: string, backend: string }}
 */
export async function resolveRoot(input, backendName) {
  const v = String(input || '').trim();
  if (!v) throw new Error('Stamm-Ordner darf nicht leer sein.');

  const backend = backendName || await getActiveBackend();
  const storage = getAdapter(backend);

  if (!v.includes('/') && storage.looksLikeId(v)) {
    const meta = await storage.getMeta(v);
    return { id: v, label: meta.name, backend };
  }
  const r = await storage.resolvePath(v);
  return { id: r.id, label: r.name, backend };
}

/**
 * Startet einen DR-Recovery-Lauf. Erzeugt eine Session und einen Tracker-Job
 * für das Frontend-Polling. Läuft im Hintergrund.
 *
 * @param {{ rootFolderId: string, rootLabel: string, backend?: string }} input
 * @returns {Promise<{ sessionId: string, jobId: string }>}
 */
export async function startRecovery({ rootFolderId, rootLabel, backend }) {
  const sessionId = randomUUID();
  const backendName = backend || await getActiveBackend();
  await db.query(
    `INSERT INTO postbuch._dr_sessions (id, status, root_folder_id, root_folder_label, backend)
     VALUES ($1, 'scanning', $2, $3, $4)`,
    [sessionId, rootFolderId, rootLabel || null, backendName]
  );

  const jobId = tracker.create('dr-recovery', `DR-Wiederherstellung: ${rootLabel || rootFolderId}`, 0, true, { sessionId });
  await db.query(`UPDATE postbuch._dr_sessions SET job_id = $2 WHERE id = $1`, [sessionId, jobId]);

  // Hintergrund-Run
  runRecovery({ sessionId, jobId, rootFolderId, backend: backendName }).catch(err => {
    console.error('[dr-recovery] Hintergrund-Lauf fehlgeschlagen:', err.message);
  });

  return { sessionId, jobId };
}

async function runRecovery({ sessionId, jobId, rootFolderId, backend }) {
  try {
    appLog('INFO', 'dr-recovery', `Recovery-Lauf gestartet (Session ${sessionId}, Backend ${backend})`);
    const storage = getAdapter(backend);

    // Phase 1: Postbuch-Zustand laden — nur Zeilen desselben Backends, sonst
    // würde ein Mischbestand quer über zwei Ablagen rematcht.
    const dbRows = (await db.query(
      `SELECT postid, storage_id, sha256, storage_filename, link
         FROM postbuch.postbuch
        WHERE storage_backend = $1
        ORDER BY postid`,
      [backend]
    )).rows;

    // Phase 2: Dateibaum listen
    tracker.setStep(jobId, 0, 'Liste Dateien der Ablage…');
    const onedriveFiles = await storage.listAllFilesRecursive(rootFolderId);

    if (tracker.isCancelled(jobId)) {
      await finalizeCancelled(sessionId, jobId);
      return;
    }

    // total_steps angleichen (1 pro File für Hash-Phase)
    const total = onedriveFiles.length;
    await db.query('UPDATE postbuch._jobs SET total_steps = $2 WHERE id = $1', [jobId, total]);

    // Phase 3: Hash jede Datei
    const hashToFiles = new Map();           // sha256 → [{id,name,...}]
    const idToFile = new Map();              // fileId → fileMeta
    const nameToFiles = new Map();           // normalizedName → [files]
    let hashedCount = 0;
    let hashErrors = 0;

    for (const f of onedriveFiles) {
      if (tracker.isCancelled(jobId)) {
        await finalizeCancelled(sessionId, jobId);
        return;
      }
      try {
        const buf = await storage.download(f.id);
        const digest = sha256Hex(buf);
        const enriched = { ...f, sha256: digest };
        idToFile.set(f.id, enriched);

        if (!hashToFiles.has(digest)) hashToFiles.set(digest, []);
        hashToFiles.get(digest).push(enriched);

        const nk = normalizeName(f.name);
        if (nk) {
          if (!nameToFiles.has(nk)) nameToFiles.set(nk, []);
          nameToFiles.get(nk).push(enriched);
        }
        hashedCount++;
      } catch (err) {
        hashErrors++;
        appLog('WARN', 'dr-recovery',
          `Hash-Fehler für ${f.name} (${f.id}): ${err.message}`);
      }
      const matched = await countMatchedSoFar(dbRows, hashToFiles);
      tracker.setStep(jobId, hashedCount,
        `${hashedCount} / ${total} Dateien gehasht — ${matched} bereits zugeordnet`);
    }

    // Phase 4: Hash-Match-Phase — DB-Zeilen aktualisieren
    const matchedByHash = [];
    const unchangedCorrect = [];     // hatte bereits korrekte ID (Update no-op)
    const relinked = [];             // ID hat sich geändert
    const stillUnmatched = [];

    for (const row of dbRows) {
      if (!row.sha256) {
        // Zeile ohne sha256 — nicht automatisch behandeln (User-Hinweis)
        stillUnmatched.push(row);
        continue;
      }
      const candidates = hashToFiles.get(row.sha256) || [];
      if (candidates.length === 0) {
        stillUnmatched.push(row);
        continue;
      }
      // Bei Mehrdeutigkeit: bevorzugen, wenn die alte storage_id darunter ist
      let pick = candidates.find(c => c.id === row.storage_id) || candidates[0];

      if (pick.id === row.storage_id) {
        unchangedCorrect.push(row.postid);
      } else {
        const lg = legacyOnedriveWerte(backend, {
          id: pick.id, name: pick.name, modified: pick.lastModified || null,
        });
        await db.query(
          `UPDATE postbuch.postbuch
              SET storage_id = $2, onedrive_id = $6,
                  link = $3,
                  storage_filename = $4, onedrive_filename = $7,
                  storage_modified = $5, onedrive_modified = $8
            WHERE postid = $1`,
          [row.postid, pick.id, pick.webUrl || null, pick.name, pick.lastModified || null,
           lg.id, lg.name, lg.modified]
        );
        relinked.push({ postid: row.postid, oldId: row.storage_id, newId: pick.id });
      }
      matchedByHash.push({ postid: row.postid, fileId: pick.id });
    }

    // Phase 5: Filename-Fallback für stillUnmatched-Zeilen
    const matchedByName = [];
    const trulyUnmatched = [];

    for (const row of stillUnmatched) {
      // Mögliche Quellen für Vergleich: storage_filename (preferred), sonst betreff/postid
      const candidateNames = [];
      if (row.storage_filename) candidateNames.push(normalizeName(row.storage_filename));

      // Auch Kandidat: nur Postbuch-ID (z. B. "P000123" als Substring im Filename)
      candidateNames.push(row.postid.toLowerCase());

      let matchedFile = null;
      for (const cn of candidateNames) {
        if (!cn) continue;
        // Exakter Match auf normalisierten Namen
        const exact = nameToFiles.get(cn) || [];
        if (exact.length === 1) { matchedFile = exact[0]; break; }
        // Substring-Match (postid in Filename) als Fallback
        if (cn === row.postid.toLowerCase()) {
          const subMatches = onedriveFiles.filter(f => normalizeName(f.name).includes(cn));
          if (subMatches.length === 1) {
            const file = idToFile.get(subMatches[0].id);
            if (file) { matchedFile = file; break; }
          }
        }
      }

      if (matchedFile) {
        // Fingerprint nachziehen
        const lgName = legacyOnedriveWerte(backend, {
          id: matchedFile.id, name: matchedFile.name, modified: matchedFile.lastModified || null,
        });
        await db.query(
          `UPDATE postbuch.postbuch
              SET storage_id = $2, onedrive_id = $7,
                  link = $3,
                  storage_filename = $4, onedrive_filename = $8,
                  storage_modified = $5, onedrive_modified = $9,
                  sha256 = COALESCE(sha256, $6)
            WHERE postid = $1`,
          [row.postid, matchedFile.id, matchedFile.webUrl || null,
           matchedFile.name, matchedFile.lastModified || null, matchedFile.sha256,
           lgName.id, lgName.name, lgName.modified]
        );
        matchedByName.push({ postid: row.postid, fileId: matchedFile.id, name: matchedFile.name });
      } else {
        trulyUnmatched.push({
          postid: row.postid,
          onedrive_id: row.storage_id,
          onedrive_filename: row.storage_filename,
          sha256: row.sha256,
        });
      }
    }

    // Phase 6: "Extras" identifizieren — Dateien, die zu keinem postbuch passen
    const usedFileIds = new Set([
      ...matchedByHash.map(m => m.fileId),
      ...matchedByName.map(m => m.fileId),
    ]);
    const extras = onedriveFiles
      .filter(f => !usedFileIds.has(f.id))
      .map(f => ({
        id: f.id,
        name: f.name,
        webUrl: f.webUrl,
        sha256: idToFile.get(f.id)?.sha256 || null,
      }));

    // Stats zusammenfassen
    const stats = {
      onedriveFilesScanned: total,
      onedriveFilesHashed: hashedCount,
      hashErrors,
      postbuchTotal: dbRows.length,
      matchedByHash: matchedByHash.length,
      relinked: relinked.length,
      unchangedCorrect: unchangedCorrect.length,
      matchedByName: matchedByName.length,
      unmatched: trulyUnmatched.length,
      extras: extras.length,
    };

    await updateSession(sessionId, {
      status: trulyUnmatched.length > 0 ? 'awaiting-manual' : 'done',
      stats: JSON.stringify(stats),
      unmatched: JSON.stringify(trulyUnmatched),
      extras: JSON.stringify(extras),
      completed_at: trulyUnmatched.length > 0 ? null : new Date(),
    });

    appLog('INFO', 'dr-recovery',
      `Recovery abgeschlossen (Session ${sessionId}): ` +
      `${stats.matchedByHash} via Hash, ${stats.matchedByName} via Filename, ` +
      `${stats.unmatched} ungematcht, ${stats.extras} Extras`);

    tracker.setStep(jobId, total, `Fertig: ${stats.matchedByHash + stats.matchedByName} / ${dbRows.length} verknüpft`);
    tracker.complete(jobId, stats);
  } catch (err) {
    appLog('ERROR', 'dr-recovery', `Recovery-Lauf fehlgeschlagen: ${err.message}`);
    await updateSession(sessionId, {
      status: 'error',
      error_message: err.message,
      completed_at: new Date(),
    }).catch(() => {});
    tracker.fail(jobId, err.message);
  }
}

async function countMatchedSoFar(dbRows, hashToFiles) {
  let n = 0;
  for (const row of dbRows) {
    if (row.sha256 && hashToFiles.has(row.sha256)) n++;
  }
  return n;
}

async function finalizeCancelled(sessionId, jobId) {
  await updateSession(sessionId, {
    status: 'cancelled',
    completed_at: new Date(),
  }).catch(() => {});
  tracker.complete(jobId, { cancelled: true });
  appLog('INFO', 'dr-recovery', `Recovery abgebrochen (Session ${sessionId})`);
}

/**
 * Liefert den aktuellen Zustand einer Session (inkl. Stats, Unmatched, Extras).
 */
export async function getSession(sessionId) {
  const r = await db.query(
    `SELECT id, job_id, status, root_folder_id, root_folder_label, backend,
            stats, unmatched, extras, created_at, updated_at, completed_at, error_message
       FROM postbuch._dr_sessions WHERE id = $1`,
    [sessionId]
  );
  return r.rows[0] || null;
}

// ── Manuelle Auflösung ─────────────────────────────────────────────────────────

async function getUnmatchedFromSession(sessionId) {
  const sess = await getSession(sessionId);
  if (!sess) throw new Error(`Session ${sessionId} nicht gefunden`);
  const list = Array.isArray(sess.unmatched) ? sess.unmatched : (sess.unmatched || []);
  return { sess, list };
}

async function removeFromUnmatched(sessionId, postid) {
  const { sess, list } = await getUnmatchedFromSession(sessionId);
  const remaining = list.filter(u => u.postid !== postid);
  const newStatus = remaining.length === 0 ? 'done' : 'awaiting-manual';
  await updateSession(sessionId, {
    unmatched: JSON.stringify(remaining),
    status: newStatus,
    completed_at: remaining.length === 0 ? new Date() : null,
  });
  return { remaining: remaining.length, status: newStatus };
}

/**
 * Verknüpft eine ungematchte Postbuch-Zeile manuell mit einer Datei der Ablage.
 * Aktualisiert auch sha256/Name/Modified und entfernt die Zeile aus unmatched.
 */
export async function resolveManualLink(sessionId, postid, fileId) {
  const sess = await getSession(sessionId);
  if (!sess) throw new Error(`Session ${sessionId} nicht gefunden`);
  const storage = getAdapter(sess.backend);

  const buf = await storage.download(fileId);
  const digest = sha256Hex(buf);
  const meta = await storage.getMeta(fileId);

  const lg = legacyOnedriveWerte(sess.backend, {
    id: fileId, name: meta.name, modified: meta.lastModified || null,
  });

  await db.query(
    `UPDATE postbuch.postbuch
        SET storage_id = $2, onedrive_id = $8,
            storage_backend = $7,
            link = $3,
            storage_filename = $4, onedrive_filename = $9,
            storage_modified = $5, onedrive_modified = $10,
            sha256 = $6
      WHERE postid = $1`,
    [postid, fileId, meta.webUrl || null, meta.name, meta.lastModified || null, digest, sess.backend,
     lg.id, lg.name, lg.modified]
  );

  appLog('INFO', 'dr-recovery',
    `Manuelle Verknüpfung: ${postid} → ${meta.name} (${fileId})`,
    { entity: 'postbuch', entityId: postid });

  return removeFromUnmatched(sessionId, postid);
}

/**
 * Belässt eine ungematchte Zeile ohne Verknüpfung (storage_id wird auf NULL gesetzt,
 * link wird auf NULL gesetzt — die Zeile bleibt sonst erhalten).
 */
export async function resolveLeaveUnlinked(sessionId, postid) {
  await db.query(
    `UPDATE postbuch.postbuch
        SET storage_id = NULL, onedrive_id = NULL,
            link = NULL,
            storage_filename = NULL, onedrive_filename = NULL,
            storage_modified = NULL, onedrive_modified = NULL
      WHERE postid = $1`,
    [postid]
  );
  appLog('INFO', 'dr-recovery',
    `Postbuch-Zeile ${postid} bleibt ohne Ablage-Verknüpfung`,
    { entity: 'postbuch', entityId: postid });
  return removeFromUnmatched(sessionId, postid);
}

/**
 * Löscht eine ungematchte Postbuch-Zeile vollständig.
 * Achtung: Ruft den User-Confirm-Pfad auf — die Bestätigung erfolgt im Frontend
 * VOR diesem Aufruf (zwei Klicks).
 */
export async function resolveDeletePostbuchEntry(sessionId, postid) {
  const { client } = await oeffneSichereDokumentloeschung(postid);
  try {
    await client.query(`DELETE FROM postbuch.postbuch WHERE postid = $1`, [postid]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  appLog('INFO', 'dr-recovery',
    `Postbuch-Zeile ${postid} per DR-Wizard gelöscht`,
    { entity: 'postbuch', entityId: postid });
  return removeFromUnmatched(sessionId, postid);
}
