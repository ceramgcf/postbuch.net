/**
 * lib/pdf.js — qpdf-Wrapper für PDF-Rotation und -Merge
 *
 * Ersetzt: stack_pdf_helper (webhook-basierter qpdf-Aufruf) sowie
 *          5 Nodes aus dem PDF-Rotieren-Flow und 3 Nodes aus dem Abrechnungsperiode-Flow.
 *
 * qpdf ist bereits im Dockerfile installiert (Session 1).
 * Temporäre Dateien werden in /tmp angelegt und immer bereinigt.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFile, readFile, unlink, mkdir, readdir, rm } from 'fs/promises';
import { randomUUID } from 'crypto';
import { PDFDocument, PDFName, PDFNull, PDFNumber, PDFString, PDFArray, PDFDict, StandardFonts, rgb } from 'pdf-lib';

const execFileAsync = promisify(execFile);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/**
 * Rotiert ein PDF um die angegebene Gradanzahl im Uhrzeigersinn.
 * @param {Buffer} pdfBuffer - Eingabe-PDF als Buffer
 * @param {number} degrees   - Rotation in Grad (0, 90, 180, 270)
 * @returns {Promise<Buffer>} - Rotiertes PDF als Buffer
 */
export async function rotatePdf(pdfBuffer, degrees) {
  if (!degrees || degrees % 360 === 0) return pdfBuffer;

  // qpdf erwartet eine positive Gradzahl für die Rotation;
  // "--rotate=+90" dreht alle Seiten um 90° im Uhrzeigersinn.
  const id = randomUUID();
  const inputPath  = `/tmp/pdfin-${id}.pdf`;
  const outputPath = `/tmp/pdfout-${id}.pdf`;

  try {
    await writeFile(inputPath, pdfBuffer);
    await execFileAsync('qpdf', [`--rotate=+${degrees % 360}`, inputPath, outputPath]);
    return await readFile(outputPath);
  } finally {
    await unlink(inputPath).catch(() => {});
    await unlink(outputPath).catch(() => {});
  }
}

/**
 * Dekodiert einen base64-Datenstring (mit oder ohne data:-Prefix) in einen
 * PDF-Buffer und prüft den PDF-Header. Wirft bei ungültigem Format.
 * @param {string} dataB64
 * @returns {Buffer}
 */
export function decodeBase64Pdf(dataB64) {
  if (!dataB64 || typeof dataB64 !== 'string') {
    throw new Error('dataB64 fehlt oder ist kein String');
  }
  const match = /base64,(.*)$/.exec(dataB64);
  const b64 = (match ? match[1] : dataB64).trim();
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < 10) throw new Error('Leere oder fehlerhafte PDF-Daten');
  if (buf[0] !== 0x25 || buf[1] !== 0x50 || buf[2] !== 0x44 || buf[3] !== 0x46) {
    throw new Error('Datei ist kein gültiges PDF (falscher Header)');
  }
  return buf;
}

/**
 * Entfernt die Textebene aus einem PDF (z. B. den vom Cleaner per Tesseract
 * eingebetteten OCR-Text), ohne Bilder, Seitendrehung, Deskew oder CropBox
 * zu verändern. Verwendet Ghostscript mit `-dFILTERTEXT`.
 *
 * Wird vor dem KI-Aufruf eingesetzt, damit das LLM rein visuell klassifiziert
 * und nicht von einer fehlerhaften OCR-Textebene in die Irre geführt wird.
 *
 * @param {Buffer} pdfBuffer
 * @returns {Promise<Buffer>}
 */
export async function stripTextLayer(pdfBuffer) {
  const id = randomUUID();
  const inputPath  = `/tmp/pdfstripin-${id}.pdf`;
  const outputPath = `/tmp/pdfstripout-${id}.pdf`;

  try {
    await writeFile(inputPath, pdfBuffer);
    await execFileAsync('gs', [
      '-q', '-dNOPAUSE', '-dBATCH', '-dSAFER',
      '-sDEVICE=pdfwrite',
      '-dFILTERTEXT',
      `-sOutputFile=${outputPath}`,
      inputPath,
    ]);
    return await readFile(outputPath);
  } finally {
    await unlink(inputPath).catch(() => {});
    await unlink(outputPath).catch(() => {});
  }
}

