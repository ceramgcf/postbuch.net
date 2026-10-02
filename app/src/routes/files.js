import { Router } from 'express';
import { query } from '../db.js';
import { uiLog } from '../log.js';
import { appLog } from '../app-log.js';
import { retrieveDocument, getFetchProgress } from '../service/document-retriever.js';
import { rotatePdf } from '../lib/pdf.js';
import { getAdapter } from '../lib/storage/index.js';
import * as suspensionStore from '../service/suspension-store.js';

const router = Router();

const POSTID_RE = /^P\d{6}$/;
// Grobfilter für Ablage-IDs, bevor sie überhaupt in eine Abfrage gehen.
// Weder '/' noch '%' noch '\' sind zulässig — genau die Zeichen, mit denen sich
// eine Backend-URL sonst umbiegen ließe.
//
// Die Untergrenze ist 1 und nicht mehr 5: Nextcloud-Fileids sind kurze
// Dezimalzahlen ("8341"). Das ist KEINE Aufweichung — die verbindliche Prüfung
// läuft jetzt nach dem Suspension-Lookup mit adapter.isValidId() und damit mit
// der Regel DES BACKENDS DER ZEILE. Für OneDrive gilt dort unverändert die
// alte, strengere Form; netto ist die Route strenger als vorher.
const STORAGE_ID_RE = /^[A-Za-z0-9!$@._~+=-]{1,300}$/;

// Erzeugt den Anzeige-/Download-Dateinamen:
//   "JJJJ-MM-TT PostID Betreff.pdf"   (Betreff auf 120 Zeichen begrenzt).
function buildPdfFilename(postid, briefdatum, betreff) {
  let datePart = '';
  if (briefdatum instanceof Date && !isNaN(briefdatum)) {
    const y = briefdatum.getFullYear();
    const m = String(briefdatum.getMonth() + 1).padStart(2, '0');
    const d = String(briefdatum.getDate()).padStart(2, '0');
    datePart = `${y}-${m}-${d}`;
  } else if (typeof briefdatum === 'string' && briefdatum) {
    datePart = briefdatum.split('T')[0];
  }
  // Zeichen, die in Dateinamen unter Windows/macOS/Linux problematisch sind, entfernen
  // eslint-disable-next-line no-control-regex
  const subject = (betreff || '')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  const parts = [datePart, postid, subject].filter(Boolean);
  return `${parts.join(' ')}.pdf`;
}

// Setzt Content-Disposition mit RFC-5987-Encoding, damit Umlaute & Co.
// in allen Browsern korrekt angezeigt werden.
function setInlineFilename(res, filename) {
  const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '');
  const utf8 = encodeURIComponent(filename);
  res.set(
    'Content-Disposition',
    `inline; filename="${ascii}"; filename*=UTF-8''${utf8}`,
  );
}

