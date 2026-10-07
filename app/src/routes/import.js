/**
 * routes/import.js — Dokumentenimport (Scanner + Upload)
 *
 * Scanner-Proxy:
 *   POST /api/import/scan
 *     Body: { endpoint, dpi?, mode?, size? }
 *     endpoint: 'adf/simplex' | 'adf/duplex' | 'adf/batch/simplex' | 'adf/batch/duplex'
 *               | 'flatbed/single' | 'flatbed/session/scan' | 'flatbed/session/finish' | 'flatbed/session/abort'
 *     Die ADF-Batch-Endpunkte liefern statt einem Dateinamen ein `files`-Array
 *     (ein PDF pro Blatt) — jede Datei durchläuft Cleaner/Pipeline unabhängig.
 *     Proxied an Scanner-Service (SCANNER_URL, default http://host.docker.internal:8080).
 *     Rückgabe identisch zum Scanner-Service.
 *     Nach Erfolg landet die PDF in /data/scans_pending und wird vom Cleaner aufgegriffen.
 *
 * Upload-Einzel (Batch-Modus):
 *   POST /api/import/upload
 *     Content-Type: application/json
 *     Body: { filename, dataB64 }
 *     Speichert in /input (scans_pending) — Cleaner übernimmt OCR + Webhook.
 *
 * Upload-Merged (Sammlung):
 *   POST /api/import/upload-merged
 *     Body: { filename, files: [{ name, dataB64 }, ...] }
 *     Mergt PDFs via qpdf, schreibt nach /input. Cleaner übernimmt wie gewohnt.
 */

import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { unlink, statfs, readdir, stat, open } from 'node:fs/promises';
import { mergePdfs, decodeBase64Pdf } from '../lib/pdf.js';
import { appLog } from '../app-log.js';
import { enqueueDocument } from '../jobs/pipeline-queue.js';
import { importArchive, pruefeArchiv } from '../service/archive-importer.js';
import { schlageZuordnungVor } from '../lib/personen-abgleich.js';
import { query } from '../db.js';
import { replacePdf } from '../service/document-replace.js';
import { setPendingReplace, clearPendingReplace } from '../service/replace-registry.js';
import { setPendingHinweis } from '../service/hinweis-registry.js';
import * as tracker from '../jobs/tracker.js';
import { loadDynamicSettings } from '../config.js';
import { quelleAusCapabilities, quelleFuerEndpunkt } from '../lib/scanner-capabilities.js';
import { requireAdmin } from '../middleware/auth.js';

const router = Router();

// Scanner läuft im Host-Netzwerk; aus dem app-Container über host.docker.internal erreichbar
const SCANNER_URL = process.env.SCANNER_URL || 'http://host.docker.internal:8080';

// Uploads gehen direkt an processDocument() — exakt derselbe Pipeline-Einstieg
// wie der Scanner-Webhook (scan-complete), nur ohne vorgelagerte OCR-Stufe.

// ── Scanner-Proxy ────────────────────────────────────────────────────────────

const ALLOWED_SCAN_ENDPOINTS = new Set([
  'adf/simplex',
  'adf/duplex',
  'adf/batch/simplex',
  'adf/batch/duplex',
  'flatbed/single',
  'flatbed/session/scan',
  'flatbed/session/start',
  'flatbed/session/add',
  'flatbed/session/finish',
  'flatbed/session/abort',
]);

const ALLOWED_SIZE = new Set(['a3', 'a4', 'a5', 'a6']);

function parseBool(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  }
  return fallback;
}

async function getScannerCapabilities() {
  const s = await loadDynamicSettings();
  const hasAdf = parseBool(s.scanner_has_adf, false);
  const supportsA3 = parseBool(s.scanner_supports_a3, false);
  const adfDuplex = parseBool(s.scanner_adf_duplex, false);
  // Ermittelte Gerätefähigkeiten; fehlt der Wert, greift der bisherige Stand.
  const geraet = s.scanner_capabilities || null;
  return { hasAdf, supportsA3, adfDuplex, geraet };
}

/**
 * Validiert die Scanner-Body-Parameter und proxiet auf den Scanner-Service.
 * Antwortet im Erfolgsfall direkt mit dem Scanner-JSON; im Fehlerfall mit
 * passendem Status. Gibt true zurück, wenn die Antwort an den Client gesendet
 * wurde (also immer — die Funktion respondet selbst).
 */
