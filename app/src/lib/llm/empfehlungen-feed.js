/**
 * lib/llm/empfehlungen-feed.js — Validierung des Empfehlungs-Feeds
 *
 * Im aktuellen Release-Modus wird `llm-empfehlungen.json` lokal mit der App
 * ausgeliefert. Der deaktiviert erhaltene Online-Pfad kann dieselbe Struktur
 * unter `<POSTBUCH_FEED_BASE_URL>/llm-empfehlungen.json` laden. Pro Modellklasse
 * gilt eine rangsortierte Kandidatenliste; der Client wählt den höchsten Rang,
 * auf den er nachweislich Zugriff hat (siehe `empfehlungen.js`).
 *
 * ── Harte Invariante ───────────────────────────────────────────────────────
 * **Der Feed darf keine Endpunkte und keine Secrets einführen.** Erlaubt sind
 * ausschließlich `(providerId | providerTyp, model, Preis, Text)`, und nur mit
 * Bezug auf **bereits vorhandene** Provider. Ein Kandidat mit `baseUrl`,
 * `apiKey`, `caps` oder `erlaubtPrivateZiele` wird **verworfen**, nicht
 * bereinigt: das ist ein Fehler auf Betreiberseite und soll sichtbar sein.
 * Ohne diese Regel wäre der Feed eine Remote-Config- und SSRF-/Exfil-Fläche —
 * wer ihn schreiben kann, würde sonst bestimmen, an welchen Host jede Instanz
 * ihre Dokumente schickt.
 *
 * **Embeddings sind ein Sonderfall, kein normaler Modellwechsel.** Die Klasse
 * `embedding` darf im Feed stehen — sie beantwortet die berechtigte Frage
 * „welches Embedding-Modell empfehlt ihr?" —, aber sie bleibt in
 * `empfehlungen.js` von jeder Sammelübernahme und von der Automatik
 * ausgenommen: `llm_embedding` trägt eine `dim`, die in jede
 * `embedding_signature` eingeht, und ein Modellwechsel entwertet den gesamten
 * Vektorbestand bis zum Neuaufbau. Deshalb ist die `dim` hier zusätzlich ein
 * **verbotenes Feld**: sie wird ausschließlich an der Instanz geprobt, nie aus
 * dem Feed geglaubt.
 */

import { textFeld, zahlImBereich, isoDatum } from '../postbuch-feed.js';
import { MODEL_CLASSES } from './model-classes.js';
import { PROVIDER_ID_RE, PROVIDER_TYPES } from './registry.js';

export const EMPFEHLUNGEN_SCHEMA_VERSION = 1;
export const EMPFEHLUNGEN_PFAD = '/llm-empfehlungen.json';

const MAX_KANDIDATEN_JE_KLASSE = 8;
const MODEL_RE = /^[A-Za-z0-9._:\/-]{1,120}$/;
const MAX_PREIS = 10_000;

/** Felder, deren bloße Anwesenheit den Kandidaten disqualifiziert. */
const VERBOTENE_FELDER = ['baseUrl', 'apiKey', 'key', 'caps', 'erlaubtPrivateZiele', 'url', 'endpoint', 'dialekt',
  // Die Embedding-Dimension wird geprobt, nicht behauptet (siehe Kopf).
  'dim', 'dimension', 'dimensions'];

/**
 * Schlüssel der Embedding-Sonderklasse. Sie steht bewusst NICHT in
 * `MODEL_CLASSES`: dort hängen die Klassen der Klassifikationskette, die über
 * `resolveModelConfig` aufgelöst und pauschal übernommen werden dürfen. Das
 * Embedding-Modell wird an genau einer Stelle gesetzt (`llm_embedding` samt
 * geprobter Dimension) und nur einzeln und ausdrücklich.
 */
export const EMBEDDING_KLASSE = 'embedding';

const KLASSEN_SCHLUESSEL = new Set([...MODEL_CLASSES.map((c) => c.key), EMBEDDING_KLASSE]);

class EmpfehlungsFehler extends Error {
  constructor(message) {
    super(message);
    this.name = 'EmpfehlungsFehler';
  }
}

function fehler(msg) {
  throw new EmpfehlungsFehler(`Ungültiger Empfehlungs-Feed: ${msg}`);
}

/**
 * Ein einzelner Kandidat. Gibt `null` zurück, wenn er verworfen wird — das ist
 * kein Abbruch des ganzen Feeds: ein neues Modell, das diese Postbuch-Version
 * noch nicht kennt, soll die übrigen Empfehlungen nicht mitreißen.
 */