/**
 * Extrahiert die vorhandene Textebene eines PDFs per Ghostscript `txtwrite`.
 * Kostenlos und lokal — kein LLM. Gibt einen leeren String zurück, wenn das PDF
 * keine Textebene hat (reiner Scan ohne OCR).
 *
 * Genutzt von lib/text-extractor.js (Büroassistent) und von lib/llm.js für den
 * Text-only-Pfad: Provider ohne `pdf`-Capability bekommen statt des PDFs diesen
 * Text — und deshalb darf bei ihnen die Textebene nie entfernt werden.
 *
 * @param {Buffer} pdfBuffer
 * @returns {Promise<string>}
 */
export async function extractTextLayer(pdfBuffer) {
  const id = randomUUID();
  const inputPath  = `/tmp/pdftext-in-${id}.pdf`;
  const outputPath = `/tmp/pdftext-out-${id}.txt`;
  try {
    await writeFile(inputPath, pdfBuffer);
    await execFileAsync('gs', [
      '-q', '-dNOPAUSE', '-dBATCH', '-dSAFER',
      '-sDEVICE=txtwrite',
      `-sOutputFile=${outputPath}`,
      inputPath,
    ]);
    const raw = await readFile(outputPath, 'utf8');
    return raw.trim();
  } catch {
    return '';
  } finally {
    await unlink(inputPath).catch(() => {});
    await unlink(outputPath).catch(() => {});
  }
}

// Default-Seitenlimit für den Rasterpfad (vision-fähige, aber PDF-unfähige
// Provider, z.B. lokale Vision-Modelle in LM Studio/Ollama/vLLM). Kontextfenster
// solcher Modelle sind oft klein (4k-8k Tokens), und jede Bildseite kostet
// grob 1000-2000 Tokens — ein kleines Default-Limit vermeidet, dass das
// Fenster allein durch Bilder gefüllt wird, bevor der Prompt überhaupt Platz hat.
// Wessen Modell mehr verträgt, hebt es je Provider an (`rasterMaxSeiten` in
// _settings.llm_providers, Obergrenze RASTER_MAX_SEITEN_GRENZE in llm/registry.js).
// Diese Datei kennt bewusst keine Provider — sie bekommt die Zahl übergeben.
export const RASTER_MAX_SEITEN = 8;

// Harte Obergrenze der Seitengröße in PDF-Punkten (1pt = 1/72 Zoll), VOR der
// DPI-Berechnung geprüft. Ohne sie erzwingt ein PDF mit absurder MediaBox/
// CropBox (spec-widrig, aber von Ghostscript nicht per se verweigert) trotz
// DPI-Untergrenze ein riesiges Bitmap — eine Speicher-/CPU-Bombe beim Rendern,
// bevor das Byte-Budget (das erst die fertige Datei prüft) überhaupt greifen
// kann. 5000pt (~1,76m) deckt A0-Baupläne komfortabel ab; die Dokumente
// kommen per Post/Scan von beliebigen Dritten, das PDF ist nicht vertrauenswürdig.
const MAX_SEITE_PT = 5000;

function extFuerDevice(device) {
  return device.startsWith('jpeg') ? 'jpg' : 'png';
}

/**
 * Rendert die ersten Seiten eines PDFs zu Rasterbildern — für Provider, die
 * Bilder verstehen, aber keinen PDF-Datei-Block annehmen (lokale Vision-
 * Modelle). Die Textebene verschwindet dabei automatisch: unsichtbarer
 * OCR-Text (Tr 3) wird nicht gerendert — für den Bildpfad ist `stripTextLayer`
 * also gratis.
 *
 * @param {Buffer} pdfBuffer
 * @param {object}  [opts]
 * @param {number}  [opts.maxSeiten=RASTER_MAX_SEITEN]
 * @param {number}  [opts.langeKanteMax=1280]        - px, bestimmt die effektive DPI
 * @param {'pnggray'|'png16m'|'jpeggray'} [opts.device='pnggray']
 * @param {number}  [opts.maxBytesGesamt=12*1024*1024]
 * @param {number}  [opts.timeoutMs=90000]
 * @param {boolean} [opts.strikt=false] - true: mehr Seiten als maxSeiten sind ein
 *   Fehler statt stiller Kürzung. Voranalyse braucht nur einen Eindruck (false),
 *   die Klassifikation soll auf ein PDF-fähiges Modell absteigen statt eine
 *   halbe Sicht auf ein Dokument zu bewerten (true).
 * @returns {Promise<{ bilder: Array<{seite:number, mime:string, buffer:Buffer}>, seitenGesamt:number, abgeschnitten:boolean }>}
 */
