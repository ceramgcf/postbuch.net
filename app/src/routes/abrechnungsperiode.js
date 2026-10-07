/**
 * routes/abrechnungsperiode.js — Abrechnungsperioden-Wizard-API + manuelle Perioden-Operationen
 *
 * Wizard (Lifecycle in service/abrechnung-session.js, Perioden-Operationen in
 * service/abrechnungsperiode.js):
 *   POST /api/abrechnungsperiode/start                     — Session sofort eröffnen (building),
 *                                                              gibt { jobId, sessionId } zurück;
 *                                                              409 mit code=ABRECHNUNG_SESSION_KONFLIKT
 *                                                              bei paralleler Session auf dasselbe Ziel
 *   GET  /api/abrechnungsperiode/progress/:jobId           — SSE-Stream mit echtem Fortschritt
 *   GET  /api/abrechnungsperiode/sessions                  — Offene Sessions (Wiederaufnahme)
 *   GET  /api/abrechnungsperiode/sessions/:id              — Session-Details
 *   GET  /api/abrechnungsperiode/sessions/:id/pdf/:groupIndex — Merged PDF (proxy, inline)
 *   POST /api/abrechnungsperiode/sessions/:id/confirm      — Session bestätigen
 *   POST /api/abrechnungsperiode/sessions/:id/reject       — Session verwerfen
 *
 * Manuelle Perioden-Operationen:
 *   POST /api/abrechnungsperiode/periode/status            — Status manuell ändern
 *   POST /api/abrechnungsperiode/periode/omit              — COLLECTING → OMITTED
 *   POST /api/abrechnungsperiode/periode/undo-omit         — OMITTED → COLLECTING (Undo)
 *   POST /api/abrechnungsperiode/periode/delete-highest    — Höchste COLLECTING löschen
 *   POST /api/abrechnungsperiode/periode/merge             — COLLECTING in höchste mergen
 *   POST /api/abrechnungsperiode/periode/null-ap           — COLLECTING löschen, AP der Rechnungen nullen
 *   POST /api/abrechnungsperiode/periode/restore           — Gelöschte COLLECTING wiederherstellen (Undo)
 */

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { Router } from 'express';
import { query } from '../db.js';
import { getAdapter, getActiveAdapter } from '../lib/storage/index.js';
import {
  beginAbrechnungsSession,
  buildAbrechnungsSessionArtefakte,
  confirmAbrechnungsperiode,
  rejectAbrechnungsperiode,
  getPendingSessions,
  getSessionById,
  getArtefaktByTypSort,
  isLegacySession,
} from '../service/abrechnung-session.js';
import {
  setPeriodeStatus,
  omitPeriode,
  undoOmit,
  deleteHighestCollecting,
  mergePerioden,
  restoreCollectingFromMerge,
  nullAPForCollectingPeriode,
} from '../service/abrechnungsperiode.js';
import { appLog } from '../app-log.js';

// ── In-Memory-Jobstore für Fortschrittsanzeige ───────────────────────────────
// Lebt nur im aktuellen Prozess; reicht für einen Einzel-User-Betrieb.
// Jeder Job wird nach 15 Minuten automatisch aufgeräumt.
const jobStore = new Map(); // jobId → { emitter, done, total, label, result, error }

function createJob(jobId) {
  const emitter = new EventEmitter();
  jobStore.set(jobId, { emitter, done: 0, total: 0, label: 'Starte…', result: null, error: null });
  setTimeout(() => jobStore.delete(jobId), 15 * 60 * 1000);
}

function progressCallback(jobId) {
  return (done, total, label) => {
    const job = jobStore.get(jobId);
    if (!job) return;
    job.done = done;
    job.total = total;
    job.label = label;
    job.emitter.emit('progress', { done, total, label });
  };
}

const router = Router();

