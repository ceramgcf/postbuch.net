// Scanner-Worker: lädt OpenCV.js einmal und erledigt Erkennung, Schärfeprüfung,
// Entzerrung, Bildverbesserung und Kodierung – alles auf dem Gerät, ohne den
// Hauptthread zu blockieren. Klassischer Worker (Vite bündelt ihn als IIFE),
// weil die Emscripten-Datei per importScripts geladen werden muss.
//
// Nachrichten (jeweils mit `id`, Antwort { id, ok, ergebnis | fehler }):
//   init    { url }                         → { } (Fortschritt: { typ: 'laden', anteil })
//   (hinweis = { ecken, breite, hoehe } aus der Live-Vorschau)
//   analyse { bild: ImageBitmap, schaerfe }  → { ecken|null, sicherheit, schaerfe|null, breite, hoehe }
//   erkenne { foto: Blob, hinweis? }                   → { ecken, erkannt, breite, hoehe }
//   qr      { bild: ImageBitmap }            → { texte: string[] } (QR-Inhalte)
//   seite   { foto: Blob, ecken|null, hinweis?, modus, drehung } → { vorschau: Blob, foto: Blob|null (auf Live-Ausschnitt zugeschnitten), pdf: {…}, ecken, erkannt, fotoBreite, fotoHoehe, breite, hoehe }

import { erkenneDokument, verfeinereEcken, vorschauImFoto, bewerteSchaerfe, entzerre, verbessere } from './bildverarbeitung.js';
import { standardEcken, langeSeiteFuerDpi, hinweisAufFoto } from './geometrie.js';
import { packeBits, deflate } from './pdfSchreiber.js';

let cv = null;
let laden = null;
let qrDetektor = null;

// Fotos größer als das rechnet niemand: 12-Megapixel-RGBA wären 48 MB je Mat.
const FOTO_MAX = 3200;
// Kamera-Diagnose (Debug-Modus): Messwerte der zuletzt gerechneten Seite.
let diagnose = null;

async function ladeOpenCv(url) {
  const antwort = await fetch(url);
  if (!antwort.ok) throw new Error(`OpenCV nicht ladbar (HTTP ${antwort.status})`);
  const gesamt = Number(antwort.headers.get('Content-Length')) || 0;
  const leser = antwort.body.getReader();
  const teile = [];
  let geladen = 0;
  for (;;) {
    const { done, value } = await leser.read();
    if (done) break;
    teile.push(value);
    geladen += value.length;
    // Bei gzip-Auslieferung nennt Content-Length die komprimierte Größe, der
    // Strom liefert entpackte Bytes – deshalb gedeckelt und grob geschätzt.
    const anteil = gesamt ? Math.min(0.95, geladen / (gesamt * 3.5)) : 0;
    self.postMessage({ typ: 'laden', anteil });
  }
  const blobUrl = URL.createObjectURL(new Blob(teile, { type: 'text/javascript' }));
  try {
    self.importScripts(blobUrl);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
  let modul = self.cv;
  if (modul && typeof modul.then === 'function') modul = await modul;
  if (!modul || !modul.Mat) throw new Error('OpenCV ließ sich nicht starten');
  cv = modul;
  self.postMessage({ typ: 'laden', anteil: 1 });
}

function matAusBitmap(bitmap) {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  const daten = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  return cv.matFromImageData(daten);
}

// Mat aus einem Bereich der Bitmap, lange Seite höchstens FOTO_MAX.
async function matAusBereich(roh, x, y, b, h) {
  const faktor = Math.min(1, FOTO_MAX / Math.max(b, h));
  const bitmap = await createImageBitmap(roh, x, y, b, h, faktor < 1 ? {
    resizeWidth: Math.round(b * faktor),
    resizeHeight: Math.round(h * faktor),
    resizeQuality: 'high',
  } : {});
  const mat = matAusBitmap(bitmap);
  bitmap.close();
  return { mat, faktor };
}

// Foto laden: `roh` in voller Auflösung bleibt offen, damit ein späterer
// Ausschnitt aus dem Original statt aus dem verkleinerten Mat kommt.
async function ladeFoto(foto) {
  const roh = await createImageBitmap(foto);
  diagnose = { fotoRoh: `${roh.width}×${roh.height}` };
  const { mat, faktor } = await matAusBereich(roh, 0, 0, roh.width, roh.height);
  return { roh, mat, faktor };
}

function rgbaZuCanvas(mat) {
  const canvas = new OffscreenCanvas(mat.cols, mat.rows);
  const ctx = canvas.getContext('2d');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(mat.data), mat.cols, mat.rows), 0, 0);
  return canvas;
}

