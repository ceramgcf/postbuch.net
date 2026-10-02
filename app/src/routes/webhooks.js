/**
 * routes/webhooks.js — Interne Webhooks (Scanner-Pipeline)
 *
 * POST /api/webhooks/scan-complete
 *   Content-Type: application/pdf
 *   X-Filename: scan_001.pdf
 *   X-Webhook-Token: <webhook_token aus _settings>
 *
 * Wird vom Cleaner-Container aufgerufen, nachdem ein Scan durch OCR gelaufen ist.
 * Startet die Dokumentverarbeitungs-Pipeline mit dem PDF-Buffer.
 *
 * Authentifizierung: Diese Routen liegen VOR dem globalen requireAuth-Gate, sind
 * also nicht session-geschützt. Sie werden zusätzlich in web/nginx.conf geblockt,
 * verlassen sich darauf aber nicht: der Proxy einer Fremdinstanz kann anders
 * konfiguriert sein. Deshalb prüft requireWebhookToken einen gemeinsamen Token,
 * den der Cleaner über /api/internal/config bezieht (nur im Docker-Netz erreichbar).
 */

import { Router } from 'express';
import express from 'express';
import { timingSafeEqual } from 'crypto';
import db from '../db.js';
import { enqueueDocument } from '../jobs/pipeline-queue.js';
import { replacePdf } from '../service/document-replace.js';
import { consumePendingReplace, markReplaceJob, consumeReplaceJob } from '../service/replace-registry.js';
import { consumePendingHinweisByFile, markHinweisJob, consumeHinweisJob } from '../service/hinweis-registry.js';
import * as tracker from '../jobs/tracker.js';
import { appLog } from '../app-log.js';
import { saveScanBuffer } from '../lib/scan-buffer.js';

const router = Router();

/**
 * Vergleicht zwei Strings zeitkonstant (kein Längen-Leak, kein Early-Exit).
 */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Prüft den X-Webhook-Token-Header gegen _settings.webhook_token.
 *
 * Der Token wird beim ersten Start von seed-settings.js erzeugt. Fehlt er in der
 * DB (sehr alte Installation, in der der Seed nie lief), wird durchgelassen und
 * gewarnt — sonst risse ein Update die Scan-Pipeline einer Fremdinstanz ab. Der
 * nginx-Block greift in dem Fall weiterhin.
 */
async function requireWebhookToken(req, res, next) {
  let expected = null;
  try {
    const row = await db.query("SELECT value FROM postbuch._settings WHERE key = 'webhook_token'");
    expected = row.rows[0]?.value ?? null;
  } catch (err) {
    console.error('[webhooks] webhook_token konnte nicht geladen werden:', err.message);
    return res.status(500).json({ error: 'Interner Serverfehler' });
  }

  if (!expected) {
    console.warn('[webhooks] Kein webhook_token in _settings — Aufruf ungeprüft durchgelassen.');
    return next();
  }

  const provided = req.headers['x-webhook-token'];
  if (typeof provided !== 'string' || !safeEqual(provided, expected)) {
    appLog('WARN', 'webhooks', `Webhook ohne gültigen Token abgewiesen: ${req.method} ${req.originalUrl}`);
    return res.status(401).json({ error: 'Nicht autorisiert' });
  }
  next();
}

router.use(requireWebhookToken);