async function proxyScannerCall(req, res) {
  const { endpoint, dpi, mode, size } = req.body || {};

  if (!endpoint || !ALLOWED_SCAN_ENDPOINTS.has(endpoint)) {
    res.status(400).json({ error: `Ungültiger endpoint. Erlaubt: ${Array.from(ALLOWED_SCAN_ENDPOINTS).join(', ')}` });
    return false;
  }

  const caps = await getScannerCapabilities();
  if (endpoint.startsWith('adf/') && !caps.hasAdf) {
    res.status(400).json({
      error: 'Dieser Scanner hat laut Einstellungen keinen ADF. Aktiviere die Option unter Einstellungen > Scanner, falls vorhanden.',
    });
    return false;
  }
  // Deckt sowohl 'adf/duplex' als auch 'adf/batch/duplex' ab.
  if (endpoint.endsWith('duplex') && endpoint.startsWith('adf/') && (!caps.hasAdf || !caps.adfDuplex)) {
    res.status(400).json({
      error: 'ADF-Duplex ist laut Einstellungen deaktiviert. Aktiviere die Option unter Einstellungen > Scanner, falls vorhanden.',
    });
    return false;
  }

  // Auflösung und Farbmodus gelten je Quelle: der ADF eines Geräts kann
  // deutlich weniger als sein Flachbett. Wurden die Fähigkeiten nie ermittelt,
  // liefert quelleAusCapabilities() den bisherigen Stand (300/600, gray/color).
  const erlaubt = quelleAusCapabilities(caps.geraet, quelleFuerEndpunkt(endpoint));

  const params = new URLSearchParams();
  if (dpi) {
    if (!erlaubt.aufloesungen.includes(Number(dpi))) {
      res.status(400).json({ error: `dpi muss einer von ${erlaubt.aufloesungen.join(', ')} sein` });
      return false;
    }
    params.set('dpi', String(Number(dpi)));
  }
  if (mode) {
    if (!erlaubt.modi.includes(mode)) {
      res.status(400).json({ error: `mode muss einer von ${erlaubt.modi.join(', ')} sein` });
      return false;
    }
    params.set('mode', mode);
  }
  if (size) {
    if (!ALLOWED_SIZE.has(size)) { res.status(400).json({ error: 'size muss a3, a4, a5 oder a6 sein' }); return false; }
    if (String(size).toLowerCase() === 'a3' && !caps.supportsA3) {
      res.status(400).json({
        error: 'A3 ist laut Scanner-Einstellungen deaktiviert. Aktiviere die Option unter Einstellungen > Scanner, falls vorhanden.',
      });
      return false;
    }
    params.set('size', size);
  }

  const qs = params.toString();
  const url = `${SCANNER_URL}/scan/${endpoint}${qs ? '?' + qs : ''}`;

  // Scans können bis ~90s dauern (Flachbett) oder länger (ADF mit vielen Seiten).
  // Wir warten bis zu 300s — danach bleibt der Scanner intern weiter tätig.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 300_000);

  let response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      res.status(504).json({ error: 'Scanner-Timeout nach 5 Minuten' });
      return false;
    }
    appLog('ERROR', 'import', `Scanner nicht erreichbar: ${err.message}`);
    res.status(502).json({ error: `Scanner nicht erreichbar: ${err.message}` });
    return false;
  } finally {
    clearTimeout(timeout);
  }

  const bodyText = await response.text();
  let data;
  try { data = JSON.parse(bodyText); } catch { data = { raw: bodyText }; }

  if (!response.ok) {
    res.status(response.status).json(data);
    return false;
  }

  appLog('INFO', 'import', `Scanner-Aufruf ${endpoint} erfolgreich`, {
    details: JSON.stringify({ endpoint, dpi, mode, size, result: data }).slice(0, 500),
  });

  // Vom Scanner vergebener Dateiname — dient als Korrelationsschlüssel für den
  // Benutzer-Hinweis (siehe hinweis-registry.js). Der Cleaner sendet exakt diesen
  // Namen als X-Filename an die Webhooks. Die ADF-Batch-Endpunkte liefern statt
  // eines einzelnen Dateinamens ein `files`-Array (ein Dokument pro Blatt).
  req._scannedFile = (data && typeof data.file === 'string') ? data.file : null;
  req._scannedFiles = (data && Array.isArray(data.files)) ? data.files : null;

  res.json(data);
  return true;
}

