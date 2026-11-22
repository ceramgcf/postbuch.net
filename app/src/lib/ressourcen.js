/**
 * lib/ressourcen.js – zählende Sperren mit Prioritäten für knappe Ressourcen
 *
 * Begrenzt wird an der Ressource selbst, nicht am Dokument: Ein KI-Server mit
 * einem Rechenplatz verträgt genau einen Aufruf gleichzeitig, egal ob er aus der
 * Pipeline, dem Bescheid-Fachjob oder dem Chat kommt. Wer wartet, belegt nichts.
 *
 * Ressourcen:
 *   ki:<host>   – ein KI-Server (LLM oder Embedding). Lokale Server (Docker-
 *                 Dienst, LAN, localhost) bekommen `ki_parallel_lokal` Plätze,
 *                 alle übrigen `ki_parallel_cloud`.
 *   rechnen     – Ghostscript-Läufe (Rendern, Textebene, Graustufen, QR-Raster),
 *                 `rechnen_parallel` Plätze, Standard: Kerne − 1.
 *
 * Vergabe: kleinste Priorität zuerst; je AGING_MS Wartezeit rückt ein Auftrag
 * eine Stufe vor, damit Hintergrundarbeit nicht verhungert. Gesperrt wird nur
 * um Blattaufrufe herum (ein HTTP-Request, ein Prozessstart), daher gibt es
 * keine verschachtelte Belegung derselben Ressource.
 */

import os from 'node:os';

export const PRIO = Object.freeze({ interaktiv: 0, eingang: 1, verarbeitung: 2, hintergrund: 3 });

const AGING_MS = 2 * 60 * 1000;
const ABBRUCH_PRUEF_MS = 2000;

const sperren = new Map();
let seq = 0;

function sperre(name) {
  let s = sperren.get(name);
  if (!s) {
    s = { name, kapazitaet: 1, belegt: 0, wartende: [] };
    sperren.set(name, s);
  }
  return s;
}

function rang(w) {
  return w.seit + w.prio * AGING_MS;
}

function vergib(s) {
  while (s.belegt < s.kapazitaet && s.wartende.length) {
    let besterIdx = 0;
    for (let i = 1; i < s.wartende.length; i++) {
      const a = s.wartende[i], b = s.wartende[besterIdx];
      if (rang(a) < rang(b) || (rang(a) === rang(b) && a.seq < b.seq)) besterIdx = i;
    }
    const [w] = s.wartende.splice(besterIdx, 1);
    s.belegt++;
    w.los();
  }
}

/**
 * Führt `fn` aus, sobald ein Platz der Ressource frei ist.
 *
 * @param {string}   name
 * @param {Function} fn
 * @param {object}   [opts]
 * @param {number}   [opts.kapazitaet]   aktuelle Platzzahl (wird übernommen)
 * @param {number}   [opts.prio]         PRIO.*, Standard: verarbeitung
 * @param {Function} [opts.abgebrochen]  () => boolean; bricht das Warten ab
 * @param {Function} [opts.abbruchFehler] () => Error für den Abbruch
 */
export async function mitRessource(name, fn, opts = {}) {
  const s = sperre(name);
  if (Number.isInteger(opts.kapazitaet) && opts.kapazitaet > 0) s.kapazitaet = opts.kapazitaet;
  const prio = Number.isInteger(opts.prio) ? opts.prio : PRIO.verarbeitung;

  if (s.belegt >= s.kapazitaet || s.wartende.length) {
    await new Promise((resolve, reject) => {
      const w = { prio, seit: Date.now(), seq: seq++, los: null };
      let timer = null;
      w.los = () => { if (timer) clearInterval(timer); resolve(); };
      if (opts.abgebrochen) {
        timer = setInterval(() => {
          if (!opts.abgebrochen()) return;
          clearInterval(timer);
          const i = s.wartende.indexOf(w);
          if (i >= 0) s.wartende.splice(i, 1);
          reject(opts.abbruchFehler ? opts.abbruchFehler() : new Error('Abgebrochen'));
        }, ABBRUCH_PRUEF_MS);
        timer.unref?.();
      }
      s.wartende.push(w);
      vergib(s);
    });
  } else {
    s.belegt++;
  }

  try {
    return await fn();
  } finally {
    s.belegt--;
    vergib(s);
  }
}

/** Momentaufnahme für Diagnose und Jobs-Anzeige. */
export function ressourcenStatus() {
  return [...sperren.values()].map((s) => ({
    name: s.name, kapazitaet: s.kapazitaet, belegt: s.belegt, wartend: s.wartende.length,
  }));
}

// ── Einordnung ──────────────────────────────────────────────────────────────

const PRIVATE_V4 = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/;

/** Läuft der Dienst hinter dieser URL auf diesem Rechner oder im eigenen Netz? */
export function istLokalerDienst(baseUrl) {
  let host;
  try { host = new URL(baseUrl).hostname.toLowerCase(); } catch { return false; }
  if (!host) return false;
  if (!host.includes('.')) return true; // Docker-Dienstname, localhost
  if (host === 'host.docker.internal' || host.endsWith('.local') || host.endsWith('.lan')) return true;
  if (PRIVATE_V4.test(host)) return true;
  return host.startsWith('[') || host === '::1';
}

function ganzzahl(v, standard) {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n > 0 ? n : standard;
}

/**
 * Ressourcenname und Platzzahl für einen KI-Provider. Zwei Provider mit
 * derselben Adresse teilen sich die Plätze.
 */
export function kiRessource(provider, settings = {}) {
  const baseUrl = provider?.baseUrl || '';
  let host = provider?.id || 'unbekannt';
  try { if (baseUrl) host = new URL(baseUrl).host; } catch { /* id bleibt */ }
  const lokal = baseUrl ? istLokalerDienst(baseUrl) : false;
  const kapazitaet = lokal
    ? ganzzahl(settings.ki_parallel_lokal, 1)
    : ganzzahl(settings.ki_parallel_cloud, 6);
  return { name: `ki:${host}`, kapazitaet };
}

/** Priorität nach Art des Aufrufs (meta.kategorie). */
export function prioFuerKategorie(kategorie) {
  switch (kategorie) {
    case 'chat':
    case 'chat_title':
    case 'search':
    case 'akte_vorschlag':
      return PRIO.interaktiv;
    case 'hilfe':
    case 'kostentraeger-profilierung':
      return PRIO.hintergrund;
    default:
      return PRIO.verarbeitung;
  }
}

let rechenPlaetze = Math.max(1, os.cpus().length - 1);

/** Übernimmt `rechnen_parallel` aus den Settings (beim Laden aufgerufen). */
export function konfiguriereRessourcen(settings = {}) {
  rechenPlaetze = ganzzahl(settings.rechnen_parallel, Math.max(1, os.cpus().length - 1));
}

/**
 * Rechenlastiger Blattaufruf (Ghostscript o. Ä.).
 * @param {{ prio?: number }} [opts]  PRIO.*, Standard: verarbeitung
 */
export function mitRechenplatz(fn, opts = {}) {
  return mitRessource('rechnen', fn, { kapazitaet: rechenPlaetze, prio: opts.prio });
}
