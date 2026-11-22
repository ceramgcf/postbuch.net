/**
 * lib/llm/lokal-modelle.js — liest das Manifest der lokalen KI (lokal-modelle.kv)
 *
 * Dieselbe Datei liest der Host-Agent in Bash; deshalb Zeilenformat statt JSON.
 * Die App braucht das Manifest nur zur Anzeige (Stack-Reiter: Modell, Größe,
 * Stufe) und zum Vergleich mit dem, was der Agent als geladen meldet. Laden,
 * Prüfen und Starten macht ausschließlich der Agent.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MANIFEST_PFAD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lokal-modelle.kv');

const SHA256_RE = /^[0-9a-f]{64}$/;
const DATEI_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.gguf$/;
const URL_PRAEFIX = 'https://huggingface.co/unsloth/';
const ROLLEN = new Set(['modell', 'mmproj', 'mtp']);
const JA_NEIN = new Set(['ja', 'nein']);

/**
 * Zerlegt den Manifest-Text. Wirft bei jedem Formfehler – ein kaputtes Manifest
 * ist ein Release-Fehler und soll im Test auffallen, nicht still übergangen werden.
 *
 * @param {string} text
 * @returns {{ modell: {schluessel,anzeige,lizenz}, dateien: object[], stufen: object[] }}
 */