// POST /api/webhooks/scan-registered — Cleaner meldet Scan-Eingang VOR OCR
// Erstellt den Job sofort, damit er im Monitoring erscheint. Wenn der Benutzer
// zuvor im Import-Screen einen Replace-Vorgang ausgelöst hat, wird hier die
// Reservierung konsumiert und der Job als Replace-Auftrag markiert. /scan-complete
// routet ihn dann in `replacePdf()` statt in die normale Pipeline.
router.post('/scan-registered', (req, res) => {
  try {
    const filename = req.headers['x-filename'] || `scan_${Date.now()}.pdf`;
    const replaceForPostId = consumePendingReplace();

    let jobId;
    if (replaceForPostId) {
      // Replace-Job: 2 Schritte (0 = Scan & OCR, 1 = OneDrive-Tausch)
      jobId = tracker.create('doc-replace', `Ersetzen ${replaceForPostId}: ${filename}`, 2);
      tracker.setStep(jobId, 0, 'Scan & OCR');
      markReplaceJob(jobId, replaceForPostId);
      appLog('INFO', 'webhooks',
        `Scan registriert (Replace): ${filename} → ${replaceForPostId} (jobId: ${jobId})`,
        { entity: 'postbuch', entityId: replaceForPostId }
      );
    } else {
      // 11 Schritte: 0 = Scan & OCR (Cleaner), 1-10 = Pipeline
      jobId = tracker.create('doc-process', filename, 11);
      tracker.setStep(jobId, 0, 'Scan & OCR');
      markHinweisJob(jobId, consumePendingHinweisByFile(filename));
      appLog('INFO', 'webhooks', `Scan registriert: ${filename} (jobId: ${jobId})`);
    }
    res.json({ jobId });
  } catch (err) {
    console.error('POST /api/webhooks/scan-registered error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// POST /api/webhooks/scan-complete — Scan verarbeiten
router.post('/scan-complete',
  express.raw({ type: 'application/pdf', limit: '50mb' }),
  async (req, res) => {
    try {
      const pdfBuffer = req.body;
      if (!pdfBuffer || pdfBuffer.length === 0) {
        return res.status(400).json({ error: 'Leerer PDF-Body' });
      }

      const filename = req.headers['x-filename'] || `scan_${Date.now()}.pdf`;

      // Wenn Cleaner einen vorregistrierten Job mitschickt, diesen weiterführen (stepOffset=1).
      // Andernfalls neuen 10-Schritt-Job erstellen (Rückwärtskompatibilität).
      const xJobId = (req.headers['x-job-id'] || '').trim();

      // ─── Sonderpfad: Replace-Auftrag ───
      // Der zugehörige scan-registered-Aufruf hat den Job als Replace markiert.
      // Statt der vollen Pipeline tauschen wir nur die OneDrive-Datei aus.
      const replaceForPostId = xJobId ? consumeReplaceJob(xJobId) : null;
      if (replaceForPostId) {
        let replaceJobId = xJobId;
        const activeJobs = tracker.listActive();
        if (!activeJobs.find(j => j.id === replaceJobId)) {
          // Job nicht mehr im Speicher (z. B. App-Neustart zwischen den Webhooks)
          // → neuen 1-Schritt-Job anlegen, damit der Verlauf konsistent bleibt.
          replaceJobId = tracker.create('doc-replace', `Ersetzen ${replaceForPostId}: ${filename}`, 1);
        }
        tracker.setStep(replaceJobId, 1, 'OneDrive-Datei austauschen');
        appLog('INFO', 'webhooks',
          `Scan empfangen (Replace): ${filename} → ${replaceForPostId} (${(pdfBuffer.length / 1024).toFixed(1)} KB)`,
          { entity: 'postbuch', entityId: replaceForPostId }
        );

        replacePdf(replaceForPostId, pdfBuffer)
          .then(result => tracker.complete(replaceJobId, { mode: 'replace', ...result }))
          .catch(err => {
            console.error(`[webhooks] Scan-Replace fehlgeschlagen für ${replaceForPostId}: ${err.message}`);
            appLog('ERROR', 'webhooks',
              `Scan-Replace fehlgeschlagen: ${replaceForPostId}: ${err.message}`,
              { entity: 'postbuch', entityId: replaceForPostId }
            );
            tracker.fail(replaceJobId, err.message);
          });

        return res.json({ jobId: replaceJobId, message: 'PDF-Austausch gestartet', mode: 'replace' });
      }

      // ─── Normalpfad: KI-Pipeline ───
      let jobId;
      let stepOffset;

      if (xJobId) {
        const activeJobs = tracker.listActive();
        if (activeJobs.find(j => j.id === xJobId)) {
          jobId = xJobId;
          stepOffset = 1; // Schritt 0 war OCR, Pipeline startet bei 1
        } else {
          // Job nicht mehr im Speicher (z.B. nach Neustart) → neu anlegen
          jobId = tracker.create('doc-process', filename, 10);
          stepOffset = 0;
        }
      } else {
        jobId = tracker.create('doc-process', filename, 10);
        stepOffset = 0;
      }

      appLog('INFO', 'webhooks', `Scan empfangen: ${filename} (${(pdfBuffer.length / 1024).toFixed(1)} KB, stepOffset=${stepOffset})`);

      // Benutzer-Hinweis: aus dem jobId-Mapping (via scan-registered gesetzt) oder
      // per Dateiname (Fallback wenn scan-registered nicht lief).
      const userHinweis = consumeHinweisJob(xJobId) || consumeHinweisJob(jobId) || consumePendingHinweisByFile(filename);

      // PDF sofort auf Disk sichern — verhindert Datenverlust wenn Phase 0 (OD-Upload) scheitert.
      // Buffer wird von Phase 0 nach erfolgreichem Upload gelöscht.
      saveScanBuffer(jobId, pdfBuffer).catch(e =>
        console.error(`[webhooks] saveScanBuffer fehlgeschlagen (kein Retry möglich): ${e.message}`)
      );

      // Pipeline im Hintergrund starten (geht durch die Queue).
      // fromScanner: true → Dunkelverarbeitung verwirft die (Tesseract-)OCR-Textebene
      // vor der KI-Analyse. Nur der echte Scan-Pfad setzt dieses Flag.
      enqueueDocument({ pdfBuffer, filename, fromScanner: true, ...(userHinweis ? { userHinweis } : {}) }, jobId, stepOffset, {
        onError: (err) => {
          console.error(`[webhooks] Scan-Verarbeitung fehlgeschlagen für ${filename}: ${err.message}`);
          appLog('ERROR', 'webhooks', `Scan-Verarbeitung fehlgeschlagen: ${filename}: ${err.message}`);
        },
      });

      res.json({ jobId, message: 'Verarbeitung gestartet' });
    } catch (err) {
      console.error('POST /api/webhooks/scan-complete error:', err);
      appLog('ERROR', 'webhooks', `Scan-Webhook-Fehler: ${err.message}`);
      res.status(500).json({ error: 'Interner Serverfehler' });
    }
  }
);

// POST /api/webhooks/scan-aborted — Cleaner meldet, dass ein Scan verworfen wurde
// (z.B. alle Seiten leer). Markiert den Job als fehlgeschlagen.
router.post('/scan-aborted', (req, res) => {
  try {
    const xJobId = (req.headers['x-job-id'] || '').trim();
    const reason = req.headers['x-reason'] || 'Scan verworfen';
    if (!xJobId) {
      return res.status(400).json({ error: 'X-Job-Id fehlt' });
    }
    tracker.fail(xJobId, reason);
    appLog('WARN', 'webhooks', `Scan abgebrochen: jobId=${xJobId}, Grund: ${reason}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/webhooks/scan-aborted error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

export default router;