// GET /api/files/suspended/:fileId/pdf — Pausiertes Dokument aus der Ablage streamen
//
// Sicherheit: die fileId kommt roh aus der URL und wird im OneDrive-Adapter bewusst
// unenkodiert in die Graph-URL interpoliert. Ohne Objektberechtigung wäre damit
// JEDE Datei des Kontos abrufbar (ein kodiertes '/' plus '..' reicht).
// Deshalb: nur IDs, zu denen eine offene Duplikat-Suspension existiert — die
// liefert zugleich das Backend, aus dem gelesen werden darf.
router.get('/suspended/:fileId/pdf', async (req, res) => {
  try {
    const { fileId } = req.params;
    if (!fileId || !STORAGE_ID_RE.test(fileId) || fileId.includes('..')) {
      return res.status(400).json({ error: 'Ungültige fileId' });
    }

    const suspension = await suspensionStore.findOpenByStorageId(fileId);
    if (!suspension) {
      return res.status(404).json({ error: 'Keine offene Entscheidung zu dieser Datei' });
    }

    // Verbindliche ID-Prüfung mit der Regel des Backends, in dem die Zeile
    // tatsächlich liegt — nicht mit einer für alle Backends gemeinsamen,
    // zwangsläufig laxeren Form.
    // Fail-CLOSED: ein Adapter ohne isValidId bekommt die Datei nicht
    // ausgeliefert. Sonst fiele ein kuenftiges drittes Backend stillschweigend
    // auf den laxen Grobfilter oben zurueck.
    const adapter = getAdapter(suspension.storage_backend);
    if (typeof adapter.isValidId !== 'function') {
      console.error(`[files] Adapter "${suspension.storage_backend}" hat kein isValidId() — Auslieferung verweigert.`);
      return res.status(500).json({ error: 'Interner Serverfehler' });
    }
    if (!adapter.isValidId(fileId)) {
      return res.status(400).json({ error: 'Ungültige fileId' });
    }

    const buffer = await adapter.download(fileId);

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="suspended.pdf"',
      'Content-Length': buffer.length,
      'Cache-Control': 'no-store',
    });

    res.send(buffer);
  } catch (err) {
    console.error('GET /api/files/suspended/:fileId/pdf error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// GET /api/files/:postid/pdf — PDF als application/pdf streamen
router.get('/:postid/pdf', async (req, res) => {
  try {
    const { postid } = req.params;
    if (!POSTID_RE.test(postid)) {
      return res.status(400).json({ error: 'Ungültige PostID' });
    }

    const result = await query(
      `SELECT pf.file, p.briefdatum, p.betreff
         FROM post_files pf
         LEFT JOIN postbuch p ON p.postid = pf.postid
        WHERE pf.postid = $1`,
      [postid]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Keine PDF-Datei gefunden' });
    }

    const { file: pdfBuffer, briefdatum, betreff } = result.rows[0];
    const filename = buildPdfFilename(postid, briefdatum, betreff);

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Length': pdfBuffer.length,
      'Cache-Control': 'no-store',
    });
    setInlineFilename(res, filename);

    res.send(pdfBuffer);
  } catch (err) {
    console.error('GET /api/files/:postid/pdf error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// GET /api/files/:postid/pdf/fetch-progress — Fortschritt eines laufenden/abgeschlossenen
// OneDrive-Downloads (rein im Server-RAM, kein DB-Zugriff). Wird vom Frontend gepollt,
// solange ein Archiv-Fetch läuft — auch von einer anderen Komponenten-Instanz/Tab aus
// gestartet, damit ein erneutes Öffnen des Dokuments den echten Stand zeigt statt neu zu starten.
router.get('/:postid/pdf/fetch-progress', (req, res) => {
  const { postid } = req.params;
  if (!POSTID_RE.test(postid)) {
    return res.status(400).json({ error: 'Ungültige PostID' });
  }
  const progress = getFetchProgress(postid);
  res.json(progress || { status: 'idle', receivedBytes: 0, totalBytes: null });
});

// GET /api/files/:postid/pdf/fetch — holt das Dokument von OneDrive (bei Cache-Miss)
router.get('/:postid/pdf/fetch', async (req, res) => {
  try {
    const { postid } = req.params;
    if (!POSTID_RE.test(postid)) {
      return res.status(400).json({ error: 'Ungültige PostID' });
    }

    await retrieveDocument(postid);

    res.json({ ok: true });
    uiLog('WEBHOOK', 'pdf_fetch', postid, 'PDF von OneDrive geholt');
  } catch (err) {
    console.error('GET /api/files/:postid/pdf/fetch error:', err);
    appLog('ERROR', 'files', `PDF-Fetch fehlgeschlagen für ${req.params.postid}: ${err.message}`, { entity: 'postbuch', entityId: req.params.postid });
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// POST /api/files/:postid/pdf/rotate — dreht das PDF lokal und aktualisiert Cache + OneDrive
router.post('/:postid/pdf/rotate', async (req, res) => {
  try {
    const { postid } = req.params;
    if (!POSTID_RE.test(postid)) {
      return res.status(400).json({ error: 'Ungültige PostID' });
    }

    const winkel = Number(req.body?.winkel);
    if (![90, 180, 270].includes(winkel)) {
      return res.status(400).json({ error: 'Ungültiger Winkel. Erlaubt: 90, 180, 270' });
    }

    // 1. PDF + Ablage-Referenz laden
    const { pdf, storageId, storageBackend } = await retrieveDocument(postid);

    // 2. PDF rotieren (lokal via qpdf)
    const rotated = await rotatePdf(pdf, winkel);

    // 3. In der Ablage überschreiben
    if (storageId) {
      await getAdapter(storageBackend).uploadContent(storageId, rotated);
    }

    // 4. Cache aktualisieren
    const base64 = rotated.toString('base64');
    await query(
      `INSERT INTO post_files (postid, file) VALUES ($1, decode($2, 'base64'))
       ON CONFLICT (postid) DO UPDATE SET file = decode($2, 'base64')`,
      [postid, base64]
    );

    res.json({ ok: true });
    uiLog('UPDATE', 'pdf_rotate', postid, `winkel: ${winkel}°`);
    appLog('INFO', 'files', `PDF rotiert: ${postid} um ${winkel}°`, { entity: 'postbuch', entityId: postid });
  } catch (err) {
    console.error('POST /api/files/:postid/pdf/rotate error:', err);
    appLog('ERROR', 'files', `PDF-Rotation fehlgeschlagen für ${req.params.postid}: ${err.message}`, { entity: 'postbuch', entityId: req.params.postid });
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

export default router;
