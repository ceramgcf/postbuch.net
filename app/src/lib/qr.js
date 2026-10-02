/**
 * lib/qr.js — lokale QR-Code-Erkennung aus PDF-Seiten
 *
 * Kette: Ghostscript pgmraw @200dpi → PGM (P5) selbst geparst → Bradley-
 * Binarisierung (Integralbild) → @undecaf/zbar-wasm. Kein LLM, kein Upload,
 * kein Fremdaufruf.
 *
 * Bewusst ohne Inhalts-Logging: der QR-Inhalt eines Patientenportal-Links ist
 * faktisch ein Zugangstoken (siehe FEATURE_RECHNUNGSTEILE_UND_QRCODES.md,
 * Abschnitt 4.7) und darf nie in appLog/Konsole landen — nur Anzahl und Typ
 * beim Aufrufer.
 *
 * Soft-Fail ist Pflicht: diese Funktion wirft bei jedem Fehler (Rastern,
 * Parsen, Dekodieren) — der Aufrufer (document-processor.js) MUSS das
 * abfangen, ein Fehler hier darf die Pipeline nie abbrechen.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFile, readFile, mkdir, rm } from 'fs/promises';
import { randomUUID } from 'crypto';
import { PDFDocument } from 'pdf-lib';
import { scanGrayBuffer } from '@undecaf/zbar-wasm';

const execFileAsync = promisify(execFile);

const MAX_SEITEN = 5; // QR-Codes stehen praktisch immer auf den vorderen Seiten
const DPI = 200;       // Untergrenze mit Sicherheitsabstand, siehe Messreihe im Feature-Dokument
const TIMEOUT_MS = 30_000;

// Obergrenze der Rasterfläche in Pixeln. Zwei Gründe, beide hart:
//   1. Korrektheit. Das Integralbild summiert Grauwerte in einem Uint32Array;
//      ab width*height*255 >= 2^32, also ab rund 16,8 Mio. Pixeln, liefe die
//      Summe still über und die Binarisierung wäre lautlos falsch — der
//      QR-Code würde einfach nicht gefunden, ohne dass ein Fehler auffiele.
//   2. Speicher. Auf einem Raspberry Pi kostet jede Million Pixel rund 6 MB
//      (Integralbild 4 Byte/px plus Grau- und Ausgabepuffer).
// Der Wert wird NICHT durch Herunterskalieren der Auflösung eingehalten: 200 dpi
// ist die gemessene Untergrenze für zuverlässige Erkennung, ein 120-dpi-Versuch
// wäre kein Gewinn, sondern eine leise Verschlechterung. Stattdessen deckt das
// Budget alle Formate ab, auf denen QR-Codes real vorkommen — A4 (3,9 Mpx), A3
// (7,7 Mpx) und A2 (15,5 Mpx) rastern unverändert mit voller Auflösung. Erst
// jenseits davon (A1, A0, Planformate) bricht der Scan sauber ab; dort findet
// die heutige Fassung wegen des Überlaufs ohnehin nichts, nur eben lautlos.
// 16 Mio. × 255 = 4,08e9 bleibt exakt unter 2^32 = 4,29e9.
const MAX_PIXEL = 16_000_000;

// Harte Obergrenze der Seitengröße in PDF-Punkten — dieselbe Prüfung wie in
// lib/pdf.js (renderPdfToImages), bewusst kopiert statt importiert: zwei
// unabhängige, für sich triviale Zwei-Zeilen-Checks sind robuster als eine
// gemeinsame Abstraktion über zwei Module hinweg.
const MAX_SEITE_PT = 5000;

// Bradley/Roth adaptive Schwellwertbildung, an einem echten Bescheid mit
// GiroCode empirisch nachgemessen (Feature-Dokument Abschnitt 2 nennt 25px/8% nach
// ImageMagick-Messung; die eigene Integralbild-Implementierung rundet beim
// Fensterrand anders, 8% liegt hier hart an der Kante und findet den grau
// hinterlegten GiroCode nicht zuverlässig). Eine Rastergitter-Messreihe
// (Fenster 11–51px × Toleranz 3–20%) zeigt eine breite stabile Zone ab 12%
// aufwärts, unabhängig von der Fenstergröße — 25px/12% liegt sicher darin.
const WINDOW = 25;
const T_PERCENT = 12;

/**
 * Parst eine binäre PGM-Datei (P5). Wirft bei ungültigem Header.
 * @param {Buffer} buf
 * @returns {{ width: number, height: number, data: Uint8Array }}
 */
