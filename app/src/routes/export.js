/**
 * routes/export.js — Dokumentenexport
 *
 * POST /api/export
 * Body: {
 *   format:  'pdf-merged' | 'zip' | 'excel' | 'zip-archiv',
 *   postids: string[],          // P000000-IDs der zu exportierenden Dokumente
 *   akteid?: string,            // optional: A000000 — aktiviert Akte-Deckblatt
 * }
 *
 * Rückgabe: binärer Download mit passendem Content-Type und Content-Disposition.
 *
 * Hinweise:
 *  - PDF/ZIP: Deckblatt aus pdfkit, PDFs via retrieveDocument (Cache + Ablage).
 *             Bei diesen Darstellungs-Exporten werden fehlende PDFs weiterhin
 *             toleriert; die Dokumentenübergabe bricht bei Unvollständigkeit ab.
 *  - Excel:   Spalten wie in PostbuchTable + OneDrive-Link; kein PDF-Abruf nötig.
 *  - ZIP:     Windows-kompatibel (archiver nutzt UTF-8, ab Win10 vollständig unterstützt).
 *  - Dokumentenübergabe: PDF plus dokumenteigene Fachdaten, ohne Instanzkontext.
 */

import { Router }   from 'express';
import archiver     from 'archiver';
import ExcelJS      from 'exceljs';
import PDFDocument  from 'pdfkit';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';
import { createWriteStream, createReadStream } from 'fs';
import { unlink, writeFile } from 'fs/promises';
import { query }    from '../db.js';
import { retrieveDocument } from '../service/document-retriever.js';
import { mergePdfs, countPdfPages, addPdfLinkAnnotations } from '../lib/pdf.js';
import { generateCoverPage } from '../lib/cover-page.js';
import { appLog }            from '../app-log.js';
import { loadDynamicSettings } from '../config.js';
import { buildDocJson, buildManifest } from '../service/archive-exporter.js';

const router = Router();

// ── Async-Job-Store ────────────────────────────────────────────────────────────
// jobId → { status, step, total, filePath, filename, contentType, error }
const jobs = new Map();

function createJob({ total, filename, contentType }) {
  const jobId = randomUUID();
  jobs.set(jobId, { status: 'running', step: 0, total, filePath: null, filename, contentType, error: null });
  setTimeout(() => {
    const job = jobs.get(jobId);
    if (job?.filePath) unlink(job.filePath).catch(() => {});
    jobs.delete(jobId);
  }, 10 * 60 * 1000);
  return jobId;
}

// GET /api/export/progress/:jobId — SSE-Fortschritt
router.get('/progress/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job nicht gefunden' });

  res.set({
    'Content-Type':     'text/event-stream',
    'Cache-Control':    'no-cache',
    'Connection':       'keep-alive',
    'X-Accel-Buffering':'no',
  });
  res.flushHeaders();

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  const tick = () => {
    const j = jobs.get(req.params.jobId);
    if (!j) { send({ status: 'error', error: 'Job nicht gefunden' }); clearInterval(iv); res.end(); return; }
    send({ status: j.status, step: j.step, total: j.total, error: j.error });
    if (j.status === 'done' || j.status === 'error') { clearInterval(iv); res.end(); }
  };

  const iv = setInterval(tick, 150);
  tick();
  req.on('close', () => clearInterval(iv));
});

// GET /api/export/download/:jobId — fertigen Export ausliefern
router.get('/download/:jobId', async (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);
  if (!job || job.status !== 'done') return res.status(404).json({ error: 'Export nicht bereit' });

  res.set({
    'Content-Type':        job.contentType,
    'Content-Disposition': `attachment; filename="${job.filename}"`,
    'Cache-Control':       'no-store',
  });

  const stream = createReadStream(job.filePath);
  stream.pipe(res);
  const cleanup = () => { unlink(job.filePath).catch(() => {}); jobs.delete(jobId); };
  stream.on('end', cleanup);
  stream.on('error', cleanup);
});

const __dir_export = dirname(fileURLToPath(import.meta.url));
const LOGO_PNG_PATH_PREVIEW = join(__dir_export, '../assets/postbuch-logo.png');