// Das Foto (takePhoto, volle Sensorfläche) zeigt oft mehr als der Videostrom,
// der für die Vorschau zugeschnitten wird. Damit Aufnahme und Live-Bild
// übereinstimmen, wird das Foto per Bildvergleich mit dem Videobild beim
// Auslösen auf genau dessen Ausschnitt zugeschnitten. Liefert den
// zugeschnittenen Mat (oder null). Abgeglichen wird auf dem verkleinerten
// Mat, geschnitten im Original und erst danach verkleinert – so behält der
// Ausschnitt die volle Auflösung des Fotos.
async function aufLiveAusschnitt({ roh, mat, faktor }, hinweis) {
  if (!hinweis?.bild) return null;
  const vorschau = matAusBitmap(hinweis.bild);
  let a;
  try {
    a = vorschauImFoto(cv, mat, vorschau);
  } finally {
    vorschau.delete();
  }
  if (diagnose) diagnose.abgleich = a ? { s: +a.s.toFixed(3), dx: Math.round(a.dx), dy: Math.round(a.dy), wert: +a.wert.toFixed(3), foto: `${mat.cols}×${mat.rows}`, live: `${hinweis.bild.width}×${hinweis.bild.height}` } : 'kein Treffer';
  if (!a) return null;
  const x = Math.max(0, Math.round(a.dx));
  const y = Math.max(0, Math.round(a.dy));
  const b = Math.min(mat.cols - x, Math.round(hinweis.bild.width * a.s));
  const h = Math.min(mat.rows - y, Math.round(hinweis.bild.height * a.s));
  // Nur zuschneiden, wenn das Foto wirklich mehr zeigt (≥ 2 % je Richtung).
  const anteil = { anteilB: +(b / mat.cols).toFixed(3), anteilH: +(h / mat.rows).toFixed(3) };
  if (b > mat.cols * 0.98 && h > mat.rows * 0.98) {
    if (diagnose) diagnose.ausschnitt = { ...anteil, zuschnitt: false };
    return null;
  }
  const rx = Math.round(x / faktor);
  const ry = Math.round(y / faktor);
  const rb = Math.min(roh.width - rx, Math.round(b / faktor));
  const rh = Math.min(roh.height - ry, Math.round(h / faktor));
  const neu = (await matAusBereich(roh, rx, ry, rb, rh)).mat;
  if (diagnose) diagnose.ausschnitt = { x: rx, y: ry, b: rb, h: rh, ...anteil, ergebnis: `${neu.cols}×${neu.rows}` };
  return neu;
}

function erkenneAufFoto(mat, hinweis) {
  // Live-Ecken auf das (ggf. zugeschnittene) Foto übertragen: gleicher Ausschnitt, nur skaliert.
  const vorgabe = hinweisAufFoto(hinweis, mat.cols, mat.rows);
  const grob = erkenneDokument(cv, mat, { hinweis: vorgabe });
  if (!grob) return { ecken: vorgabe ?? standardEcken(mat.cols, mat.rows), erkannt: false };
  return { ecken: verfeinereEcken(cv, mat, grob.ecken), erkannt: true };
}

async function alsJpeg(mat, qualitaet) {
  return rgbaZuCanvas(mat).convertToBlob({ type: 'image/jpeg', quality: qualitaet });
}