// POST /api/abrechnungsperiode/start
// Body: { persons, kostentraeger }  ODER  { selections: [{person, kostentraeger, periode}, ...] }
// Gibt sofort { jobId } zurück. Fortschritt per GET /progress/:jobId (SSE).
router.post('/start', async (req, res) => {
  try {
    const { persons, kostentraeger, selections } = req.body;

    if (Array.isArray(selections) && selections.length > 0) {
      for (const s of selections) {
        if (!s.person || !['PKV', 'Beihilfe'].includes(s.kostentraeger) || !Number.isInteger(s.periode)) {
          return res.status(400).json({ error: 'Ungültige Selection-Struktur' });
        }
      }
    } else {
      if (!Array.isArray(persons) || persons.length === 0) {
        return res.status(400).json({ error: 'persons muss eine nicht-leere Array sein' });
      }
      if (!Array.isArray(kostentraeger) || kostentraeger.length === 0) {
        return res.status(400).json({ error: 'kostentraeger muss eine nicht-leere Array sein' });
      }
      for (const kt of kostentraeger) {
        if (!['PKV', 'Beihilfe'].includes(kt)) {
          return res.status(400).json({ error: `Ungültiger Kostenträger: ${kt}` });
        }
      }
    }

    // Eine Abrechnungssitzung darf niemals Menschen und Tiere zusammenführen.
    // Die UI trennt dies in Tabs; diese Prüfung macht die Grenze auch für
    // direkte API-Aufrufe verbindlich.
    const ausgewahltePersonen = Array.isArray(selections) && selections.length > 0
      ? selections.map((s) => s.person)
      : persons;
    const gruppen = await query(
      `SELECT DISTINCT ist_tier FROM postbuch.mensch WHERE kurzname = ANY($1::text[])`,
      [ausgewahltePersonen],
    );
    if (gruppen.rows.length === 0 || gruppen.rows.length > 1) {
      return res.status(400).json({ error: 'Eine Abrechnung darf nur Menschen oder nur Tiere enthalten.' });
    }

    // Phase 1-4: Session sofort in einer kurzen Transaktion eröffnen (Ziel
    // sperren, Session 'building', Snapshot). Erst danach existiert die
    // Session — ein 409 bei Konflikt kommt darum synchron zurück, nicht erst
    // nach der (potenziell langen) PDF-Erzeugung.
    let sessionId;
    let allDocs;
    let targets;
    try {
      ({ sessionId, allDocs, targets } = await beginAbrechnungsSession({ persons, kostentraeger, selections }));
    } catch (err) {
      const status = err.code === 'ABRECHNUNG_SESSION_KONFLIKT' ? 409 : 400;
      return res.status(status).json({ error: err.message, code: err.code });
    }

    const jobId = randomUUID();
    createJob(jobId);
    appLog('INFO', 'abrechnungsperiode', `Start-Job ${jobId} angelegt für Session ${sessionId}`, { jobId, memory: process.memoryUsage() });

    res.json({ jobId, sessionId });

    // Phase 5-6: PDFs bauen + hochladen — läuft nach der Antwort weiter (Fire-and-forget).
    buildAbrechnungsSessionArtefakte(sessionId, allDocs, targets, progressCallback(jobId))
      .then((groups) => {
        const result = { sessionId, groups };
        const job = jobStore.get(jobId);
        if (job) { job.result = result; job.emitter.emit('done', result); }
        appLog('INFO', 'abrechnungsperiode', `Start-Job ${jobId} abgeschlossen`, { jobId, memory: process.memoryUsage() });
      })
      .catch((err) => {
        appLog('ERROR', 'abrechnungsperiode', `Start-Job ${jobId} fehlgeschlagen: ${err.message}`, { jobId, memory: process.memoryUsage(), stack: err.stack });
        const job = jobStore.get(jobId);
        if (job) { job.error = err.message; job.emitter.emit('error', err.message); }
      });
  } catch (err) {
    appLog('ERROR', 'abrechnungsperiode', `Start fehlgeschlagen (sync): ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/abrechnungsperiode/progress/:jobId — SSE-Fortschrittsstream
// Events: progress { done, total, label } | done { sessionId, groups } | error { message }
router.get('/progress/:jobId', (req, res) => {
  const job = jobStore.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job nicht gefunden' });

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // Caddy/Nginx-Proxy: kein Buffering
  });
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Bereits abgeschlossener Job → sofort antworten
  if (job.result) { send('done', job.result); return res.end(); }
  if (job.error)  { send('error', { message: job.error }); return res.end(); }

  // Aktuellen Stand sofort senden, dann Events abonnieren
  send('progress', { done: job.done, total: job.total, label: job.label });

  const onProgress = (data) => send('progress', data);
  const onDone     = (data) => { send('done', data); res.end(); };
  const onError    = (msg)  => { send('error', { message: msg }); res.end(); };

  job.emitter.on('progress', onProgress);
  job.emitter.on('done', onDone);
  job.emitter.on('error', onError);

  req.on('close', () => {
    job.emitter.off('progress', onProgress);
    job.emitter.off('done', onDone);
    job.emitter.off('error', onError);
  });
});

// GET /api/abrechnungsperiode/sessions
router.get('/sessions', async (req, res) => {
  try {
    const sessions = await getPendingSessions();
    res.json({ sessions });
  } catch (err) {
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// GET /api/abrechnungsperiode/sessions/:id
router.get('/sessions/:id', async (req, res) => {
  try {
    const session = await getSessionById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session nicht gefunden' });
    res.json(session);
  } catch (err) {
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// Dateinamen der Downloads: identisch mit den Namen in der Ablage
// (abrechnung-session.js) und mit dem download-Attribut im Wizard
// (AbrechnungWizardCard.jsx) – egal, über welchen Schritt geladen wird.
function groupFileName(group) {
  return group.fileName || `${group.fileNamePart || 'Abrechnung'}.pdf`;
}

function chunkFileName(group, chunkIndex) {
  return groupFileName(group).replace(/\.pdf$/i, `_Teil${chunkIndex + 1}.pdf`);
}

// RFC 5987, damit Umlaute in Personennamen in allen Browsern ankommen.
function contentDisposition(type, fileName) {
  const ascii = fileName.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

// GET /api/abrechnungsperiode/sessions/:id/pdf/:groupIndex
// Proxied das gemergte PDF aus der Ablage — inline im Browser darstellbar.
// Gehärtete Sessions lösen das Artefakt backend-bewusst über
// _abrechnung_sessions.artefakte auf (getAdapter(storage_backend)); Alt-Sessions
// von vor der Härtung fallen auf den früheren groups-JSONB-Pfad zurück.
router.get('/sessions/:id/pdf/:groupIndex', async (req, res) => {
  try {
    const session = await getSessionById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session nicht gefunden' });

    const idx = parseInt(req.params.groupIndex, 10);
    const groups = session.groups;
    if (!Number.isFinite(idx) || idx < 0 || !groups || idx >= groups.length) {
      return res.status(400).json({ error: 'Ungültiger Gruppenindex' });
    }
    const group = groups[idx];

    let pdfBuffer;
    if (await isLegacySession(req.params.id)) {
      if (!group.pdfOneDriveId) return res.status(404).json({ error: 'Kein PDF für diese Gruppe vorhanden' });
      pdfBuffer = await (await getActiveAdapter()).download(group.pdfOneDriveId);
    } else {
      const artefakt = await getArtefaktByTypSort(req.params.id, 'PDF_GRUPPE', idx);
      if (!artefakt) return res.status(404).json({ error: 'Kein PDF für diese Gruppe vorhanden' });
      pdfBuffer = await getAdapter(artefakt.storage_backend).download(artefakt.storage_id);
    }
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': contentDisposition('inline', groupFileName(group)),
      'Content-Length': pdfBuffer.length,
    });
    res.send(pdfBuffer);
  } catch (err) {
    appLog('ERROR', 'abrechnungsperiode', `PDF-Proxy fehlgeschlagen: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/abrechnungsperiode/sessions/:id/pdf/:groupIndex/chunk/:chunkIndex
// Liefert einen Chunk (Teil-PDF) zum Download. Chunks werden nie größer als 3 MB.
// Der Browser löst über den download-Attribute einen Datei-Download aus.
router.get('/sessions/:id/pdf/:groupIndex/chunk/:chunkIndex', async (req, res) => {
  try {
    const session = await getSessionById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session nicht gefunden' });

    const gIdx = parseInt(req.params.groupIndex, 10);
    const cIdx = parseInt(req.params.chunkIndex, 10);
    const groups = session.groups;

    if (!Number.isFinite(gIdx) || gIdx < 0 || !groups || gIdx >= groups.length) {
      return res.status(400).json({ error: 'Ungültiger Gruppenindex' });
    }
    const group = groups[gIdx];
    if (!Array.isArray(group.chunks) || !Number.isFinite(cIdx) || cIdx < 0 || cIdx >= group.chunks.length) {
      return res.status(400).json({ error: 'Ungültiger Chunk-Index' });
    }
    const chunk = group.chunks[cIdx];

    let pdfBuffer;
    if (await isLegacySession(req.params.id)) {
      if (!chunk.oneDriveId) return res.status(404).json({ error: 'Kein PDF für diesen Chunk vorhanden' });
      pdfBuffer = await (await getActiveAdapter()).download(chunk.oneDriveId);
    } else {
      const artefakt = await getArtefaktByTypSort(req.params.id, 'PDF_CHUNK', gIdx * 100 + cIdx);
      if (!artefakt) return res.status(404).json({ error: 'Kein PDF für diesen Chunk vorhanden' });
      pdfBuffer = await getAdapter(artefakt.storage_backend).download(artefakt.storage_id);
    }
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': contentDisposition('attachment', chunkFileName(group, cIdx)),
      'Content-Length': pdfBuffer.length,
    });
    res.send(pdfBuffer);
  } catch (err) {
    appLog('ERROR', 'abrechnungsperiode', `Chunk-Download fehlgeschlagen: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/abrechnungsperiode/sessions/:id/confirm
router.post('/sessions/:id/confirm', async (req, res) => {
  try {
    const summary = await confirmAbrechnungsperiode(req.params.id);
    res.json({ success: true, ...summary });
  } catch (err) {
    appLog('ERROR', 'abrechnungsperiode', `Bestätigung fehlgeschlagen: ${err.message}`);
    const status = err.code === 'ABRECHNUNG_SESSION_VERALTET' ? 409 : 500;
    res.status(status).json({ error: err.message, code: err.code });
  }
});

// POST /api/abrechnungsperiode/sessions/:id/reject
router.post('/sessions/:id/reject', async (req, res) => {
  try {
    await rejectAbrechnungsperiode(req.params.id);
    res.json({ success: true });
  } catch (err) {
    appLog('ERROR', 'abrechnungsperiode', `Ablehnung fehlgeschlagen: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── Manuelle Perioden-Operationen ─────────────────────────────────────────────

function parsePerioden(body) {
  const { person, kostentraeger, periode } = body || {};
  if (typeof person !== 'string' || person.length === 0) throw new Error('person fehlt');
  if (!['PKV', 'Beihilfe'].includes(kostentraeger)) throw new Error('Ungültiger kostentraeger');
  if (!Number.isInteger(periode)) throw new Error('periode muss integer sein');
  return { person, kostentraeger, periode };
}

// POST /api/abrechnungsperiode/periode/status
// Body: { person, kostentraeger, periode, targetStatus, expectedCurrentStatus? }
router.post('/periode/status', async (req, res) => {
  try {
    const { person, kostentraeger, periode } = parsePerioden(req.body);
    const { targetStatus, expectedCurrentStatus } = req.body;
    await setPeriodeStatus({ person, kostentraeger, periode, targetStatus, expectedCurrentStatus });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message, code: err.code });
  }
});

// POST /api/abrechnungsperiode/periode/omit
// Body: { person, kostentraeger, periode }
router.post('/periode/omit', async (req, res) => {
  try {
    const args = parsePerioden(req.body);
    const result = await omitPeriode(args);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message, code: err.code });
  }
});

// POST /api/abrechnungsperiode/periode/undo-omit
// Body: { person, kostentraeger, periode, autoCreatedPeriode? }
router.post('/periode/undo-omit', async (req, res) => {
  try {
    const args = parsePerioden(req.body);
    const { autoCreatedPeriode } = req.body;
    await undoOmit({ ...args, autoCreatedPeriode });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message, code: err.code });
  }
});

