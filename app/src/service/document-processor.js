/**
 * service/document-processor.js — Hauptverarbeitungs-Pipeline
 *
 * Ersetzt: "Einzeldokumentverarbeitung" (60 Nodes → 1 Funktion).
 *
 * Zwei Eingangswege:
 *   A) { onedriveFileId }                  — Datei bereits auf OneDrive
 *   B) { pdfBuffer, filename }             — PDF direkt (z.B. Scanner, Session 6)
 *
 * Bei Eingang B wird das PDF zuerst auf OneDrive hochgeladen, dann normal verarbeitet.
 *
 * Der Job-Tracker bildet den Fortschritt ab:
 *   0: Upload auf OneDrive (nur Scanner)
 *   1: PDF herunterladen
 *   2: KI-Analyse
 *   3: Duplikaterkennung
 *   4: Duplikat-Handling
 *   5: OneDrive-Sortierung
 *   6: Discord-Benachrichtigung
 *   7: PDF-Rotation
 *   8: Datenbank-Insert
 *   9: Embedding + Cache
 */

import pool from '../db.js';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadDynamicSettings, getFolders, getActiveBackendName } from '../config.js';
import { deleteScanBuffer, SCAN_BUFFER_DIR } from '../lib/scan-buffer.js';
import * as tracker from '../jobs/tracker.js';
import { getActiveAdapterFor, getAdapter, legacyOnedriveWerte } from '../lib/storage/index.js';
import * as discord from '../lib/discord.js';
import * as llm from '../lib/llm.js';
import * as pdf from '../lib/pdf.js';
import { scanQrCodes } from '../lib/qr.js';
import {
  generateAndStoreEmbedding, fetchEmbeddingForExtractedData,
  activeSignature as aktuelleEmbeddingSignatur,
} from '../lib/embedding.js';
import { buildLxdClassificationPromptParts } from '../prompts/classification-lxd.js';
import { getAktiveTaxonomie, effektiveGruppe } from '../lib/taxonomie.js';
import { wendeInvalidierungAn } from './rechnung-invalidierung.js';
import { pruefeFachblockStruktur, pruefeUndRepariere, fatalMeldung } from './extract-validator.js';
import * as duplicateChecker from './duplicate-checker.js';
import * as suspensionStore from './suspension-store.js';
import * as failedHandler from './failed-handler.js';
import * as duplicateNotifier from './duplicate-notifier.js';
import * as documentInserter from './document-inserter.js';
import { gleichePersonAb } from '../lib/personen-abgleich.js';
import { sendPushToAllUsers } from '../lib/webpush.js';
import { uiLog } from '../log.js';
import { appLog } from '../app-log.js';
import { trashName } from './document-replace.js';
import { ensureAblageOrdner } from './storage-setup.js';
import * as pipelineFileJournal from './pipeline-file-journal.js';
import { oeffneSichereErsetzung } from './reprocess-protection.js';
import { setzeBescheidwirkungZurueck } from './periodenabschluss.js';

// ── In-Flight-Registry ────────────────────────────────────────────────────────
// Verhindert Doppelverarbeitung derselben OneDrive-Datei wenn Webhook und
// OneDrive-Watcher gleichzeitig dieselbe Datei greifen (Race Condition).
// Schlüssel: OneDrive-Item-ID. Cleanup immer im finally-Block.
const _inFlightIds = new Set();

export function claimInFlight(onedriveFileId) {
  if (!onedriveFileId) return false;
  if (_inFlightIds.has(onedriveFileId)) return false;
  _inFlightIds.add(onedriveFileId);
  return true;
}

export function releaseInFlight(onedriveFileId) {
  if (!onedriveFileId) return;
  _inFlightIds.delete(onedriveFileId);
}

// ── Error-Klassen ────────────────────────────────────────────────────────────

// CancellationError kommt aus jobs/tracker.js — dort auch von lib/llm.js
// genutzt (Abbruch während einer Retry-Wartezeit).
const { CancellationError } = tracker;

// ── API-Fehler-Klassifizierung ────────────────────────────────────────────────
/**
 * Erkennt bekannte API-Fehlertypen (Quota, Rate-Limit, Auth, …) und gibt
 * einen nutzerfreundlichen Label zurück.
 * @param {string} message - rohe Fehlermeldung
 * @returns {{ code: string|null, label: string|null }}
 */
function classifyApiError(message) {
  const m = String(message || '');
  // HTTP 429 oder 402
  if (/\b(429|402)\b/.test(m)) {
    if (/quota|insufficient|billing|credit|exceed|limit/i.test(m)) {
      return { code: 'quota_exceeded', label: 'API-Guthaben aufgebraucht' };
    }
    return { code: 'rate_limited', label: 'API-Rate-Limit erreicht' };
  }
  if (/\b401\b/.test(m)) return { code: 'auth_failed', label: 'API-Key ungültig' };
  if (/\b403\b/.test(m)) return { code: 'forbidden',   label: 'API-Zugriff verweigert' };
  if (/\b5\d\d\b/.test(m) || /ECONNREFUSED|ETIMEDOUT|fetch failed|network/i.test(m)) {
    return { code: 'api_unavailable', label: 'API-Server nicht erreichbar' };
  }
  return { code: null, label: null };
}

// ── Hilfsfunktionen ──────────────────────────────────────────────────────────

function buildKorrekturKontext(input) {
  const parts = [];
  if (input.korrekturAnweisung) {
    parts.push(`\n\n### KORREKTUR-ANWEISUNGEN VOM BENUTZER ###\n${input.korrekturAnweisung}\n`);
  }
  parts.push(`\n### KORREKTUR-MODUS ###\nDies ist eine Wiederverarbeitung des Dokuments ${input.modifyPostID}. Analysiere das Dokument erneut sorgfältig.\n`);
  return parts.join('');
}

function buildDiscordSuccessMessage(data, finalPostID, isDuplicate, webUrl, isReprocessing = false) {
  const qf = data.qualityFlags || {};
  const pb = data.postbuch || {};
  const warnLines = (qf.warnungen || []).map(w => `• ${w}`).join('\n');

  let header;
  let hint;
  if (isReprocessing) {
    header = '### 🔁 Wiederverarbeitung 🔁';
    hint = ' Das Dokument wurde neu analysiert und der bestehende Eintrag aktualisiert.';
  } else if (isDuplicate) {
    header = '### 🔄 Verbesserung! 🔄';
    hint = ' Es handelte sich um eine Duplette, die jedoch von besserer Qualität war. Die bereits veraktete Fassung wurde daher mit dieser neuen ersetzt.';
  } else {
    header = '### ✅🎉 Erfolg! ✅';
    hint = '';
  }

  return `${header}
Ich habe das Dokument "**${pb.betreff || '(kein Betreff)'}**" vom ${pb.briefdatum || '(kein Datum)'} erkannt und es mit Schlüssel ${finalPostID} als [${pb.dateiname || 'Dokument'}.pdf](${webUrl || '#'}) abgelegt.${hint}

Der Vertrauensgrad war ${qf.vertrauensgrad || '?'} (${qf.sicherheitsgrad || '?'}).${warnLines ? ' Ich weise auf Folgendes hin:\n' + warnLines : ''}`;
}

function todayISO() {
  return new Date().toISOString().split('T')[0];
}

/**
 * Baut das Push-Payload für eine erfolgreiche Dokumentverarbeitung.
 * @param {string}  finalPostID
 * @param {boolean} isDuplicateReplace - Ersetzung eines Duplikats
 * @param {boolean} isReprocessing     - Wiederverarbeitung
 * @param {object}  settings
 */
function buildPushSuccessPayload(data, finalPostID, isDuplicateReplace, isReprocessing, settings) {
  const pb = data.postbuch || {};
  const betreff = pb.betreff || '(kein Betreff)';
  const datum   = pb.briefdatum || '';

  let title, body;
  if (isReprocessing) {
    title = '🔁 Wiederverarbeitung abgeschlossen';
    body  = `${finalPostID}: ${betreff}${datum ? ' · ' + datum : ''}`;
  } else if (isDuplicateReplace) {
    title = '🔄 Dokument ersetzt (bessere Qualität)';
    body  = `${finalPostID}: ${betreff}${datum ? ' · ' + datum : ''}`;
  } else {
    title = '✅ Neues Dokument erfasst';
    body  = `${finalPostID}: ${betreff}${datum ? ' · ' + datum : ''}`;
  }

  const appHost = (settings?.app_host || '').replace(/\/$/, '');
  const url = appHost ? `${appHost}/postbuch/${finalPostID}` : `/postbuch/${finalPostID}`;

  return {
    title,
    body,
    tag: `doc-${finalPostID}`,
    url,
    requireInteraction: false,
  };
}

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

// ── Hauptpipeline ────────────────────────────────────────────────────────────

/**
 * Verarbeitet ein Dokument komplett: Download → KI → Duplikat → Move → Discord → DB → Embedding.
 *
 * @param {object}  input
 * @param {string}  [input.onedriveFileId]      - OneDrive Item-ID (Eingang A)
 * @param {Buffer}  [input.pdfBuffer]           - PDF-Buffer (Eingang B / Scanner)
 * @param {string}  [input.filename]            - Dateiname (Eingang B)
 * @param {boolean} [input.preclaimedInFlight]  - OneDrive-ID wurde bereits extern als in-flight reserviert
 * @param {string}  [input.modifyPostID]        - Korrektur-Modus: existierende PostID beibehalten
 * @param {string}  [input.korrekturAnweisung]  - Benutzer-Korrekturanweisungen
 * @param {{lebensbereich:string}} [input.rechnungInvalidierung]
 *                                            - Rechnungsblock entfernen: Ziel-LxD und
 *                                              Betreffvermerk werden nach der Analyse
 *                                              erzwungen (service/rechnung-invalidierung.js)
 * @param {string}  [input.userHinweis]         - Optionaler Benutzer-Hinweis beim initialen Import
 * @param {boolean} [input.textebeneEntfernen]  - Wiederverarbeitung: erkannte Textebene (OCR)
 *                                                 vor der KI-Analyse verwerfen (nur Bild an die KI)
 * @param {boolean} [input.fromScanner]         - Eingang aus der Scan-/Cleaner-Pipeline:
 *                                                 OCR-Textebene wird in der Dunkelverarbeitung
 *                                                 immer verworfen (manuelle Uploads NICHT)
 * @param {string}  [input.modelTier]           - Wiederverarbeitung: feste Modellstufe
 *                                                 ('auto'|'leicht'|'mittel'|'schwierig'|'large').
 *                                                 ≠ 'auto' überspringt den Preclassifier.
 * @param {string}  jobId                       - Job-Tracker ID
 */
