import { Router } from 'express';
import { query } from '../db.js';
import { uiLog } from '../log.js';
import { appLog } from '../app-log.js';
import { regenerateEmbedding, activeSignature } from '../lib/embedding.js';
import { computeAndSaveAkteEmbedding } from '../service/akten-service.js';
import {
  getHelpEmbeddingStatus, loadHelpSource, reconcileHelpCorpus,
} from '../service/help-corpus.js';
import { enqueueDocument } from '../jobs/pipeline-queue.js';
import * as tracker from '../jobs/tracker.js';
import { resolveDuplicate } from '../service/resolve-duplicate.js';
import { verschiebeInPapierkorb } from '../service/document-delete.js';
import * as failedHandler from '../service/failed-handler.js';
import * as suspensionStore from '../service/suspension-store.js';
import { retrieveDocument } from '../service/document-retriever.js';
import { erkenneScanMitTextebene } from '../lib/pdf.js';
import { verify as verifyToken } from '../lib/decision-token.js';
import { getAktiveCodes } from '../lib/taxonomie.js';
import {
  isCompatible,
  applyCompatibleChange,
  buildReprocessInstruction,
} from '../service/type-change.js';
import {
  ermittleReprocessSchutz,
  reprocessSchutzAntwort,
} from '../service/reprocess-protection.js';
import {
  ermittleInvalidierungsLage,
  buildInvalidierungsAnweisung,
  INVALIDIERUNG_ZIEL_D,
  INVALIDIERUNG_GESPERRT_CODE,
} from '../service/rechnung-invalidierung.js';
import {
  oeffneSichereDokumentloeschung,
  istLoeschschutzFehler,
  loeschschutzAntwort,
} from '../service/document-delete-protection.js';
import { requireAdmin } from '../middleware/auth.js';
import { setzeBescheidwirkungZurueck } from '../service/periodenabschluss.js';

const router = Router();

const POSTID_RE = /^P\d{6}$/;
// Die erlaubten Dokumentarten kommen aus der DB-Taxonomie, nicht aus einer
// Code-Kopie. So bleiben Prompt, Validierung und manuelle Änderung konsistent.