export function parseManifest(text) {
  let modell = null;
  const dateien = [];
  const stufen = [];
  for (const [i, roh] of String(text).split('\n').entries()) {
    const zeile = roh.trim();
    if (!zeile || zeile.startsWith('#')) continue;
    const f = zeile.split('|');
    const fehler = (was) => new Error(`lokal-modelle.kv Zeile ${i + 1}: ${was}`);
    switch (f[0]) {
      case 'modell':
        if (f.length !== 4 || modell) throw fehler('modell-Zeile ungültig oder doppelt');
        modell = { schluessel: f[1], anzeige: f[2], lizenz: f[3] };
        break;
      case 'datei': {
        if (f.length !== 6) throw fehler('datei-Zeile braucht 6 Felder');
        const [, rolle, datei, sha256, bytes, url] = f;
        if (!ROLLEN.has(rolle)) throw fehler(`unbekannte Rolle ${rolle}`);
        if (!DATEI_RE.test(datei)) throw fehler(`Dateiname ${datei}`);
        if (!SHA256_RE.test(sha256)) throw fehler('sha256');
        if (!/^[1-9][0-9]{0,12}$/.test(bytes)) throw fehler('bytes');
        if (!url.startsWith(URL_PRAEFIX) || !url.endsWith(`/${datei}`) || /[\s"'`$\\]/.test(url)) throw fehler('url');
        if (dateien.some((d) => d.rolle === rolle)) throw fehler(`Rolle ${rolle} doppelt`);
        dateien.push({ rolle, datei, sha256, bytes: Number(bytes), url });
        break;
      }
      case 'stufe': {
        if (f.length !== 10) throw fehler('stufe-Zeile braucht 10 Felder');
        const [, name, vramAb, gpu, kontext, schichten, mtp, warnung, ram, anzeige] = f;
        if (!/^[a-z0-9-]{1,32}$/.test(name)) throw fehler('Stufenname');
        if (!/^[0-9]{1,6}$/.test(vramAb) || !/^[0-9]{4,7}$/.test(kontext) || !/^[0-9]{1,7}$/.test(ram)) throw fehler('Zahl');
        if (!JA_NEIN.has(gpu) || !JA_NEIN.has(mtp) || !JA_NEIN.has(warnung)) throw fehler('ja/nein');
        if (!/^(all|auto|[0-9]{1,3})$/.test(schichten)) throw fehler('gpu_schichten');
        stufen.push({
          name, vramAbMiB: Number(vramAb), gpu: gpu === 'ja', kontext: Number(kontext),
          gpuSchichten: schichten, mtp: mtp === 'ja', warnung: warnung === 'ja', ramMiB: Number(ram), anzeige,
        });
        break;
      }
      default:
        throw fehler(`unbekannter Zeilentyp ${f[0]}`);
    }
  }
  if (!modell) throw new Error('lokal-modelle.kv: modell-Zeile fehlt');
  for (const rolle of ['modell', 'mmproj']) {
    if (!dateien.some((d) => d.rolle === rolle)) throw new Error(`lokal-modelle.kv: Datei ${rolle} fehlt`);
  }
  if (stufen.some((s) => s.mtp) && !dateien.some((d) => d.rolle === 'mtp')) {
    throw new Error('lokal-modelle.kv: Stufe mit mtp ohne mtp-Datei');
  }
  if (!stufen.some((s) => !s.gpu && s.vramAbMiB === 0)) throw new Error('lokal-modelle.kv: CPU-Stufe fehlt');
  return { modell, dateien, stufen };
}

let cache = null;

/** Manifest des installierten Release (einmal gelesen). */
export function ladeManifest() {
  if (!cache) cache = parseManifest(fs.readFileSync(MANIFEST_PFAD, 'utf8'));
  return cache;
}

/**
 * Wählt die Stufe für eine erkannte Grafikkarte – dieselbe Regel wie im Agenten:
 * erste Stufe in Manifest-Reihenfolge, deren Bedingung erfüllt ist.
 *
 * @param {{ stufen: object[] }} manifest
 * @param {{ vramMiB: number }|null} gpu  null = keine nutzbare NVIDIA-Karte
 */
export function waehleStufe(manifest, gpu) {
  const vram = gpu && Number.isFinite(gpu.vramMiB) ? gpu.vramMiB : null;
  return manifest.stufen.find((s) => (s.gpu ? vram != null && vram >= s.vramAbMiB : true)) || null;
}

/** Dateien, die eine Stufe braucht. */
export function dateienFuerStufe(manifest, stufe) {
  return manifest.dateien.filter((d) => d.rolle !== 'mtp' || stufe?.mtp);
}

/** Download-Größe einer Stufe in Bytes. */
export function bytesFuerStufe(manifest, stufe) {
  return dateienFuerStufe(manifest, stufe).reduce((s, d) => s + d.bytes, 0);
}

/**
 * Mindestausstattung der lokalen KI – dieselben Werte wie in
 * scripts/postbuch-hostconfig.sh (HOSTCONFIG_LOKALKI_*). GB dezimal.
 */
export const LOKALKI_GRENZEN = Object.freeze({
  minSpeicherMiB: 22888,          // 24 GB Arbeitsspeicher + nutzbarer Grafikspeicher
  flottVramMiB: 7629,             // unter 8 GB Grafikspeicher wird es extrem langsam
  reserveBytes: 5 * 1024 ** 3,    // nach dem Modell müssen 5 GiB frei bleiben
});

const gbText = (bytes) => Math.round(bytes / 1e9).toLocaleString('de-DE');

/**
 * Taugt der Rechner für die lokale KI? Grundlage ist der Stack-Teil des
 * Agenten-Heartbeats. Unbekannte Werte (älterer Agent) sperren nicht – der
 * Agent prüft beim Einschalten selbst noch einmal.
 *
 * @param {object|null} stack  agent.stack
 * @returns {{ ramMiB: number|null, vramMiB: number, speicherMiB: number|null,
 *   langsam: boolean, sperrgrund: string|null }|null}
 */
export function lokalkiEignung(stack) {
  if (!stack) return null;
  const g = LOKALKI_GRENZEN;
  const gpu = stack.gpu;
  const vramMiB = gpu?.dockerBereit && Number.isFinite(gpu.vramMiB) ? gpu.vramMiB : 0;
  const ramMiB = Number.isFinite(stack.ramMiB) ? stack.ramMiB : null;
  const speicherMiB = ramMiB != null ? ramMiB + vramMiB : null;
  const lk = stack.lokalki;
  const fehltBytes = Number.isFinite(lk?.bedarf?.bytes)
    ? Math.max(0, lk.bedarf.bytes - (lk.vorhandenBytes || 0)) : null;
  const frei = Number.isFinite(stack.platteFreiBytes) ? stack.platteFreiBytes : null;

  let sperrgrund = null;
  if (speicherMiB != null && speicherMiB < g.minSpeicherMiB) {
    sperrgrund = `Zu wenig Speicher: Arbeitsspeicher und nutzbarer Grafikspeicher ergeben rund ${gbText(speicherMiB * 1024 ** 2)} GB, `
      + 'die lokale KI braucht mindestens 24 GB.';
  } else if (fehltBytes != null && frei != null && frei < fehltBytes + g.reserveBytes) {
    sperrgrund = `Zu wenig freier Speicherplatz: Das Modell braucht noch rund ${gbText(fehltBytes)} GB, danach müssen `
      + `mindestens 5 GB frei bleiben. Frei sind ${gbText(frei)} GB.`;
  }
  return { ramMiB, vramMiB, speicherMiB, langsam: vramMiB < g.flottVramMiB, sperrgrund };
}
