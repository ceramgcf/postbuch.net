/**
 * lib/dokument-pin-vorblatt.js — Vorblatt für angepinnte Dokumente: beliebige
 * Unterlagen, die zusätzlich zur regulären Einreichung ganz hinten ins
 * Abrechnungspaket gehängt werden (siehe service/dokument-pin.js).
 *
 * Wie beim PKV-Prüfblock steht auf dem Vorblatt keine Absender-/Empfänger-
 * anschrift und keine Versicherungsnummer — nur die Zuordnung (Person,
 * Dokument, Grund).
 */

import PDFDocument from 'pdfkit';

const FONT      = 'Helvetica';
const FONT_BOLD = 'Helvetica-Bold';
const A4_W = 595.28;
const A4_H = 841.89;
const MARGIN = 50;
const CW = A4_W - MARGIN * 2;

const TITEL = 'Beigefügte Unterlagen zur Kenntnisnahme';
const KOPFTEXT = 'Die folgenden Unterlagen werden zusätzlich beigefügt, ohne Teil der regulären '
  + 'Einreichung zu sein:';

function fmtDate(d) {
  if (!d) return 'nicht erfasst';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return String(d);
  return dt.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Berlin' });
}

/**
 * Erzeugt das Vorblatt-PDF (Hochformat A4) für den Pin-Block.
 * @param {object} opts
 * @param {Array<{person, betreff, briefdatum, grund}>} opts.zeilen
 * @param {Date} [opts.erstelltAm]
 * @returns {Promise<Buffer>}
 */
export async function generatePinVorblatt({ zeilen, erstelltAm = new Date() }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 0, size: [A4_W, A4_H], autoFirstPage: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    let y = MARGIN;

    doc.font(FONT_BOLD).fontSize(14).fillColor('#111111')
       .text(TITEL, MARGIN, y, { width: CW });
    y += 20;

    doc.font(FONT).fontSize(8).fillColor('#666666')
       .text(`Erstellt am: ${fmtDate(erstelltAm)}`, MARGIN, y, { width: CW });
    y += 16;

    doc.font(FONT).fontSize(9).fillColor('#222222')
       .text(KOPFTEXT, MARGIN, y, { width: CW, align: 'justify' });
    y += doc.heightOfString(KOPFTEXT, { width: CW, align: 'justify' }) + 14;

    doc.moveTo(MARGIN, y).lineTo(MARGIN + CW, y).lineWidth(0.5).strokeColor('#cccccc').stroke();
    y += 14;

    for (const row of zeilen) {
      const kopf = `${row.person} – ${row.betreff || 'ohne Betreff'} (${fmtDate(row.briefdatum)})`;
      const kopfH = doc.font(FONT_BOLD).fontSize(9).heightOfString(kopf, { width: CW });
      const grundText = `Grund: ${row.grund}`;
      const grundH = doc.font(FONT).fontSize(9).heightOfString(grundText, { width: CW });

      if (y + kopfH + grundH + 12 > A4_H - MARGIN) { doc.addPage(); y = MARGIN; }

      doc.font(FONT_BOLD).fontSize(9).fillColor('#111111').text(kopf, MARGIN, y, { width: CW });
      y += kopfH + 2;
      doc.font(FONT).fontSize(9).fillColor('#333333').text(grundText, MARGIN, y, { width: CW });
      y += grundH + 12;
    }

    doc.end();
  });
}
