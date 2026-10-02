/**
 * lib/cover-page.js — PDF-Deckblatt mit pdfkit
 *
 * Erzeugt ein Deckblatt für Dokumentenexporte.
 * Struktur:
 *   1. Titel + Export-Metadaten
 *   2. (bei Akten-Export) Aktendetails-Tabelle
 *   3. Dokumentenübersicht: Briefdatum | Dokumentart | Kontakt | Betreff
 */

import PDFDocument from 'pdfkit';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

const __dirname_local = dirname(fileURLToPath(import.meta.url));
const LOGO_PNG_PATH   = join(__dirname_local, '../assets/postbuch-logo-6x.png');
// Logo PNG native size: 1557×702px
// Tuned values — logo is a purely decorative background layer; changing these
// NEVER shifts the main content layout (title/meta/table).
const LOGO_IMG_W  = 250;                                 // display width in PDF points
const LOGO_IMG_H  = Math.round(LOGO_IMG_W * 351 / 779); // ≈113 pt (proportional)
const LOGO_IMG_X  = 345;   // absolute X — logo bleeds into right margin area intentionally
const LOGO_IMG_Y  = 1;     // absolute Y — logo bleeds into top margin area intentionally
const INST_FONT_SIZE = 8;  // instance name font size
const INST_Y      = 68;    // absolute Y for instance name
// Fixed header advance — CONSTANT, never depends on logo size.
const HEADER_ADV  = 34;

const FONT      = 'Helvetica';
const FONT_BOLD = 'Helvetica-Bold';
const A4_W      = 595.28;
const A4_H      = 841.89;
const MARGIN    = 50;
const CW        = A4_W - MARGIN * 2; // 495.28 pt — usable width

// Column widths for the document summary table (must sum to CW)
const NUM_W = 22; // laufende Nummer
const TABLE_COLS = [
  { label: '#',           w: NUM_W,                           bold: false },
  { label: 'Briefdatum',  w: 66,                              bold: false },
  { label: 'Dokumentart', w: 105,                             bold: false },
  { label: 'Kontakt',     w: 120,                             bold: false },
  { label: 'Betreff',     w: CW - NUM_W - 66 - 105 - 120,    bold: true  }, // ~182
];

// Width of the right-side brand block
const BRAND_W = 155;
const TITLE_W = CW - BRAND_W - 12; // space for brand, with gap

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtDate(d) {
  if (!d) return '–';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return String(d);
  return dt.toLocaleDateString('de-DE', {
    day:   '2-digit',
    month: '2-digit',
    year:  'numeric',
    timeZone: 'Europe/Berlin',
  });
}

function fmtDateTime(d) {
  if (!d) return '–';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return String(d);
  return dt.toLocaleString('de-DE', {
    day:    '2-digit',
    month:  '2-digit',
    year:   'numeric',
    hour:   '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Berlin',
  });
}

/**
 * Zeichnet den Tabellenkopf für die Dokumentübersicht.
 * Gibt die neue Y-Position zurück.
 */
function drawTableHeader(doc, y) {
  const HDR_H = 18;
  doc.rect(MARGIN, y, CW, HDR_H).fill('#1a1a2e');
  let x = MARGIN;
  for (const col of TABLE_COLS) {
    doc
      .font(FONT_BOLD)
      .fontSize(7.5)
      .fillColor('#ffffff')
      .text(col.label, x + 4, y + 5, { width: col.w - 8, lineBreak: false });
    x += col.w;
  }
  doc.fillColor('#000000');
  return y + HDR_H;
}

// ── Main export ────────────────────────────────────────────────────────────────

/**
 * Zeichnet den Marken-Header (PNG-Logo + Instanzname) rechtsbündig.
 * Gibt die tatsächlich verbrauchte Höhe zurück.
 */
function drawBrand(doc, instanceName) {
  // Logo at absolute position — may intentionally bleed over margins
  doc.image(LOGO_PNG_PATH, LOGO_IMG_X, LOGO_IMG_Y, { width: LOGO_IMG_W, height: LOGO_IMG_H });

  if (instanceName) {
    doc.font(FONT).fontSize(INST_FONT_SIZE).fillColor('#888888')
       .text(instanceName, MARGIN + CW - BRAND_W, INST_Y,
             { width: BRAND_W, align: 'right', lineBreak: false });
  }
  doc.fillColor('#000000');
}

/**
 * Erzeugt ein Deckblatt-PDF.
 *
 * @param {object}   opts
 * @param {Array}    opts.docs         - Dokument-Metadaten: [{ postid, briefdatum, art, kontakt, betreff }]
 * @param {object}   [opts.akte]       - Akte-Metadaten (betreff, beschreibung, schlagwoerter, created_at, updated_at, notiz)
 * @param {Date}     [opts.exportedAt]
 * @param {string}   [opts.instanceName]
 * @returns {Promise<{ pdf: Buffer, rowBBoxes: Array<{pageIndex:number, x:number, y:number, w:number, h:number}> }>}
 *   rowBBoxes[i] entspricht docs[i]: Bounding-Box der Tabellenzeile im Deckblatt-PDF
 *   (PDFKit-Koordinaten: Ursprung oben-links, Y wächst nach unten).
 */