// Endpunkte, die ein vollständiges Dokument erzeugen und die KI-Pipeline auslösen.
// Nur für diese ist ein Benutzer-Hinweis sinnvoll.
const PIPELINE_SCAN_ENDPOINTS = new Set([
  'adf/simplex', 'adf/duplex', 'adf/batch/simplex', 'adf/batch/duplex',
  'flatbed/single', 'flatbed/session/finish',
]);

router.post('/scan', async (req, res) => {
  const { endpoint, hinweis } = req.body || {};
  const userHinweis = typeof hinweis === 'string' ? hinweis.trim().slice(0, 1000) || undefined : undefined;
  try {
    const ok = await proxyScannerCall(req, res);
    if (ok && userHinweis && PIPELINE_SCAN_ENDPOINTS.has(endpoint)) {
      // An den/die Scanner-Dateinamen koppeln — verhindert Überkreuzung bei
      // mehreren Scans. Ein ADF-Batch liefert mehrere Dateien; derselbe vom
      // Nutzer eingegebene Hinweis gilt dann für jedes der Dokumente.
      const targets = req._scannedFiles || (req._scannedFile ? [req._scannedFile] : []);
      for (const f of targets) setPendingHinweis(f, userHinweis);
    }
  } catch (err) {
    console.error('POST /api/import/scan error:', err);
    appLog('ERROR', 'import', `Scanner-Proxy-Fehler: ${err.message}`);
    if (!res.headersSent) res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// POST /api/import/scan-replace — Scan auslösen, dessen Ergebnis das PDF eines
// existierenden Postbuch-Eintrags ersetzt. Setzt VOR dem Scanner-Aufruf einen
// "Pending Replace"-Marker, der später vom /webhooks/scan-registered konsumiert
// wird, sodass der scan-complete-Webhook das fertige PDF in `replacePdf()`
// statt in die normale Pipeline routet.
const POSTID_RE = /^P\d{6}$/;
router.post('/scan-replace', async (req, res) => {
  const { postid } = req.body || {};
  if (!postid || !POSTID_RE.test(postid)) {
    return res.status(400).json({ error: 'Ungültige oder fehlende PostID' });
  }
  setPendingReplace(postid);
  appLog('INFO', 'import', `Scanner-Replace vorbereitet für ${postid}`,
    { entity: 'postbuch', entityId: postid });

  try {
    const ok = await proxyScannerCall(req, res);
    if (!ok) {
      // Bei Validierungs- oder Scanner-Fehlern Reservierung wieder freigeben,
      // damit der nächste Scan nicht versehentlich als Replace verarbeitet wird.
      clearPendingReplace();
    }
  } catch (err) {
    clearPendingReplace();
    console.error('POST /api/import/scan-replace error:', err);
    appLog('ERROR', 'import', `Scanner-Replace-Proxy-Fehler: ${err.message}`,
      { entity: 'postbuch', entityId: postid });
    if (!res.headersSent) res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// ── Upload: einzelne Datei (Batch-Modus) ─────────────────────────────────────

function sanitizeFilename(name) {
  const base = (name || `upload_${Date.now()}.pdf`).replace(/\s+/g, '_').replace(/[^a-zA-Z0-9._\-]/g, '_');
  return base.endsWith('.pdf') || base.endsWith('.PDF') ? base : base + '.pdf';
}

router.post('/upload', async (req, res) => {
  try {
    const { filename, dataB64, hinweis, batchSize } = req.body || {};
    const userHinweis = typeof hinweis === 'string' ? hinweis.trim().slice(0, 1000) || undefined : undefined;
    const batchCount = Number.isFinite(Number(batchSize)) ? Math.max(1, Math.trunc(Number(batchSize))) : 1;
    let pdfBuffer;
    try {
      pdfBuffer = decodeBase64Pdf(dataB64);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    const safeName = sanitizeFilename(filename);

    // Job anlegen und sofort Pipeline starten (Upload → OneDrive-Inbox → Rest)
    const jobId = tracker.create('doc-process', safeName, 10);

    appLog('INFO', 'import', `Upload empfangen: ${safeName} (${(pdfBuffer.length / 1024).toFixed(1)} KB)`);

    enqueueDocument({ pdfBuffer, filename: safeName, ...(userHinweis ? { userHinweis } : {}) }, jobId, 0, {
      batchSize: batchCount,  // Mehrfach-Upload meldet die Gesamtanzahl → Auto-Cache ab Datei 1
      onError: (err) => {
        console.error(`[import] Upload-Verarbeitung fehlgeschlagen für ${safeName}: ${err.message}`);
        appLog('ERROR', 'import', `Upload-Verarbeitung fehlgeschlagen: ${safeName}: ${err.message}`);
      },
    });

    res.json({ jobId, filename: safeName, message: 'Verarbeitung gestartet' });
  } catch (err) {
    console.error('POST /api/import/upload error:', err);
    appLog('ERROR', 'import', `Upload-Fehler: ${err.message}`);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// ── Upload: mehrere Dateien mergen (Sammlung) ────────────────────────────────

router.post('/upload-merged', async (req, res) => {
  try {
    const { filename, files, hinweis } = req.body || {};
    const userHinweis = typeof hinweis === 'string' ? hinweis.trim().slice(0, 1000) || undefined : undefined;
    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: 'files (Array) fehlt oder ist leer' });
    }
    if (files.length > 50) {
      return res.status(400).json({ error: 'Maximal 50 Dateien pro Merge erlaubt' });
    }

    const buffers = [];
    for (const f of files) {
      try {
        buffers.push(decodeBase64Pdf(f?.dataB64));
      } catch (err) {
        return res.status(400).json({ error: `Datei "${f?.name || '?'}": ${err.message}` });
      }
    }

    const merged = await mergePdfs(buffers);
    const safeName = sanitizeFilename(filename || `merged_${Date.now()}.pdf`);

    const jobId = tracker.create('doc-process', safeName, 10);

    appLog('INFO', 'import', `Merge & Upload empfangen: ${safeName} aus ${files.length} Datei(en), ${(merged.length / 1024).toFixed(1)} KB`);

    enqueueDocument({ pdfBuffer: merged, filename: safeName, ...(userHinweis ? { userHinweis } : {}) }, jobId, 0, {
      onError: (err) => {
        console.error(`[import] Merge-Verarbeitung fehlgeschlagen für ${safeName}: ${err.message}`);
        appLog('ERROR', 'import', `Merge-Verarbeitung fehlgeschlagen: ${safeName}: ${err.message}`);
      },
    });

    res.json({ jobId, filename: safeName, mergedCount: files.length, message: 'Merge + Verarbeitung gestartet' });
  } catch (err) {
    console.error('POST /api/import/upload-merged error:', err);
    appLog('ERROR', 'import', `Merge-Fehler: ${err.message}`);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// ── Dokumentenübergabe-Import (ohne KI-Neuverarbeitung) ──────────────────────
// Zweistufig, weil die Personen im Paket vor dem Import zugeordnet werden:
//
//   POST   /api/import/archiv/vorpruefung      (nur admin)
//     Body: rohes ZIP als application/octet-stream, direkt vom Client gestreamt
//           (kein Base64/JSON — bei mehreren hundert MB bis wenigen GB sonst
//           unnötiger RAM- und CPU-Aufwand für Kodierung/Dekodierung).
//     Antwort: 202 { jobId, token }. Der Job prüft das Paket und liefert im
//     payload alle vorkommenden Personennamen samt Zuordnungsvorschlag.
//   POST   /api/import/archiv/:token/start     (nur admin)
//     Body: { conflictMode: 'skip'|'createNew', personenZuordnung: { quellname: kurzname|null } }
//     Antwort: 202 { jobId } — Fortschritt/Ergebnis über GET /api/jobs/:jobId.
//   DELETE /api/import/archiv/:token           (nur admin) — vorbereitete Übergabe verwerfen, { ok: true }
//
// Abrechnungsperioden, Akten, Wiedervorlagen und andere Kontexttabellen werden
// bewusst nicht importiert. Bestehende Dokumente dürfen nicht überschrieben werden.
const VALID_CONFLICT_MODES = new Set(['skip', 'createNew']);
const MAX_ARCHIVE_ZIP_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB, gepackt
// Sicherheitsabstand für die Tempdatei: /tmp liegt im selben Dateisystem wie
// die Postgres-Daten (kein eigenes Docker-Volume) — ein Upload darf die
// Datenbank nicht durch volllaufende Platte gefährden. Benötigt wird die
// angekündigte Uploadgröße plus diese Reserve; ohne Content-Length die
// Höchstgröße. Node liest nie mehr Body-Bytes als angekündigt.
const ARCHIVE_RESERVE_BYTES = 1 * 1024 * 1024 * 1024;
// Solange eine vorbereitete Übergabe auf die Zuordnung wartet, belegt ihre
// Tempdatei Platz — nach dieser Frist wird sie verworfen.
const ARCHIV_BEREIT_TTL_MS = 30 * 60 * 1000;

// Höchstens eine Übergabe gleichzeitig, ob vorbereitet oder laufend: mehrere
// wartende ZIPs mit bis zu 2 GB im selben Dateisystem wie Postgres würden den
// Plattenwächter aushebeln. Der Slot gehört der Admin-Sitzung, die hochgeladen hat.
//   { token, phase: 'upload'|'pruefung'|'bereit'|'import', tmpPath, sessionId, personen: string[], timer }
let archivSlot = null;

function gibArchivSlotFrei(slot) {
  clearTimeout(slot.timer);
  if (archivSlot === slot) archivSlot = null;
  unlink(slot.tmpPath).catch(() => {});
}

function eigenerSlot(req) {
  const slot = archivSlot;
  if (!slot || slot.token !== req.params.token || slot.sessionId !== req.sessionID) return null;
  return slot;
}

/** Freie Bytes unter /tmp, null wenn statfs nicht verfügbar ist. */
async function freierPlatz() {
  try {
    const s = await statfs('/tmp');
    return s.bavail * s.bsize;
  } catch {
    return null; // statfs auf dieser Plattform nicht verfügbar → nicht blockieren
  }
}

function formatGiB(bytes) {
  return `${(bytes / 1024 ** 3).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} GiB`;
}

// Räumt beim App-Start liegen gebliebene Tempdateien eines abgebrochenen
// Imports auf (z. B. nach einem Absturz mitten im Upload/Import).
export async function raeumeArchivImportTempAuf() {
  try {
    const files = await readdir('/tmp');
    for (const name of files) {
      if (!name.startsWith('archiv-import-')) continue;
      const path = `/tmp/${name}`;
      try {
        const info = await stat(path);
        if (Date.now() - info.mtimeMs > 60 * 60 * 1000) {
          await unlink(path);
          appLog('INFO', 'import', `Verwaiste Archiv-Import-Tempdatei entfernt: ${name}`);
        }
      } catch { /* Datei zwischenzeitlich verschwunden — kein Problem */ }
    }
  } catch { /* /tmp nicht lesbar — kein Problem */ }
}

// Der frühere einstufige Import hätte die Personenzuordnung umgangen. Ein noch
// geöffnetes, veraltetes Frontend bekommt deshalb einen klaren Hinweis.
router.post('/archiv', requireAdmin, (req, res) => {
  req.resume();
  res.status(409).json({ error: 'Die Dokumentenübergabe hat einen neuen Ablauf mit Personenzuordnung. Bitte die Seite neu laden.' });
});

router.post('/archiv/vorpruefung', requireAdmin, async (req, res) => {
  if (archivSlot?.phase === 'bereit' && archivSlot.sessionId === req.sessionID) {
    // Eigene, noch wartende Übergabe wird durch den neuen Upload ersetzt.
    gibArchivSlotFrei(archivSlot);
  }
  if (archivSlot) {
    return res.status(409).json({
      error: archivSlot.phase === 'bereit'
        ? 'Eine andere vorbereitete Dokumentenübergabe wartet auf ihre Personenzuordnung. Bitte warten, bis sie abgeschlossen oder verworfen ist.'
        : 'Es läuft bereits eine Dokumentenübergabe. Bitte warten, bis sie abgeschlossen ist.',
    });
  }
  const contentLength = Number(req.get('Content-Length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_ARCHIVE_ZIP_BYTES) {
    return res.status(413).json({ error: 'ZIP-Archiv ist zu groß (maximal 2 GB).' });
  }
  const uploadBytes = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : MAX_ARCHIVE_ZIP_BYTES;
  const benoetigt = uploadBytes + ARCHIVE_RESERVE_BYTES;
  const frei = await freierPlatz();
  if (frei !== null && frei < benoetigt) {
    return res.status(507).json({
      error: `Nicht genügend freier Speicherplatz für den Archiv-Import: benötigt ${formatGiB(benoetigt)} `
        + `(Upload plus ${formatGiB(ARCHIVE_RESERVE_BYTES)} Reserve), frei ${formatGiB(frei)}.`,
    });
  }
  if (archivSlot) {
    return res.status(409).json({ error: 'Es läuft bereits eine Dokumentenübergabe. Bitte warten, bis sie abgeschlossen ist.' });
  }

  const slot = {
    token: randomUUID(),
    phase: 'upload',
    tmpPath: `/tmp/archiv-import-${randomUUID()}.zip`,
    sessionId: req.sessionID,
    personen: [],
    timer: null,
  };
  archivSlot = slot;
  const tmpPath = slot.tmpPath;
  let receivedBytes = 0;
  let failed = false;

  const respondError = (status, message) => {
    failed = true;
    if (!res.headersSent) res.status(status).json({ error: message });
  };

  const out = createWriteStream(tmpPath);

  // Content-Length ist nur eine Absichtserklärung des Clients — die reale
  // Begrenzung läuft über die tatsächlich empfangenen Bytes.
  req.on('data', (chunk) => {
    receivedBytes += chunk.length;
    if (receivedBytes > MAX_ARCHIVE_ZIP_BYTES && !failed) {
      respondError(413, 'ZIP-Archiv ist zu groß (maximal 2 GB).');
      req.unpipe(out);
      out.destroy();
      req.destroy();
    }
  });
  req.on('aborted', () => { failed = true; out.destroy(); });
  out.on('error', (err) => {
    console.error('[import] Fehler beim Schreiben der Archiv-Tempdatei:', err.message);
    respondError(500, 'Fehler beim Empfang der Datei');
  });
  req.pipe(out);

  out.on('close', async () => {
    if (failed) return gibArchivSlotFrei(slot);
    try {
      if (!receivedBytes) {
        gibArchivSlotFrei(slot);
        return respondError(400, 'Leere ZIP-Datei');
      }
      // ZIP-Signatur prüfen (PK\x03\x04 / leeres Archiv PK\x05\x06)
      const fh = await open(tmpPath, 'r');
      const head = Buffer.alloc(2);
      await fh.read(head, 0, 2, 0);
      await fh.close();
      if (!(head[0] === 0x50 && head[1] === 0x4b)) {
        gibArchivSlotFrei(slot);
        return respondError(400, 'Datei ist kein gültiges ZIP-Archiv');
      }

      const mb = (receivedBytes / 1024 / 1024).toFixed(1);
      const jobId = tracker.create('archiv-vorpruefung', `Dokumentenübergabe prüfen (${mb} MB)`, 1);
      slot.phase = 'pruefung';
      appLog('INFO', 'import', `Dokumentenübergabe hochgeladen (${mb} MB), Vorprüfung gestartet`);
      res.status(202).json({ jobId, token: slot.token });

      pruefeArchiv(tmpPath, { jobId })
        .then(async (ergebnis) => {
          const menschen = (await query(`SELECT kurzname, anzeigename FROM postbuch.mensch`)).rows;
          const personen = ergebnis.personen.map((p) => {
            const legende = ergebnis.legende.get(p.name) ?? null;
            return {
              ...p,
              legende: legende ? { anzeigename: legende.anzeigename, istTier: legende.istTier } : null,
              vorschlag: schlageZuordnungVor(p.name, legende, menschen),
            };
          });
          if (archivSlot !== slot) return; // zwischenzeitlich verworfen
          slot.personen = personen.map((p) => p.name);
          slot.phase = 'bereit';
          slot.timer = setTimeout(() => {
            if (archivSlot === slot && slot.phase === 'bereit') {
              appLog('INFO', 'import', 'Vorbereitete Dokumentenübergabe ohne Start verworfen (Frist abgelaufen)');
              gibArchivSlotFrei(slot);
            }
          }, ARCHIV_BEREIT_TTL_MS);
          slot.timer.unref?.();
          tracker.complete(jobId, {
            total: ergebnis.total,
            fehlerhaft: ergebnis.fehlerhaft,
            personen,
            gueltigBis: new Date(Date.now() + ARCHIV_BEREIT_TTL_MS).toISOString(),
          });
        })
        .catch((err) => {
          appLog('WARN', 'import', `Vorprüfung der Dokumentenübergabe fehlgeschlagen: ${err.message}`);
          tracker.fail(jobId, err.message || 'Interner Serverfehler');
          gibArchivSlotFrei(slot);
        });
    } catch (err) {
      gibArchivSlotFrei(slot);
      respondError(500, 'Interner Serverfehler');
    }
  });
});

router.post('/archiv/:token/start', requireAdmin, async (req, res) => {
  const slot = eigenerSlot(req);
  if (!slot) {
    return res.status(404).json({ error: 'Die vorbereitete Übergabe ist nicht mehr vorhanden (Frist abgelaufen oder verworfen). Bitte die Datei erneut hochladen.' });
  }
  if (slot.phase !== 'bereit') {
    return res.status(409).json({ error: 'Diese Übergabe wird bereits verarbeitet.' });
  }
  const conflictMode = req.body?.conflictMode || 'skip';
  if (!VALID_CONFLICT_MODES.has(conflictMode)) {
    return res.status(400).json({ error: `Ungültiger conflictMode. Erlaubt: ${[...VALID_CONFLICT_MODES].join(', ')}` });
  }
  const zuordnung = req.body?.personenZuordnung;
  if (!zuordnung || typeof zuordnung !== 'object' || Array.isArray(zuordnung)) {
    return res.status(400).json({ error: 'Personenzuordnung fehlt.' });
  }
  const offen = slot.personen.filter((n) => !Object.hasOwn(zuordnung, n));
  if (offen.length) {
    return res.status(400).json({ error: `Für diese Personen fehlt noch eine Entscheidung: ${offen.join(', ')}` });
  }
  const personenZuordnung = {};
  for (const name of slot.personen) {
    const ziel = zuordnung[name];
    if (ziel !== null && (typeof ziel !== 'string' || !ziel)) {
      return res.status(400).json({ error: `Ungültige Zuordnung für ${name}.` });
    }
    personenZuordnung[name] = ziel;
  }
  const ziele = [...new Set(Object.values(personenZuordnung).filter(Boolean))];
  const vorhanden = new Set((await query(
    `SELECT kurzname FROM postbuch.mensch WHERE kurzname = ANY($1)`, [ziele],
  )).rows.map((r) => r.kurzname));
  const unbekannt = ziele.filter((z) => !vorhanden.has(z));
  if (unbekannt.length) {
    return res.status(400).json({ error: `Diese Zielpersonen gibt es nicht (mehr): ${unbekannt.join(', ')}` });
  }
  // Nach dem await erneut prüfen und synchron umschalten — ein Doppelklick
  // darf dieselbe Übergabe nicht zweimal starten.
  if (archivSlot !== slot || slot.phase !== 'bereit') {
    return res.status(409).json({ error: 'Diese Übergabe wird bereits verarbeitet.' });
  }
  slot.phase = 'import';
  clearTimeout(slot.timer);

  const jobId = tracker.create('archiv-import', 'Dokumentenübergabe importieren', 1);
  appLog('INFO', 'import', `Archiv-Import gestartet (Modus: ${conflictMode}, ${slot.personen.length} Personennamen zugeordnet)`);
  res.status(202).json({ jobId });

  // Ab hier läuft der eigentliche Import im Hintergrund weiter — die
  // HTTP-Antwort ist bereits raus, Fortschritt/Ergebnis laufen über den Job.
  importArchive(slot.tmpPath, { conflictMode, personenZuordnung, jobId })
    .then((report) => tracker.complete(jobId, report))
    .catch((err) => {
      console.error('[import] Archiv-Import fehlgeschlagen:', err);
      appLog('ERROR', 'import', `Archiv-Import-Fehler: ${err.message}`);
      tracker.fail(jobId, err.message || 'Interner Serverfehler');
    })
    .finally(() => gibArchivSlotFrei(slot));
});

router.delete('/archiv/:token', requireAdmin, (req, res) => {
  const slot = eigenerSlot(req);
  if (!slot) return res.json({ ok: true });
  if (slot.phase !== 'bereit') {
    return res.status(409).json({ error: 'Diese Übergabe wird gerade verarbeitet und kann nicht mehr verworfen werden.' });
  }
  gibArchivSlotFrei(slot);
  appLog('INFO', 'import', 'Vorbereitete Dokumentenübergabe verworfen');
  res.json({ ok: true });
});

export default router;
