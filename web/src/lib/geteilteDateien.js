import { api } from '@/api/client';

// Abholseite des Share-Targets: Der Service-Worker (public/service-worker.js)
// legt per Teilen-Menü übergebene PDFs im Cache-Speicher ab und leitet auf
// die Jobs-Ansicht (/logs?geteilt=1); die holt sie hier ab, gibt sie in die
// Pipeline und verfolgt die Jobs. Name des Caches und Schlüsselpräfix müssen
// mit dem Service-Worker übereinstimmen.
const GETEILT_CACHE = 'postbuch-geteilt';
const PRAEFIX = '/__geteilt/';
// Nicht abgeholte Dateien (z. B. geteilt, aber nie angemeldet) verfallen,
// damit sie nicht Tage später unerwartet in die Pipeline gehen.
const HOECHSTALTER_MS = 24 * 60 * 60 * 1000;

function zeitstempel(req) {
  return Number(new URL(req.url).pathname.slice(PRAEFIX.length).split('-')[0]) || 0;
}

let laufend = null;

async function holen() {
  if (typeof caches === 'undefined') return [];
  const cache = await caches.open(GETEILT_CACHE);
  const schluessel = (await cache.keys())
    .filter((req) => new URL(req.url).pathname.startsWith(PRAEFIX))
    .sort((a, b) => a.url.localeCompare(b.url, undefined, { numeric: true }));
  const dateien = [];
  for (const req of schluessel) {
    const res = await cache.match(req);
    await cache.delete(req);
    if (!res || Date.now() - zeitstempel(req) > HOECHSTALTER_MS) continue;
    const blob = await res.blob();
    let name = 'geteilt.pdf';
    try { name = decodeURIComponent(res.headers.get('X-Dateiname') || name); } catch { /* Rohname behalten */ }
    dateien.push(new File([blob], name, { type: blob.type || 'application/pdf' }));
  }
  return dateien;
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

/** true, wenn geteilte Dateien auf die Abholung warten. */
export async function hatGeteilteDateien() {
  try {
    if (typeof caches === 'undefined') return false;
    const cache = await caches.open(GETEILT_CACHE);
    return (await cache.keys()).some((req) => new URL(req.url).pathname.startsWith(PRAEFIX)
      && Date.now() - zeitstempel(req) <= HOECHSTALTER_MS);
  } catch {
    return false;
  }
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