export async function renderPdfToImages(pdfBuffer, {
  maxSeiten      = RASTER_MAX_SEITEN,
  langeKanteMax  = 1280,
  device         = 'pnggray',
  maxBytesGesamt = 12 * 1024 * 1024,
  timeoutMs      = 90_000,
  strikt         = false,
} = {}) {
  const doc = await PDFDocument.load(pdfBuffer, { updateMetadata: false });
  const seitenGesamt = doc.getPageCount();
  if (strikt && seitenGesamt > maxSeiten) {
    throw new Error(`PDF hat ${seitenGesamt} Seiten (Limit ${maxSeiten}) — zu lang für den Bildpfad.`);
  }
  const seitenZuRendern = Math.min(seitenGesamt, maxSeiten);
  const abgeschnitten = seitenGesamt > seitenZuRendern;

  // getCropBox() statt getSize()/MediaBox: die Scan-Pipeline setzt teils eine
  // /CropBox (z.B. A6-Ausschnitt in einer A4-MediaBox), ohne die MediaBox zu
  // ändern. Nur Seite 1 wird vermessen — mehrseitige Scans sind praktisch
  // immer einheitlich formatiert (dasselbe vereinfachte Muster wie convertToGrayscale).
  const { width, height } = doc.getPage(0).getCropBox();
  const langeKantePt = Math.max(width, height);
  if (!Number.isFinite(langeKantePt) || langeKantePt <= 0) {
    throw new Error('PDF-Seitengröße konnte nicht bestimmt werden.');
  }
  if (langeKantePt > MAX_SEITE_PT) {
    throw new Error(`PDF-Seite ist zu groß zum Rastern (${Math.round(langeKantePt)}pt > ${MAX_SEITE_PT}pt).`);
  }

  const ext = extFuerDevice(device);
  const mime = ext === 'jpg' ? 'image/jpeg' : 'image/png';
  const id = randomUUID();
  const dir = `/tmp/pdfraster-${id}`;
  const inputPath = `${dir}/in.pdf`;

  async function render(dpi) {
    await execFileAsync('gs', [
      '-q', '-dNOPAUSE', '-dBATCH', '-dSAFER',
      `-sDEVICE=${device}`,
      `-r${dpi}`,
      '-dFirstPage=1', `-dLastPage=${seitenZuRendern}`,
      '-dUseCropBox',
      '-dTextAlphaBits=4', '-dGraphicsAlphaBits=4',
      `-sOutputFile=${dir}/s-%03d.${ext}`,
      inputPath,
    ], { timeout: timeoutMs, killSignal: 'SIGKILL' });
    const dateien = (await readdir(dir)).filter((f) => f.startsWith('s-')).sort();
    const bilder = [];
    let gesamtBytes = 0;
    let ueberBudget = false;
    for (const [i, f] of dateien.entries()) {
      // Budget schon beim Einlesen prüfen und dann nichts mehr im Speicher
      // halten: erst alle Seiten zu puffern und danach zu messen, macht den
      // Heap-Peak von der Seitenzahl abhängig statt vom Budget — bei einem
      // hohen `maxSeiten` und drei parallelen Pipeline-Jobs der einzige Punkt,
      // an dem ein fremdes PDF echten Speicherdruck erzeugen könnte.
      if (!ueberBudget) {
        const buffer = await readFile(`${dir}/${f}`);
        gesamtBytes += buffer.length;
        if (gesamtBytes > maxBytesGesamt) {
          ueberBudget = true;
          bilder.length = 0;
        } else {
          bilder.push({ seite: i + 1, mime, buffer });
        }
      }
      // Sofort löschen: ein zweiter Renderdurchlauf (DPI-Downgrade) soll nicht
      // mit den Resten des ersten kollidieren.
      await unlink(`${dir}/${f}`).catch(() => {});
    }
    return { bilder, gesamtBytes, ueberBudget };
  }

  try {
    await mkdir(dir, { recursive: true });
    await writeFile(inputPath, pdfBuffer);

    let dpi = clamp(Math.round(langeKanteMax / (langeKantePt / 72)), 72, 200);
    let lauf = await render(dpi);

    // Byte-Budget überschritten: EINMAL mit halber DPI wiederholen, dann
    // aufgeben (Fehler → die aufrufende Fallback-Kette steigt ab). Kein
    // Endlos-Downgrade.
    if (lauf.ueberBudget && dpi > 72) {
      dpi = Math.max(72, Math.round(dpi / 2));
      lauf = await render(dpi);
    }
    if (lauf.ueberBudget) {
      // `gesamtBytes` ist beim Abbruch nur die Summe bis zur reißenden Seite,
      // also eine Untergrenze — daher „mindestens".
      throw new Error(
        `Gerasterte Seiten zu groß (mindestens ${Math.round(lauf.gesamtBytes / 1024)}KB > `
        + `${Math.round(maxBytesGesamt / 1024)}KB) — auch nach DPI-Reduktion.`,
      );
    }

    return { bilder: lauf.bilder, seitenGesamt, abgeschnitten };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Untersucht ein PDF darauf, ob es eine durchsuchbare Textebene UND ein
 * seitenfüllendes Scan-Bild enthält — die typische Signatur eines eingescannten
 * Dokuments mit (oft fehlerhafter) Tesseract-OCR-Textebene.
 *
 * Heuristik (rein lesend, kein Schreiben):
 *   • Textebene  = Ghostscript `txtwrite` liefert ≥ 20 Nicht-Leerzeichen.
 *   • Scan-Bild  = irgendeine Bild-XObject mit max. Kantenlänge ≥ 1000 px
 *                  ODER ≥ 1.000.000 px Fläche (Vollseiten-Scan; Logos/Banner
 *                  bleiben darunter).
 *
 * Dient nur dazu, in der Wiederverarbeitung einen sinnvollen Vorschlag für das
 * Entfernen der Textebene zu setzen (Default an, wenn beides zutrifft).
 *
 * @param {Buffer} pdfBuffer
 * @returns {Promise<{ hatTextebene: boolean, hatScanBild: boolean, empfehlungEntfernen: boolean }>}
 */
export async function erkenneScanMitTextebene(pdfBuffer) {
  let hatTextebene = false;
  let hatScanBild  = false;

  // 1. Textebene via Ghostscript txtwrite
  const id = randomUUID();
  const inputPath  = `/tmp/pdftxtprobe-in-${id}.pdf`;
  const outputPath = `/tmp/pdftxtprobe-out-${id}.txt`;
  try {
    await writeFile(inputPath, pdfBuffer);
    await execFileAsync('gs', [
      '-q', '-dNOPAUSE', '-dBATCH', '-dSAFER',
      '-sDEVICE=txtwrite',
      `-sOutputFile=${outputPath}`,
      inputPath,
    ]);
    const txt = await readFile(outputPath, 'utf8');
    hatTextebene = txt.replace(/\s+/g, '').length >= 20;
  } catch {
    hatTextebene = false; // im Zweifel: keine Textebene angenommen
  } finally {
    await unlink(inputPath).catch(() => {});
    await unlink(outputPath).catch(() => {});
  }

  // 2. Seitenfüllendes Scan-Bild via pdf-lib (Bild-XObjects + Pixelmaße)
  try {
    const doc = await PDFDocument.load(pdfBuffer, { updateMetadata: false });
    for (const page of doc.getPages()) {
      let res;
      try { res = page.node.Resources(); } catch { /* ignore */ }
      if (!res) res = page.node.get(PDFName.of('Resources'));
      const xobjects = res?.lookup?.(PDFName.of('XObject'), PDFDict);
      if (!xobjects) continue;
      for (const [, ref] of xobjects.entries()) {
        const stream = doc.context.lookup(ref);
        const dict = stream?.dict || stream;
        if (dict?.get?.(PDFName.of('Subtype'))?.toString() !== '/Image') continue;
        const w = dict.get(PDFName.of('Width'))?.asNumber?.()  || 0;
        const h = dict.get(PDFName.of('Height'))?.asNumber?.() || 0;
        if (Math.max(w, h) >= 1000 || w * h >= 1_000_000) {
          hatScanBild = true;
          break;
        }
      }
      if (hatScanBild) break;
    }
  } catch {
    hatScanBild = false;
  }

  return { hatTextebene, hatScanBild, empfehlungEntfernen: hatTextebene && hatScanBild };
}

// A4: 210×297 mm = 595.28×841.89 pt; A6: 105×148 mm = 297.64×420.94 pt
const PAGE_FORMATS = {
  a4: { w: 595, h: 842 },
  a6: { w: 298, h: 421 },
};

/**
 * Konvertiert ein PDF in Graustufen und normiert es auf eine Ziel-Seitengröße bei 150 DPI.
 *
 * Strategie:
 *   1. `-dFIXEDMEDIA -dDEVICEWIDTHPOINTS/-dDEVICEHEIGHTPOINTS` setzt die Ausgabe-MediaBox
 *      auf exakt A4 oder A6 (in Punkten). `-dFitPage` skaliert den Inhalt hinein.
 *   2. Danach rechnet `-dColorImageResolution=150` DPI korrekt — weil die MediaBox
 *      jetzt eine definierte physikalische Größe hat.
 *   3. `-dColorConversionStrategy=/Gray` + `-dProcessColorModel=/DeviceGray` → Graustufen.
 *
 * Warum nicht 1-Bit (Monochrom):
 *   Stempel, Unterschriften und gedruckte Logos haben weiche Kanten. 1-Bit-Dithering
 *   führt dort zu unleserlichem Rauschen. 8-Bit Grau @ 150 DPI ist kompakt genug
 *   (A4 ≈ 0.4–1 MB, A6 ≈ 0.1–0.3 MB) und bleibt zuverlässig lesbar.
 *
 * @param {Buffer} pdfBuffer
 * @param {'a4'|'a6'} targetFormat  – 'a6' für Rezepte, 'a4' für alles andere
 * @returns {Promise<Buffer>}
 */
export async function convertToGrayscale(pdfBuffer, targetFormat = 'a4') {
  const baseFmt = PAGE_FORMATS[targetFormat] ?? PAGE_FORMATS.a4;
  const id = randomUUID();
  const inputPath  = `/tmp/pdfgray-in-${id}.pdf`;
  const flatPath   = `/tmp/pdfgray-flat-${id}.pdf`;
  const outputPath = `/tmp/pdfgray-out-${id}.pdf`;

  try {
    await writeFile(inputPath, pdfBuffer);

    // Step 1: Physically bake any /Rotate metadata into the content stream.
    // This is critical: Ghostscript's -dFitPage calculates the fit against the raw
    // MediaBox, NOT the visually-rotated dimensions. A landscape page stored as
    // portrait + Rotate=90 would be fitted at ~70% scale → appears A7/A8 sized.
    // After --flatten-rotation, MediaBox == true visual dimensions, Rotate is gone.
    await execFileAsync('qpdf', ['--flatten-rotation', inputPath, flatPath]);

    // Step 2: Detect visual orientation from the effective visible area.
    // Use getCropBox() rather than getSize()/getMediaBox() because the scan
    // pipeline (process_scan.py) sets a /CropBox (e.g. A6 region inside an
    // A4 MediaBox) without changing the MediaBox itself.  getCropBox() falls
    // back to MediaBox when no CropBox is present (e.g. photo uploads).
    const flatBuf = await readFile(flatPath);
    const srcDoc  = await PDFDocument.load(flatBuf, { updateMetadata: false });
    const { width: vw, height: vh } = srcDoc.getPage(0).getCropBox();
    const isLandscape = vw > vh;

    // Match target box to source orientation — landscape stays landscape, portrait stays portrait.
    const fmt = isLandscape
      ? { w: baseFmt.h, h: baseFmt.w }
      : baseFmt;

    // Step 3: Grayscale + proportional scale to target format at 150 DPI.
    // -dFitPage scales proportionally (aspect-ratio preserved); pages slightly
    // smaller than the box are left as-is (scan photos will rarely be exactly A4/A6).
    // -dAutoRotatePages=/None prevents GS from second-guessing orientation.
    await execFileAsync('gs', [
      '-q', '-dNOPAUSE', '-dBATCH', '-dSAFER',
      '-sDEVICE=pdfwrite',
      '-dFIXEDMEDIA',
      `-dDEVICEWIDTHPOINTS=${fmt.w}`,
      `-dDEVICEHEIGHTPOINTS=${fmt.h}`,
      '-dFitPage',
      '-dUseCropBox',      // honour /CropBox (set by scan pipeline); falls back to MediaBox if absent
      '-dAutoRotatePages=/None',
      '-dColorConversionStrategy=/Gray',
      '-dProcessColorModel=/DeviceGray',
      '-dCompatibilityLevel=1.4',
      '-dDownsampleColorImages=true', '-dColorImageResolution=150',
      '-dDownsampleGrayImages=true',  '-dGrayImageResolution=150',
      '-dDownsampleMonoImages=true',  '-dMonoImageResolution=150',
      `-sOutputFile=${outputPath}`,
      flatPath,
    ]);
    return await readFile(outputPath);
  } finally {
    await unlink(inputPath).catch(() => {});
    await unlink(flatPath).catch(() => {});
    await unlink(outputPath).catch(() => {});
  }
}

/**
 * Erzeugt ein neues PDF, das nur den 1-basierten, inklusiven Seitenbereich
 * [von, bis] des Eingabe-PDFs enthält. Filtert nur für die Ausgabe — das
 * gespeicherte Original bleibt unangetastet (siehe
 * service/abrechnung-paket.js, das damit Deckblatt/Duplikat aus dem
 * Einreichungspaket herausfiltert, ohne die Ablage zu verändern).
 * Wirft bei leerem/ungültigem Bereich — der Aufrufer fällt dann per
 * Sicherheitsnetz auf das ganze Dokument zurück.
 * @param {Buffer} pdfBuffer
 * @param {number} von - 1-basiert, inklusiv
 * @param {number} bis - 1-basiert, inklusiv
 * @returns {Promise<Buffer>}
 */
export async function selectPages(pdfBuffer, von, bis) {
  const src = await PDFDocument.load(pdfBuffer, { updateMetadata: false });
  const seitenGesamt = src.getPageCount();
  const start = Math.max(1, von);
  const ende = Math.min(seitenGesamt, bis);
  if (start > ende) {
    throw new Error(`selectPages: leerer/ungültiger Bereich ${von}-${bis} (Dokument hat ${seitenGesamt} Seiten)`);
  }
  const indices = [];
  for (let i = start; i <= ende; i++) indices.push(i - 1);

  const out = await PDFDocument.create();
  const kopierte = await out.copyPages(src, indices);
  kopierte.forEach((p) => out.addPage(p));
  return Buffer.from(await out.save());
}

/**
 * Fügt mehrere PDFs zu einem einzigen zusammen (in Eingabereihenfolge).
 * @param {Buffer[]} pdfBuffers - Array von Eingabe-PDFs als Buffer
 * @returns {Promise<Buffer>}   - Zusammengeführtes PDF als Buffer
 */
export async function mergePdfs(pdfBuffers) {
  if (!pdfBuffers || pdfBuffers.length === 0) {
    throw new Error('mergePdfs: mindestens ein Eingabe-PDF erforderlich');
  }
  if (pdfBuffers.length === 1) return pdfBuffers[0];

  const id = randomUUID();
  const inputPaths = [];
  const outputPath = `/tmp/pdfmerge-${id}.pdf`;

  try {
    for (let i = 0; i < pdfBuffers.length; i++) {
      const p = `/tmp/pdfmerge-in-${id}-${i}.pdf`;
      await writeFile(p, pdfBuffers[i]);
      inputPaths.push(p);
    }
    // qpdf --empty --pages <file1> <file2> ... -- <output>
    await execFileAsync('qpdf', [
      '--empty', '--pages', ...inputPaths, '--', outputPath
    ]);
    return await readFile(outputPath);
  } finally {
    await Promise.all(
      [...inputPaths, outputPath].map(p => unlink(p).catch(() => {}))
    );
  }
}

/**
 * Zählt die Seiten eines PDF-Buffers.
 * @param {Buffer} pdfBuffer
 * @returns {Promise<number>}
 */
export async function countPdfPages(pdfBuffer) {
  const doc = await PDFDocument.load(pdfBuffer, { updateMetadata: false });
  return doc.getPageCount();
}

/**
 * Fügt Link-Annotationen in ein PDF ein.
 *
 * @param {Buffer} pdfBuffer  - Eingabe-PDF
 * @param {Array}  annotations - Array mit einem Eintrag pro Dokument:
 *   {
 *     pageIndex: number,   // 0-basierter Seitenindex im PDF
 *     x: number,           // PDFKit-X (Ursprung oben-links)
 *     y: number,           // PDFKit-Y (Ursprung oben-links)
 *     w: number,           // Breite  der Ziel-Bounding-Box
 *     h: number,           // Höhe    der Ziel-Bounding-Box
 *     action: {
 *       type: 'GoTo',      pageIndex: number  // Intern: Sprung auf Seite N (0-basiert)
 *     } | {
 *       type: 'URI',       uri: string        // Extern: relativer Dateiname
 *     }
 *   } | null              // null → kein Link für dieses Dokument
 * @returns {Promise<Buffer>}
 */
export async function addPdfLinkAnnotations(pdfBuffer, annotations) {
  // Abbruch wenn keine nutzbaren Annotationen vorhanden
  if (!annotations || annotations.every(a => a === null)) return pdfBuffer;

  const pdfDoc = await PDFDocument.load(pdfBuffer, { updateMetadata: false });
  const pages  = pdfDoc.getPages();

  for (const ann of annotations) {
    if (ann === null) continue;

    const page = pages[ann.pageIndex];
    if (!page) continue;

    const { height: pgH } = page.getSize();

    // PDFKit-Koordinaten (oben-links) → PDF-Koordinaten (unten-links)
    const x1 = ann.x;
    const y1 = pgH - ann.y - ann.h;
    const x2 = ann.x + ann.w;
    const y2 = pgH - ann.y;

    // Ziel-Aktion aufbauen
    let actionObj;
    if (ann.action.type === 'GoTo') {
      const targetPage = pages[ann.action.pageIndex];
      if (!targetPage) continue;
      const { height: targetH } = targetPage.getSize();
      // Ziel: Seitenanfang (XYZ mit top = Seitenhöhe, null = X/Zoom beibehalten)
      const dest = pdfDoc.context.obj([
        targetPage.ref,
        PDFName.of('XYZ'),
        PDFNull,
        PDFNumber.of(targetH),
        PDFNull,
      ]);
      actionObj = pdfDoc.context.obj({
        S: 'GoTo',
        D: dest,
      });
    } else if (ann.action.type === 'URI') {
      actionObj = pdfDoc.context.obj({
        S: 'URI',
        URI: PDFString.of(ann.action.uri),
      });
    } else {
      continue;
    }

    // Annotations-Dictionary
    const annotObj = pdfDoc.context.obj({
      Type:    'Annot',
      Subtype: 'Link',
      Rect:    [x1, y1, x2, y2],
      Border:  [0, 0, 0],
      A:       actionObj,
    });
    const annotRef = pdfDoc.context.register(annotObj);

    // In die Annots-Liste der Seite eintragen
    const annotsKey      = PDFName.of('Annots');
    const existingAnnots = page.node.lookup(annotsKey);
    if (existingAnnots instanceof PDFArray) {
      existingAnnots.push(annotRef);
    } else {
      page.node.set(annotsKey, pdfDoc.context.obj([annotRef]));
    }
  }

  return Buffer.from(await pdfDoc.save());
}

const PRUEFANLAGE_HINWEIS = [
  'Anlage zur Prüfung eines ergänzenden Erstattungsanspruchs',
  'Nur als Prüfanlage beigefügt – keine erneute reguläre Einreichung',
];
const PRUEFANLAGE_BAND_H = 26; // pt — Kopfbereich, überdeckt nie Originalinhalt

/**
 * Kennzeichnet jede Seite eines PDFs als Prüfanlage (PKV-Beihilfeergänzungstarif-
 * Prüfung, siehe FEATURE_KUERZUNGEN_GESEHEN_PKV_PRUEFUNG_PLAN.md, 7.3).
 *
 * Überdeckt bewusst NICHTS vom Original: jede Seite wird als eingebettetes
 * Form-XObject auf eine neue Seite IN UNVERÄNDERTER GRÖSSE gezeichnet. Der
 * Aufrufer normiert Prüfanlagen vorher wie reguläre Anlagen per
 * `convertToGrayscale()` auf A4/A6 — würde diese Funktion die Seite dafür um
 * PRUEFANLAGE_BAND_H verlängern, wäre die Prüfanlage am Ende höher als eine
 * reguläre Seite und der Kostenträger bekäme uneinheitliche Seitengrößen im
 * selben Paket. Stattdessen wird der Originalinhalt proportional um den
 * Bandanteil verkleinert und horizontal zentriert unterhalb des Hinweis-
 * streifens platziert; Barcodes/Scan-Inhalt bleiben dabei vollständig sichtbar
 * und eine Beschädigung des Originaldokuments in der Ablage ist ausgeschlossen
 * (das Original wird nur gelesen, nie ersetzt).
 *
 * @param {Buffer} pdfBuffer - unverändertes Original (Rechnung oder Bescheid)
 * @param {object} [opts]
 * @param {string} [opts.referenz] - fortlaufende B…/R…-Referenz (siehe Vorblatt,
 *   FEATURE_KUERZUNGEN_GESEHEN_PKV_PRUEFUNG_PLAN.md, 7.2) — steht zusätzlich links
 *   im Kennzeichnungsbereich, damit jede Anlage eindeutig auf ihre Vorblattzeile
 *   zurückverweist.
 * @param {string[]} [opts.hinweisZeilen] - abweichender Hinweistext (Default:
 *   PRUEFANLAGE_HINWEIS), für andere Anlage-Arten wie das Dokument-Anpinnen.
 * @returns {Promise<Buffer>} gekennzeichnete Kopie, gleiche Seitengröße je Seite wie das Original
 */
export async function kennzeichnePruefanlage(pdfBuffer, { referenz, hinweisZeilen = PRUEFANLAGE_HINWEIS } = {}) {
  const srcDoc = await PDFDocument.load(pdfBuffer, { updateMetadata: false });
  const srcPages = srcDoc.getPages();
  if (srcPages.length === 0) throw new Error('kennzeichnePruefanlage: PDF ohne Seiten');

  const outDoc = await PDFDocument.create();
  const embedded = await outDoc.embedPages(srcPages);
  const font = await outDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await outDoc.embedFont(StandardFonts.HelveticaBold);

  for (const ep of embedded) {
    const { width: W, height: H } = ep;
    const page = outDoc.addPage([W, H]);

    // Originalinhalt wird proportional verkleinert, damit er unterhalb des
    // Hinweisstreifens Platz findet, OHNE die Gesamtseitengröße zu verändern.
    const contentH = H - PRUEFANLAGE_BAND_H;
    const scale = contentH / H;
    const xOffset = (W - W * scale) / 2;

    page.drawRectangle({
      x: 0, y: contentH, width: W, height: PRUEFANLAGE_BAND_H,
      color: rgb(1, 0.97, 0.8), borderColor: rgb(0.6, 0.5, 0), borderWidth: 0.5,
    });

    let textStartX = 4;
    if (referenz) {
      const refSize = 12;
      page.drawText(referenz, {
        x: 6, y: contentH + PRUEFANLAGE_BAND_H / 2 - refSize / 2,
        size: refSize, font: fontBold, color: rgb(0.35, 0.28, 0),
      });
      textStartX = 6 + fontBold.widthOfTextAtSize(referenz, refSize) + 10;
    }

    const fontSize = 7;
    const lineH = 9.5;
    const availW = W - textStartX - 4;
    let ty = contentH + PRUEFANLAGE_BAND_H - 10;
    for (const line of hinweisZeilen) {
      const textWidth = font.widthOfTextAtSize(line, fontSize);
      const centeredX = textStartX + Math.max(0, (availW - textWidth) / 2);
      page.drawText(line, {
        x: centeredX, y: ty,
        size: fontSize, font, color: rgb(0.35, 0.28, 0),
      });
      ty -= lineH;
    }

    page.drawPage(ep, { x: xOffset, y: 0, xScale: scale, yScale: scale });
  }

  return Buffer.from(await outDoc.save());
}
