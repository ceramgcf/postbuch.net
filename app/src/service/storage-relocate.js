/**
 * service/storage-relocate.js — Datei-Umzug innerhalb der Ablage
 *
 * Verschiebt Dokumente, wenn sich Ordner-Zuordnungen ändern. Die Item-IDs
 * bleiben dabei unverändert → alle gespeicherten Links/IDs in der DB behalten
 * ihre Gültigkeit.
 *
 * Immer gegen das aktive Backend: Ordner-Zuordnungen gelten je Backend, und
 * eine Zeile aus einem anderen Backend hätte in dessen Ordnern nichts zu suchen.
 *
 * Der Gesamtumzug nach Einrichtung des Wurzelordners ist der einzige
 * unterstützte Pfad. Unterordner werden ausschließlich automatisch verwaltet.
 */

import db from '../db.js';
import { loadDynamicSettings, getActiveBackendName } from '../config.js';
import { ensureAblageOrdner, behandeltePersonSql } from './storage-setup.js';
import { getActiveAdapterFor } from '../lib/storage/index.js';
import { appLog } from '../app-log.js';
import { cleanupLegacyDocumentFolders } from './storage-legacy-cleanup.js';
import { istBestaetigterDateiFehlt, markiereDateiFehlend } from './storage-missing.js';
import { fuerJedesBegrenzt } from '../lib/parallel.js';

// ── Alle Dokumente aus der DB in ihre richtigen Ordner verschieben ───────────

// Es gibt drei Aufrufer (Setup-Assistent async, Setup-Assistent sync, manueller
// relocate-all-Endpunkt) — ein einfacher Prozess-Flag genügt, weil relocate
// (anders als storage-migration.js) nicht über einen Neustart hinweg
// fortgesetzt werden muss und dieser Prozess ohnehin der einzige App-Container
// ist. Zwei parallele Läufe würden sich sonst beim Verschieben derselben
// Dateien in die Quere kommen.
let _laufAktiv = false;

// Gleichzeitige Verschiebungen. Jede kostet bei Nextcloud auf kleiner Hardware
// rund eine halbe Sekunde Roundtrip; mehr als drei bringen dort kaum noch etwas
// und erhöhen das Risiko von 423 Locked.
const UMZUG_PARALLEL = 3;

export function istUmzugAktiv() {
  return _laufAktiv;
}

/**
 * Verschiebt alle DB-Dokumente in ihre jeweils konfigurierten Ordner.
 * Wird nach dem Setup-Assistenten im Hintergrund aufgerufen.
 * Fehler bei einzelnen Dokumenten unterbrechen den Batch nicht.
 *
 * @param {(p:{schritt:number,gesamt:number,name:string}) => void} [onProgress]
 * @param {{signal?: AbortSignal}} [opts]  Ein abgebrochenes Signal beendet den
 *   Lauf vor dem nächsten Dokument; die gerade bewegten (höchstens
 *   UMZUG_PARALLEL) werden noch fertig verschoben. Ein abgebrochener Lauf räumt keine Ordner auf.
 * @returns {{ moved: number, skipped: number, errors: number, abgebrochen?: boolean }}
 */
export async function relocateAllDocuments(onProgress, opts = {}) {
  if (_laufAktiv) {
    const err = new Error('Es läuft bereits ein Dokumentumzug — bitte warten, bis er abgeschlossen ist.');
    err.statusCode = 409;
    throw err;
  }
  _laufAktiv = true;
  try {
    return await relocateAllDocumentsImpl(onProgress, opts.signal);
  } finally {
    _laufAktiv = false;
  }
}