// POST /api/actions/reprocess/:postid — Dokument erneut durch lokale Pipeline verarbeiten
router.post('/reprocess/:postid', async (req, res) => {
  try {
    const { postid } = req.params;
    if (!POSTID_RE.test(postid)) {
      return res.status(400).json({ error: 'Ungültige PostID' });
    }

    const { instructions, textebeneEntfernen, modelTier } = req.body;

    // Modellstufe für die Wiederverarbeitung. 'auto' (Default) = normales
    // difficulty-Routing mit Preclassifier; eine konkrete Stufe erzwingt das
    // zugehörige Modell und überspringt die Voranalyse.
    const VALID_TIERS = new Set(['auto', 'leicht', 'mittel', 'schwierig', 'large']);
    const tier = VALID_TIERS.has(modelTier) ? modelTier : 'auto';

    // Dokument existiert? storage_id muss vorhanden sein für den Re-Download
    const check = await query(
      `SELECT postid, storage_id, storage_backend FROM postbuch WHERE postid = $1`,
      [postid]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Dokument nicht gefunden' });
    }

    const onedriveFileId = check.rows[0].storage_id;
    if (!onedriveFileId) {
      return res.status(422).json({ error: 'Dokument hat keine Ablage-ID — Wiederverarbeitung nicht möglich' });
    }

    const reprocessSchutz = await ermittleReprocessSchutz(postid);
    if (reprocessSchutz.geschuetzt) {
      return res.status(409).json(reprocessSchutzAntwort(reprocessSchutz));
    }

    // Job erstellen und Pipeline asynchron starten
    const jobId = tracker.create('doc-reprocess', `Wiederverarbeitung ${postid}`, 10);

    // Pipeline im Hintergrund (geht durch die Queue)
    enqueueDocument({
      onedriveFileId,
      // Die Datei liegt in dem Backend, in dem sie liegt — auch wenn
      // zwischenzeitlich umgeschaltet wurde.
      storageBackend: check.rows[0].storage_backend,
      modifyPostID: postid,
      korrekturAnweisung: instructions || '',
      textebeneEntfernen: !!textebeneEntfernen,
      modelTier: tier,
    }, jobId, 0, {
      onError: (err) => {
        console.error(`[actions] Reprocess ${postid} fehlgeschlagen:`, err.message);
        appLog('ERROR', 'actions', `Reprocess ${postid} fehlgeschlagen: ${err.message}`, { entity: 'postbuch', entityId: postid });
      },
    });

    res.json({ success: true, jobId, message: 'Wiederverarbeitung gestartet' });
    uiLog('AI_CALL', 'reprocess', postid, `Modell: ${tier}${textebeneEntfernen ? ', OCR verworfen' : ''} · instructions: ${(instructions || '').slice(0, 60)}`);
  } catch (err) {
    console.error('POST /api/actions/reprocess/:postid error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// GET /api/actions/reprocess-status/:postid — prüft, ob die Wiederverarbeitung
// aktuell durch einen geschützten fachlichen Zustand gesperrt ist. Read-only;
// das UI blendet den Wiederverarbeiten-Knopf damit von Anfang an gesperrt ein,
// statt den Nutzer erst beim Klick mit dem 409-Fehler zu konfrontieren.
router.get('/reprocess-status/:postid', async (req, res) => {
  try {
    const { postid } = req.params;
    if (!POSTID_RE.test(postid)) {
      return res.status(400).json({ error: 'Ungültige PostID' });
    }
    const schutz = await ermittleReprocessSchutz(postid);
    res.json({ geschuetzt: schutz.geschuetzt, gruende: schutz.gruende });
  } catch (err) {
    console.error('GET /api/actions/reprocess-status/:postid error:', err);
    // Bei Fehler neutral antworten, damit der Knopf nicht fälschlich gesperrt bleibt.
    res.json({ geschuetzt: false, gruende: [] });
  }
});

// GET /api/actions/textebene-status/:postid — prüft, ob das PDF eine erkannte
// Textebene (OCR) über einem Scan-Bild trägt. Liefert einen Vorschlag, ob die
// Textebene bei der Wiederverarbeitung entfernt werden sollte. Read-only.
router.get('/textebene-status/:postid', async (req, res) => {
  try {
    const { postid } = req.params;
    if (!POSTID_RE.test(postid)) {
      return res.status(400).json({ error: 'Ungültige PostID' });
    }
    const { pdf } = await retrieveDocument(postid);
    const status = await erkenneScanMitTextebene(pdf);
    res.json(status);
  } catch (err) {
    console.error('GET /api/actions/textebene-status/:postid error:', err);
    // Erkennung ist nur ein Komfort-Default — bei Fehler neutral antworten,
    // damit der Wiederverarbeitungs-Dialog trotzdem öffnet.
    res.json({ hatTextebene: false, hatScanBild: false, empfehlungEntfernen: false });
  }
});

// POST /api/actions/change-type/:postid — Dokumenttyp ändern
//
// Body: { newType: string, confirmReprocess?: boolean }
//
// Antwort-Modi:
//   - { mode: 'noop' }                    → newType == aktueller Typ
//   - { mode: 'compatible', moved, newWebUrl }
//                                         → DB + OneDrive direkt aktualisiert
//   - { mode: 'requires_reprocess', message }
//                                         → KI-Wiederverarbeitung nötig, Client
//                                           muss Bestätigung einholen und neu
//                                           senden mit confirmReprocess=true
//   - { mode: 'reprocessing', jobId }     → Pipeline-Job gestartet (asynchron)
router.post('/change-type/:postid', async (req, res) => {
  try {
    const { postid } = req.params;
    if (!POSTID_RE.test(postid)) {
      return res.status(400).json({ error: 'Ungültige PostID' });
    }

    const { newL, newD, confirmReprocess } = req.body || {};
    if (typeof newL !== 'string' || typeof newD !== 'string') {
      return res.status(400).json({ error: 'newL und newD sind verpflichtend.' });
    }
    const codes = await getAktiveCodes();
    if (!codes.lebensbereiche.includes(newL) || !codes.dokumentarten.includes(newD)) {
      return res.status(400).json({ error: 'Unbekannter oder inaktiver Lebensbereich bzw. Dokumentart.' });
    }

    const check = await query(
      `SELECT postid, lebensbereich, dokumentart, storage_id, storage_backend FROM postbuch WHERE postid = $1`,
      [postid]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Dokument nicht gefunden' });
    }

    const currentL = check.rows[0].lebensbereich;
    const currentD = check.rows[0].dokumentart;
    if (!currentL || !currentD) return res.status(409).json({ error: 'Dokument ist noch nicht nach LxD migriert.' });
    if (currentL === newL && currentD === newD) {
      uiLog('UPDATE', 'postbuch', postid, `LxD-Einordnung bestätigt: ${currentL}/${currentD}`);
      return res.json({ mode: 'noop', message: 'Einordnung bestätigt.' });
    }

    // ── Pfad A: v-kompatibel — direkte DB-/Datei-Änderung ───
    if (await isCompatible(currentL, currentD, newL, newD)) {
      const result = await applyCompatibleChange(postid, currentL, currentD, newL, newD);
      return res.json({
        mode: 'compatible',
        moved: result.moved,
        newWebUrl: result.newWebUrl,
        message: result.moved
          ? `Einordnung geändert: ${currentL}/${currentD} → ${newL}/${newD} (Datei verschoben)`
          : `Einordnung geändert: ${currentL}/${currentD} → ${newL}/${newD}`,
      });
    }

    // ── Pfad B: Nicht v-kompatibel — KI-Wiederverarbeitung erforderlich ───
    if (!confirmReprocess) {
      return res.json({
        mode: 'requires_reprocess',
        message:
          `Die Änderung ${currentL}/${currentD} → ${newL}/${newD} braucht eine Wiederverarbeitung — ` +
          `die zugehörigen Detailtabellen unterscheiden sich. Eine KI-Wiederverarbeitung ist ` +
          `daher erforderlich, damit die zum neuen Typ passenden Felder extrahiert werden. ` +
          `Bitte bestätige, um die Wiederverarbeitung anzustoßen.`,
      });
    }

    // Bestätigt → Pipeline asynchron mit Korrekturanweisung starten
    const onedriveFileId = check.rows[0].storage_id;
    if (!onedriveFileId) {
      return res.status(422).json({ error: 'Dokument hat keine Ablage-ID — Wiederverarbeitung nicht möglich' });
    }

    const reprocessSchutz = await ermittleReprocessSchutz(postid);
    if (reprocessSchutz.geschuetzt) {
      return res.status(409).json(reprocessSchutzAntwort(reprocessSchutz));
    }

    const instructions = buildReprocessInstruction(currentL, currentD, newL, newD);
    const jobId = tracker.create('doc-reprocess', `LxD-Wechsel ${postid} → ${newL}/${newD}`, 10);

    enqueueDocument({
      onedriveFileId,
      storageBackend: check.rows[0].storage_backend,
      modifyPostID: postid,
      korrekturAnweisung: instructions,
    }, jobId, 0, {
      onError: (err) => {
        console.error(`[actions] change-type Reprocess ${postid} fehlgeschlagen:`, err.message);
        appLog('ERROR', 'actions', `Typänderungs-Reprocess ${postid} fehlgeschlagen: ${err.message}`, { entity: 'postbuch', entityId: postid });
      },
    });

    res.json({
      mode: 'reprocessing',
      jobId,
      message: `KI-Wiederverarbeitung gestartet (${currentL}/${currentD} → ${newL}/${newD})`,
    });
    uiLog('AI_CALL', 'change-type', postid, `${currentL}/${currentD} → ${newL}/${newD} (Reprocess)`);
  } catch (err) {
    console.error('POST /api/actions/change-type/:postid error:', err);
    appLog('ERROR', 'actions', `change-type fehlgeschlagen für ${req.params.postid}: ${err.message}`, { entity: 'postbuch', entityId: req.params.postid });
    res.status(500).json({ error: err.message || 'Interner Serverfehler' });
  }
});

// POST /api/actions/rechnung-invalidieren/:postid — Rechnungsblock entfernen,
// weil die Rechnung durch eine Korrekturrechnung ersetzt wurde.
//
// Body: { confirm?: boolean }
//
// Antwort-Modi:
//   - { mode: 'requires_confirm', spielart, ziel, message }
//                                    → Client muss bestätigen und erneut senden
//   - { mode: 'reprocessing', jobId } → LxD-Umschaltung + Wiederverarbeitung läuft
//
// Warum immer über die Pipeline: Arzt- und Handwerkerblöcke lassen sich nicht
// einzeln löschen, ohne dass das Dokument in seiner LxD-Zelle unpassend würde.
// Der einheitliche Weg ist die Umschaltung auf Korrespondenz mit Neuextraktion.
router.post('/rechnung-invalidieren/:postid', async (req, res) => {
  try {
    const { postid } = req.params;
    if (!POSTID_RE.test(postid)) {
      return res.status(400).json({ error: 'Ungültige PostID' });
    }

    const lage = await ermittleInvalidierungsLage(postid);
    if (!lage.gefunden) return res.status(404).json({ error: 'Dokument nicht gefunden' });
    if (!lage.hatBlock) {
      return res.status(409).json({ error: 'Dieses Dokument hat keinen Rechnungsblock, der invalidiert werden könnte.' });
    }
    if (!lage.lebensbereich || !lage.dokumentart) {
      return res.status(409).json({ error: 'Dokument ist noch nicht nach LxD migriert.' });
    }
    if (lage.dokumentart === INVALIDIERUNG_ZIEL_D && lage.spielart === 'generische_rechnung') {
      // Korrespondenz mit generischem Block: hier reicht das schlichte Löschen
      // des Blocks, eine Umschaltung wäre ein Umweg ohne Ziel.
      return res.status(409).json({
        error: 'Dieses Dokument ist bereits Korrespondenz — der Rechnungsblock kann direkt gelöscht werden.',
      });
    }
    if (lage.gruende.length > 0) {
      return res.status(409).json({
        error: `Invalidierung nicht möglich: ${lage.gruende.join(' ')}`,
        code: INVALIDIERUNG_GESPERRT_CODE,
        gruende: lage.gruende,
      });
    }
    if (!lage.storageId) {
      return res.status(422).json({ error: 'Dokument hat keine Ablage-ID — Wiederverarbeitung nicht möglich' });
    }

    const ziel = { lebensbereich: lage.lebensbereich, dokumentart: INVALIDIERUNG_ZIEL_D };
    if (!req.body?.confirm) {
      return res.json({
        mode: 'requires_confirm',
        spielart: lage.spielart,
        ziel,
        message:
          `Der Rechnungsblock wird entfernt. Dazu wird die Einordnung von ` +
          `${lage.lebensbereich}/${lage.dokumentart} auf ${lage.lebensbereich}/${INVALIDIERUNG_ZIEL_D} ` +
          `umgeschaltet und das Dokument neu durch die KI verarbeitet.`,
      });
    }

    const instructions = buildInvalidierungsAnweisung(lage.lebensbereich, lage.dokumentart);
    const jobId = tracker.create('doc-reprocess', `Rechnung invalidieren ${postid}`, 10);

    enqueueDocument({
      onedriveFileId: lage.storageId,
      storageBackend: lage.storageBackend,
      modifyPostID: postid,
      korrekturAnweisung: instructions,
      rechnungInvalidierung: { lebensbereich: lage.lebensbereich },
    }, jobId, 0, {
      onError: (err) => {
        console.error(`[actions] Invalidierung ${postid} fehlgeschlagen:`, err.message);
        appLog('ERROR', 'actions', `Rechnungs-Invalidierung ${postid} fehlgeschlagen: ${err.message}`, { entity: 'postbuch', entityId: postid });
      },
    });

    res.json({
      mode: 'reprocessing',
      jobId,
      ziel,
      message: `Invalidierung gestartet (${lage.lebensbereich}/${lage.dokumentart} → ${lage.lebensbereich}/${INVALIDIERUNG_ZIEL_D})`,
    });
    uiLog('AI_CALL', 'rechnung-invalidieren', postid, `${lage.spielart} entfällt · ${lage.dokumentart} → ${INVALIDIERUNG_ZIEL_D}`);
  } catch (err) {
    console.error('POST /api/actions/rechnung-invalidieren/:postid error:', err);
    appLog('ERROR', 'actions', `Rechnungs-Invalidierung fehlgeschlagen für ${req.params.postid}: ${err.message}`, { entity: 'postbuch', entityId: req.params.postid });
    res.status(500).json({ error: err.message || 'Interner Serverfehler' });
  }
});

// POST /api/actions/delete/:postid — Dokument lokal löschen (DB + Ablage)
router.post('/delete/:postid', async (req, res) => {
  let deleteClient = null;
  try {
    const { postid } = req.params;
    if (!POSTID_RE.test(postid)) {
      return res.status(400).json({ error: 'Ungültige PostID' });
    }

    // 1. Dokument-Info laden (für die Löschung in der Ablage)
    const locked = await oeffneSichereDokumentloeschung(postid);
    deleteClient = locked.client;
    const { storage_id, storage_backend, betreff } = locked.document;

    // 2. Datei zuerst nachweislich in den Papierkorb verschieben. Ein
    // fehlgeschlagener Storage-Call darf nie wieder eine erfolgreiche
    // DB-Löschung vortäuschen und eine Waisen-Datei erzeugen.
    const verschoben = await verschiebeInPapierkorb({
      postid, storageId: storage_id, storageBackend: storage_backend, betreff,
    });
    if (!verschoben) {
      await deleteClient.query('ROLLBACK');
      deleteClient.release();
      deleteClient = null;
      return res.status(502).json({
        error: 'Datei konnte nicht in den Papierkorb verschoben werden. Dokument wurde nicht gelöscht.',
      });
    }

    // 3. Erst nach bestätigtem Ablage-Move die DB-Zeile löschen.
    // Ist das Dokument ein Erstattungsbescheid, zuerst seine Periodenwirkung
    // zurücknehmen: Restperioden auflösen, abgeschlossene Perioden wieder auf
    // SUBMITTED. Sonst bliebe eine Restperiode ohne ihre Ursprungsperiode stehen.
    await setzeBescheidwirkungZurueck(postid, { grund: 'bescheid-geloescht', db: deleteClient });
    await deleteClient.query('DELETE FROM postbuch.postbuch WHERE postid = $1', [postid]);
    await deleteClient.query('COMMIT');
    deleteClient.release();
    deleteClient = null;

    // 4. Cache löschen
    query('DELETE FROM post_files WHERE postid = $1', [postid]).catch(() => {});

    res.json({ success: true });
    uiLog('DELETE', 'postbuch', postid, `Dokument gelöscht; PDF nach _trash verschoben (${betreff || 'kein Betreff'})`);
    appLog('INFO', 'actions', `Dokument gelöscht: ${postid}`, { entity: 'postbuch', entityId: postid });
  } catch (err) {
    if (deleteClient) {
      await deleteClient.query('ROLLBACK').catch(() => {});
      deleteClient.release();
    }
    if (istLoeschschutzFehler(err)) return res.status(409).json(loeschschutzAntwort(err));
    if (err.status === 404) return res.status(404).json({ error: err.message });
    console.error('POST /api/actions/delete/:postid error:', err);
    appLog('ERROR', 'actions', `Löschung fehlgeschlagen für ${req.params.postid}: ${err.message}`, { entity: 'postbuch', entityId: req.params.postid });
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// POST /api/actions/duplicate-decision/:jobId — Duplikat-Entscheidung (UI oder Magic-Link)
router.post('/duplicate-decision/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const { decision, token } = req.body || {};

    if (!['replace', 'discard', 'keep_both'].includes(decision)) {
      return res.status(400).json({ error: 'Ungültige Entscheidung (replace|discard|keep_both)' });
    }

    // Authentifizierung: entweder Session (UI) oder JWT-Token (Magic-Link)
    const isAuthenticated = req.session?.authenticated === true;
    let tokenValid = false;
    if (token) {
      try {
        const payload = await verifyToken(token);
        tokenValid = payload?.jobId === jobId && payload?.exp > Math.floor(Date.now() / 1000);
      } catch { /* invalid token */ }
    }

    if (!isAuthenticated && !tokenValid) {
      return res.status(401).json({ error: 'Nicht autorisiert' });
    }

    const source = isAuthenticated ? `ui:${req.session.user}` : 'magic-link';
    const result = await resolveDuplicate({ jobId, decision, source });

    if (!result.ok) {
      return res.status(404).json({ error: result.reason });
    }

    appLog('INFO', 'actions', `Duplikat-Entscheidung: ${decision} für Job ${jobId} (${source})`);
    res.json({ ok: true, decision });
  } catch (err) {
    console.error('POST /api/actions/duplicate-decision error:', err);
    appLog('ERROR', 'actions', `duplicate-decision fehlgeschlagen: ${err.message}`);
    res.status(500).json({ error: err.message || 'Interner Serverfehler' });
  }
});

// POST /api/actions/reprocess-failed/:onedriveId — Fehlgeschlagenes Dokument erneut verarbeiten
router.post('/reprocess-failed/:onedriveId', async (req, res) => {
  try {
    const { onedriveId } = req.params;

    // Dokument aus _failed_documents laden
    const failedResult = await query(
      'SELECT * FROM postbuch._failed_documents WHERE onedrive_id = $1',
      [onedriveId]
    );
    if (failedResult.rows.length === 0) {
      return res.status(404).json({ error: 'Fehlgeschlagenes Dokument nicht gefunden' });
    }
    const failedDoc = failedResult.rows[0];

    // Datei aus _failed Ordner zurück in Inbox verschieben
    // Signatur ist create(type, label, totalSteps) — ein einzelnes Argument
    // ließ `label` undefined, der INSERT in _jobs (label NOT NULL) scheiterte
    // still im .catch(), und der Lauf tauchte im Jobs-Monitor nie auf.
    const jobId = tracker.create('doc-process', `Wiederverarbeitung ${failedDoc.failed_filename}`, 10);

    // Der _failed_documents-Eintrag bleibt bewusst stehen, bis der Lauf ihn
    // erledigt hat (document-processor löscht ihn bei Erfolg/Abbruch, bei
    // erneutem Fehlschlag schreibt moveToFailed ihn mit der neuen Job-ID fort).
    // Vorab gelöscht ging das Dokument bei einem zweiten Fehlschlag verloren:
    // Datei im _failed-Ordner, aber kein Eintrag und damit kein Retry im UI.

    enqueueDocument({
      onedriveFileId: failedDoc.storage_id || onedriveId,
      storageBackend: failedDoc.storage_backend,
    }, jobId, 0, {
      onError: (err) => {
        console.error(`[actions] reprocess-failed ${onedriveId} fehlgeschlagen:`, err.message);
        appLog('ERROR', 'actions', `reprocess-failed fehlgeschlagen: ${err.message}`);
      },
    });

    appLog('INFO', 'actions', `Fehlgeschlagenes Dokument wird erneut verarbeitet: ${onedriveId}`);
    res.json({ ok: true, jobId });
  } catch (err) {
    console.error('POST /api/actions/reprocess-failed error:', err);
    appLog('ERROR', 'actions', `reprocess-failed fehlgeschlagen: ${err.message}`);
    res.status(500).json({ error: err.message || 'Interner Serverfehler' });
  }
});

// POST /api/actions/retry-missing-embeddings — Fehlende Embeddings für alle betroffenen Dokumente nachholen
// Antwort kommt sofort zurück; Verarbeitung läuft asynchron im Hintergrund.
router.post('/retry-missing-embeddings', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT postid FROM postbuch WHERE embedding IS NULL ORDER BY erfassungsdatum DESC`
    );

    if (rows.length === 0) {
      return res.json({ started: 0, message: 'Keine fehlenden Embeddings gefunden.' });
    }

    res.json({ started: rows.length, message: `${rows.length} Embedding(s) werden im Hintergrund nachgeholt.` });

    // Async verarbeiten — Response wurde bereits gesendet
    let processed = 0;
    let failed = 0;
    for (const { postid } of rows) {
      try {
        await regenerateEmbedding(postid);
        // storeEmbedding() löscht embedding_failed_at + embedding_error automatisch
        processed++;
        appLog('INFO', 'embedding', `Embedding nachgeholt für ${postid}`, { entity: 'postbuch', entityId: postid });
      } catch (err) {
        failed++;
        await query(
          `UPDATE postbuch SET embedding_failed_at = NOW(), embedding_error = $1 WHERE postid = $2`,
          [err.message.slice(0, 500), postid]
        ).catch(() => {});
        appLog('WARN', 'embedding', `Embedding-Retry fehlgeschlagen für ${postid}: ${err.message}`, { entity: 'postbuch', entityId: postid });
      }
    }
    console.log(`[retry-missing-embeddings] Abgeschlossen: ${processed} erfolgreich, ${failed} fehlgeschlagen`);
  } catch (err) {
    console.error('POST /api/actions/retry-missing-embeddings error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message || 'Interner Serverfehler' });
  }
});

// POST /api/actions/rebuild-embeddings — ALLE Embeddings mit dem aktuell
// konfigurierten Modell neu berechnen.
//
// Nötig nach einem Wechsel des Embedding-Providers: Zeilen mit abweichender
// Signatur gelten für Suche und Duplikat-Check als „kein Embedding" (siehe
// lib/embedding.js). Ohne diesen Lauf wäre die semantische Suche nach dem
// Wechsel schlagartig leer.
//
// Antwort kommt sofort; der Lauf hängt an jobs/tracker.js (WebSocket-Live-Status).
router.post('/rebuild-embeddings', requireAdmin, async (req, res) => {
  try {
    const signatur = await activeSignature();
    const nurVeraltet = req.body?.alle !== true;
    const filter = nurVeraltet
      ? `WHERE embedding_signature IS DISTINCT FROM $1`
      : '';
    const params = nurVeraltet ? [signatur] : [];

    const { rows: docs } = await query(
      `SELECT postid FROM postbuch.postbuch ${filter} ORDER BY postid`, params);
    const { rows: akten } = await query(
      `SELECT akteid FROM postbuch.akte ${nurVeraltet ? 'WHERE embedding_signature IS DISTINCT FROM $1' : ''} ORDER BY akteid`,
      params);
    const hilfe = await loadHelpSource();
    const hilfeStatus = await getHelpEmbeddingStatus();
    const hilfeGesamt = hilfeStatus.aktuell ? 0 : hilfe.chunks.length;

    const gesamt = docs.length + akten.length + hilfeGesamt;
    if (gesamt === 0) {
      return res.json({ started: 0, signatur, message: 'Alle Embeddings sind bereits aktuell.' });
    }

    const jobId = tracker.create('embedding-rebuild', `Embeddings neu berechnen (${gesamt})`, gesamt);
    res.json({ started: gesamt, jobId, signatur,
      message: `${gesamt} Embedding(s) werden im Hintergrund neu berechnet (${signatur}).` });

    (async () => {
      let ok = 0, fehler = 0, i = 0;
      for (const { postid } of docs) {
        tracker.setStep(jobId, ++i, `Dokument ${postid}`);
        try { await regenerateEmbedding(postid); ok++; }
        catch (err) {
          fehler++;
          await query(
            `UPDATE postbuch SET embedding_failed_at = NOW(), embedding_error = $1 WHERE postid = $2`,
            [err.message.slice(0, 500), postid],
          ).catch(() => {});
          appLog('WARN', 'embedding', `Neuberechnung fehlgeschlagen für ${postid}: ${err.message}`,
            { entity: 'postbuch', entityId: postid });
        }
      }
      for (const { akteid } of akten) {
        tracker.setStep(jobId, ++i, `Akte ${akteid}`);
        // wirft nie an den Aufrufer (fire-and-forget-Semantik des Services)
        await computeAndSaveAkteEmbedding(akteid);
        ok++;
      }
      if (hilfeGesamt > 0) {
        const hilfeResult = await reconcileHelpCorpus({
          reason: 'embedding-rebuild',
          onItem: (_hilfeIndex, _hilfeGesamt, chunk) => {
            tracker.setStep(jobId, ++i, `Hilfe: ${chunk.kapitelTitel}`);
          },
        });
        ok += hilfeResult.embedded || 0;
      }
      tracker.complete(jobId, { ok, fehler, signatur });
      appLog('INFO', 'embedding', `Embedding-Neuberechnung abgeschlossen: ${ok} ok, ${fehler} Fehler (${signatur})`);
      console.log(`[rebuild-embeddings] Abgeschlossen: ${ok} ok, ${fehler} Fehler`);
    })().catch((err) => {
      tracker.fail(jobId, err.message);
      appLog('ERROR', 'embedding', `Embedding-Neuberechnung abgebrochen: ${err.message}`);
    });
  } catch (err) {
    console.error('POST /api/actions/rebuild-embeddings error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message || 'Interner Serverfehler' });
  }
});

export default router;