export async function processDocument(input, jobId, stepOffset = 0) {
  let insertedPostId = null;
  let onedriveFileId = input.onedriveFileId;
  let settings = null;
  // Adapter der aktiven Ablage — Neuzugänge landen immer dort.
  // Wird direkt nach dem Laden der Settings gesetzt.
  let storage = null;
  let aktenEntries = null;
  let extractedData = null;
  // Ergebnis der Phase-2.5-Prüfung. Wie extractedData auf Funktionsebene, damit
  // der catch-Block es sieht (genau dort lag der Bug, der die Pipeline 2024
  // stumm hängen ließ: eine let-Deklaration im try ist im catch nicht sichtbar).
  let validierung = null;
  let _lockedId = null; // die ID, die wir in _inFlightIds registriert haben
  let replacementStarted = false;
  let replacementClient = null;
  let dbStateComplete = false;
  // Schon vor Phase 1 bekannt: Auch ein früher Nutzerabbruch darf beim
  // Reprocess niemals die weiterhin gültige Originaldatei entsorgen.
  let replacementMode = input.modifyPostID
    ? 'same_file'
    : input._resume?.decision === 'replace' ? 'duplicate' : null;
  let movedFileMeta = null;
  let ebPending = false;
  let preservedLxdMigrationItem = null;
  let preservedStorageMigrationItems = [];
  let preservedDokumentPins = [];
  let existingErfassungsdatum = null;
  let duplicateCleanupPending = false;

  // Ein Retry aus der Failed-Liste (routes/actions.js) lässt seinen
  // _failed_documents-Eintrag bewusst stehen, bis dieser Lauf ihn erledigt hat.
  // Wird er vorab gelöscht, ist das Dokument nach einem erneuten Fehlschlag —
  // oder nach einem Absturz/Hänger vor moveToFailed — im UI unauffindbar und
  // liegt nur noch im _failed-Ordner der Ablage.
  const clearFailedEntry = () => (input.onedriveFileId
    ? pool.query('DELETE FROM postbuch._failed_documents WHERE onedrive_id = $1', [input.onedriveFileId]).catch(() => {})
    : Promise.resolve());

  // ── Timing-Tracking ────────────────────────────────────────────────────────
  const tTotal = Date.now();
  const timings = {}; // { phase: ms }
  let _phaseStart = Date.now();
  const startPhase = () => { _phaseStart = Date.now(); };
  const endPhase   = (name) => { timings[name] = Date.now() - _phaseStart; };

  // ── Debug-Log (gesammelte Einträge für OneDrive-Upload) ───────────────────
  const debugEntries = [];
  const debugLog = (step, data) => debugEntries.push({ step, ts: new Date().toISOString(), ...data });

  try {
    // ─── In-Flight-Sperre (Pfad A): ID bereits beim Aufruf bekannt ───
    // Tritt auf wenn onedrive-watcher eine Datei findet, die der Scanner-Webhook
    // gerade schon verarbeitet (Datei liegt noch im Inbox-Ordner).
    if (onedriveFileId) {
      if (input.preclaimedInFlight) {
        _lockedId = onedriveFileId;
      } else if (!claimInFlight(onedriveFileId)) {
        console.log(`[doc-processor] Doppelverarbeitung verhindert: ${onedriveFileId} wird bereits verarbeitet`);
        appLog('WARN', 'doc-processor', `Doppelverarbeitung verhindert (Race Condition) für OneDrive-ID: ${onedriveFileId}`);
        tracker.complete(jobId);
        return;
      } else {
        _lockedId = onedriveFileId;
      }
    }

    settings = await loadDynamicSettings();
    // Trägt der Eingang eine Datei-ID, gehört sie dem Backend, aus dem sie
    // stammt — NICHT dem gerade aktiven. Ein Job, der vor einem Backend-Wechsel
    // eingereiht und danach gedraint wird, suchte sonst eine OneDrive-ID in
    // Nextcloud. Buffer-Eingänge (Scanner, Upload) haben kein Backend und
    // landen korrekt im aktiven.
    storage = onedriveFileId && input.storageBackend
      ? getAdapter(input.storageBackend)
      : getActiveAdapterFor(settings);

    // Wiederaufnahme nach Suspension? Phase 0/1/2 können dann übersprungen werden,
    // KI-Analyse und Download wurden bereits gemacht (KI-Kosten nicht doppelt berechnen).
    const isResume = !!input._resume;

    // Identitätsguard: Ein Retry aus der Failed-Liste (routes/actions.js) liefert
    // dieselbe onedriveFileId erneut ein. Steckt die Datei unter genau dieser ID
    // bereits in postbuch.postbuch, war die vorherige KI-Analyse in Wahrheit
    // erfolgreich — nur der (spätere) Fehlereintrag ist stehen geblieben, z. B.
    // weil der periodische Pipeline-Recovery-Sweep dieselbe physikalische Datei
    // zusätzlich nach _failed verschoben hat. Eine Neuanalyse würde hier nur
    // unnötige KI-Kosten verursachen und in der inhaltsbasierten Duplikaterkennung
    // als "Duplikat seiner selbst" wieder auftauchen. NICHT für bewusste
    // Wiederverarbeitung derselben Datei (modifyPostID/same_file) oder eine
    // Suspension-Wiederaufnahme greifen — die finden ihre eigene storage_id
    // absichtlich wieder.
    if (onedriveFileId && !input.modifyPostID && !isResume) {
      const bereitsEingebucht = await pool.query(
        'SELECT postid, betreff, lebensbereich, dokumentart, familienmitglied FROM postbuch.postbuch WHERE storage_id = $1 AND storage_backend = $2 LIMIT 1',
        [onedriveFileId, storage.name],
      );
      if (bereitsEingebucht.rows.length > 0) {
        const { postid, betreff, lebensbereich, dokumentart, familienmitglied } = bereitsEingebucht.rows[0];
        try {
          // Derselbe Sweep, der den Fehleintrag erst erzeugt hat, kann die
          // physische Datei zusätzlich nach _failed verschoben haben, während
          // storage_id und die postbuch-Zeile unverändert blieben (genau die
          // P000002-Korruption vom Testsystem). Soll-Ist-Abgleich wie bei einer
          // manuellen LxD-Korrektur (type-change.js): aktuellen Ordner gegen die
          // aus der DB-Klassifikation berechnete Sollablage prüfen und bei
          // Abweichung dorthin zurückverschieben, bevor der Fehleintrag verschwindet.
          const meta = await storage.getMeta(onedriveFileId);
          const sollFolderId = await ensureAblageOrdner(settings, { lebensbereich, dokumentart, familienmitglied }, storage.name);
          if (meta.parentId !== sollFolderId) {
            const zurueckverschoben = await storage.move(onedriveFileId, sollFolderId, meta.name);
            if (zurueckverschoben.webUrl) {
              await pool.query('UPDATE postbuch.postbuch SET link = $1 WHERE postid = $2', [zurueckverschoben.webUrl, postid]);
            }
            console.log(`[doc-processor] ${postid}: Datei aus Fehlablage in korrekten Ordner zurückverschoben`);
          }
          await clearFailedEntry();
          appLog('WARN', 'doc-processor',
            `Erneute Einlieferung einer bereits abgelegten Datei übersprungen: ${postid}`,
            { entity: 'postbuch', entityId: postid });
          console.log(`[doc-processor] ${onedriveFileId} ist bereits als ${postid} abgelegt — Fehleintrag bereinigt, keine Neuanalyse`);
          tracker.complete(jobId, { postid, betreff: betreff || null, bereitsVorhanden: true });
        } catch (err) {
          // Fehleintrag bewusst NICHT löschen: Bleibt sichtbar für einen erneuten
          // Retry, statt eine noch immer falsch liegende Datei aus dem Blick zu
          // verlieren.
          appLog('ERROR', 'doc-processor',
            `Bereits abgelegte Datei ${postid} (${onedriveFileId}) konnte nicht verifiziert/zurückverschoben werden: ${err.message}`,
            { entity: 'postbuch', entityId: postid });
          tracker.fail(jobId, `Datei bereits als ${postid} abgelegt, aber Lageprüfung fehlgeschlagen: ${err.message}`);
        }
        return;
      }
    }

    // Scanner-Pfad = Datei kommt aus der Scan-/Cleaner-Pipeline und trägt eine vom
    // Tesseract eingebettete (oft fehlerhafte) OCR-Textebene → vor der KI-Analyse
    // strippen, weil dort alle Informationen im Bild stecken und die OCR-Ebene das
    // LLM nur in die Irre führt. Dies wird ausschließlich über das explizite
    // input.fromScanner-Flag entschieden (gesetzt vom Scan-Webhook / Scan-Retry).
    //
    // WICHTIG: NICHT mehr aus dem bloßen Vorhandensein eines pdfBuffers ableiten —
    // manuelle Uploads (import.js) kommen ebenfalls als pdfBuffer herein, sind aber
    // textnative PDFs mit echtem Inhalt. Deren Textebene darf in der normalen
    // Dunkelverarbeitung NIEMALS verworfen werden (Datenverlust). Das Verwerfen
    // bei Nicht-Scanner-Dokumenten ist allein User-Choice bei der Wiederverarbeitung
    // (input.textebeneEntfernen, mit Voranalyse-Vorschlag).
    const isFromScanner = !!input.fromScanner && !isResume;

    // ─── PHASE 0: Scanner-Eingang → OneDrive-Upload ───
    if (input.pdfBuffer && !onedriveFileId && !isResume) {
      startPhase();
      tracker.setStep(jobId, stepOffset + 0, 'PDF auf OneDrive hochladen');
      if (tracker.isCancelled(jobId)) throw new CancellationError();

      const inboxFolderId = getFolders(settings).inbox;
      if (!inboxFolderId) throw new Error('Inbox-Ordner der Ablage nicht konfiguriert');

      const uploaded = await storage.uploadNew(
        input.pdfBuffer,
        input.filename || `scan_${Date.now()}.pdf`,
        inboxFolderId
      );
      onedriveFileId = uploaded.id;

      // ─── In-Flight-Sperre (Pfad B): ID erst nach Upload bekannt ───
      // Der Watcher könnte die soeben hochgeladene Datei bereits gefunden haben.
      if (!claimInFlight(onedriveFileId)) {
        console.log(`[doc-processor] Doppelverarbeitung verhindert nach Upload: ${onedriveFileId} wird bereits verarbeitet`);
        appLog('WARN', 'doc-processor', `Doppelverarbeitung verhindert (Race Condition nach Upload) für OneDrive-ID: ${onedriveFileId}`);
        tracker.complete(jobId);
        return; // Datei im Inbox belassen – der andere Prozess verarbeitet sie
      }
      _lockedId = onedriveFileId;

      endPhase('Upload');

      // Scan-Buffer löschen: PDF ist jetzt auf OneDrive, lokale Kopie nicht mehr nötig.
      const _uploadBufferJobId = input._retrySourceJobId || jobId;
      await deleteScanBuffer(_uploadBufferJobId).catch(() => {});
      await pool.query(
        'DELETE FROM postbuch._scan_retry_queue WHERE job_id = $1',
        [_uploadBufferJobId]
      ).catch(() => {});
    }

    extractedData = isResume ? (input.extractedData || null) : null;
    let pdfOriginal = null;
    let plog = {};

    // ─── PHASE 1: PDF herunterladen ───
    if (!isResume) {
      startPhase();
      tracker.setStep(jobId, stepOffset + 1, 'PDF herunterladen von OneDrive');
      if (tracker.isCancelled(jobId)) throw new CancellationError();
      pdfOriginal = input.pdfBuffer || await storage.download(onedriveFileId);
      endPhase('Download');
    }

    // ─── PHASE 2: KI-Analyse ───
    if (!isResume || !extractedData) {
      // Fallback: kein extractedData im _resume-Payload → Analyse erneut ausführen
      if (!pdfOriginal) {
        pdfOriginal = input.pdfBuffer || await storage.download(onedriveFileId);
      }
      startPhase();
      tracker.setStep(jobId, stepOffset + 2, 'KI-Analyse');
      if (tracker.isCancelled(jobId)) throw new CancellationError();

      let korrekturKontext = input.modifyPostID
        ? buildKorrekturKontext(input)
        : null;
      if (input.userHinweis) {
        korrekturKontext = (korrekturKontext || '') + `\n\n### BENUTZER-HINWEIS ###\n${input.userHinweis}\n`;
        // Zustellung des Benutzer-Hinweises protokollieren — der Scanner-Pfad trägt ihn
        // über eine flüchtige In-Memory-Registry; dieses Log macht nachvollziehbar, ob
        // er den Job tatsächlich erreicht hat.
        appLog('INFO', 'doc-processor', `Benutzer-Hinweis an KI-Analyse übergeben (Job ${jobId || '?'}): "${String(input.userHinweis).slice(0, 120)}"`,
          { entity: 'postbuch', entityId: input.modifyPostID || null });
      }

      const activePersonsResult = await pool.query(
        `SELECT kurzname, anzeigename AS vollname, ist_tier, pkv, beihilfe, pkv_satz, beihilfe_satz, archiviert
         FROM postbuch.mensch
         WHERE archiviert = false
         ORDER BY kurzname`
      );
      const aktiveTaxonomie = await getAktiveTaxonomie();
      const classificationPrompt = buildLxdClassificationPromptParts(
        activePersonsResult.rows,
        settings.classification_custom_rules,
        aktiveTaxonomie,
      );

      // OCR-Textebene vor KI-Analyse entfernen — gewünscht in zwei klar definierten Fällen:
      //   • Scanner-Pfad (input.fromScanner): immer — Tesseract-OCR ist häufig
      //     fehlerhaft und führt das LLM in die Irre; alle Infos stecken im Bild.
      //   • Wiederverarbeitung: nur wenn der Benutzer es ausdrücklich gewählt hat
      //     (input.textebeneEntfernen). Der Re-Download von OneDrive trägt die
      //     OCR-Ebene weiterhin, daher hier explizit anfordern.
      // Normale Pipeline ohne Scanner (Watcher, manuelle Uploads): Textebene bleibt
      // IMMER erhalten. Speicher-Pfad (Phasen 5/7/8/9) nutzt ohnehin pdfOriginal mit
      // Textebene für die Volltextsuche.
      //
      // AUSGEFÜHRT wird das Strippen seit 1.7.0 in lib/llm.js, nicht hier: ob es
      // erlaubt ist, hängt vom Provider des jeweiligen Kettenglieds ab. Ein
      // Text-only-Provider bekäme sonst ein PDF ohne jeden extrahierbaren Text.
      const stripTextLayerGewuenscht = !!(isFromScanner || input.textebeneEntfernen);

      // Wiederverarbeitung mit manueller Modellwahl: input.modelTier (≠ 'auto')
      // erzwingt eine feste Modellstufe und überspringt den Preclassifier.
      const forceTier = input.modelTier && input.modelTier !== 'auto' ? input.modelTier : null;

      extractedData = await llm.analyzeDocument(
        pdfOriginal,
        classificationPrompt,
        korrekturKontext,
        settings,
        { entity: 'postbuch', entityId: input.modifyPostID || null, correlationId: jobId || null },
        {
          forceTier,
          stripTextLayerGewuenscht,
          validateResult: (data) => pruefeFachblockStruktur(data, aktiveTaxonomie),
        },
      );
      endPhase('KI-Analyse');
      plog = extractedData._pipelineLog || {};
      debugLog('ki-analyse', {
        model: plog.analysisModel,
        providerId: plog.analysisProviderId,
        inputMode: plog.inputMode,
        preAnalysisMs: plog.preAnalysisMs,
        analysisMs: plog.analysisMs,
        chainModels: plog.chainModels,
        chainReason: plog.chainReason,
        failedModels: plog.failedModels,
        rawPreAnalysisResponse: plog.rawPreAnalysisResponse,
        rawAnalysisResponse: plog.rawAnalysisResponse,
        result: extractedData,
      });

      console.log(`[doc-processor] KI-Analyse: L×D=${extractedData.lebensbereich}/${extractedData.dokumentart}, Sicherheit=${extractedData.qualityFlags?.sicherheitsgrad}`);
      const isFallback = (plog.failedModels?.length || 0) > 0;
      const fallbackHint = isFallback
        ? `; ${plog.failedModels.join(', ')} fehlgeschlagen, Fallback zu ${plog.analysisModel}`
        : '';
      const pipelineSummary =
        `Voranalyse: ${plog.pages || 1} Seite${(plog.pages || 1) !== 1 ? 'n' : ''}, d=${plog.difficulty ?? '?'} in ${plog.preAnalysisMs ?? '?'}ms, ` +
        `Analyse mit ${plog.analysisModel} (${plog.chainReason ?? '?'}${fallbackHint}) in ${plog.analysisMs ?? '?'}ms`;
      appLog('INFO', 'doc-processor', `KI-Analyse: L×D=${extractedData.lebensbereich}/${extractedData.dokumentart}, Sicherheit=${extractedData.qualityFlags?.sicherheitsgrad}`, {
        details: pipelineSummary,
        entity: 'postbuch',
        entityId: input.modifyPostID || null,
      });
    } else {
      plog = extractedData._pipelineLog || {};
    }

    // ─── PHASE 2.5: Validierung & Reparatur der KI-Ausgabe ───
    //
    // Bewusst HIER, wo Erstlauf und Suspension-Resume wieder zusammenlaufen:
    //   • der Resume überspringt Phase 2 (siehe oben) und käme an einer späteren
    //     Prüfung vorbei;
    //   • das Embedding in Phase 3 entsteht damit aus bereinigten Daten statt aus
    //     Müll, der sonst dauerhaft im Vektor stünde;
    //   • der Suspension-Payload weiter unten trägt bereits geprüfte Daten;
    //   • und die stille Fehlablage über getFolderId in Phase 5 ist nicht mehr
    //     erreichbar, weil ein unbekannter Typ hier schon abgefangen wird.
    //
    // Kein eigener tracker-Schritt: die Schrittzahl ist Vertrag mit dem
    // WebSocket-UI. Stattdessen nur das Label des laufenden Schritts.
    tracker.setStep(jobId, stepOffset + 2, 'KI-Analyse — Ausgabe wird geprüft');
    const pruefung = await pruefeUndRepariere(extractedData, settings, {
      correlationId: jobId,
      entity: 'postbuch',
      entityId: input.modifyPostID || null,
    });
    extractedData = pruefung.data;
    validierung = pruefung;

    // Beim Resume nach einer Duplikat-Suspension liegen im Payload bereits die
    // BEREINIGTEN Daten des Erstlaufs — die Prüfung findet dort zu Recht nichts
    // mehr. Ohne das Übernehmen des damaligen Ergebnisses gingen genau in diesem
    // Fall die Review-Pflicht (Status bliebe AIClearance) und der Audit-Trail
    // (data_repairs bliebe NULL) verloren.
    if (isResume && input.validierungVorlauf?.repariert && !pruefung.repariert) {
      validierung = {
        ...pruefung,
        repariert: true,
        reparaturen: input.validierungVorlauf.reparaturen || [],
      };
      console.log('[doc-processor] Resume: Reparatur-Status aus dem Erstlauf übernommen');
    }

    if (pruefung.fatal) {
      // Nur Pflichtfelder ohne zulässigen Ersatzwert landen hier (L/D oder Legacy-Typ).
      // Ein stiller Fallback auf 'Sonstiges' würde die typspezifischen
      // Folgeworkflows überspringen — lauter Fehlschlag ist ehrlicher.
      throw new Error(fatalMeldung(pruefung.fatal));
    }
    if (pruefung.repariert) {
      console.log(`[doc-processor] KI-Ausgabe korrigiert: ${pruefung.reparaturen.map(r => `${r.feld}=${r.ergebnis}`).join(', ')}`);
      // In qualityFlags.warnungen spiegeln: das Array wird im Detail-View bereits
      // angezeigt (Confidence-Badge) und geht in Discord-Nachricht und
      // Suspension-Payload mit ein — der Nutzer erfährt so ohne neues UI-Element,
      // dass und was korrigiert wurde.
      if (!extractedData.qualityFlags) extractedData.qualityFlags = {};
      if (!Array.isArray(extractedData.qualityFlags.warnungen)) {
        extractedData.qualityFlags.warnungen = [];
      }
      for (const r of pruefung.reparaturen) {
        const text = r.ergebnis === 'genullt'
          ? `Feld "${r.feld}" konnte nicht übernommen werden (${r.roh}) — bitte prüfen und nachtragen`
          : `Feld "${r.feld}" wurde automatisch korrigiert (${r.roh} → ${r.neu})`;
        extractedData.qualityFlags.warnungen.push(text);
      }
    }

    // Invalidierung einer korrigierten Rechnung: Ergebnis erzwingen, nicht
    // erhoffen. Der Prompt bittet die KI um dasselbe, aber ein Modell, das den
    // Rechnungsblock trotzdem liefert, würde die Forderung wieder auferstehen
    // lassen. Bewusst vor Phase 3: Embedding, Ablage-Sortierung und DB-Insert
    // sollen den invalidierten Zustand sehen.
    if (input.rechnungInvalidierung) {
      wendeInvalidierungAn(extractedData, input.rechnungInvalidierung);
      appLog('INFO', 'doc-processor',
        `Rechnung invalidiert: Rechnungsblock entfällt, Einordnung ${extractedData.lebensbereich}/${extractedData.dokumentart}`,
        { entity: 'postbuch', entityId: input.modifyPostID || null, correlationId: jobId || null });
    }

    // ─── PHASE 3: Duplikaterkennung (Embedding-basiert) ───
    startPhase();
    tracker.setStep(jobId, stepOffset + 3, 'Duplikaterkennung');
    if (tracker.isCancelled(jobId)) throw new CancellationError();

    // _resume: Wiederaufnahme nach Suspension (Entscheidung bereits gefallen)
    let newEmbedding = input._resume?.embedding || null;
    // Signatur des Vektors. Bei einem Resume gilt die damals gespeicherte: ein
    // zwischenzeitlicher Modellwechsel darf den alten Vektor nicht als aktuell
    // ausgeben. Der Duplikat-Check filtert dann korrekt auf null-Treffer.
    let newEmbeddingSignature = input._resume?.embeddingSignature || null;
    let embErrMessage = null; // gesetzt wenn Embedding-API fehlschlägt (Soft-Fail)

    if (!isResume) {
      try {
        newEmbeddingSignature = await aktuelleEmbeddingSignatur();
        newEmbedding = await fetchEmbeddingForExtractedData(extractedData, settings, {
          entity: 'postbuch', entityId: input.modifyPostID || null, correlationId: jobId || null,
        });
      } catch (embErr) {
        // Embedding-Fehler ist kein fataler Fehler: Dokument wird ohne Embedding gespeichert.
        // Folgen: Duplikat-Erkennung wird übersprungen, semantische Suche funktioniert
        // für dieses Dokument nicht, bis das Embedding nachgeneriert wird (Einstellungen → Embedding).
        const embApiErr = classifyApiError(embErr.message);
        const embHint = embApiErr.label ? ` (${embApiErr.label})` : '';
        embErrMessage = embErr.message.slice(0, 500);
        console.warn(`[doc-processor] Embedding-API nicht erreichbar${embHint} — Duplikat-Check übersprungen: ${embErr.message}`);
        appLog('WARN', 'doc-processor',
          `Embedding fehlgeschlagen${embHint} — Duplikat-Check übersprungen. Embedding kann später in Einstellungen → KI nachgeneriert werden.`,
          { details: embErr.message }
        );
        newEmbedding = null;
        newEmbeddingSignature = null;
      }
    }

    const threshold = Number(settings.duplicate_embedding_threshold || 0.90);
    const dupResult = await duplicateChecker.check(
      { extractedData, embedding: newEmbedding, modifyPostID: input.modifyPostID, threshold },
      pool
    );
    const { isDuplicate, matchID, match: dupMatch } = dupResult;

    // PostID bestimmen
    let finalPostID;
    if (input.modifyPostID) {
      finalPostID = input.modifyPostID;
    } else if (isResume && input._resume.decision === 'replace') {
      // Ersetze bestehendes Dokument: benutze alte PostID
      finalPostID = input._resume.matchPostid;
    } else if (isResume && input._resume.decision === 'keep_both') {
      // Beide behalten: benutze reservierte neue PostID
      finalPostID = input._resume.reservedPostid;
    } else if (isDuplicate && !isResume) {
      // Duplikat erkannt, noch keine Entscheidung → Suspension anlegen
      const timeoutMin = Number(settings.duplicate_decision_timeout_min || 60);
      const expiresAt = new Date(Date.now() + timeoutMin * 60_000);

      const seqResult = await pool.query(
        `SELECT 'P' || lpad(nextval('postbuch.postbuch_seq')::text, 6, '0') AS postid`
      );
      const reservedPostID = seqResult.rows[0].postid;

      // Datei in den _suspended-Ordner verschieben:
      // (1) Verhindert Doppelverarbeitung — Datei liegt nicht mehr in der Inbox,
      //     der Watcher findet sie beim nächsten Poll nicht erneut.
      // (2) Liefert webUrl für die Discord-Benachrichtigung ("Neues Dokument"-Link).
      // Beim Wiederaufnehmen führt Phase 5 den finalen Move in den Zielordner aus —
      // OneDrive-Item-IDs bleiben beim Verschieben stabil.
      let sortedWebUrl = null;
      const suspendedFolderId = getFolders(settings).suspended;
      if (suspendedFolderId) {
        const suspDateiname = (extractedData.postbuch?.dateiname || 'Dokument').replace(/\.pdf$/i, '');
        const suspFileName = `${suspDateiname} ${reservedPostID}.pdf`;
        try {
          const moveResult = await storage.move(onedriveFileId, suspendedFolderId, suspFileName);
          sortedWebUrl = moveResult.webUrl;
          console.log(`[doc-processor] Suspension: ${suspFileName} → _suspended (${sortedWebUrl})`);
        } catch (err) {
          console.warn(`[doc-processor] Suspension-Move nach _suspended fehlgeschlagen (Datei bleibt in Inbox): ${err.message}`);
        }
      } else {
        console.warn('[doc-processor] storage_folders.<backend>.suspended nicht konfiguriert — Datei bleibt in Inbox (Doppelverarbeitung möglich)');
      }

      // pdfBuffer aus dem Payload entfernen: Ein Buffer überlebt den JSON-Roundtrip
      // nicht als Buffer, sondern wird zu {type:'Buffer',data:[...]}. Das würde beim
      // Resume eines Scanner-Jobs erneut Phase 0 auslösen und ein kaputtes Objekt
      // als Datei hochladen ("[object Object]" → qpdf "can't find PDF header").
      // Gleichzeitig das aufgelöste onedriveFileId setzen, damit das Resume die
      // Datei direkt herunterladen kann.
      const { pdfBuffer: _omitPdfBuffer, _resume: _omitResume, ...inputForSusp } = input;
      // validierungVorlauf mitgeben: extractedData ist hier bereits bereinigt,
      // die Prüfung beim Resume fände deshalb nichts mehr und würde das Dokument
      // fälschlich als unrepariert durchwinken.
      const suspPayload = {
        ...inputForSusp,
        onedriveFileId,
        extractedData,
        validierungVorlauf: validierung?.repariert
          ? { repariert: true, reparaturen: validierung.reparaturen }
          : null,
      };

      const newConf = Number(extractedData.qualityFlags?.sicherheitsgrad || 0);
      const suspension = await suspensionStore.create({
        jobId,
        reason: 'duplicate_detected',
        onedriveId: onedriveFileId,
        storageBackend: storage.name,
        onedriveWeburl: sortedWebUrl,
        reservedPostid: reservedPostID,
        matchPostid: dupMatch.postid,
        matchWeburl: dupMatch.webUrl,
        matchConfidence: dupMatch.confidence,
        similarity: dupMatch.similarity,
        newConfidence: newConf,
        embedding: newEmbedding,
        embeddingSignature: newEmbeddingSignature,
        payload: suspPayload,
        stepOffset,
        expiresAt,
      });

      // Discord-Benachrichtigung (best-effort)
      const discordMessageId = await duplicateNotifier.requestDecision({
        jobId, reservedPostID, dup: dupResult, extractedData, onedriveWeburl: sortedWebUrl, expiresAt,
      }, settings).catch(err => {
        console.warn('[doc-processor] Discord-Duplikat-Notification fehlgeschlagen:', err.message);
        return null;
      });

      if (discordMessageId) {
        await pool.query(
          'UPDATE postbuch._pipeline_suspensions SET discord_message_id = $1 WHERE job_id = $2',
          [discordMessageId, jobId]
        ).catch(() => {});
      }

      tracker.markSuspended(jobId);
      appLog('INFO', 'doc-processor', `Duplikat erkannt → Job ${jobId} suspendiert. Match: ${dupMatch.postid}, Ähnlichkeit: ${Math.round(dupMatch.similarity * 100)}%`, { entity: 'postbuch', entityId: reservedPostID });
      console.log(`[doc-processor] Job ${jobId} suspendiert — Duplikat von ${dupMatch.postid}`);
      return; // Pipeline-Slot freigeben; finally-Block läuft durch
    } else {
      // Kein Duplikat: neue PostID vergeben
      const seqResult = await pool.query(
        `SELECT 'P' || lpad(nextval('postbuch.postbuch_seq')::text, 6, '0') AS postid`
      );
      finalPostID = seqResult.rows[0].postid;
    }

    // Ab jetzt existiert eine reservierte PostID. Das Journal steht bewusst
    // VOR dem Löschen eines Ersetzungsziels und VOR dem externen Datei-Move:
    // nach SIGKILL/Stromausfall kann der Start-Recoverer die Datei dadurch
    // eindeutig laut nach _failed überführen.
    replacementMode = input.modifyPostID
      ? 'same_file'
      : (isResume && input._resume.decision === 'replace') ? 'duplicate' : null;
    await pipelineFileJournal.prepare({
      jobId,
      postid: finalPostID,
      storageId: onedriveFileId,
      storageBackend: storage.name,
      replacementMode,
    });
    endPhase('Duplikat-Check');

    console.log(`[doc-processor] Duplikat: ${isDuplicate}, matchID=${matchID}, finalPostID=${finalPostID}`);
    if (isDuplicate && !input.modifyPostID) appLog('INFO', 'doc-processor', `Duplikat erkannt: matchID=${matchID}, finalPostID=${finalPostID}`, { entity: 'postbuch', entityId: finalPostID });

    // ─── PHASE 4: Duplikat-Handling (_resume-Modus oder Korrektur) ───
    tracker.setStep(jobId, stepOffset + 4, 'Duplikat-Handling');
    if (tracker.isCancelled(jobId)) throw new CancellationError();

    let existingOnedriveId = null;
    let existingNotiz = null;
    let existingHistorisch = false;
    let preservedBezahltAm = null; // { value: date|null } — nur gesetzt wenn bezahlt_am_manuell=true
    let preservedBestrittenBetrag = null;
    let preservedArzWorkflow = null;
    let preservedPostbuchWorkflow = null;
    let preservedWiedervorlagen = [];
    let preservedSaldoQuelleIds = [];
    let existingDoc = null;
    const resolvedMatchID = input._resume?.matchPostid || matchID;

    // Im _resume-Modus (replace) oder modifyPostID: alten Eintrag ersetzen
    const shouldReplace = replacementMode !== null;

    // Personenbezüge auf erfasste Kurznamen abbilden (vor der Sortierung, weil
    // familienmitglied bei Personenablage den Zielordner bestimmt): familienmitglied gegen alle
    // Menschen, behandeltePerson gegen Menschen mit PKV/Beihilfe. Eine Angabe,
    // die sich nicht eindeutig zuordnen lässt, wird verworfen — und weil dann
    // niemand die Zuordnung gesehen hat, geht das Dokument in die Prüfung.
    let personVerworfen = false;
    const pruefePerson = (feld, roh, menschen) => {
      const ergebnis = gleichePersonAb(roh, menschen);
      if (ergebnis.art === 'verworfen') {
        personVerworfen = true;
        appLog('WARN', 'doc-processor',
          `${feld} "${String(roh).slice(0, 80)}" ist keinem erfassten Menschen eindeutig zuzuordnen — Feld bleibt leer`,
          { entity: 'postbuch', entityId: input.modifyPostID || null, correlationId: jobId || null });
      } else if (ergebnis.art === 'normalisiert') {
        appLog('INFO', 'doc-processor',
          `${feld} "${String(roh).slice(0, 80)}" → Kurzname "${ergebnis.kurzname}"`,
          { entity: 'postbuch', entityId: input.modifyPostID || null, correlationId: jobId || null });
      }
      return ergebnis.kurzname;
    };
    const menschen = (await pool.query(
      `SELECT kurzname, anzeigename, pkv, beihilfe FROM postbuch.mensch`)).rows;
    const familienmitglied = pruefePerson(
      'familienmitglied', extractedData.postbuch?.familienmitglied, menschen);
    const patienten = menschen.filter((m) => m.pkv || m.beihilfe);
    for (const block of [extractedData.arztrechnung, extractedData.arztbericht]) {
      if (block && typeof block === 'object' && 'behandeltePerson' in block) {
        block.behandeltePerson = pruefePerson('behandeltePerson', block.behandeltePerson, patienten);
      }
    }

    // ─── PHASE 5: OneDrive-Sortierung ───
    startPhase();
    tracker.setStep(jobId, stepOffset + 5, 'OneDrive-Sortierung');
    if (tracker.isCancelled(jobId)) throw new CancellationError();

    if (typeof extractedData.lebensbereich !== 'string' || typeof extractedData.dokumentart !== 'string') {
      throw new Error('Klassifikation enthält keine vollständige L×D-Einordnung.');
    }
    const destFolderId = await ensureAblageOrdner(settings, {
      lebensbereich: extractedData.lebensbereich,
      dokumentart: extractedData.dokumentart,
      familienmitglied,
    }, storage.name);

    // .pdf am Ende entfernen falls LLM es mitliefert (war in n8n bereits ein Bug)
    const dateinameRaw = extractedData.postbuch?.dateiname || 'Dokument';
    const dateiname = dateinameRaw.replace(/\.pdf$/i, '');
    const wunschFileName = `${dateiname} ${finalPostID}.pdf`;
    await pipelineFileJournal.noteMoveIntent(jobId, destFolderId, wunschFileName);
    // Der Adapter kann den Namen ändern: er saniert ihn (der Wunschname kommt
    // aus einer LLM-Ausgabe) und weicht bei Namenskollision auf „… (2).pdf"
    // aus. Ab hier gilt deshalb der zurückgegebene Name — sonst stünde in
    // storage_filename ein Name, den es in der Ablage so nicht gibt.
    const { id: newFileId, webUrl, name: newFileName } = await storage.move(
      onedriveFileId, destFolderId, wunschFileName
    );
    movedFileMeta = { id: newFileId, webUrl, name: newFileName, lastModified: null };
    await pipelineFileJournal.noteMoved(jobId, newFileId, newFileName);
    console.log(`[doc-processor] Datei verschoben: ${newFileName} → ${webUrl}`);
    appLog('INFO', 'doc-processor', `Ablage-Sortierung: ${newFileName}`, { entity: 'postbuch', entityId: finalPostID });
    endPhase('Sortierung');

    // Ab hier: onedriveFileId aktualisieren (Datei wurde verschoben)
    onedriveFileId = newFileId;

    // ─── PHASE 6: Discord + Push-Benachrichtigung ───
    tracker.setStep(jobId, stepOffset + 6, 'Benachrichtigung');
    const isReprocessing = !!input.modifyPostID;
    const isDuplicateReplace = shouldReplace && !isReprocessing;
    await discord.sendMessage(
      buildDiscordSuccessMessage(extractedData, finalPostID, isDuplicateReplace, webUrl, isReprocessing),
      settings
    );
    // Push-Benachrichtigung (fire-and-forget, kein Fehler nach oben).
    // Kategorie: bei Wiederverarbeitung 'reprocess', sonst 'new_doc' (auch bei Duplikat-Ersetzung,
    // weil aus Nutzersicht ein neues bzw. verbessertes Dokument erscheint).
    const successCategory = isReprocessing ? 'reprocess' : 'new_doc';
    sendPushToAllUsers(
      buildPushSuccessPayload(extractedData, finalPostID, isDuplicateReplace, isReprocessing, settings),
      { category: successCategory },
    ).catch((e) => console.warn('[doc-processor] Push-Fehler:', e.message));

    // ─── PHASE 7: PDF-Rotation ───
    // Beim Resume wurde PDF nicht heruntergeladen → jetzt nachholen (billig, keine KI-Kosten)
    if (!pdfOriginal) pdfOriginal = await storage.download(onedriveFileId);
    let pdfFinal = pdfOriginal;
    const rotation = Number(extractedData.rotation || 0);
    if (rotation > 0) {
      startPhase();
      tracker.setStep(jobId, stepOffset + 7, 'PDF rotieren');
      // rotation ist die erkannte Verdrehung; die Korrektur ist der Gegenwinkel
      const correctionAngle = (360 - rotation) % 360;
      pdfFinal = await pdf.rotatePdf(pdfOriginal, correctionAngle);
      await storage.uploadContent(newFileId, pdfFinal);
      endPhase('Rotation');
      console.log(`[doc-processor] PDF um ${rotation}° rotiert und hochgeladen`);
    }

    // DR-Fingerprint direkt beim Import setzen, damit neue Dokumente nicht
    // bis zum nächsten Fingerprint-Job als "ausstehend" erscheinen.
    const importSha256 = sha256Hex(pdfFinal);
    const importMeta = await storage.getMeta(newFileId);
    movedFileMeta = {
      id: newFileId,
      webUrl: importMeta.webUrl || webUrl,
      name: importMeta.name || newFileName,
      lastModified: importMeta.lastModified || null,
    };

    // ─── PHASE 8: Datenbank-Inserts ───
    startPhase();
    tracker.setStep(jobId, stepOffset + 8, 'Datenbank-Insert');
    if (tracker.isCancelled(jobId)) throw new CancellationError();

    const sicherheitsgrad = Number(extractedData.qualityFlags?.sicherheitsgrad || 0);
    // Eine KI, die sich beim Dokumenttyp oder beim Betrag vertan hat, kann sich
    // auch anderswo vertan haben — nach jeder Korrektur prüft ein Mensch nach,
    // unabhängig vom gemeldeten Sicherheitsgrad.
    const status = (sicherheitsgrad >= 0.9 && !validierung?.repariert && !personVerworfen)
      ? 'AIClearance'
      : 'NeedsUserReview';

    const schlagwoerter = extractedData.postbuch?.schlagwörter
      || extractedData.postbuch?.schlagwoerter
      || null;


    // Richtung: 'eingang' oder 'ausgang'. Default 'eingang'. Wenn 'ausgang' aber
    // kein gültiges Familienmitglied → auf 'eingang' zurückfallen.
    const rawRichtung = extractedData.postbuch?.richtung;
    let richtung = rawRichtung === 'ausgang' ? 'ausgang' : 'eingang';
    if (richtung === 'ausgang' && !familienmitglied) richtung = 'eingang';

    const rawKontakt = extractedData.postbuch?.kontakt;
    const kontakt = (typeof rawKontakt === 'string' && rawKontakt.trim()) ? rawKontakt.trim() : null;

    // Legacy-Spalten onedrive_* nur füllen, wenn die Datei wirklich in OneDrive
    // liegt (siehe legacyOnedriveWerte) — sonst stünde eine Fremd-ID im Rückweg.
    const legacyOd = legacyOnedriveWerte(storage.name, {
      id: newFileId,
      name: importMeta.name || newFileName,
      modified: importMeta.lastModified || null,
    });

    const neueGruppe = await effektiveGruppe(
      extractedData.lebensbereich,
      extractedData.dokumentart,
    );
    const zielRechnungstabelle = neueGruppe === 'arztrechnung'
      ? 'arztrechnung'
      : neueGruppe === 'handwerker'
        ? 'handwerkerrechnung'
        : (!['erstattungsbescheid', 'arztbericht'].includes(neueGruppe) && extractedData.istRechnung)
          ? 'generische_rechnung'
          : null;

    let dbWriter = pool;
    if (shouldReplace && resolvedMatchID) {
      // Ab hier bis zum Commit bleibt der alte Datensatz bei jedem Fehler per
      // ROLLBACK vollständig erhalten. Snapshot, DELETE, Neuaufbau und Restore
      // sind eine einzige DB-Transaktion; nur externe Dateioperationen liegen davor.
      replacementClient = await oeffneSichereErsetzung(resolvedMatchID);
      dbWriter = replacementClient;

      const aktenResult = await dbWriter.query(
        `SELECT COALESCE(json_agg(json_build_object(
                  'akteid', akteid, 'sort_order', sort_order, 'added_at', added_at
                ) ORDER BY sort_order), '[]'::json) AS akten_entries
           FROM postbuch.akte_dokument WHERE postid = $1`,
        [resolvedMatchID]
      );
      aktenEntries = aktenResult.rows[0]?.akten_entries || [];
      if (typeof aktenEntries === 'string') aktenEntries = JSON.parse(aktenEntries);

      const existingDocResult = await dbWriter.query(
        `SELECT storage_id, notiz, storage_filename, historisch, erfassungsdatum,
                verbleib_id, original_urkunde, verbleib_ort, verbleib_ablage_id
           FROM postbuch.postbuch WHERE postid = $1`,
        [resolvedMatchID]
      );
      existingDoc = existingDocResult.rows[0];
      existingOnedriveId = existingDoc.storage_id;
      existingNotiz = existingDoc.notiz;
      existingHistorisch = !!existingDoc.historisch;
      existingErfassungsdatum = existingDoc.erfassungsdatum;
      await pipelineFileJournal.noteReplacementSource(
        jobId,
        existingDoc.storage_id,
        existingDoc.storage_filename,
        dbWriter,
      );
      preservedPostbuchWorkflow = {
        verbleib_id: existingDoc.verbleib_id ?? null,
        original_urkunde: !!existingDoc.original_urkunde,
        verbleib_ort: existingDoc.verbleib_ort ?? null,
        verbleib_ablage_id: existingDoc.verbleib_ablage_id ?? null,
      };

      const arzWorkflowResult = await dbWriter.query(
        `SELECT abrechnungsperiode_pkv, abrechnungsperiode_beihilfe,
                pkv_satz_override, beihilfe_satz_override
           FROM postbuch.arztrechnung WHERE postid = $1`,
        [resolvedMatchID]
      );
      preservedArzWorkflow = arzWorkflowResult.rows[0] || null;

      preservedWiedervorlagen = (await dbWriter.query(
        `SELECT wv_id, faellig_am, aktion, erledigt, created_at, push_notified_on
           FROM postbuch.wiedervorlage
          WHERE postid = $1 ORDER BY wv_id FOR UPDATE`,
        [resolvedMatchID]
      )).rows;
      preservedSaldoQuelleIds = (await dbWriter.query(
        `SELECT quelle_id FROM postbuch.saldo_quelle
          WHERE postid = $1 ORDER BY quelle_id FOR UPDATE`,
        [resolvedMatchID]
      )).rows.map((row) => row.quelle_id);
      preservedLxdMigrationItem = (await dbWriter.query(
        `SELECT to_jsonb(item) AS item
           FROM postbuch._lxd_migration_items item
          WHERE postid = $1 FOR UPDATE`,
        [resolvedMatchID]
      )).rows[0]?.item || null;
      preservedStorageMigrationItems = (await dbWriter.query(
        `SELECT to_jsonb(item) AS item
           FROM postbuch._storage_migration_items item
          WHERE postid = $1 ORDER BY run_id FOR UPDATE`,
        [resolvedMatchID]
      )).rows.map((row) => row.item);

      const bezahltRow = (await dbWriter.query(
        `SELECT bezahlt_am, bezahlt_am_manuell, bestritten_betrag FROM arztrechnung WHERE postid = $1
         UNION ALL
         SELECT bezahlt_am, bezahlt_am_manuell, bestritten_betrag FROM handwerkerrechnung WHERE postid = $1
         UNION ALL
         SELECT bezahlt_am, bezahlt_am_manuell, bestritten_betrag FROM generische_rechnung WHERE postid = $1
         LIMIT 1`,
        [resolvedMatchID]
      )).rows[0];
      if (bezahltRow?.bezahlt_am_manuell) preservedBezahltAm = { value: bezahltRow.bezahlt_am };
      if (bezahltRow?.bestritten_betrag != null) preservedBestrittenBetrag = Number(bezahltRow.bestritten_betrag);

      const hatArzWorkflow = preservedArzWorkflow
        && Object.values(preservedArzWorkflow).some(v => v != null);
      if (hatArzWorkflow && zielRechnungstabelle !== 'arztrechnung') {
        throw new Error('Wiederverarbeitung gesperrt: Abrechnungsperioden oder Satz-Overrides können beim Wechsel aus dem Arztrechnungs-Typ nicht erhalten werden.');
      }
      if ((preservedBezahltAm || preservedBestrittenBetrag !== null) && !zielRechnungstabelle) {
        throw new Error('Wiederverarbeitung gesperrt: Manueller Zahlungs- oder Streitstatus kann beim Wechsel in einen Nicht-Rechnungstyp nicht erhalten werden.');
      }
      if (preservedBestrittenBetrag !== null) {
        const neuerGesamtbetrag = Number(
          zielRechnungstabelle === 'arztrechnung'
            ? extractedData.arztrechnung?.gesamtbetrag
            : zielRechnungstabelle === 'handwerkerrechnung'
              ? extractedData.handwerkerrechnung?.gesamtbetrag
              : extractedData.generischeRechnung?.gesamtbetrag
        );
        if (!Number.isFinite(neuerGesamtbetrag) || neuerGesamtbetrag < preservedBestrittenBetrag) {
          throw new Error('Wiederverarbeitung gesperrt: Der bestrittene Betrag ist höher als der neu erkannte Rechnungsbetrag.');
        }
      }

      // Beim Ersetzen eines bereits verarbeiteten Erstattungsbescheids muss
      // dessen alte Periodenwirkung noch vor dem DELETE zurückgenommen werden.
      // Das neue Bescheiddokument erhält dieselbe PostID; nach dem FK-CASCADE
      // wäre der alte eb_postid jedoch nicht mehr auffindbar und eine
      // unveränderte Restperiode bliebe liegen. Die Rücknahme läuft im bereits
      // gesicherten Ersetzungs-Client und wird bei jedem Fehler mit der
      // gesamten Ersetzung zurückgerollt.
      const alterBescheid = await dbWriter.query(
        `SELECT 1 FROM postbuch.erstattungsbescheid WHERE postid = $1 FOR UPDATE`,
        [resolvedMatchID],
      );
      if (alterBescheid.rowCount > 0) {
        await setzeBescheidwirkungZurueck(resolvedMatchID, {
          grund: 'bescheid-reprocess-vor-ersetzung',
          db: dbWriter,
        });
      }

      // Pins dürfen beim Ersetzen eines Dokuments nicht an der RESTRICT-FK
      // scheitern oder verloren gehen. Nach der Rücknahme der alten
      // Bescheidwirkung werden sie erneut gelesen, weil dabei ein Pin aus der
      // alten Restperiode zurück in die Elternperiode gewandert sein kann.
      preservedDokumentPins = (await dbWriter.query(
        `SELECT person, kostentraeger, periode, grund, status,
                vorgemerkt_am, vorgemerkt_von, eingereicht_am,
                eingereicht_session_id
           FROM postbuch.dokument_pin
          WHERE postid = $1
          ORDER BY id`,
        [resolvedMatchID],
      )).rows;
      if (preservedDokumentPins.length > 0) {
        await dbWriter.query(
          `DELETE FROM postbuch.dokument_pin WHERE postid = $1`,
          [resolvedMatchID],
        );
      }

      await dbWriter.query('DELETE FROM postbuch.postbuch WHERE postid = $1', [resolvedMatchID]);
    } else {
      insertedPostId = finalPostID;
    }

    // ─── QR-Codes (Soft-Fail) ───────────────────────────────────────────────
    // Kein eigener Tracker-Schritt: die feste Phasennummerierung 0-9 ist an
    // mehreren Stellen hart verdrahtet (tracker.create(..., 10)). Diese Phase
    // hängt sich rein zeitlich zwischen Rotation und DB-Insert ein.
    // Ein Fehler beim Rastern/Dekodieren darf die Pipeline nie abbrechen —
    // gescannte Fremd-PDFs sind nicht vertrauenswürdig, QR-Codes sind
    // Zusatzinformation. Der Inhalt selbst landet NIE im Log (Zugangstoken).
    startPhase();
    let qrCodes = null;
    try {
      qrCodes = await scanQrCodes(pdfFinal);
    } catch (e) {
      appLog('WARN', 'doc-processor', `QR-Scan fehlgeschlagen: ${e.message}`, { entity: 'postbuch', entityId: finalPostID });
    }
    endPhase('QR-Codes');

    // Postbuch-Insert
    await dbWriter.query(
      `INSERT INTO postbuch
         (postid, briefdatum, erfassungsdatum, kontakt, fremdes_zeichen,
          art, lebensbereich, dokumentart, betreff, zusammenfassung, schlagwoerter,
         onedrive_id, storage_id, storage_backend,
         link, status, confidence, metadata, notiz, autoreview_instructions, familienmitglied, richtung,
         sha256, onedrive_filename, storage_filename, onedrive_modified, storage_modified,
         embedding, embedding_signature,
         ai_model, ai_pre_model,
         ai_tokens_in, ai_tokens_out, ai_pre_tokens_in, ai_pre_tokens_out,
         ai_cost_usd, ai_pre_cost_usd,
         data_repaired_at, data_repairs, historisch,
         qr_codes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::postbuch.post_richtung,
               $23,$24,$25,$26,$27,$28::halfvec,$29,
               $30,$31,$32,$33,$34,$35,$36,$37,
               $38,$39::jsonb,$40,
               $41::jsonb)`,
      [
        finalPostID,
        extractedData.postbuch?.briefdatum || null,
        existingErfassungsdatum || todayISO(),
        kontakt,
        extractedData.postbuch?.fremdesZeichen || null,
        extractedData.dokumentart,
        extractedData.lebensbereich,
        extractedData.dokumentart,
        extractedData.postbuch?.betreff || null,
        extractedData.postbuch?.zusammenfassung || null,
        schlagwoerter,
        legacyOd.id,
        newFileId,
        storage.name,
        webUrl,
        status,
        sicherheitsgrad,
        JSON.stringify(extractedData),
        existingNotiz || null,                       // Notiz vom alten Eintrag übernehmen
        null,
        familienmitglied,
        richtung,
        importSha256,
        legacyOd.name,
        importMeta.name || newFileName,
        legacyOd.modified,
        importMeta.lastModified || null,
        newEmbedding ? '[' + newEmbedding.join(',') + ']' : null,  // Embedding direkt speichern
        newEmbedding ? newEmbeddingSignature : null,
        plog.analysisModel    || null,
        plog.preAnalysisModel || null,
        plog.analysisTokensIn    ?? null,
        plog.analysisTokensOut   ?? null,
        plog.preAnalysisTokensIn  ?? null,
        plog.preAnalysisTokensOut ?? null,
        plog.analysisCostUsd    ?? null,
        plog.preAnalysisCostUsd ?? null,
        validierung?.repariert ? new Date() : null,
        validierung?.repariert ? JSON.stringify(validierung.reparaturen) : null,
        existingHistorisch,                          // Archiv-Status vom alten Eintrag übernehmen
        qrCodes !== null ? JSON.stringify(qrCodes) : null,
      ]
    );
    console.log(`[doc-processor] Postbuch-Insert: ${finalPostID} (${extractedData.lebensbereich}/${extractedData.dokumentart}, ${status})`);
    endPhase('DB-Insert');

    // Wenn Embedding in Phase 3 fehlschlug: Fehlerzeitpunkt + Meldung in DB schreiben.
    // Ermöglicht Dashboard-Warnung "Fehlende Embeddings" und späteres Nachholen.
    if (embErrMessage) {
      await dbWriter.query(
        `UPDATE postbuch SET embedding_failed_at = NOW(), embedding_error = $1 WHERE postid = $2`,
        [embErrMessage, finalPostID]
      );
    }

    // ── Detaillierter Activity-Log ─────────────────────────────────────────
    const totalSec = ((Date.now() - tTotal) / 1000).toFixed(1);
    const dupHint    = isDuplicate ? ' [Duplikat-Ersetzung]' : '';
    const rotHint    = rotation > 0 ? ` | Rotation: ${rotation}°` : '';
    const isFallbackModel = (plog.failedModels?.length || 0) > 0;
    const modelLabel = isFallbackModel
      ? `${plog.analysisModel} (Fallback)`
      : (plog.analysisModel || '?');

    // Timing-Zeile: nur Phasen >200ms anzeigen
    const timingParts = Object.entries(timings)
      .filter(([, ms]) => ms > 200)
      .map(([k, ms]) => `${k}: ${(ms / 1000).toFixed(1)}s`);
    const timingLine = timingParts.join(' · ');

    uiLog('CREATE', 'postbuch', finalPostID,
      `${extractedData.dokumentart}: ${extractedData.postbuch?.betreff || '(kein Betreff)'}` +
      ` · ${modelLabel} · ${totalSec}s${rotHint}${dupHint}\n` +
      `${timingLine}\n` +
      `Sicherheit: ${sicherheitsgrad} (${status}) · ${plog.pages || 1}S · d=${plog.difficulty ?? '?'}`
    );

    // Typ-spezifischer Detail-Insert
    const detailResult = await documentInserter.insert(
      finalPostID,
      extractedData,
      dbWriter,
      input.korrekturAnweisung || '',
      { deferErstattungsbescheid: true },
    );
    ebPending = !!detailResult?.erstattungsbescheidAusstehend;

    // Manuell gesetztes bezahlt_am wiederherstellen — KI darf diesen Wert nie überschreiben
    if (preservedBezahltAm) {
      const tables = ['arztrechnung', 'handwerkerrechnung', 'generische_rechnung'];
      let bezahltRestored = false;
      for (const t of tables) {
        const r = await dbWriter.query(
          `UPDATE ${t} SET bezahlt_am = $1, bezahlt_am_manuell = true WHERE postid = $2`,
          [preservedBezahltAm.value, finalPostID]
        );
        if (r.rowCount > 0) {
          bezahltRestored = true;
          appLog('INFO', 'doc-processor', `bezahlt_am (manuell) wiederhergestellt: ${preservedBezahltAm.value ?? 'null'}`, { entity: 'postbuch', entityId: finalPostID });
          break;
        }
      }
      if (!bezahltRestored) {
        throw new Error('Manueller Zahlungsstatus konnte nicht wiederhergestellt werden');
      }
    }

    // Ein manuell gesetzter Streitfall gehört zum Zahlungsvorgang, nicht zur KI-Extraktion.
    if (preservedBestrittenBetrag !== null) {
      const tables = ['arztrechnung', 'handwerkerrechnung', 'generische_rechnung'];
      let streitRestored = false;
      for (const t of tables) {
        const r = await dbWriter.query(
          `UPDATE ${t} SET bestritten_betrag = $1 WHERE postid = $2 AND gesamtbetrag >= $1`,
          [preservedBestrittenBetrag, finalPostID]
        );
        if (r.rowCount > 0) {
          streitRestored = true;
          appLog('INFO', 'doc-processor', `bestritten_betrag wiederhergestellt: ${preservedBestrittenBetrag}`, { entity: 'postbuch', entityId: finalPostID });
          break;
        }
      }
      if (!streitRestored) {
        throw new Error('Bestrittener Betrag konnte nicht wiederhergestellt werden');
      }
    }

    // Fachlichen Workflowzustand wiederherstellen. Anders als KI-Felder ist
    // dieser Zustand nicht Ergebnis der Neuanalyse und muss die Ersetzung
    // identitätstreu überleben (analog zu Notiz und Aktenzugehörigkeit).
    if (shouldReplace) {
        if (preservedPostbuchWorkflow) {
          const restored = await dbWriter.query(
            `UPDATE postbuch.postbuch
                SET verbleib_id = $1,
                    original_urkunde = $2,
                    verbleib_ort = $3,
                    verbleib_ablage_id = $4
              WHERE postid = $5`,
            [
              preservedPostbuchWorkflow.verbleib_id,
              preservedPostbuchWorkflow.original_urkunde,
              preservedPostbuchWorkflow.verbleib_ort,
              preservedPostbuchWorkflow.verbleib_ablage_id,
              finalPostID,
            ]
          );
          if (restored.rowCount !== 1) throw new Error('Originalverbleib konnte nicht wiederhergestellt werden');
        }

        if (preservedArzWorkflow) {
          const restored = await dbWriter.query(
            `UPDATE postbuch.arztrechnung
                SET abrechnungsperiode_pkv = $1,
                    abrechnungsperiode_beihilfe = $2,
                    pkv_satz_override = $3,
                    beihilfe_satz_override = $4
              WHERE postid = $5`,
            [
              preservedArzWorkflow.abrechnungsperiode_pkv,
              preservedArzWorkflow.abrechnungsperiode_beihilfe,
              preservedArzWorkflow.pkv_satz_override,
              preservedArzWorkflow.beihilfe_satz_override,
              finalPostID,
            ]
          );
          const hatArzWorkflow = Object.values(preservedArzWorkflow).some(v => v != null);
          if (hatArzWorkflow && restored.rowCount !== 1) {
            throw new Error('Arztrechnungs-Workflowzustand konnte nicht wiederhergestellt werden');
          }
        }

        for (const wv of preservedWiedervorlagen) {
          await dbWriter.query(
            `INSERT INTO postbuch.wiedervorlage
               (wv_id, postid, akteid, faellig_am, aktion, erledigt, created_at, push_notified_on)
             VALUES ($1, $2, NULL, $3, $4, $5, $6, $7)`,
            [
              wv.wv_id,
              finalPostID,
              wv.faellig_am,
              wv.aktion,
              wv.erledigt,
              wv.created_at,
              wv.push_notified_on,
            ]
          );
        }

        if (preservedSaldoQuelleIds.length > 0) {
          const restored = await dbWriter.query(
            `UPDATE postbuch.saldo_quelle
                SET postid = $1
              WHERE quelle_id = ANY($2::int[]) AND postid IS NULL`,
            [finalPostID, preservedSaldoQuelleIds]
          );
          if (restored.rowCount !== preservedSaldoQuelleIds.length) {
            throw new Error('Saldo-Verknüpfungen konnten nicht vollständig wiederhergestellt werden');
          }
        }

        if (aktenEntries?.length > 0) {
          for (const entry of aktenEntries) {
            await dbWriter.query(
              `INSERT INTO postbuch.akte_dokument (akteid, postid, sort_order, added_at)
               VALUES ($1, $2, $3, $4)`,
              [entry.akteid, finalPostID, entry.sort_order, entry.added_at]
            );
          }
        }

        if (preservedLxdMigrationItem) {
          const restored = await dbWriter.query(
            `INSERT INTO postbuch._lxd_migration_items
             SELECT * FROM jsonb_populate_record(
               NULL::postbuch._lxd_migration_items, $1::jsonb
             )`,
            [JSON.stringify(preservedLxdMigrationItem)]
          );
          if (restored.rowCount !== 1) {
            throw new Error('L×D-Migrationsstatus konnte nicht wiederhergestellt werden');
          }
        }

        for (const item of preservedStorageMigrationItems) {
          const restored = await dbWriter.query(
            `INSERT INTO postbuch._storage_migration_items
             SELECT * FROM jsonb_populate_record(
               NULL::postbuch._storage_migration_items, $1::jsonb
             )`,
            [JSON.stringify(item)]
          );
          if (restored.rowCount !== 1) {
            throw new Error('Ablage-Migrationsstatus konnte nicht wiederhergestellt werden');
          }
        }

        for (const pin of preservedDokumentPins) {
          await dbWriter.query(
            `INSERT INTO postbuch.dokument_pin
               (postid, person, kostentraeger, periode, grund, status,
                vorgemerkt_am, vorgemerkt_von, eingereicht_am,
                eingereicht_session_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
              finalPostID,
              pin.person,
              pin.kostentraeger,
              pin.periode,
              pin.grund,
              pin.status,
              pin.vorgemerkt_am,
              pin.vorgemerkt_von,
              pin.eingereicht_am,
              pin.eingereicht_session_id,
            ],
          );
        }

        if (ebPending) await pipelineFileJournal.noteEbPending(jobId, dbWriter);
        else {
          const journalDone = await dbWriter.query(
            `UPDATE postbuch._pipeline_file_journal
                SET state = 'db_complete', updated_at = NOW()
              WHERE job_id = $1`,
            [jobId]
          );
          if (journalDone.rowCount !== 1) {
            throw new Error(`Pipeline-Journal für Job ${jobId} fehlt`);
          }
        }

        await replacementClient.query('COMMIT');
        replacementClient.release();
        replacementClient = null;
        replacementStarted = true;
        insertedPostId = finalPostID;
        dbStateComplete = true;
        console.log(`[doc-processor] Alter Eintrag ${resolvedMatchID} atomar ersetzt`);

        // Erst nach dem DB-Commit darf die alte Datei verschwinden. Beim normalen
        // Reprocess ist es dieselbe ID; bei Duplikat-Ersetzung wird nur das alte
        // Ziel best-effort in den Papierkorb verschoben.
        if (existingOnedriveId && existingOnedriveId !== onedriveFileId) {
          const trashFileName = trashName('Ersetzt', resolvedMatchID, existingDoc.storage_filename);
          try {
            await storage.moveToTrash(existingOnedriveId, trashFileName);
            await pipelineFileJournal.noteReplacementCleaned(jobId);
          } catch (e) {
            duplicateCleanupPending = true;
            console.error(`[doc-processor] Alte Datei -> Papierkorb ausstehend: ${e.message}`);
          }
        }

      } else {
        if (ebPending) await pipelineFileJournal.noteEbPending(jobId);
        dbStateComplete = true;
      }

    if (ebPending) {
      documentInserter.starteErstattungsbescheidVerarbeitung(
        finalPostID,
        input.korrekturAnweisung || '',
      ).then(() => pipelineFileJournal.acknowledgeEbComplete(jobId)).catch((e) => {
        appLog('ERROR', 'pipeline-recovery',
          `Persistenter EB-Fachjob für ${finalPostID} bleibt zur Wiederholung vorgemerkt: ${e.message}`,
          { entity: 'postbuch', entityId: finalPostID });
      });
    }

    // ─── PHASE 9: Embedding + Cache + Akten ───
    startPhase();
    tracker.setStep(jobId, stepOffset + 9, 'Embedding + Cache');

    // Parallele Operationen: PDF-Cache, Aktenzugehörigkeit
    // (Embedding wurde bereits in Phase 8 gespeichert)
    const parallelOps = [
      storePdfInCache(finalPostID, pdfFinal).catch(e => {
        console.error(`[doc-processor] PDF-Cache fehlgeschlagen: ${e.message}`);
        appLog('WARN', 'doc-processor', `PDF-Cache fehlgeschlagen: ${e.message}`, { entity: 'postbuch', entityId: finalPostID });
      }),
    ];

    await Promise.all(parallelOps);
    endPhase('Embedding+Cache');

    // Erst Basiszeile + Spezialblock + geschützte Zahlungswerte + wiederher-
    // gestellte Aktenbezüge bilden einen vollständigen Commit. Ein Kill davor
    // wird beim Start als partial erkannt, zurückgerollt und laut nach _failed
    // überführt.
    if (!ebPending) await pipelineFileJournal.noteDbComplete(jobId);

    const totalMs = Date.now() - tTotal;
    await clearFailedEntry();
    if (!ebPending && !duplicateCleanupPending) {
      await pipelineFileJournal.clear(jobId).catch((e) => {
        appLog('WARN', 'pipeline-recovery',
          `Journal-Cleanup für ${finalPostID} verzögert: ${e.message}`,
          { entity: 'postbuch', entityId: finalPostID });
      });
    }
    tracker.complete(jobId, { postid: finalPostID, betreff: extractedData.postbuch?.betreff || null });
    console.log(`[doc-processor] ✅ Verarbeitung abgeschlossen: ${finalPostID} (${(totalMs/1000).toFixed(1)}s)`);
    appLog('INFO', 'doc-processor', `Pipeline abgeschlossen: ${finalPostID} (${extractedData.lebensbereich}/${extractedData.dokumentart}) in ${(totalMs/1000).toFixed(1)}s`, { entity: 'postbuch', entityId: finalPostID });

    // ─── Debug-Log: Datei auf OneDrive hochladen (wenn Debug-Mode aktiv) ───
    if (settings.debug_mode?.enabled) {
      uploadDebugLog(finalPostID, debugEntries, timings, totalMs, extractedData, settings).catch(e =>
        console.warn(`[doc-processor] Debug-Log Upload fehlgeschlagen: ${e.message}`)
      );
    }

  } catch (err) {
    // ─── CLEANUP bei Fehler oder Abbruch ───
    console.error(`[doc-processor] Fehler: ${err.message}`);
    if (replacementClient) {
      await replacementClient.query('ROLLBACK').catch(() => {});
      replacementClient.release();
      replacementClient = null;
    }
    // Beim normalen Reprocess wurde dieselbe physische Datei bereits bewegt.
    // Nach DB-Rollback bleibt die vollständige Altzeile bestehen; wir gleichen
    // ausschließlich ihre Ablage-Metadaten an, statt das Original nach _failed
    // oder in den Papierkorb zu verschieben.
    if (replacementMode === 'same_file' && !dbStateComplete && movedFileMeta) {
      await pipelineFileJournal.reconcileReplacementFile({
        postid: input.modifyPostID,
        storageBackend: storage.name,
        meta: movedFileMeta,
      }).then(() => pipelineFileJournal.clear(jobId)).catch((reconcileErr) => {
        appLog('ERROR', 'pipeline-recovery',
          `Datei-Reconciliation für ${input.modifyPostID} ausstehend: ${reconcileErr.message}`,
          { entity: 'postbuch', entityId: input.modifyPostID });
      });
    }
    if (!(err instanceof CancellationError)) {
      appLog('ERROR', 'doc-processor', err.message, { details: err.stack?.slice(0, 2000), entity: 'postbuch', entityId: insertedPostId || input.modifyPostID || null });
    }

    // DB-Eintrag löschen falls vorhanden (CASCADE löscht abhängige Tabellen mit)
    if (insertedPostId && !dbStateComplete) {
      await pool.query('DELETE FROM postbuch WHERE postid = $1', [insertedPostId]).catch(() => {});
    }

    if (err instanceof CancellationError) {
      // Abbruch → Papierkorb
      // storage ist null, wenn der Abbruch vor dem Laden der Settings kam —
      // dann gibt es auch noch keine Datei in der Ablage.
      if (onedriveFileId && storage && replacementMode !== 'same_file') {
        try {
          await storage.moveToTrash(onedriveFileId, `Abbruch ${insertedPostId || 'unbekannt'}`);
          await pipelineFileJournal.clear(jobId).catch(() => {});
        } catch (moveErr) {
          appLog('ERROR', 'doc-processor',
            `Abbruch-Datei konnte nicht in den Papierkorb verschoben werden: ${moveErr.message}`,
            { entity: 'postbuch', entityId: insertedPostId || input.modifyPostID || null });
          await failedHandler.recordOrphanedFailed({
            onedriveFileId,
            reason: 'Abbruch: Papierkorb-Move fehlgeschlagen',
            detail: moveErr.message,
            sourceJobId: jobId,
            backend: storage.name,
          }).catch(() => {});
        }
      }
      tracker.complete(jobId); // complete() erkennt den Cancel-Flag automatisch
      await clearFailedEntry(); // Datei liegt im Papierkorb — Eintrag wäre nur noch ein Geist
    } else {
      // Fehler → FAILED-Ordner via failedHandler (erledigt OneDrive-Verschiebung + DB-Eintrag)

      // Nutzerfreundliche Fehlermeldung (Quota, Rate-Limit, …)
      const apiErr = classifyApiError(err.message);
      const failReason = apiErr.label
        ? `${apiErr.label}: ${err.message.slice(0, 350)}`
        : err.message.slice(0, 400);

      // ZUERST den Job als fehlgeschlagen markieren, erst danach aufräumen.
      // Das Aufräumen redet mit der Ablage (move nach _failed) und kann bei
      // Netzproblemen — genau der Lage, die den Fehler ausgelöst hat — lange
      // hängen. Stand tracker.fail() dahinter, blieb der Job als "running" in
      // _jobs stehen und tauchte im Job-Log überhaupt nicht auf.
      tracker.fail(jobId, failReason);

      // Eine Wiederverarbeitung, die noch vor dem Löschen der alten DB-Zeile
      // scheitert, darf das weiterhin gültige Original nicht aus seiner Ablage
      // reißen. Ab dem destruktiven Ersetzungsschritt gilt der normale Fail-Pfad.
      const sollDateiFehlschlagen = !dbStateComplete && (!input.modifyPostID || replacementStarted);
      if (onedriveFileId && settings && sollDateiFehlschlagen) {
        // Phase 0 war erfolgreich (OD hat die Datei) → lokaler Buffer nicht mehr nötig
        const _failBufferJobId = input._retrySourceJobId || jobId;
        await deleteScanBuffer(_failBufferJobId).catch(() => {});
        await pool.query(
          'DELETE FROM postbuch._scan_retry_queue WHERE job_id = $1',
          [_failBufferJobId]
        ).catch(() => {});

        await failedHandler.moveToFailed({
          onedriveFileId,
          storageBackend: storage?.name || input.storageBackend,
          reason: failReason,
          detail: err.stack?.slice(0, 1000),
          sourceJobId: jobId,
          betreff: extractedData?.postbuch?.betreff || null,
          documentType: extractedData?.dokumentart || null,
          settings,
        }).then(async () => {
          await pipelineFileJournal.clear(jobId).catch((journalErr) => {
            appLog('WARN', 'pipeline-recovery',
              `Journal-Cleanup nach _failed-Move verzögert: ${journalErr.message}`,
              { entity: 'postbuch', entityId: insertedPostId || input.modifyPostID || null });
          });
        }).catch(async e => {
          // S2: moveToFailed selbst schlug fehl — Datei liegt im OD-Inbox, nicht in _failed.
          // DB-Eintrag anlegen damit die Datei sichtbar und manuell behandelbar ist.
          console.error(`[doc-processor] moveToFailed fehlgeschlagen: ${e.message}`);
          const orphanId = e.storageMoved?.id || onedriveFileId;
          if (e.storageMoved?.id) {
            await pipelineFileJournal.noteMoved(
              jobId, e.storageMoved.id, e.storageMoved.name || null,
            ).catch(() => {});
          }
          await failedHandler.recordOrphanedFailed({
            onedriveFileId: orphanId,
            reason: failReason,
            detail: err.stack?.slice(0, 1000),
            sourceJobId: jobId,
            note: `moveToFailed fehlgeschlagen: ${e.message}`,
            backend: storage?.name || input.storageBackend || getActiveBackendName(settings),
          }).catch(() => {});
        });
      } else if (input.modifyPostID && !replacementStarted && !movedFileMeta) {
        // Original und DB-Zeile sind unverändert; das vorbereitete Journal ist
        // damit kein Recovery-Fall.
        await pipelineFileJournal.clear(jobId).catch(() => {});
      } else if (!onedriveFileId && jobId && (input.pdfBuffer || input._retrySourceJobId)) {
        // S1: Phase 0 gescheitert → PDF liegt nur im lokalen Scan-Buffer.
        // Eintrag in _scan_retry_queue anlegen: exponentieller Backoff-Retry.
        const _s1BufferJobId = input._retrySourceJobId || jobId;
        await pool.query(
          `INSERT INTO postbuch._scan_retry_queue
            (job_id, original_filename, local_file_path, next_retry_at, last_error)
           VALUES ($1, $2, $3, now() + interval '30 minutes', $4)
           ON CONFLICT (job_id) DO UPDATE
             SET last_error    = EXCLUDED.last_error,
                 next_retry_at = now() + interval '30 minutes'`,
          [
            _s1BufferJobId,
            input.filename || `scan_${_s1BufferJobId}.pdf`,
            path.join(SCAN_BUFFER_DIR, `${_s1BufferJobId}.pdf`),
            failReason,
          ]
        ).catch(e => console.error(`[doc-processor] _scan_retry_queue INSERT fehlgeschlagen: ${e.message}`));
      }

      // Dokument-Info für Benachrichtigungen
      const betreff = extractedData?.postbuch?.betreff || input.filename || null;
      const docHint = betreff ? ` · "${betreff.slice(0, 60)}"` : '';

      // Discord-Benachrichtigung bei Fehler
      let discordMsg = `### ❌ Verarbeitungsfehler\n`;
      if (apiErr.code === 'quota_exceeded') {
        discordMsg += `⚠️ **${apiErr.label}** – Verarbeitung kann nach Aufladung in Logs/Jobs wiederholt werden.\n`;
      }
      discordMsg += `\`\`\`\n${err.message.slice(0, 500)}\n\`\`\``;
      if (docHint) discordMsg += `\nDokument:${docHint}`;
      await discord.sendMessage(discordMsg, settings).catch(() => {});

      // Push-Benachrichtigung (requireInteraction: true damit die Meldung sichtbar bleibt)
      const pushTitle = apiErr.code === 'quota_exceeded'
        ? '❌ API-Guthaben aufgebraucht'
        : apiErr.label
          ? `❌ ${apiErr.label}`
          : '❌ Verarbeitungsfehler';
      const pushBody = apiErr.label
        ? `${apiErr.label}${docHint} – Logs/Jobs für Details und Wiederholung`
        : `${err.message.slice(0, 80)}${docHint}`;
      sendPushToAllUsers({
        title: pushTitle,
        body: pushBody.slice(0, 120),
        tag: `error-${jobId}`,
        url: '/logs',
        requireInteraction: true,
      }, { category: 'error' }).catch(() => {});
    }
  } finally {
    // In-Flight-Sperre immer freigeben – egal ob Erfolg, Fehler oder Abbruch
    if (_lockedId) releaseInFlight(_lockedId);
  }
}

// ── PDF-Cache ────────────────────────────────────────────────────────────────

async function storePdfInCache(postid, pdfBuffer) {
  const base64 = pdfBuffer.toString('base64');
  await pool.query(
    `INSERT INTO post_files (postid, file) VALUES ($1, decode($2, 'base64'))
     ON CONFLICT (postid) DO UPDATE SET file = decode($2, 'base64')`,
    [postid, base64]
  );
  console.log(`[doc-processor] PDF-Cache gespeichert für ${postid}`);
}

// ── Aktenzugehörigkeit ───────────────────────────────────────────────────────

// ── Debug-Log Upload ─────────────────────────────────────────────────────────

async function uploadDebugLog(postid, debugEntries, timings, totalMs, extractedData, settings) {
  const debugFolderId = getFolders(settings).debug;
  if (!debugFolderId) {
    console.warn('[doc-processor] Debug-Modus aktiv, aber storage_folders.<backend>.debug nicht konfiguriert');
    return;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${postid}_${timestamp}.log`;

  const logContent = JSON.stringify({
    postid,
    timestamp: new Date().toISOString(),
    totalMs,
    timings,
    pipelineSteps: debugEntries,
    extractedData,
  }, null, 2);

  const buf = Buffer.from(logContent, 'utf-8');
  await getActiveAdapterFor(settings).uploadNew(buf, filename, debugFolderId);
  console.log(`[doc-processor] Debug-Log hochgeladen: ${filename}`);
}