function parsePgm(buf) {
  let pos = 0;
  function istWhitespace(b) {
    return b === 0x20 || b === 0x09 || b === 0x0A || b === 0x0D;
  }
  function skipWhitespaceAndComments() {
    for (;;) {
      while (pos < buf.length && istWhitespace(buf[pos])) pos++;
      if (buf[pos] === 0x23 /* # */) {
        while (pos < buf.length && buf[pos] !== 0x0A) pos++;
      } else {
        break;
      }
    }
  }
  function readToken() {
    skipWhitespaceAndComments();
    const start = pos;
    while (pos < buf.length && !istWhitespace(buf[pos]) && buf[pos] !== 0x23) pos++;
    return buf.slice(start, pos).toString('ascii');
  }

  const magic = readToken();
  if (magic !== 'P5') throw new Error(`Kein binäres PGM (Magic "${magic}")`);
  const width = parseInt(readToken(), 10);
  const height = parseInt(readToken(), 10);
  const maxval = parseInt(readToken(), 10);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error('Ungültige PGM-Dimensionen');
  }
  if (maxval !== 255) throw new Error(`Unerwarteter PGM-Maxval ${maxval}`);
  // Genau EIN Whitespace-Byte trennt den Maxval-Token von den Binärdaten (PGM-Spezifikation).
  pos += 1;
  const data = buf.subarray(pos, pos + width * height);
  if (data.length !== width * height) throw new Error('PGM-Datenblock zu kurz');
  return { width, height, data: new Uint8Array(data) };
}

/**
 * Bradley/Roth adaptive Binarisierung über ein Integralbild. Ein Pixel wird
 * schwarz (0), wenn er signifikant dunkler ist als der lokale Mittelwert.
 * @param {Uint8Array} gray
 * @param {number} width
 * @param {number} height
 * @returns {Uint8Array} 0 = schwarz, 255 = weiß, Länge width*height
 */
function binarizeAdaptive(gray, width, height) {
  // Geprüft wird an den tatsächlichen Rastermaßen, nicht an der vorab
  // berechneten Fläche: vermessen wird nur Seite 1, eine spätere Seite
  // kann größer sein. Erst diese Zeile garantiert, dass die Summen
  // unten in den Uint32-Bereich passen.
  if (width * height > MAX_PIXEL) {
    throw new Error(`Rasterbild zu groß zum Binarisieren (${width}×${height} px).`);
  }
  // Integralbild als Uint32Array statt Float64Array: unterhalb von MAX_PIXEL
  // bleibt die Summe sicher unter 2^32, das halbiert aber den Speicherbedarf
  // gegenüber Gleitkomma.
  const integral = new Uint32Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    const rowOff = y * width;
    const intRowOff = (y + 1) * (width + 1);
    const intPrevRowOff = y * (width + 1);
    for (let x = 0; x < width; x++) {
      rowSum += gray[rowOff + x];
      integral[intRowOff + x + 1] = integral[intPrevRowOff + x + 1] + rowSum;
    }
  }

  const half = Math.floor(WINDOW / 2);
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - half);
    const y1 = Math.min(height - 1, y + half);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - half);
      const x1 = Math.min(width - 1, x + half);
      const count = (x1 - x0 + 1) * (y1 - y0 + 1);
      const sum = integral[(y1 + 1) * (width + 1) + (x1 + 1)]
                - integral[y0 * (width + 1) + (x1 + 1)]
                - integral[(y1 + 1) * (width + 1) + x0]
                + integral[y0 * (width + 1) + x0];
      const pixel = gray[y * width + x];
      out[y * width + x] = (pixel * count * 100 <= sum * (100 - T_PERCENT)) ? 0 : 255;
    }
  }
  return out;
}

/**
 * Rendert eine PDF-Seite mit Ghostscript zu einer binären PGM-Bitmap.
 * @param {number} dpi - Rasterauflösung in dpi
 * @returns {Promise<{ width: number, height: number, data: Uint8Array }>}
 */