// POST /api/abrechnungsperiode/periode/delete-highest
// Body: { person, kostentraeger, periode }
router.post('/periode/delete-highest', async (req, res) => {
  try {
    const args = parsePerioden(req.body);
    const result = await deleteHighestCollecting(args);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message, code: err.code });
  }
});

// POST /api/abrechnungsperiode/periode/merge
// Body: { person, kostentraeger, sourcePeriode, targetPeriode }
router.post('/periode/merge', async (req, res) => {
  try {
    const { person, kostentraeger, sourcePeriode, targetPeriode } = req.body || {};
    if (typeof person !== 'string' || !['PKV', 'Beihilfe'].includes(kostentraeger) ||
        !Number.isInteger(sourcePeriode) || !Number.isInteger(targetPeriode)) {
      return res.status(400).json({ error: 'Ungültige Parameter' });
    }
    const result = await mergePerioden({ person, kostentraeger, sourcePeriode, targetPeriode });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message, code: err.code });
  }
});

// POST /api/abrechnungsperiode/periode/null-ap
// Body: { person, kostentraeger, periode }
// Setzt die AP-Zuordnung aller Rechnungen der Periode auf NULL und löscht die Periode.
router.post('/periode/null-ap', async (req, res) => {
  try {
    const args = parsePerioden(req.body);
    const result = await nullAPForCollectingPeriode(args);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message, code: err.code });
  }
});

// POST /api/abrechnungsperiode/periode/restore
// Body: { person, kostentraeger, periode, postIds, status?, movedKuerzungen? }
// status: 'COLLECTING' (default) oder 'OMITTED' (für Undo eines OMITTED-Merges)
// movedKuerzungen: exakte Kürzungsschlüssel aus dem Merge/Delete-highest-Snapshot,
// die zusammen mit den Rechnungen zurückgehängt werden.
router.post('/periode/restore', async (req, res) => {
  try {
    const args = parsePerioden(req.body);
    const { postIds, status, movedKuerzungen } = req.body;
    await restoreCollectingFromMerge({
      ...args,
      postIds: Array.isArray(postIds) ? postIds : [],
      status: status === 'OMITTED' ? 'OMITTED' : 'COLLECTING',
      movedKuerzungen: Array.isArray(movedKuerzungen) ? movedKuerzungen : [],
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message, code: err.code });
  }
});

export default router;