// ── Cover-Layout-Tuner: POST /api/export/cover-preview ───────────────────────
// Generates a sample cover page with overridden logo/instanceName positioning.
// Body: { logoX, logoY, logoW, instX, instY, instFontSize, instanceName }
//
// Three independent layers:
//   1 (back)   — Logo PNG at (logoX, logoY)       — purely decorative, never affects layout
//   2 (middle) — Instance name at (instX, instY)  — purely decorative, never affects layout
//   3 (front)  — Main content (title, meta, table) — uses FIXED constants identical to cover-page.js
router.post('/cover-preview', async (req, res) => {
  try {
    const settings = await loadDynamicSettings();
    const instanceName = String(req.body.instanceName ?? settings.instance_name ?? '');

    // ── Fixed layout constants — identical to cover-page.js ─────────────────
    const FONT        = 'Helvetica';
    const FONT_BOLD   = 'Helvetica-Bold';
    const A4_W        = 595.28;
    const A4_H        = 841.89;
    const MARGIN      = 50;
    const CW          = A4_W - MARGIN * 2;          // 495.28 pt
    const BRAND_W     = 155;
    const TITLE_W     = CW - BRAND_W - 12; // 328.28 pt — CONSTANT, never changes
    const HEADER_ADV  = 34;               // fixed — logo is decorative, never shifts main content
    const NUM_W       = 22;
    const TABLE_COLS  = [
      { label: '#',           w: NUM_W                        },
      { label: 'Briefdatum',  w: 66                           },
      { label: 'Dokumentart', w: 105                          },
      { label: 'Absender',    w: 120                          },
      { label: 'Betreff',     w: CW - NUM_W - 66 - 105 - 120 },
    ];

    // ── Tunable overlay params (cosmetic only — do NOT touch TITLE_W / HEADER_ADV) ──
    const logoW  = Number(req.body.logoW   ?? 250);
    const logoH  = Math.round(logoW * 351 / 779);
    const logoX  = Number(req.body.logoX   ?? 345);
    const logoY  = Number(req.body.logoY   ?? 1);
    const instX  = Number(req.body.instX   ?? 300);
    const instY  = Number(req.body.instY   ?? 68);
    const instFs = Number(req.body.instFontSize ?? 8);

    const buf = await new Promise((resolve, reject) => {
      const doc    = new PDFDocument({ margin: 0, size: 'A4', autoFirstPage: true });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end',  () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // ── Layer 1 (back): Logo PNG ─────────────────────────────────────────
      doc.image(LOGO_PNG_PATH_PREVIEW, logoX, logoY, { width: logoW, height: logoH });

      // ── Layer 2 (middle): Instance name ──────────────────────────────────
      if (instanceName) {
        doc.font(FONT).fontSize(instFs).fillColor('#888888')
           .text(instanceName, instX, instY,
                 { width: A4_W - instX - MARGIN, align: 'right', lineBreak: false });
      }

      // ── Layer 3 (front): Main content — fixed layout, identical to cover-page.js ──
      let y = MARGIN;

      doc.font(FONT_BOLD).fontSize(20).fillColor('#111111')
         .text('Exportübersicht', MARGIN, y, { width: TITLE_W });
      y += HEADER_ADV;

      const now = new Date();
      const fmt = (d) => d.toLocaleString('de-DE', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin',
      });
      doc.font(FONT).fontSize(9).fillColor('#666666')
         .text(`Exportiert am: ${fmt(now)}    |    Anzahl Dokumente: 5`, MARGIN, y, { width: CW });
      y += 18;

      doc.moveTo(MARGIN, y).lineTo(MARGIN + CW, y).lineWidth(0.5).strokeColor('#cccccc').stroke();
      y += 16;

      doc.font(FONT_BOLD).fontSize(13).fillColor('#1a1a2e')
         .text('Dokumentenübersicht', MARGIN, y, { width: CW });
      y += 20;

      // Table header
      const HDR_H = 18;
      doc.rect(MARGIN, y, CW, HDR_H).fill('#1a1a2e');
      let hx = MARGIN;
      for (const col of TABLE_COLS) {
        doc.font(FONT_BOLD).fontSize(7.5).fillColor('#ffffff')
           .text(col.label, hx + 4, y + 5, { width: col.w - 8, lineBreak: false });
        hx += col.w;
      }
      doc.fillColor('#000000');
      y += HDR_H;

      // Sample rows
      const sampleDocs = [
        { num: '1', date: '01.03.2026', art: 'Rechnung',    absender: 'AOK Bayern',             betreff: 'Erstattungsbescheid Q1 2026' },
        { num: '2', date: '15.03.2026', art: 'Bescheid',    absender: 'Beihilfestelle',          betreff: 'Beihilfebescheid März 2026' },
        { num: '3', date: '22.03.2026', art: 'Rechnung',    absender: 'Dr. Müller',              betreff: 'Arztrechnung Behandlung 12.03.2026' },
        { num: '4', date: '28.03.2026', art: 'Sonstiges',   absender: 'Krankenhaus Musterstadt', betreff: 'Entlassungsbrief stationärer Aufenthalt' },
        { num: '5', date: '02.04.2026', art: 'Rechnung',    absender: 'Apotheke Central',        betreff: 'Rezeptabrechnung April 2026' },
      ];
      for (let i = 0; i < sampleDocs.length; i++) {
        const d    = sampleDocs[i];
        const vals = [d.num, d.date, d.art, d.absender, d.betreff];
        let maxH   = 12;
        for (let j = 0; j < TABLE_COLS.length; j++) {
          const h = doc.font(FONT).fontSize(7.5).heightOfString(vals[j], { width: TABLE_COLS[j].w - 8 });
          if (h > maxH) maxH = h;
        }
        const rowH = maxH + 8;
        doc.rect(MARGIN, y, CW, rowH).fill(i % 2 === 0 ? '#f5f5f5' : '#ffffff');
        let rx = MARGIN;
        for (let j = 0; j < TABLE_COLS.length; j++) {
          doc.font(FONT).fontSize(7.5).fillColor('#111111')
             .text(vals[j], rx + 4, y + 4, { width: TABLE_COLS[j].w - 8 });
          rx += TABLE_COLS[j].w;
        }
        y += rowH;
      }

      doc.end();
    });

    res.set({
      'Content-Type':        'application/pdf',
      'Content-Disposition': 'inline; filename="cover-preview.pdf"',
      'Content-Length':      buf.length,
      'Cache-Control':       'no-store',
    });
    res.send(buf);
  } catch (err) {
    console.error('[cover-preview]', err);
    res.status(500).json({ error: err.message });
  }
});