async function rasterSeiteAlsPgm(pdfPath, seite, dir, dpi) {
  const outputPath = `${dir}/s-${seite}.pgm`;
  await execFileAsync('gs', [
    '-q', '-dNOPAUSE', '-dBATCH', '-dSAFER',
    '-sDEVICE=pgmraw',
    `-r${dpi}`,
    `-dFirstPage=${seite}`, `-dLastPage=${seite}`,
    '-dUseCropBox',
    `-sOutputFile=${outputPath}`,
    pdfPath,
  ], { timeout: TIMEOUT_MS, killSignal: 'SIGKILL' });
  const buf = await readFile(outputPath);
  return parsePgm(buf);
}

/** Deterministische Benennung ohne LLM — siehe Feature-Dokument Abschnitt 4.3. */
function benenne(inhalt) {
  if (inhalt.startsWith('BCD\n') || inhalt.startsWith('BCD\r\n')) {
    return { typ: 'girocode', name: 'GiroCode (Überweisung)' };
  }
  if (/^https?:\/\//i.test(inhalt)) {
    let url;
    try {
      url = new URL(inhalt);
    } catch {
      return { typ: 'url', name: inhalt.slice(0, 60) };
    }
    const haystack = `${url.hostname}${url.pathname}`.toLowerCase();
    if (/patient|arztrechnung|portal/.test(haystack)) {
      return { typ: 'patientenportal', name: 'Patientenportal' };
    }
    return { typ: 'url', name: url.hostname };
  }
  return { typ: 'unbekannt', name: 'Unbekannt' };
}

/**
 * Liest die QR-Codes der ersten Seiten eines PDFs aus.
 * @param {Buffer} pdfBuffer
 * @returns {Promise<Array<{ seite: number, name: string, typ: string, inhalt: string }>>}
 */
export async function scanQrCodes(pdfBuffer) {
  const doc = await PDFDocument.load(pdfBuffer, { updateMetadata: false });
  const seitenGesamt = doc.getPageCount();
  const seitenZuScannen = Math.min(seitenGesamt, MAX_SEITEN);
  if (seitenZuScannen < 1) return [];

  // Nur Seite 1 vermessen — mehrseitige Dokumente sind praktisch immer
  // einheitlich formatiert (dasselbe vereinfachte Muster wie in lib/pdf.js).
  const { width, height } = doc.getPage(0).getCropBox();
  const langeKantePt = Math.max(width, height);
  if (!Number.isFinite(langeKantePt) || langeKantePt <= 0 || width <= 0 || height <= 0) {
    throw new Error('PDF-Seitengröße konnte nicht bestimmt werden.');
  }
  if (langeKantePt > MAX_SEITE_PT) {
    throw new Error(`PDF-Seite ist zu groß zum Rastern (${Math.round(langeKantePt)}pt > ${MAX_SEITE_PT}pt).`);
  }

  // Zweite Grenze neben MAX_SEITE_PT: die Fläche. Die lange Kante allein sagt
  // nichts über den Speicher- und Wertebereichsbedarf des Integralbilds aus.
  // Gerastert wird immer mit voller Auflösung; passt die Seite nicht ins
  // Budget, bricht der Scan ab — der Aufrufer fängt das als Soft-Fail.
  const pixel = Math.ceil((width / 72) * DPI) * Math.ceil((height / 72) * DPI);
  if (pixel > MAX_PIXEL) {
    throw new Error(`PDF-Seite ist zu groß zum Rastern (${Math.round(width)}×${Math.round(height)}pt, ${pixel} px).`);
  }

  const id = randomUUID();
  const dir = `/tmp/qrscan-${id}`;
  const pdfPath = `${dir}/in.pdf`;
  const treffer = [];

  try {
    await mkdir(dir, { recursive: true });
    await writeFile(pdfPath, pdfBuffer);

    // Seriell, nicht parallel: bei drei gleichzeitigen Pipeline-Jobs sonst
    // dreifache Spitzenlast durch gleichzeitiges Rastern+Binarisieren.
    for (let seite = 1; seite <= seitenZuScannen; seite++) {
      const { width: w, height: h, data } = await rasterSeiteAlsPgm(pdfPath, seite, dir, DPI);
      const binar = binarizeAdaptive(data, w, h);
      const symbole = await scanGrayBuffer(binar.buffer, w, h);
      for (const sym of symbole) {
        if (sym.typeName !== 'ZBAR_QRCODE') continue;
        const inhalt = sym.decode();
        const { typ, name } = benenne(inhalt);
        treffer.push({ seite, name, typ, inhalt });
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  return treffer;
}