export async function generateCoverPage({ docs, akte = null, exportedAt = new Date(), instanceName = '' }) {
  return new Promise((resolve, reject) => {
    const pdfDoc = new PDFDocument({ margin: 0, size: 'A4', autoFirstPage: true });
    const chunks = [];
    /** Aktuelle Seitenindex (0-basiert) innerhalb des Deckblatt-PDFs */
    let currentPageIndex = 0;
    /** Bounding-Boxes der Dokumentzeilen – ein Eintrag pro docs[i] */
    const rowBBoxes = [];
    pdfDoc.on('data', c => chunks.push(c));
    pdfDoc.on('end',  () => resolve({ pdf: Buffer.concat(chunks), rowBBoxes }));
    pdfDoc.on('error', reject);

    let y = MARGIN;

    // ── Layer 1+2 (back): Brand — drawn first so main content renders on top ──
    drawBrand(pdfDoc, instanceName);

    // ── Layer 3 (front): Title + Brand ─────────────────────────────────────
    pdfDoc
      .font(FONT_BOLD)
      .fontSize(20)
      .fillColor('#111111')
      .text('Exportübersicht', MARGIN, y, { width: TITLE_W });

    y += HEADER_ADV;

    pdfDoc
      .font(FONT)
      .fontSize(9)
      .fillColor('#666666')
      .text(
        `Exportiert am: ${fmtDateTime(exportedAt)}    |    Anzahl Dokumente: ${docs.length}`,
        MARGIN, y, { width: CW },
      );
    y += 18;

    // Separator
    pdfDoc.moveTo(MARGIN, y).lineTo(MARGIN + CW, y).lineWidth(0.5).strokeColor('#cccccc').stroke();
    y += 16;

    // ── Akte section ───────────────────────────────────────────────────────────
    if (akte) {
      pdfDoc.font(FONT_BOLD).fontSize(13).fillColor('#1a1a2e').text('Akte', MARGIN, y, { width: CW });
      y += 22;

      const LABEL_W = 90;
      const VAL_W   = CW - LABEL_W - 12;

      const metaRows = [
        ['Akten-ID',     akte.akteid],
        ['Betreff',      akte.betreff || '–'],
        akte.beschreibung                  ? ['Beschreibung', akte.beschreibung]                      : null,
        (akte.schlagwoerter?.length > 0)   ? ['Schlagwörter', akte.schlagwoerter.join(', ')] : null,
        ['Angelegt',     fmtDate(akte.created_at)],
        ['Aktualisiert', fmtDate(akte.updated_at)],
        akte.notiz ? ['Notiz', akte.notiz] : null,
      ].filter(Boolean);

      for (const [label, value] of metaRows) {
        const valStr = String(value ?? '–');
        const isBetreff = label === 'Betreff';
        const valFont  = isBetreff ? FONT_BOLD : FONT;
        const labelH = pdfDoc.font(FONT_BOLD).fontSize(8).heightOfString(label, { width: LABEL_W });
        const valH   = pdfDoc.font(valFont).fontSize(9).heightOfString(valStr, { width: VAL_W });
        const rowH   = Math.max(labelH, valH) + 6;

        if (y + rowH > A4_H - MARGIN) {
          pdfDoc.addPage();
          currentPageIndex++;
          y = MARGIN;
        }

        pdfDoc.font(FONT_BOLD).fontSize(8).fillColor('#555555')
              .text(label, MARGIN, y, { width: LABEL_W });
        pdfDoc.font(valFont).fontSize(9).fillColor('#111111')
              .text(valStr, MARGIN + LABEL_W + 12, y, { width: VAL_W });
        y += rowH;
      }

      y += 12;
      pdfDoc.moveTo(MARGIN, y).lineTo(MARGIN + CW, y).lineWidth(0.5).strokeColor('#cccccc').stroke();
      y += 16;
    }

    // ── Document table ─────────────────────────────────────────────────────────
    pdfDoc.font(FONT_BOLD).fontSize(13).fillColor('#1a1a2e')
          .text('Dokumentenübersicht', MARGIN, y, { width: CW });
    y += 20;

    y = drawTableHeader(pdfDoc, y);

    const numDigits = String(docs.length).length;

    for (let i = 0; i < docs.length; i++) {
      const d = docs[i];
      const num = String(i + 1).padStart(numDigits, '0');
      const values = [
        num,
        fmtDate(d.briefdatum),
        d.art        || '–',
        d.kontakt || '–',
        d.betreff    || '–',
      ];

      // Measure row height (use bold font for betreff column)
      let maxH = 12;
      for (let j = 0; j < TABLE_COLS.length; j++) {
        const font = TABLE_COLS[j].bold ? FONT_BOLD : FONT;
        const h = pdfDoc.font(font).fontSize(7.5).heightOfString(values[j], { width: TABLE_COLS[j].w - 8 });
        if (h > maxH) maxH = h;
      }
      const rowH = maxH + 8;

      // Page break + repeat header
      if (y + rowH > A4_H - MARGIN) {
        pdfDoc.addPage();
        currentPageIndex++;
        y = MARGIN;
        y = drawTableHeader(pdfDoc, y);
      }

      // Record bounding box for this row (PDFKit top-left coordinates)
      rowBBoxes.push({ pageIndex: currentPageIndex, x: MARGIN, y, w: CW, h: rowH });

      // Alternating row background
      pdfDoc.rect(MARGIN, y, CW, rowH).fill(i % 2 === 0 ? '#f5f5f5' : '#ffffff');

      // Row content
      let rx = MARGIN;
      for (let j = 0; j < TABLE_COLS.length; j++) {
        const font = TABLE_COLS[j].bold ? FONT_BOLD : FONT;
        pdfDoc.font(font).fontSize(7.5).fillColor('#111111')
              .text(values[j], rx + 4, y + 4, { width: TABLE_COLS[j].w - 8 });
        rx += TABLE_COLS[j].w;
      }
      y += rowH;
    }

    pdfDoc.end();
  });
}