const aufgaben = {
  async init({ url }) {
    if (!laden) laden = ladeOpenCv(url);
    try {
      await laden;
    } catch (err) {
      laden = null;
      throw err;
    }
    return {};
  },

  async analyse({ bild, schaerfe }) {
    const mat = matAusBitmap(bild);
    bild.close();
    try {
      const treffer = erkenneDokument(cv, mat);
      let wert = null;
      if (treffer && schaerfe) wert = bewerteSchaerfe(cv, mat, treffer.ecken).minimum;
      return {
        ecken: treffer?.ecken ?? null,
        sicherheit: treffer?.sicherheit ?? 0,
        schaerfe: wert,
        breite: mat.cols,
        hoehe: mat.rows,
      };
    } finally {
      mat.delete();
    }
  },

  async qr({ bild }) {
    const mat = matAusBitmap(bild);
    bild.close();
    const grau = new cv.Mat();
    const punkte = new cv.Mat();
    try {
      cv.cvtColor(mat, grau, cv.COLOR_RGBA2GRAY);
      qrDetektor ??= new cv.QRCodeDetector();
      const text = qrDetektor.detectAndDecode(grau, punkte);
      return { texte: text ? [text] : [] };
    } finally {
      mat.delete();
      grau.delete();
      punkte.delete();
    }
  },

  async erkenne({ foto, hinweis }) {
    const geladen = await ladeFoto(foto);
    let { mat } = geladen;
    try {
      const zugeschnitten = await aufLiveAusschnitt(geladen, hinweis);
      if (zugeschnitten) { mat.delete(); mat = zugeschnitten; }
    } catch (err) {
      mat.delete();
      throw err;
    } finally {
      geladen.roh.close();
    }
    try {
      return { ...erkenneAufFoto(mat, hinweis), breite: mat.cols, hoehe: mat.rows };
    } finally {
      mat.delete();
    }
  },

  async seite({ foto, ecken, hinweis, modus, drehung = 0 }) {
    const geladen = await ladeFoto(foto);
    let { mat } = geladen;
    let blatt = null;
    let bild = null;
    let neuesFoto = null;
    try {
      if (!ecken) {
        const zugeschnitten = await aufLiveAusschnitt(geladen, hinweis);
        if (zugeschnitten) {
          mat.delete();
          mat = zugeschnitten;
          // Das zugeschnittene Foto ersetzt das Original, damit Ecken-Editor
          // und spätere Neuberechnungen denselben Ausschnitt sehen.
          neuesFoto = await alsJpeg(mat, 0.92);
        }
      }
      const auto = ecken ? null : erkenneAufFoto(mat, hinweis);
      const genutzt = ecken ?? auto.ecken;
      blatt = entzerre(cv, mat, genutzt, { maxLang: langeSeiteFuerDpi(genutzt), drehung, beschnitt: 0.004 });
      bild = verbessere(cv, blatt, modus);
      const jpeg = await alsJpeg(bild, modus === 'farbe' ? 0.82 : 0.78);
      let pdf;
      if (modus === 'sw') {
        // Ein Kanal genügt, verbessere() liefert für SW reines Schwarz/Weiß.
        const rgba = bild.data;
        const grau = new Uint8Array(bild.cols * bild.rows);
        for (let i = 0, j = 0; j < grau.length; i += 4, j++) grau[j] = rgba[i];
        const bits = await deflate(packeBits(grau, bild.cols, bild.rows));
        pdf = { art: 'bits', daten: bits, breite: bild.cols, hoehe: bild.rows };
      } else {
        // Das Canvas kodiert immer YCbCr mit drei Kanälen, auch bei Grau.
        pdf = { art: 'jpeg', daten: new Uint8Array(await jpeg.arrayBuffer()), breite: bild.cols, hoehe: bild.rows, grau: false };
      }
      return { diagnose, vorschau: jpeg, foto: neuesFoto, pdf, ecken: genutzt, erkannt: auto ? auto.erkannt : true, fotoBreite: mat.cols, fotoHoehe: mat.rows, breite: bild.cols, hoehe: bild.rows };
    } finally {
      geladen.roh.close();
      mat.delete();
      blatt?.delete();
      bild?.delete();
    }
  },
};

self.onmessage = async (ereignis) => {
  const { id, typ, daten } = ereignis.data;
  try {
    if (typ !== 'init' && !cv) throw new Error('OpenCV ist noch nicht geladen');
    const ergebnis = await aufgaben[typ](daten);
    const transfer = ergebnis?.pdf?.daten ? [ergebnis.pdf.daten.buffer] : [];
    self.postMessage({ id, ok: true, ergebnis }, transfer);
  } catch (err) {
    self.postMessage({ id, ok: false, fehler: err?.message || String(err) });
  }
};