function kandidat(roh, rang) {
  if (!roh || typeof roh !== 'object' || Array.isArray(roh)) return null;
  for (const f of VERBOTENE_FELDER) {
    if (roh[f] !== undefined) {
      console.warn(`[empfehlungen-feed] Kandidat verworfen: unerlaubtes Feld "${f}"`);
      return null;
    }
  }

  const providerId = typeof roh.providerId === 'string' && PROVIDER_ID_RE.test(roh.providerId.trim())
    ? roh.providerId.trim() : null;
  const providerTyp = typeof roh.providerTyp === 'string' && PROVIDER_TYPES.includes(roh.providerTyp.trim())
    ? roh.providerTyp.trim() : null;
  if (!providerId && !providerTyp) return null;

  const model = typeof roh.model === 'string' && MODEL_RE.test(roh.model.trim())
    ? roh.model.trim() : null;
  if (!model) return null;

  const label = textFeld(roh.label, 80);
  const notiz = textFeld(roh.notiz, 200);
  if (label === null || notiz === null) return null;

  // Preise dürfen fehlen (lokale Modelle kosten nichts), aber wenn sie da sind,
  // müssen beide da und plausibel sein — ein halber Preis rechnet falsch.
  let preisIn = null;
  let preisOut = null;
  if (roh.preisIn != null || roh.preisOut != null) {
    preisIn = zahlImBereich(roh.preisIn, 0, MAX_PREIS);
    preisOut = zahlImBereich(roh.preisOut, 0, MAX_PREIS);
    if (preisIn == null || preisOut == null) return null;
  }
  // Cache-Preise sind einzeln optional (nicht jeder Anbieter kennt beide
  // Klassen), aber nur zusammen mit einem Input-/Output-Preis sinnvoll.
  let preisCacheWrite = null;
  let preisCacheRead = null;
  if (roh.preisCacheWrite != null || roh.preisCacheRead != null) {
    if (preisIn == null) return null;
    if (roh.preisCacheWrite != null) {
      preisCacheWrite = zahlImBereich(roh.preisCacheWrite, 0, MAX_PREIS);
      if (preisCacheWrite == null) return null;
    }
    if (roh.preisCacheRead != null) {
      preisCacheRead = zahlImBereich(roh.preisCacheRead, 0, MAX_PREIS);
      if (preisCacheRead == null) return null;
    }
  }

  const waehrung = roh.waehrung == null ? 'USD' : textFeld(roh.waehrung, 8);
  if (waehrung !== 'USD') return null;   // buildCostMap rechnet ausschließlich in USD

  return { rang, providerId, providerTyp, model, label: label || model, notiz: notiz || '', preisIn, preisOut, preisCacheWrite, preisCacheRead, waehrung };
}

/**
 * Validiert den rohen Feed und gibt eine saubere Kopie zurück.
 *
 * @param {unknown} obj
 * @returns {{schemaVersion:number, stand:string, hinweis:string, klassen:Record<string,Array>}}
 * @throws {EmpfehlungsFehler}
 */
export function validiereEmpfehlungen(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) fehler('kein JSON-Objekt.');

  if (obj.schemaVersion !== EMPFEHLUNGEN_SCHEMA_VERSION) {
    fehler(`schemaVersion ${JSON.stringify(obj.schemaVersion)} wird nicht unterstützt `
      + `(erwartet: ${EMPFEHLUNGEN_SCHEMA_VERSION}).`);
  }

  const stand = isoDatum(obj.stand);
  if (!stand) fehler('"stand" ist kein Datum im Format YYYY-MM-DD.');

  const hinweis = obj.hinweis == null ? '' : textFeld(obj.hinweis, 500);
  if (hinweis === null) fehler('"hinweis" ist zu lang oder enthält Markup.');

  if (!obj.klassen || typeof obj.klassen !== 'object' || Array.isArray(obj.klassen)) {
    fehler('"klassen" fehlt oder ist kein Objekt.');
  }

  const klassen = {};
  for (const [key, liste] of Object.entries(obj.klassen)) {
    // Unbekannte Schlüssel verwerfen, nicht abbrechen: der Feed darf Klassen
    // enthalten, die es in dieser Postbuch-Version noch nicht gibt.
    if (!KLASSEN_SCHLUESSEL.has(key)) continue;
    if (!Array.isArray(liste)) continue;
    if (liste.length > MAX_KANDIDATEN_JE_KLASSE) {
      fehler(`Klasse "${key}" hat ${liste.length} Kandidaten — erlaubt sind höchstens ${MAX_KANDIDATEN_JE_KLASSE}.`);
    }
    const geprueft = liste
      .map((k, i) => kandidat(k, i + 1))
      .filter(Boolean)
      // Ränge nach dem Filtern neu vergeben, damit „#1" im UI der erste
      // tatsächlich angezeigte Kandidat ist.
      .map((k, i) => ({ ...k, rang: i + 1 }));
    if (geprueft.length) klassen[key] = geprueft;
  }

  return { schemaVersion: EMPFEHLUNGEN_SCHEMA_VERSION, stand, hinweis: hinweis || '', klassen };
}

export { EmpfehlungsFehler };
