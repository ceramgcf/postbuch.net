/**
 * service/eingang-vorschau.js – Vorschaubilder der Eingangsgalerie
 *
 * Seite 1 eines Eingangs als kleines JPEG. Gerechnet wird mit dem vorhandenen
 * Rasterpfad (lib/pdf.js) und Hintergrundpriorität, höchstens ein Bild
 * gleichzeitig. Der Cache liegt im Container und ist jederzeit neu erzeugbar;
 * ein Recreate leert ihn folgenlos.
 *
 * Ein Cachebild berechtigt zu nichts: Der Aufrufer schlägt die Quelle vor
 * jedem Abruf neu nach und übergibt nur dann einen Cacheschlüssel.
 */

import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { mkdir, readFile, writeFile, readdir, stat, unlink, rename } from 'node:fs/promises';
import { renderPdfToImages } from '../lib/pdf.js';
import { PRIO } from '../lib/ressourcen.js';

const CACHE_DIR = path.join(os.tmpdir(), 'postbuch-eingang-vorschau');
const CACHE_MAX_BYTES = 40 * 1024 * 1024;
const CACHE_MAX_ALTER_MS = 7 * 24 * 60 * 60 * 1000;
const LANGE_KANTE_PX = 566;        // A4 hochkant ≈ 400 px breit
const RENDER_TIMEOUT_MS = 20_000;
const MAX_PDF_BYTES = 80 * 1024 * 1024;
const MAX_WARTEND = 24;

const _laufende = new Map(); // Cacheschlüssel → Promise<Buffer>
let _kette = Promise.resolve(); // serialisiert die Renderläufe
let _wartend = 0;
let _aufraeumenAm = 0;

function dateiFuer(schluessel) {
  return path.join(CACHE_DIR, `${createHash('sha256').update(schluessel).digest('hex')}.jpg`);
}

export class VorschauUeberlastetError extends Error {
  constructor() {
    super('Zu viele Vorschaubilder in Arbeit.');
    this.name = 'VorschauUeberlastetError';
  }
}

/**
 * Hält den Cache unter dem Größendeckel und entfernt alte Bilder. Läuft
 * höchstens alle zehn Minuten.
 */
async function raeumeAuf() {
  const jetzt = Date.now();
  if (jetzt - _aufraeumenAm < 10 * 60 * 1000) return;
  _aufraeumenAm = jetzt;
  let namen;
  try { namen = await readdir(CACHE_DIR); } catch { return; }
  const dateien = [];
  for (const name of namen) {
    const pfad = path.join(CACHE_DIR, name);
    try {
      const st = await stat(pfad);
      if (jetzt - st.mtimeMs > CACHE_MAX_ALTER_MS) await unlink(pfad);
      else dateien.push({ pfad, groesse: st.size, zeit: st.mtimeMs });
    } catch { /* gleichzeitig entfernt */ }
  }
  let summe = dateien.reduce((s, d) => s + d.groesse, 0);
  dateien.sort((a, b) => a.zeit - b.zeit);
  for (const d of dateien) {
    if (summe <= CACHE_MAX_BYTES) break;
    await unlink(d.pfad).catch(() => {});
    summe -= d.groesse;
  }
}

async function rendere(schluessel, ladePdf, langeKanteMax) {
  const pdf = await ladePdf();
  if (!pdf?.length) throw new Error('PDF nicht verfügbar.');
  if (pdf.length > MAX_PDF_BYTES) throw new Error('PDF zu groß für eine Vorschau.');
  const { bilder } = await renderPdfToImages(pdf, {
    maxSeiten: 1,
    langeKanteMax,
    device: 'jpeg',
    maxBytesGesamt: 2 * 1024 * 1024,
    timeoutMs: RENDER_TIMEOUT_MS,
    prio: PRIO.hintergrund,
  });
  const bild = bilder[0]?.buffer;
  if (!bild) throw new Error('Vorschau konnte nicht erzeugt werden.');
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    const ziel = dateiFuer(schluessel);
    const tmp = `${ziel}.${process.pid}.tmp`;
    await writeFile(tmp, bild);
    await rename(tmp, ziel);
    raeumeAuf().catch(() => {});
  } catch (err) {
    console.warn(`[eingang-vorschau] Cache nicht beschreibbar: ${err.message}`);
  }
  return bild;
}

/**
 * Liefert das Vorschaubild zu einem Cacheschlüssel.
 *
 * @param {string} schluessel               Quellidentität plus Änderungsmerkmal
 * @param {() => Promise<Buffer>} ladePdf   wird nur bei fehlendem Cachebild aufgerufen
 * @param {{ langeKante?: number }} [opts]  Kantenlänge in px (Standard 566, höchstens 1600)
 * @returns {Promise<Buffer>} JPEG
 */
export async function holeVorschau(schluessel, ladePdf, { langeKante = LANGE_KANTE_PX } = {}) {
  const kante = Math.min(1600, Math.max(200, Math.round(Number(langeKante) || LANGE_KANTE_PX)));
  if (kante !== LANGE_KANTE_PX) schluessel = `${schluessel}@${kante}`;
  try {
    return await readFile(dateiFuer(schluessel));
  } catch { /* nicht im Cache */ }

  // Gleichzeitige Anforderungen desselben Bildes teilen sich einen Lauf.
  const laufend = _laufende.get(schluessel);
  if (laufend) return laufend;
  if (_wartend >= MAX_WARTEND) throw new VorschauUeberlastetError();

  _wartend++;
  const lauf = _kette.then(() => rendere(schluessel, ladePdf, kante));
  // Ein Fehler darf die Kette nicht abreißen lassen.
  _kette = lauf.catch(() => {});
  _laufende.set(schluessel, lauf);
  const fertig = () => { _wartend--; _laufende.delete(schluessel); };
  lauf.then(fertig, fertig);
  return lauf;
}
