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

// Liefert [{ datei, entfernen }]. Ohne `behalten` ist jede Datei sofort aus dem
// Cache gelöscht; mit `behalten` erst, wenn der Aufrufer `entfernen()` ruft –
// so geht eine PDF bei einem gescheiterten Upload nicht verloren.
async function holen(praefix = PRAEFIX, { behalten = false } = {}) {
  if (typeof caches === 'undefined') return [];
  const cache = await caches.open(GETEILT_CACHE);
  const schluessel = (await cache.keys())
    .filter((req) => new URL(req.url).pathname.startsWith(praefix))
    .sort((a, b) => a.url.localeCompare(b.url, undefined, { numeric: true }));
  const eintraege = [];
  for (const req of schluessel) {
    const res = await cache.match(req);
    const entfernen = () => cache.delete(req).catch(() => false);
    if (!res || Date.now() - zeitstempel(req, praefix) > HOECHSTALTER_MS) { await entfernen(); continue; }
    if (!behalten) await entfernen();
    const blob = await res.blob();
    let name = praefix === PRAEFIX ? 'geteilt.pdf' : 'geteilt';
    try { name = decodeURIComponent(res.headers.get('X-Dateiname') || name); } catch { /* Rohname behalten */ }
    eintraege.push({ datei: new File([blob], name, { type: blob.type || 'application/pdf' }), entfernen });
  }
  return eintraege;
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
  return holen(PRAEFIX_FOTO).then((e) => e.map((x) => x.datei)).catch(() => []);
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

function dauerhaftAbgelehnt(status) {
  return status >= 400 && status < 500 && ![401, 408, 429].includes(status);
}

// Eine PDF verlässt den Cache erst nach erfolgreichem Upload. Scheitert er
// (Server nicht erreichbar, 5xx), bleibt sie liegen und lässt sich erneut
// einreichen – per Knopf oder beim nächsten Öffnen von postbuch.net.
async function einreichen() {
  const eintraege = await holen(PRAEFIX, { behalten: true }).catch(() => []);
  const pdfs = eintraege.filter((e) => istPdf(e.datei));
  // Andere Dateitypen lassen sich nie übernehmen – nicht aufbewahren.
  for (const e of eintraege) if (!istPdf(e.datei)) await e.entfernen();
  const ergebnis = { jobIds: [], fehler: [], wartend: 0, ohnePdf: eintraege.length > 0 && pdfs.length === 0 };
  for (const { datei: f, entfernen } of pdfs) {
    try {
      // Gesamtanzahl mitgeben → Auto-Cache springt schon bei der ersten Datei an.
      const res = await api.import.upload(f.name, await alsBase64(f), '', pdfs.length);
      ergebnis.jobIds.push(res.jobId);
      await entfernen();
    } catch (err) {
      ergebnis.fehler.push(`${f.name}: ${err.message}`);
      // Abgelehnt (z. B. Lesezugriff, ungültige PDF): ein neuer Versuch ändert
      // nichts. Nicht erreichbar, 5xx, 401, 408, 429: aufbewahren.
      if (dauerhaftAbgelehnt(err.status)) await entfernen();
      else ergebnis.wartend += 1;
    }
  }
  return ergebnis;
}

let einreichenLaufend = null;

/**
 * Holt die wartenden geteilten PDFs ab und gibt jede einzeln in die Pipeline
 * (wie ein Batch-Upload ohne KI-Hinweis). Liefert { jobIds, fehler, wartend, ohnePdf };
 * `wartend` zählt die PDFs, deren Upload scheiterte und die im Cache bleiben.
 * Gleichzeitige Aufrufe (StrictMode-Doppelmount) teilen sich einen Lauf und
 * dasselbe Ergebnis, damit keine Datei zweimal in die Pipeline geht.
 */
export function geteilteDateienEinreichen() {
  if (!einreichenLaufend) {
    einreichenLaufend = einreichen().finally(() => { einreichenLaufend = null; });
  }
  return einreichenLaufend;
}