async function relocateAllDocumentsImpl(onProgress, signal) {
  appLog('INFO', 'relocate', 'Umzug aller Dokumente gestartet (nach Setup-Assistent)');

  let settings;
  try {
    settings = await loadDynamicSettings();
  } catch (err) {
    appLog('ERROR', 'relocate', `Settings konnten nicht geladen werden: ${err.message}`);
    return { moved: 0, skipped: 0, errors: 1 };
  }

  const storage = getActiveAdapterFor(settings);

  let rows;
  try {
    rows = await db.query(
      `SELECT postid, storage_id
         FROM postbuch.postbuch
        WHERE storage_id IS NOT NULL AND storage_backend = $1
        ORDER BY postid`,
      [getActiveBackendName(settings)]
    );
  } catch (err) {
    appLog('ERROR', 'relocate', `DB-Abfrage fehlgeschlagen: ${err.message}`);
    return { moved: 0, skipped: 0, errors: 1 };
  }

  const total = rows.rows.length;
  onProgress?.({ schritt: 0, gesamt: Math.max(1, total), name: total ? 'Dokumente werden geprüft' : 'Keine Dokumente umzuziehen' });
  appLog('INFO', 'relocate', `${total} Dokument(e) mit Ablage-ID gefunden`);

  let moved = 0, skipped = 0, unresolved = 0, errors = 0;
  // Strukturierte Fehlerliste fürs Frontend (SetupWizardCard) — bisher stand
  // dort nur die Gesamtzahl ("Dokumentumzug mit 1 Fehler(n) beendet"), ohne
  // dass erkennbar war, WELCHES Dokument betroffen ist.
  const fehlerListe = [];

  // Ordnerketten, die in diesem Lauf bereits erzwungen neu aufgelöst wurden.
  // Gecachte IDs können nach einem Wurzelordner-Wechsel noch auf den alten Ort
  // zeigen; relocateAllDocuments() ist der einzige unterstützte Aufrufer
  // danach. Deshalb wird jeder Ordner einmal je Lauf zwangsweise neu aufgelöst
  // und für alle weiteren Dokumente wiederverwendet (siehe ensureAblageOrdner).
  const laufCache = new Map();

  let schritt = 0;
  const fortschritt = (name) => onProgress?.({ schritt: ++schritt, gesamt: Math.max(1, total), name });

  const verschiebeEines = async (listenRow) => {
    // Zeile frisch lesen: Der Lauf dauert, und eine parallele Änderung von
    // Familienmitglied oder Klassifikation darf nicht mit dem Stand vom
    // Laufbeginn überschrieben werden.
    const aktuell = await db.query(
      `SELECT p.postid, p.lebensbereich, p.dokumentart, p.familienmitglied, p.briefdatum, p.richtung::text AS richtung,
              ${behandeltePersonSql('p')} AS behandelte_person,
              p.storage_id, p.storage_filename, p.storage_backend
         FROM postbuch.postbuch p WHERE p.postid = $1`,
      [listenRow.postid],
    ).catch(() => null);
    const row = aktuell?.rows[0];
    if (!row || row.storage_id !== listenRow.storage_id || row.storage_backend !== getActiveBackendName(settings)) {
      skipped++;
      fortschritt(`${listenRow.postid} übersprungen`);
      return;
    }
    let targetFolderId = null;
    if (row.lebensbereich && row.dokumentart) {
      try {
        targetFolderId = await ensureAblageOrdner(settings, row, undefined, { force: true, laufCache });
      } catch (err) {
        appLog('WARN', 'relocate',
          `Kein Ablageziel für ${row.postid} (${row.lebensbereich}/${row.dokumentart}): ${err.message}`);
      }
    }
    if (!targetFolderId) {
      appLog('WARN', 'relocate',
        `Kein Zielordner für ${row.lebensbereich}/${row.dokumentart} (${row.postid}) — übersprungen`);
      skipped++;
      unresolved++;
      fortschritt(`${row.postid} übersprungen`);
      return;
    }

    try {
      const meta = await storage.getMeta(row.storage_id);

      // Bereits im richtigen Ordner → überspringen
      if (meta.parentId === targetFolderId) {
        skipped++;
        return;
      }

      await storage.move(row.storage_id, targetFolderId, meta.name);
      moved++;
      appLog('INFO', 'relocate',
        `${row.postid} "${meta.name}" → ${row.lebensbereich}/${row.dokumentart} verschoben`);
    } catch (err) {
      errors++;
      if (istBestaetigterDateiFehlt(err)) {
        await markiereDateiFehlend(row.postid, 'relocate');
      }
      fehlerListe.push({
        postid: row.postid,
        filename: row.storage_filename || null,
        message: err.message,
      });
      appLog('ERROR', 'relocate',
        `${row.postid} (${row.storage_id}) Fehler: ${err.message}`);
    } finally {
      fortschritt(row.postid);
    }
  };

  // Ein Fehler beim Fortschritt oder Log darf den Lauf nicht abbrechen,
  // sondern zählt wie ein Dokumentfehler.
  await fuerJedesBegrenzt(rows.rows, UMZUG_PARALLEL, (listenRow) => verschiebeEines(listenRow).catch((err) => {
    errors++;
    fehlerListe.push({ postid: listenRow.postid, filename: null, message: err.message });
    appLog('ERROR', 'relocate', `${listenRow.postid} Fehler: ${err.message}`);
  }), { signal });
  const abgebrochen = !!signal?.aborted && schritt < total;

  if (abgebrochen) {
    appLog('INFO', 'relocate',
      `Umzug abgebrochen nach ${schritt} von ${total} Dokumenten — verschoben: ${moved}, Fehler: ${errors}`);
    return { moved, skipped, unresolved, errors, legacyCleanup: null, fehlerListe, abgebrochen: true };
  }

  appLog('INFO', 'relocate',
    `Umzug abgeschlossen — verschoben: ${moved}, bereits korrekt: ${skipped}, Fehler: ${errors}`);

  let legacyCleanup = null;
  if (errors === 0 && unresolved === 0) {
    try {
      legacyCleanup = await cleanupLegacyDocumentFolders({ backendName: storage.name });
    } catch (err) {
      appLog('ERROR', 'relocate', `Legacy-Ordner-Cleanup fehlgeschlagen: ${err.message}`);
      legacyCleanup = { errors: 1, reason: err.message };
    }
  } else {
    appLog('WARN', 'relocate',
      `Legacy-Ordner bleiben unangetastet: errors=${errors}, ungelöste Ziele=${unresolved}`);
  }

  return { moved, skipped, unresolved, errors, legacyCleanup, fehlerListe };
}
