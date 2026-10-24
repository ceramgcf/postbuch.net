/**
 * Vorberechnete Hilfevektoren für den eingebauten Embedding-Dienst.
 *
 * Ein Release liefert zur Anwenderhilfe die Vektoren gleich mit, berechnet mit
 * genau dem Modell und den Vorsilben des eingebauten Dienstes. Eine neue
 * Instanz muss die Hilfe dann nicht selbst einbetten: Auf einem Raspberry Pi
 * wären das einige Minuten Volllast direkt nach der Installation.
 *
 * Format von app/hilfe-vektoren.json:
 *   { "format": 1, "signatur": "<embedding_signature>", "dim": 768,
 *     "abschnitte": { "<inhalt_hash>": "<float16 little-endian als Hex>" } }
 *
 * Hex statt Base64: Base64-Zeichenfolgen enthalten zufällig jedes kurze Wort.
 * Die Release-Audits suchen in allen ausgelieferten Dateien nach persönlichen
 * Kennungen und würden auf solche Zufallstreffer anschlagen.
 *
 * Schlüssel ist der Hash des Texts, der eingebettet würde (help-corpus.js).
 * Ein Abschnitt, dessen Text sich seit dem Erzeugen geändert hat, findet
 * keinen Eintrag und wird wie bisher lokal eingebettet. Die Datei ist damit
 * nie Voraussetzung, nur Abkürzung.
 */

import { readFile } from 'node:fs/promises';
import { toVectorLiteral } from './embedding.js';

export const HILFE_VEKTOREN_DATEI = process.env.POSTBUCH_HILFE_VEKTOREN || '/app/hilfe-vektoren.json';
const FORMAT = 1;

/** Vektor → Hex-Zeichenkette aus float16-Werten (little-endian). */
export function kodiereVektor(vec) {
  const dv = new DataView(new ArrayBuffer(vec.length * 2));
  vec.forEach((x, i) => dv.setFloat16(i * 2, x, true));
  return Buffer.from(dv.buffer).toString('hex');
}

/** Hex-Zeichenkette → Vektor; null bei falscher Länge oder ungültigen Werten. */
export function dekodiereVektor(hex, dim) {
  if (typeof hex !== 'string' || hex.length !== dim * 4 || !/^[0-9a-f]+$/.test(hex)) return null;
  const buf = Buffer.from(hex, 'hex');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const vec = new Array(dim);
  for (let i = 0; i < dim; i++) {
    const x = dv.getFloat16(i * 2, true);
    if (!Number.isFinite(x)) return null;
    vec[i] = x;
  }
  return vec;
}

/** Inhalt der Vektordatei als Objekt im Dateiformat. */
export function vektorDatei(signatur, dim, abschnitte) {
  const sortiert = Object.fromEntries(Object.entries(abschnitte).sort(([a], [b]) => (a < b ? -1 : 1)));
  return { format: FORMAT, signatur, dim, abschnitte: sortiert };
}

let cache = null;

/**
 * Liest die mitgelieferte Datei einmal je Prozess. Fehlt sie oder ist sie
 * unbrauchbar, gibt es schlicht keine vorberechneten Vektoren.
 */
async function ladeDatei(datei) {
  if (cache?.datei === datei) return cache.inhalt;
  let inhalt = null;
  try {
    const roh = JSON.parse(await readFile(datei, 'utf8'));
    const dim = Number(roh?.dim);
    if (roh?.format === FORMAT && typeof roh.signatur === 'string'
        && Number.isInteger(dim) && dim > 0 && roh.abschnitte && typeof roh.abschnitte === 'object') {
      inhalt = { signatur: roh.signatur, dim, abschnitte: roh.abschnitte };
    } else {
      console.warn(`[hilfe-vektoren] ${datei} hat ein unbekanntes Format, wird ignoriert`);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[hilfe-vektoren] ${datei} nicht lesbar: ${err.message}`);
  }
  cache = { datei, inhalt };
  return inhalt;
}

/**
 * Liefert einen Lieferanten für vorberechnete Vektoren der gegebenen Signatur:
 * `(inhaltHash) → halfvec-Literal | null`. Passt die Signatur nicht, liefert
 * er immer null.
 */
export async function vorberechneteHilfevektoren(signatur, { datei = HILFE_VEKTOREN_DATEI } = {}) {
  const inhalt = await ladeDatei(datei);
  if (!inhalt || inhalt.signatur !== signatur) return () => null;
  return (inhaltHash) => {
    const hex = Object.hasOwn(inhalt.abschnitte, inhaltHash) ? inhalt.abschnitte[inhaltHash] : null;
    const vec = hex ? dekodiereVektor(hex, inhalt.dim) : null;
    return vec ? toVectorLiteral(vec) : null;
  };
}

/** Nur für Tests: Cache verwerfen. */
export function _cacheLeeren() {
  cache = null;
}
