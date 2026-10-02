/**
 * lib/pkv-beihilfe-vorblatt.js — Vorblatt für die PKV-Prüfung gekürzter
 * Beihilfepositionen (siehe FEATURE_KUERZUNGEN_GESEHEN_PKV_PRUEFUNG_PLAN.md, 7.2)
 *
 * Neutral: kein Absenderfeld, keine Empfängeranschrift, keine Versicherungsnummer.
 * Schlichte Liste mit den Angaben, die eine Position eindeutig identifizieren
 * (Rechnungsdatum + Rechnungsbetrag) bzw. auf die zugehörige Anlage verweisen
 * (Bescheid vom + Bescheidposition), ergänzt um den zur Prüfung gestellten
 * gekürzten Betrag. Kürzungsgrund steht bewusst nicht hier, sondern geht aus
 * der beigefügten Anlage selbst hervor.
 */

import PDFDocument from 'pdfkit';

const FONT      = 'Helvetica';
const FONT_BOLD = 'Helvetica-Bold';
const A4_W = 595.28;
const A4_H = 841.89;
const MARGIN = 50;
const CW = A4_W - MARGIN * 2;

const KOPFTEXT = 'Mit der Bitte um Prüfung, ob für die folgenden von der Beihilfestelle gekürzten bzw. nicht übernommenen '
  + 'Positionen ein ergänzender Erstattungsanspruch bei Ihnen besteht, z. B. im Rahmen des Beihilfeergänzungstarifs, '
  + 'und mit der Bitte um entsprechende Veranlassung:';
const FUSSTEXT = 'Anlagen: Beihilfebescheid(e), betroffene Rechnungen.';

const COLS = [
  { label: 'Rechnungsdatum',    w: 85,  value: (r) => fmtDate(r.rechnungsdatum) },
  { label: 'Rechnungsbetrag',   w: 100, value: (r) => fmtGeld(r.rechnungsbetrag) },
  { label: 'Bescheid vom',      w: 85,  value: (r) => fmtDate(r.bescheiddatum) },
  { label: 'Bescheidposition',  w: 90,  value: (r) => r.bescheidposition ? String(r.bescheidposition) : 'nicht erfasst' },
  { label: 'Gekürzter Betrag',  w: 135, value: (r) => fmtGeld(r.kuerzungsbetrag) },
];

function fmtDate(d) {
  if (!d) return 'nicht erfasst';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return String(d);
  return dt.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Berlin' });
}

function fmtGeld(n) {
  if (n === null || n === undefined) return 'nicht erfasst';
  return Number(n).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

function drawTableHeader(doc, y) {
  const HDR_H = 20;
  doc.rect(MARGIN, y, CW, HDR_H).fill('#1a1a2e');
  let x = MARGIN;
  for (const col of COLS) {
    doc.font(FONT_BOLD).fontSize(8).fillColor('#ffffff')
       .text(col.label, x + 4, y + 6, { width: col.w - 8 });
    x += col.w;
  }
  doc.fillColor('#000000');
  return y + HDR_H;
}

/**
 * Erzeugt das Vorblatt-PDF (Hochformat A4).
 * @param {object} opts
 * @param {Array<{person, rechnungsdatum, rechnungsbetrag, bescheiddatum, bescheidposition, kuerzungsbetrag, erlaeuterung}>} opts.zeilen
 *   `person` wird mitgegeben, aber bewusst nicht als eigene Spalte gerendert.
 * @param {Date}   [opts.erstelltAm]
 * @returns {Promise<Buffer>}
 */
export async function generateVorblatt({ zeilen, erstelltAm = new Date() }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 0, size: [A4_W, A4_H], autoFirstPage: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    let y = MARGIN;

    doc.font(FONT_BOLD).fontSize(14).fillColor('#111111')
       .text('Prüfung eines ergänzenden Erstattungsanspruches', MARGIN, y, { width: CW });
    y += 20;

    doc.font(FONT).fontSize(8).fillColor('#666666')
       .text(`Erstellt am: ${fmtDate(erstelltAm)}`, MARGIN, y, { width: CW });
    y += 16;

    doc.font(FONT).fontSize(9).fillColor('#222222')
       .text(KOPFTEXT, MARGIN, y, { width: CW, align: 'justify' });
    y += doc.heightOfString(KOPFTEXT, { width: CW, align: 'justify' }) + 14;

    doc.moveTo(MARGIN, y).lineTo(MARGIN + CW, y).lineWidth(0.5).strokeColor('#cccccc').stroke();
    y += 10;

    y = drawTableHeader(doc, y);

    const ROW_H = 20;
    zeilen.forEach((row, i) => {
      if (y + ROW_H > A4_H - MARGIN) {
        doc.addPage();
        y = MARGIN;
        y = drawTableHeader(doc, y);
      }

      doc.rect(MARGIN, y, CW, ROW_H).fill(i % 2 === 0 ? '#f5f5f5' : '#ffffff');

      let x = MARGIN;
      for (const col of COLS) {
        doc.font(FONT).fontSize(8).fillColor('#111111')
           .text(String(col.value(row)), x + 4, y + 6, { width: col.w - 8, lineBreak: false, ellipsis: true });
        x += col.w;
      }
      y += ROW_H;
    });

    const erlaeuterungen = zeilen.filter((r) => r.erlaeuterung);
    if (erlaeuterungen.length > 0) {
      y += 14;
      if (y > A4_H - MARGIN - 20) { doc.addPage(); y = MARGIN; }
      for (const row of erlaeuterungen) {
        const bezug = row.bescheidposition ? String(row.bescheidposition) : 'nicht erfasst';
        const text = `zu ${bezug}: ${row.erlaeuterung}`;
        const h = doc.font(FONT).fontSize(8).heightOfString(text, { width: CW });
        if (y + h > A4_H - MARGIN) { doc.addPage(); y = MARGIN; }
        doc.font(FONT).fontSize(8).fillColor('#222222').text(text, MARGIN, y, { width: CW });
        y += h + 4;
      }
    }

    y += 14;
    if (y > A4_H - MARGIN - 20) { doc.addPage(); y = MARGIN; }
    doc.font(FONT).fontSize(8).fillColor('#666666').text(FUSSTEXT, MARGIN, y, { width: CW });

    doc.end();
  });
}