const MAX_MERGE    = 50;
const POSTID_RE    = /^P\d{6}$/;
const AKTEID_RE    = /^A\d{6}$/;
const VALID_FMTS   = ['pdf-merged', 'zip', 'excel', 'zip-archiv'];

function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return String(d);
  return dt.toLocaleDateString('de-DE', {
    day:   '2-digit',
    month: '2-digit',
    year:  'numeric',
    timeZone: 'Europe/Berlin',
  });
}

/** Erstellt einen sicheren Dateinamen aus freiem Text. */
function safeName(s, maxLen = 80) {
  return (s || '').replace(/[/\\?%*:|"<>\r\n\t]/g, '_').trim().slice(0, maxLen);
}

/** Erzeugt eine laufende Nummer mit führenden Nullen basierend auf Gesamtanzahl. */
function seqNum(i, total) {
  return String(i).padStart(String(total).length, '0');
}

// POST /api/export
router.post('/', async (req, res) => {
  try {
    const { format, postids, akteid, useJobFlow = false } = req.body;

    // ── Validation ─────────────────────────────────────────────────────────────
    if (!VALID_FMTS.includes(format)) {
      return res.status(400).json({ error: `Ungültiges Format. Erlaubt: ${VALID_FMTS.join(', ')}` });
    }
    if (!Array.isArray(postids) || postids.length === 0) {
      return res.status(400).json({ error: 'postids muss ein nicht-leeres Array sein' });
    }
    if (format === 'pdf-merged' && postids.length > MAX_MERGE) {
      return res.status(400).json({ error: `Beim PDF-Zusammenführen sind maximal ${MAX_MERGE} Dokumente erlaubt` });
    }
    if (!postids.every(id => typeof id === 'string' && POSTID_RE.test(id))) {
      return res.status(400).json({ error: 'Ungültige PostID im Array' });
    }
    if (akteid && !AKTEID_RE.test(akteid)) {
      return res.status(400).json({ error: 'Ungültige AkteID' });
    }

    // ── Fetch document metadata ────────────────────────────────────────────────
    const docsResult = await query(
      `SELECT p.postid,
              p.briefdatum,
              p.dokumentart           AS art,
              p.kontakt,
              p.betreff,
              p.status::text          AS status,
              p.link,
              COALESCE(
                a.gesamtbetrag,
                h.gesamtbetrag,
                g.gesamtbetrag,
                e.erstattungsbetrag
              )                       AS betrag
         FROM postbuch.postbuch p
         LEFT JOIN postbuch.arztrechnung      a ON a.postid = p.postid
         LEFT JOIN postbuch.handwerkerrechnung h ON h.postid = p.postid
         LEFT JOIN postbuch.generische_rechnung g ON g.postid = p.postid
         LEFT JOIN postbuch.erstattungsbescheid e ON e.postid = p.postid
        WHERE p.postid = ANY($1::text[])`,
      [postids],
    );

    // Preserve the original postids order
    const docMap = Object.fromEntries(docsResult.rows.map(r => [r.postid, r]));
    const docs   = postids.map(id => docMap[id]).filter(Boolean);

    if (format === 'zip-archiv') {
      if (new Set(postids).size !== postids.length) {
        return res.status(400).json({ error: 'Doppelte PostIDs sind in einer Dokumentenübergabe nicht erlaubt' });
      }
      if (docs.length !== postids.length) {
        return res.status(404).json({ error: 'Mindestens ein angefordertes Dokument existiert nicht' });
      }
    }

    // ── Fetch akte metadata (optional) ────────────────────────────────────────
    let akte = null;
    if (akteid) {
      const akteResult = await query(
        `SELECT akteid, betreff, beschreibung, schlagwoerter, created_at, updated_at, notiz
           FROM postbuch.akte WHERE akteid = $1`,
        [akteid],
      );
      akte = akteResult.rows[0] ?? null;
    }

    const exportedAt = new Date();

    // ──────────────────────────────────────────────────────────────────────────
    // FORMAT: Excel
    // ──────────────────────────────────────────────────────────────────────────
    if (format === 'excel') {
      const wb = new ExcelJS.Workbook();
      wb.creator  = 'Postbuch';
      wb.created  = exportedAt;

      // Akte-Metadaten-Tabellenblatt
      if (akte) {
        const akteSheet = wb.addWorksheet('Aktendetails');
        akteSheet.getColumn(1).width = 18;
        akteSheet.getColumn(2).width = 55;
        const metaRows = [
          ['Akten-ID',      akte.akteid],
          ['Betreff',       akte.betreff || ''],
          ['Beschreibung',  akte.beschreibung || ''],
          ['Schlagwörter',  (akte.schlagwoerter || []).join(', ')],
          ['Angelegt',      fmtDate(akte.created_at)],
          ['Aktualisiert',  fmtDate(akte.updated_at)],
          ['Notiz',         akte.notiz || ''],
        ];
        for (const [label, value] of metaRows) {
          const row = akteSheet.addRow([label, value]);
          row.getCell(1).font = { bold: true };
        }
      }

      // Dokumente-Tabellenblatt
      const sheet = wb.addWorksheet('Dokumente');
      sheet.columns = [
        { header: 'Nr.',          key: 'nr',           width: 6  },
        { header: 'ID',           key: 'postid',       width: 10 },
        { header: 'Briefdatum',   key: 'briefdatum',   width: 14 },
        { header: 'Dokumentart',  key: 'art',          width: 22 },
        { header: 'Kontakt',      key: 'kontakt',      width: 30 },
        { header: 'Betreff',      key: 'betreff',      width: 48 },
        { header: 'Betrag',       key: 'betrag',       width: 13 },
        { header: 'Status',       key: 'status',       width: 20 },
        { header: 'OneDrive-Link',key: 'link',         width: 55 },
      ];

      // Header style
      const headerRow = sheet.getRow(1);
      headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A1A2E' } };
      headerRow.alignment = { vertical: 'middle' };

      for (let i = 0; i < docs.length; i++) {
        const d = docs[i];
        const row = sheet.addRow({
          nr:         i + 1,
          postid:    d.postid,
          briefdatum: d.briefdatum ? fmtDate(d.briefdatum) : '',
          art:        d.art        || '',
          kontakt:    d.kontakt || '',
          betreff:    d.betreff    || '',
          betrag:     d.betrag != null ? Number(d.betrag) : null,
          status:     d.status     || '',
          link:       d.link       || '',
        });

        // Betreff fett
        row.getCell('betreff').font = { bold: true };

        // Betrag: Zahlenformat
        if (d.betrag != null) {
          row.getCell('betrag').numFmt = '#,##0.00 "€"';
        }

        // Link: klickbar machen
        if (d.link) {
          row.getCell('link').value = { text: d.link, hyperlink: d.link };
          row.getCell('link').font  = { color: { argb: 'FF0563C1' }, underline: true };
        }
      }

      // Autofilter
      sheet.autoFilter = { from: 'A1', to: { row: 1, column: sheet.columns.length } };

      const filename = akte
        ? `Akte_${akte.akteid}_Dokumente.xlsx`
        : `Dokumentenexport_${exportedAt.toISOString().slice(0, 10)}.xlsx`;

      res.set({
        'Content-Type':        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control':       'no-store',
      });

      const buf = await wb.xlsx.writeBuffer();
      appLog('INFO', 'export', `Excel-Export: ${docs.length} Dokumente, Format=${format}`, { entity: akteid ? 'akte' : 'postbuch', entityId: akteid || null });
      return res.send(buf);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // FORMAT: pdf-merged / zip  →  beide brauchen Cover + PDFs
    // ──────────────────────────────────────────────────────────────────────────
    const settings     = await loadDynamicSettings();
    const instanceName = String(settings.instance_name ?? '');

    // ── Async-Job-Flow (Fortschrittsbalken) ───────────────────────────────────
    if ((useJobFlow || format === 'zip-archiv') && (format === 'pdf-merged' || format === 'zip' || format === 'zip-archiv')) {
      const isZip      = format === 'zip';
      const isArchiv   = format === 'zip-archiv';
      const filename   = isArchiv
        ? `Dokumentenuebergabe_${exportedAt.toISOString().slice(0, 10)}.zip`
        : akte
          ? `Akte_${akte.akteid}${isZip ? '.zip' : '.pdf'}`
          : `Dokumentenexport_${exportedAt.toISOString().slice(0, 10)}${isZip ? '.zip' : '.pdf'}`;
      const contentType = (isZip || isArchiv) ? 'application/zip' : 'application/pdf';

      const jobId  = createJob({ total: docs.length, filename, contentType });
      const runner = isArchiv ? runZipArchivJob : isZip ? runZipJob : runMergeJob;
      runner(jobId, { docs, akte, exportedAt, instanceName }).catch(err => {
        const job = jobs.get(jobId);
        if (job) { job.status = 'error'; job.error = err.message; }
        console.error(`[export] Job ${jobId} fehlgeschlagen:`, err);
      });

      appLog('INFO', 'export', `Async-Export gestartet: ${format}, ${docs.length} Dokumente`, { entity: akteid ? 'akte' : 'postbuch', entityId: akteid || null });
      return res.json({ jobId });
    }

    if (format === 'pdf-merged') {
      // ── 1. Alle Dokument-PDFs vorab laden + Seitenzahl ermitteln ───────────
      const fetchedDocs = [];
      for (const d of docs) {
        try {
          const { pdf } = await retrieveDocument(d.postid);
          const pageCount = await countPdfPages(pdf);
          fetchedDocs.push({ doc: d, pdf, pageCount });
        } catch (err) {
          console.warn(`[export] PDF für ${d.postid} nicht verfügbar: ${err.message}`);
          fetchedDocs.push({ doc: d, pdf: null, pageCount: 0 });
        }
      }

      // ── 2. Deckblatt erzeugen (mit Zeilen-Bounding-Boxes) ─────────────────
      const { pdf: rawCover, rowBBoxes } = await generateCoverPage({ docs, akte, exportedAt, instanceName });

      // ── 3. PDFs zusammenführen ────────────────────────────────────────────
      const pdfBuffers = [rawCover, ...fetchedDocs.filter(f => f.pdf).map(f => f.pdf)];
      const merged = await mergePdfs(pdfBuffers);

      // ── 4. Sprungmarken-Annotationen im Deckblatt einfügen ────────────────
      // Startseiten berechnen: nach dem Deckblatt folgen die Dokument-PDFs
      // in der Reihenfolge der fetchedDocs (nur die, für die ein PDF existiert).
      const coverPageCount = await countPdfPages(rawCover);
      let runningPage = coverPageCount; // 0-basierter Index der ersten Seite nach Deckblatt
      const annotations = fetchedDocs.map((fd, i) => {
        if (!fd.pdf) return null;
        const bbox = rowBBoxes[i];
        const ann = {
          pageIndex: bbox.pageIndex,
          x: bbox.x, y: bbox.y, w: bbox.w, h: bbox.h,
          action: { type: 'GoTo', pageIndex: runningPage },
        };
        runningPage += fd.pageCount;
        return ann;
      });

      const mergedWithLinks = await addPdfLinkAnnotations(merged, annotations);

      const filename = akte
        ? `Akte_${akte.akteid}.pdf`
        : `Dokumentenexport_${exportedAt.toISOString().slice(0, 10)}.pdf`;

      res.set({
        'Content-Type':        'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length':      mergedWithLinks.length,
        'Cache-Control':       'no-store',
      });

      appLog('INFO', 'export', `PDF-Merge-Export: ${docs.length} Dokumente`, { entity: akteid ? 'akte' : 'postbuch', entityId: akteid || null });
      return res.send(mergedWithLinks);
    }

    if (format === 'zip') {
      // ── 1. Dateinamen vorab berechnen (ohne PDFs zu laden) ────────────────
      const docFilenames = docs.map((d, i) => {
        const num = seqNum(i + 1, docs.length);
        const betreff = safeName(d.betreff, 150);
        return akte
          ? `${akte.akteid}_${num} ${d.postid}${betreff ? ' ' + betreff : ''}.pdf`
          : `${num} ${d.postid}${betreff ? ' ' + betreff : ''}.pdf`;
      });

      // ── 2. Deckblatt erzeugen (mit Zeilen-Bounding-Boxes) ─────────────────
      const { pdf: rawCover, rowBBoxes } = await generateCoverPage({ docs, akte, exportedAt, instanceName });

      // ── 3. Relative URI-Links ins Deckblatt einfügen ──────────────────────
      // Link-Ziel: relativer Dateiname (URI-kodiert) – nach dem Entpacken der
      // ZIP liegen alle Dateien im selben Verzeichnis neben dem Deckblatt.
      const annotations = docs.map((d, i) => {
        const bbox = rowBBoxes[i];
        return {
          pageIndex: bbox.pageIndex,
          x: bbox.x, y: bbox.y, w: bbox.w, h: bbox.h,
          action: { type: 'URI', uri: encodeURI(docFilenames[i]) },
        };
      });
      const coverPdf = await addPdfLinkAnnotations(rawCover, annotations);

      // ── 4. ZIP streamen – PDFs einzeln laden und sofort in den Stream schreiben ──
      // Niemals alle PDFs gleichzeitig im RAM: jeder Buffer wird nach archive.append()
      // freigegeben, bevor das nächste Dokument geladen wird.
      const zipFilename = akte
        ? `Akte_${akte.akteid}.zip`
        : `Dokumentenexport_${exportedAt.toISOString().slice(0, 10)}.zip`;

      res.set({
        'Content-Type':        'application/zip',
        'Content-Disposition': `attachment; filename="${zipFilename}"`,
        'Cache-Control':       'no-store',
      });

      const archive = archiver('zip', { zlib: { level: 1 } });
      archive.pipe(res);

      const coverFilename = akte ? 'Übersicht.pdf' : 'Deckblatt.pdf';
      archive.append(coverPdf, { name: coverFilename });

      for (let i = 0; i < docs.length; i++) {
        try {
          const { pdf } = await retrieveDocument(docs[i].postid);
          archive.append(pdf, { name: docFilenames[i] });
        } catch (err) {
          console.warn(`[export] PDF für ${docs[i].postid} nicht verfügbar: ${err.message}`);
        }
      }

      await archive.finalize();
      appLog('INFO', 'export', `ZIP-Export: ${docs.length} Dokumente`, { entity: akteid ? 'akte' : 'postbuch', entityId: akteid || null });
      return;
    }

    if (format === 'zip-archiv') {
      res.set({
        'Content-Type':        'application/zip',
        'Content-Disposition': `attachment; filename="Dokumentenuebergabe_${exportedAt.toISOString().slice(0, 10)}.zip"`,
        'Cache-Control':       'no-store',
      });
      const archive = archiver('zip', { zlib: { level: 1 } });
      archive.pipe(res);
      await appendArchive(archive, docs, { instanceName, exportedAt });
      await archive.finalize();
      appLog('INFO', 'export', `Archiv-Export: ${docs.length} Dokumente`, { entity: 'postbuch', entityId: null });
      return;
    }

    res.status(400).json({ error: 'Unbekanntes Format' });
  } catch (err) {
    console.error('[export] POST /api/export Fehler:', err);
    appLog('ERROR', 'export', `Export fehlgeschlagen: ${err.message}`);
    // Only send error if headers not yet sent (zip streams can't be "undone")
    if (!res.headersSent) {
      res.status(500).json({ error: 'Interner Serverfehler beim Export' });
    }
  }
});

// ── Async-Job-Verarbeitung ─────────────────────────────────────────────────────

async function runZipJob(jobId, { docs, akte, exportedAt, instanceName }) {
  const job = jobs.get(jobId);

  const docFilenames = docs.map((d, i) => {
    const num = seqNum(i + 1, docs.length);
    const betreff = safeName(d.betreff, 150);
    return akte
      ? `${akte.akteid}_${num} ${d.postid}${betreff ? ' ' + betreff : ''}.pdf`
      : `${num} ${d.postid}${betreff ? ' ' + betreff : ''}.pdf`;
  });

  const { pdf: rawCover, rowBBoxes } = await generateCoverPage({ docs, akte, exportedAt, instanceName });
  const annotations = docs.map((d, i) => {
    const bbox = rowBBoxes[i];
    return { pageIndex: bbox.pageIndex, x: bbox.x, y: bbox.y, w: bbox.w, h: bbox.h,
             action: { type: 'URI', uri: encodeURI(docFilenames[i]) } };
  });
  const coverPdf = await addPdfLinkAnnotations(rawCover, annotations);

  const tmpPath = `/tmp/export-${jobId}.zip`;
  const output  = createWriteStream(tmpPath);
  const archive = archiver('zip', { zlib: { level: 1 } });
  archive.pipe(output);
  archive.append(coverPdf, { name: akte ? 'Übersicht.pdf' : 'Deckblatt.pdf' });

  for (let i = 0; i < docs.length; i++) {
    try {
      const { pdf } = await retrieveDocument(docs[i].postid);
      archive.append(pdf, { name: docFilenames[i] });
    } catch (err) {
      console.warn(`[export] PDF für ${docs[i].postid} nicht verfügbar: ${err.message}`);
    }
    job.step = i + 1;
  }

  await new Promise((resolve, reject) => {
    output.on('close', resolve);
    archive.on('error', reject);
    archive.finalize();
  });

  job.filePath = tmpPath;
  job.status   = 'done';
}

// ── Dokumentenübergabe (re-importierbares Dokumentenpaket) ───────────────────
// Hängt manifest.json + je Dokument eine gleichnamige .pdf und .json an das Archiv.
// Der gemeinsame Basisname (num postid betreff) paart PDF und JSON beim Re-Import.
async function appendArchive(archive, docs, { instanceName, exportedAt, onStep }) {
  // Erst alle Dokumente prüfen, dann manifest.json schreiben. Ein aktuelles
  // Übergabepaket darf nicht mit einer still verkürzten Dokumentmenge beginnen.
  // Die PDFs werden dabei nicht gesammelt, damit große Übergaben nicht unnötig
  // den Arbeitsspeicher belasten; beim eigentlichen Schreiben wird jeder Fehler
  // weiterhin hart abgebrochen und die temporäre ZIP verworfen.
  for (const d of docs) {
    try {
      const { pdf } = await retrieveDocument(d.postid);
      if (!pdf) throw new Error('keine abrufbare PDF');
      const docJson = await buildDocJson(d.postid);
      if (!docJson) throw new Error('nicht mehr vorhanden');
    } catch (err) {
      throw new Error(`Dokument ${d.postid} konnte nicht vollständig exportiert werden: ${err.message}`);
    }
  }

  const postids = docs.map(d => d.postid);
  const manifest = await buildManifest(postids, { instanceName, exportedAt });
  archive.append(Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), { name: 'manifest.json' });

  for (let i = 0; i < docs.length; i++) {
    const d = docs[i];
    const num = seqNum(i + 1, docs.length);
    const betreff = safeName(d.betreff, 120);
    const base = `${num} ${d.postid}${betreff ? ' ' + betreff : ''}`;
    let pdf;
    let docJson;
    try {
      ({ pdf } = await retrieveDocument(d.postid));
      docJson = await buildDocJson(d.postid);
      if (!pdf || !docJson) throw new Error('PDF oder Fachdaten sind nicht mehr vollständig verfügbar');
    } catch (err) {
      throw new Error(`Dokument ${d.postid} konnte nicht vollständig exportiert werden: ${err.message}`);
    }
    archive.append(Buffer.from(JSON.stringify(docJson, null, 2), 'utf8'), { name: `${base}.json` });
    archive.append(pdf, { name: `${base}.pdf` });
    onStep?.(i + 1);
  }
}

async function runZipArchivJob(jobId, { docs, exportedAt, instanceName }) {
  const job = jobs.get(jobId);
  const tmpPath = `/tmp/export-${jobId}.zip`;
  const output  = createWriteStream(tmpPath);
  const archive = archiver('zip', { zlib: { level: 1 } });
  archive.pipe(output);
  try {
    await appendArchive(archive, docs, { instanceName, exportedAt, onStep: (s) => { job.step = s; } });

    await new Promise((resolve, reject) => {
      output.on('close', resolve);
      archive.on('error', reject);
      archive.finalize();
    });

    job.filePath = tmpPath;
    job.status   = 'done';
  } catch (err) {
    archive.abort();
    output.destroy();
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}

async function runMergeJob(jobId, { docs, akte, exportedAt, instanceName }) {
  const job = jobs.get(jobId);
  const fetchedDocs = [];

  for (const d of docs) {
    try {
      const { pdf } = await retrieveDocument(d.postid);
      const pageCount = await countPdfPages(pdf);
      fetchedDocs.push({ doc: d, pdf, pageCount });
    } catch (err) {
      console.warn(`[export] PDF für ${d.postid} nicht verfügbar: ${err.message}`);
      fetchedDocs.push({ doc: d, pdf: null, pageCount: 0 });
    }
    job.step = fetchedDocs.length;
  }

  const { pdf: rawCover, rowBBoxes } = await generateCoverPage({ docs, akte, exportedAt, instanceName });
  const pdfBuffers = [rawCover, ...fetchedDocs.filter(f => f.pdf).map(f => f.pdf)];
  const merged = await mergePdfs(pdfBuffers);

  const coverPageCount = await countPdfPages(rawCover);
  let runningPage = coverPageCount;
  const annotations = fetchedDocs.map((fd, i) => {
    if (!fd.pdf) return null;
    const bbox = rowBBoxes[i];
    const ann  = { pageIndex: bbox.pageIndex, x: bbox.x, y: bbox.y, w: bbox.w, h: bbox.h,
                   action: { type: 'GoTo', pageIndex: runningPage } };
    runningPage += fd.pageCount;
    return ann;
  });

  const mergedWithLinks = await addPdfLinkAnnotations(merged, annotations);
  const tmpPath = `/tmp/export-${jobId}.pdf`;
  await writeFile(tmpPath, mergedWithLinks);

  job.filePath = tmpPath;
  job.status   = 'done';
}

export default router;
