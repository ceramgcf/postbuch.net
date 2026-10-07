/**
 * lib/excel.js – gemeinsame Bausteine für die Excel-Exporte der Analyse-Seiten
 *
 * Einheitliches Aussehen: fixierte, dunkle Kopfzeile, Euro-Spalten mit
 * deutschem Zahlenformat, graue Summenzeilen.
 */

import ExcelJS from 'exceljs';

const EURO = '#,##0.00 "€"';

/** ISO-Datum (YYYY-MM-DD…) → TT.MM.JJJJ, leer bei fehlendem Wert. */
export function fmtDatum(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
}

/** NUMERIC-Strings aus PostgreSQL als Zahl; null bleibt leer. */
export function zahl(wert) {
  return wert == null ? null : Number(wert);
}

/** Spalten: { header, key, width, euro? } */
export function neuesBlatt(wb, name, spalten) {
  const sheet = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = spalten;
  const kopf = sheet.getRow(1);
  kopf.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  kopf.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A1A2E' } };
  kopf.alignment = { vertical: 'middle' };
  for (const s of spalten) {
    if (s.euro) sheet.getColumn(s.key).numFmt = EURO;
  }
  return sheet;
}

export function summenZeile(sheet, werte) {
  const row = sheet.addRow(werte);
  row.font = { bold: true };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
  return row;
}

export function neueMappe() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'postbuch.net';
  wb.created = new Date();
  return wb;
}

/** Schickt eine fertige Mappe als Download `<name>_<Datum>.xlsx`. */
export function sendeExcel(res, buf, name) {
  const datum = new Date().toISOString().slice(0, 10);
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${name}_${datum}.xlsx"`,
    'Cache-Control': 'no-store',
  });
  res.send(Buffer.from(buf));
}
