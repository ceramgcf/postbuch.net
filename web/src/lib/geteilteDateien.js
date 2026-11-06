import { api } from '@/api/client';

// Abholseite des Share-Targets: Der Service-Worker (public/service-worker.js)
// legt per Teilen-Menü übergebene Dateien im Cache-Speicher ab. PDFs holt die
// Jobs-Ansicht (/logs?geteilt=1) ab, gibt sie in die Pipeline und verfolgt die
// Jobs; Fotos holt der Fotoimport (/foto-import) ab und bereitet sie wie einen
// Kamerascan auf. Name des Caches und Schlüsselpräfixe müssen mit dem
// Service-Worker übereinstimmen.
const GETEILT_CACHE = 'postbuch-geteilt';
const PRAEFIX = '/__geteilt/';
const PRAEFIX_FOTO = '/__geteilt-foto/';
// Nicht abgeholte Dateien (z. B. geteilt, aber nie angemeldet) verfallen,
// damit sie nicht Tage später unerwartet in die Pipeline gehen.
const HOECHSTALTER_MS = 24 * 60 * 60 * 1000;

function zeitstempel(req, praefix) {
  return Number(new URL(req.url).pathname.slice(praefix.length).split('-')[0]) || 0;
}

let laufend = null;

async function holen(praefix = PRAEFIX) {
  if (typeof caches === 'undefined') return [];
  const cache = await caches.open(GETEILT_CACHE);
  const schluessel = (await cache.keys())
    .filter((req) => new URL(req.url).pathname.startsWith(praefix))
    .sort((a, b) => a.url.localeCompare(b.url, undefined, { numeric: true }));
  const dateien = [];
  for (const req of schluessel) {
    const res = await cache.match(req);
    await cache.delete(req);
    if (!res || Date.now() - zeitstempel(req, praefix) > HOECHSTALTER_MS) continue;
    const blob = await res.blob();
    let name = praefix === PRAEFIX ? 'geteilt.pdf' : 'geteilt';
    try { name = decodeURIComponent(res.headers.get('X-Dateiname') || name); } catch { /* Rohname behalten */ }
    dateien.push(new File([blob], name, { type: blob.type || 'application/pdf' }));
  }
  return dateien;
}

async function wartet(praefix) {
  try {
    if (typeof caches === 'undefined') return false;
    const cache = await caches.open(GETEILT_CACHE);
    return (await cache.keys()).some((req) => new URL(req.url).pathname.startsWith(praefix)
      && Date.now() - zeitstempel(req, praefix) <= HOECHSTALTER_MS);
  } catch {
    return false;
  }
}

/**
 * Liefert alle wartenden geteilten Dateien und entfernt sie aus dem Cache.
 * Gleichzeitige Aufrufe (StrictMode-Doppelmount) teilen sich einen Lauf,
 * damit keine Datei zweimal in die Pipeline geht.
 */
export function geteilteDateienAbholen() {
  if (!laufend) {
    laufend = holen().catch(() => []).finally(() => { laufend = null; });
    return laufend;
  }
  return laufend.then(() => []);
}

/** true, wenn geteilte PDFs auf die Abholung warten. */
export function hatGeteilteDateien() {
  return wartet(PRAEFIX);
}

/** true, wenn geteilte Fotos auf den Fotoimport warten. */
export function hatGeteilteFotos() {
  return wartet(PRAEFIX_FOTO);
}

/**
 * Liefert alle wartenden geteilten Fotos und entfernt sie aus dem Cache.
 * Der Aufrufer stellt sicher, dass er nur einmal abholt.
 */
export function geteilteFotosAbholen() {
  return holen(PRAEFIX_FOTO).catch(() => []);
}

function istPdf(f) {
  return f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
}

function alsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('FileReader-Fehler'));
    // data:application/pdf;base64,XXXX – das Backend schneidet den Präfix ab
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.readAsDataURL(file);
  });
}

async function einreichen() {
  const dateien = await geteilteDateienAbholen();
  const pdfs = dateien.filter(istPdf);
  const ergebnis = { jobIds: [], fehler: [], ohnePdf: dateien.length > 0 && pdfs.length === 0 };
  for (const f of pdfs) {
    try {
      // Gesamtanzahl mitgeben → Auto-Cache springt schon bei der ersten Datei an.
      const res = await api.import.upload(f.name, await alsBase64(f), '', pdfs.length);
      ergebnis.jobIds.push(res.jobId);
    } catch (err) {
      ergebnis.fehler.push(`${f.name}: ${err.message}`);
    }
  }
  return ergebnis;
}

let einreichenLaufend = null;

/**
 * Holt die wartenden geteilten PDFs ab und gibt jede einzeln in die Pipeline
 * (wie ein Batch-Upload ohne KI-Hinweis). Liefert { jobIds, fehler, ohnePdf }.
 * Gleichzeitige Aufrufe teilen sich einen Lauf und dasselbe Ergebnis.
 */
export function geteilteDateienEinreichen() {
  if (!einreichenLaufend) {
    einreichenLaufend = einreichen().finally(() => { einreichenLaufend = null; });
  }
  return einreichenLaufend;
}
