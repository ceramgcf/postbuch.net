/**
 * service/extract-validator.js — Prüfung & Reparatur des KI-Extraktionsergebnisses
 *
 * Anlass: Ungültige KI-Klassifikationscodes sprengten früher den DB-Insert nach Download, KI-Analyse,
 * Duplikatprüfung und Ablage-Sortierung, also am teuersten möglichen Zeitpunkt.
 * Dieselbe Landmine lag auf briefdatum (date), schlagwoerter (text[]) und
 * confidence (numeric(3,2) mit CHECK 0..1).
 *
 * Ablauf (Phase 2.5 der Pipeline, siehe service/document-processor.js):
 *   1. Hygiene: Steuer-/Unsichtbar-Zeichen raus, NFC, Längenbudget, _-Keys strippen
 *   2. Prüfung gegen die Feldregeln → Liste der Verstöße
 *   3. Bei mindestens einem Verstoß: GENAU EIN Repair-Call an die KI
 *   4. Erneute Prüfung. Was dann noch ungültig ist, wird deterministisch
 *      koerziert; was auch das nicht rettet, wird genullt (bzw. ist fatal)
 *
 * Bewusste Entscheidungen:
 * - Diese Schicht WIRFT NICHT bei Validierungsverstößen und läuft NICHT innerhalb
 *   der Modell-Fallback-Kette in lib/llm.js. Dort bedeutet ein throw „Modell
 *   gescheitert, nimm das nächste" — ein Verstoß würde sonst einen Repair-Call
 *   pro Kettenglied und im Extremfall den 10-Minuten-Retry auslösen und damit
 *   einen der wenigen Pipeline-Slots blockieren.
 * - Der Merge der Repair-Antwort läuft ausschließlich auf den beanstandeten
 *   Pfaden. Ein Repair-Call, der das volle JSON zurückgibt, dürfte sonst
 *   unbeanstandete Beträge und Befundtexte stillschweigend umschreiben.
 * - Rückgabe ist rein; die Politik „wann wird repariert" steckt allein in
 *   sollRepariert().
 */

import { appLog } from '../app-log.js';
import { callLLM, parseJsonFromText, resolveTierModelConfig } from '../lib/llm.js';
import { kanonisiere } from '../lib/db-enums.js';
import { getAktiveTaxonomie } from '../lib/taxonomie.js';
import { toDate, toNumeric, toBetrag, MAX_BETRAG, MAX_FAKTOR } from '../lib/coerce.js';
import { buildRepairPrompt } from '../prompts/repair.js';

// Hygiene-Budgets. Bislang begrenzte allein maxTokens=8192 in lib/llm.js die
// Größe des Ergebnisses — ein impliziter Schutz an ganz anderer Stelle, der
// wegfällt, sobald jemand diesen Wert erhöht.
const MAX_STRING_LEN = 4000;
const MAX_LISTEN_EINTRAEGE = 40;
const MAX_LISTEN_EINTRAG_LEN = 120;
// Im Repair-Prompt zitierte Werte: ein Wert, der eine Regel verletzt, ist per
// Definition nicht vertrauenswürdig — Länge ist hier kein Informationsverlust.
const MAX_ZITAT_LEN = 200;

const WINKEL = [0, 90, 180, 270];
// Deckungsgleich mit der CHECK-Constraint hand_leistungsjahr_ck.
const JAHR_MIN = 1900;
const JAHR_MAX = 2100;

// Mindeststruktur der Fachblöcke. Die Werte selbst dürfen je nach Lesbarkeit
// null sein; die Schlüssel müssen das Modell aber bewusst ausgegeben haben.
// So ist ein fehlender Block von einem tatsächlich nicht ermittelbaren Wert
// unterscheidbar und kann bereits in der Modell-Fallback-Kette abgefangen werden.
const FACHBLOCK_FELDER = {
  arztrechnung: ['rechnungsdatum', 'nameArzt', 'behandeltePerson', 'leistung', 'gesamtbetrag', 'einzelpositionen'],
  handwerkerrechnung: ['rechnungsdatum', 'nameUnternehmen', 'leistung', 'gesamtbetrag', 'lohnkosten'],
  arztbericht: ['behandeltePerson', 'anlass', 'normBefunde', 'pathologischeBefunde'],
  erstattungsbescheid: ['kostenträger', 'bescheiddatum', 'erstattungsbetrag'],
  generischeRechnung: ['reNr', 'rechnungsdatum', 'faelligkeit', 'gesamtbetrag', 'absender', 'bezahltAm'],
};

const PIPELINE_FACHBLOCK = {
  arztrechnung: 'arztrechnung',
  handwerker: 'handwerkerrechnung',
  arztbericht: 'arztbericht',
  erstattungsbescheid: 'erstattungsbescheid',
};

/**
 * Prüft die vom Modell geschuldete Fachblock-Mindeststruktur anhand derselben
 * DB-Taxonomie, aus der auch der Klassifikationsprompt gebaut wird.
 *
 * @returns {string|null} Fehlermeldung für Modell-Fallback bzw. Pipeline-Abbruch
 */
export function pruefeFachblockStruktur(data, taxonomie) {
  if (!data || typeof data !== 'object') return 'Extraktion ist kein JSON-Objekt';
  if (typeof data.istRechnung !== 'boolean') return 'Pflichtfeld "istRechnung" fehlt oder ist kein Boolean';

  const dokumentart = (taxonomie?.dokumentarten || [])
    .find((d) => d.code === data.dokumentart);
  const istAktiviert = (taxonomie?.aktivierungen || []).some((a) =>
    a.lebensbereich_code === data.lebensbereich
    && a.dokumentart_code === data.dokumentart);
  const pipeline = istAktiviert ? dokumentart?.spezial_pipeline : null;
  const fachblock = PIPELINE_FACHBLOCK[pipeline]
    || (data.istRechnung ? 'generischeRechnung' : null);

  if (!fachblock) return null;

  const block = data[fachblock];
  if (!block || typeof block !== 'object' || Array.isArray(block)) {
    return `Pflicht-Fachblock "${fachblock}" fehlt oder ist kein Objekt`;
  }

  const fehlend = FACHBLOCK_FELDER[fachblock]
    .filter((feld) => !Object.prototype.hasOwnProperty.call(block, feld));
  if (fehlend.length) {
    return `Pflicht-Fachblock "${fachblock}" ist unvollständig; fehlend: ${fehlend.join(', ')}`;
  }
  if (fachblock === 'arztrechnung' && !Array.isArray(block.einzelpositionen)) {
    return 'Pflichtfeld "arztrechnung.einzelpositionen" ist keine Liste';
  }
  return null;
}

// Unterstrich-Felder, die die App selbst an das Ergebnis hängt (lib/llm.js:774).
// Alles andere mit führendem Unterstrich stammt aus der Modellantwort und fliegt
// raus — siehe saeubere().
const APP_FELDER = ['_pipelineLog'];

// ── Feldregeln ───────────────────────────────────────────────────────────────
function feldRegeln(lxdCodes, data) {
  // Ein sD-faehiges D darf ohne gueltiges L nie auf "allgemeines" sinken:
  // dadurch wuerde die LxD-Aktivierung der Spezialpipeline still ausbleiben.
  const dIstSpezialfaehig = lxdCodes.sdDokumentarten.has(data?.dokumentart);
  return [
    { pfad: 'lebensbereich', regel: 'ENUM', erlaubt: lxdCodes.lebensbereiche, pflicht: true, nullbar: !dIstSpezialfaehig },
    { pfad: 'dokumentart', regel: 'ENUM', erlaubt: lxdCodes.dokumentarten, pflicht: true, nullbar: false },

    { pfad: 'postbuch.briefdatum', regel: 'DATUM' },
    { pfad: 'postbuch.bezahlStatus.bezahltAm', regel: 'DATUM' },
    { pfad: 'postbuch.schlagwörter', regel: 'LISTE' },
    { pfad: 'postbuch.schlagwoerter', regel: 'LISTE' },

    { pfad: 'qualityFlags.sicherheitsgrad', regel: 'ANTEIL' },
    { pfad: 'rotation', regel: 'WINKEL' },

    { pfad: 'handwerkerrechnung.rechnungsdatum', regel: 'DATUM' },
    { pfad: 'handwerkerrechnung.zahlungstermin', regel: 'DATUM' },
    { pfad: 'handwerkerrechnung.gesamtbetrag', regel: 'ZAHL', max: MAX_BETRAG },
    { pfad: 'handwerkerrechnung.lohnkosten', regel: 'ZAHL', max: MAX_BETRAG },
    { pfad: 'handwerkerrechnung.leistungsjahr', regel: 'JAHR' },

    { pfad: 'arztrechnung.rechnungsdatum', regel: 'DATUM' },
    { pfad: 'arztrechnung.zahlungstermin', regel: 'DATUM' },
    { pfad: 'arztrechnung.gesamtbetrag', regel: 'ZAHL', max: MAX_BETRAG },
    { pfad: 'arztrechnung.einzelpositionen[].behandlungsDatum', regel: 'DATUM' },
    { pfad: 'arztrechnung.einzelpositionen[].faktor', regel: 'ZAHL', max: MAX_FAKTOR },
    { pfad: 'arztrechnung.einzelpositionen[].betrag', regel: 'ZAHL', max: MAX_BETRAG },
    { pfad: 'arztrechnung.einreichungSeiteVon', regel: 'SEITE' },
    { pfad: 'arztrechnung.einreichungSeiteBis', regel: 'SEITE' },

    { pfad: 'erstattungsbescheid.bescheiddatum', regel: 'DATUM' },
    { pfad: 'erstattungsbescheid.erstattungsbetrag', regel: 'ZAHL', max: MAX_BETRAG },
    { pfad: 'erstattungsbescheid.kostenträger', regel: 'ENUM', erlaubt: ['Beihilfe', 'PKV'] },

    { pfad: 'generischeRechnung.rechnungsdatum', regel: 'DATUM' },
    { pfad: 'generischeRechnung.faelligkeit', regel: 'DATUM' },
    { pfad: 'generischeRechnung.bezahltAm', regel: 'DATUM' },
    { pfad: 'generischeRechnung.gesamtbetrag', regel: 'ZAHL', max: MAX_BETRAG },
  ];
}

// ── Pfad-Zugriff ─────────────────────────────────────────────────────────────
// Pfade sind punktgetrennt; '[]' expandiert über ein Array, '[n]' adressiert
// einen konkreten Index (so kommen die Pfade aus der Repair-Antwort zurück).

function teilePfad(pfad) {
  return pfad.split('.').map((t) => {
    const m = t.match(/^(.*)\[(\d*)\]$/);
    return m ? { key: m[1], index: m[2] === '' ? '*' : Number(m[2]) } : { key: t, index: null };
  });
}

/** Alle konkreten Pfade, die eine (ggf. '[]'-haltige) Regel im Objekt trifft. */
function expandiere(obj, pfad) {
  let treffer = [{ pfad: '', ziel: obj }];
  for (const { key, index } of teilePfad(pfad)) {
    const naechste = [];
    for (const t of treffer) {
      const wert = t.ziel?.[key];
      const basis = t.pfad ? `${t.pfad}.${key}` : key;
      if (index === null) {
        naechste.push({ pfad: basis, ziel: wert });
      } else if (index === '*') {
        if (Array.isArray(wert)) {
          wert.forEach((el, i) => naechste.push({ pfad: `${basis}[${i}]`, ziel: el }));
        }
      } else if (Array.isArray(wert)) {
        naechste.push({ pfad: `${basis}[${index}]`, ziel: wert[index] });
      }
    }
    treffer = naechste;
  }
  return treffer;
}

function setzeAn(obj, pfad, wert) {
  const teile = teilePfad(pfad);
  let ziel = obj;
  for (let i = 0; i < teile.length - 1; i++) {
    const { key, index } = teile[i];
    ziel = index === null || index === '*' ? ziel?.[key] : ziel?.[key]?.[index];
    if (ziel == null || typeof ziel !== 'object') return false;
  }
  const letzt = teile[teile.length - 1];
  if (letzt.index === null) {
    if (!ziel || typeof ziel !== 'object') return false;
    ziel[letzt.key] = wert;
    return true;
  }
  const arr = ziel?.[letzt.key];
  if (!Array.isArray(arr) || typeof letzt.index !== 'number') return false;
  arr[letzt.index] = wert;
  return true;
}

// ── Hygiene ──────────────────────────────────────────────────────────────────

/**
 * Steuerzeichen, Zero-Width- und Richtungsmarker raus, NFC-Normalisierung,
 * Laengenbudget. Ein einzelnes NUL-Byte laesst sonst jeden text-/jsonb-Insert
 * scheitern, RTL-Override erlaubt Namens-Spoofing in Ablage, UI und Discord.
 *
 * Das ist bewusst KEIN Regelverstoss: es ist Transport-Normalisierung und darf
 * keinen Repair-Call kosten.
 */
function saeubereString(s) {
  let out = s.normalize('NFC')
    // C0/C1-Steuerzeichen ausser Tab und Zeilenumbruch
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '')
    // Zero-Width, Wortverbinder, BOM, Richtungsmarker
    .replace(/[\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g, '');
  if (out.length > MAX_STRING_LEN) out = out.slice(0, MAX_STRING_LEN);
  return out;
}

/**
 * Rekursive Hygiene über das gesamte Ergebnis. Entfernt zusätzlich alle Keys mit
 * führendem Unterstrich: die sind der App vorbehalten (_pipelineLog), und ein
 * Dokument könnte sonst über die KI ein _validation-Feld unterschieben und damit
 * den Reparaturzustand selbst steuern.
 */
function saeubere(wert, tiefe = 0) {
  if (tiefe > 12) return null;
  if (typeof wert === 'string') return saeubereString(wert);
  if (typeof wert === 'number') return Number.isFinite(wert) ? wert : null;
  if (wert == null || typeof wert === 'boolean') return wert;
  if (Array.isArray(wert)) return wert.slice(0, 200).map((v) => saeubere(v, tiefe + 1));
  if (typeof wert === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(wert)) {
      if (k.startsWith('_')) continue;
      out[saeubereString(k).slice(0, 200)] = saeubere(v, tiefe + 1);
    }
    return out;
  }
  return null;
}

// ── Einzelprüfung ────────────────────────────────────────────────────────────
// Rückgabe: { ok } wenn der Wert so in die DB darf, sonst zusätzlich
// { koerziert } mit dem deterministisch ableitbaren Ersatz (undefined = keiner).

function pruefeWert(regel, wert) {
  if (wert == null) {
    return regel.pflicht || regel.nullbar === false
      ? { ok: false, koerziert: undefined }
      : { ok: true };
  }

  switch (regel.regel) {
    case 'ENUM': {
      if (typeof wert === 'string' && regel.erlaubt.includes(wert)) return { ok: true };
      return { ok: false, koerziert: kanonisiere(wert, regel.erlaubt) ?? undefined };
    }
    case 'DATUM': {
      const norm = toDate(wert);
      if (typeof wert === 'string' && norm === wert) return { ok: true };
      return { ok: false, koerziert: norm ?? undefined };
    }
    case 'ZAHL': {
      if (typeof wert === 'number' && Number.isFinite(wert) && Math.abs(wert) <= regel.max) {
        return { ok: true };
      }
      return { ok: false, koerziert: toBetrag(wert, regel.max) ?? undefined };
    }
    case 'ANTEIL': {
      if (typeof wert === 'number' && Number.isFinite(wert) && wert >= 0 && wert <= 1) {
        return { ok: true };
      }
      const n = toNumeric(wert);
      if (n != null && n >= 0 && n <= 1) return { ok: false, koerziert: n };
      // Häufiger Modellfehler: Prozent statt Anteil. Nur ab 10 als solche gelesen —
      // bei einer 2 ist "2 Prozent" genauso geraten wie "sehr sicher", und eine
      // erfundene Sicherheit ist schlimmer als eine fehlende.
      if (n != null && n >= 10 && n <= 100) return { ok: false, koerziert: n / 100 };
      return { ok: false, koerziert: 0 };
    }
    case 'SEITE': {
      // Einzelne Seitenzahl (Feature "Rechnungsteile" — einreichungSeiteVon/Bis).
      // Die Von/Bis-Konsistenz prüft erst der Insert (document-inserter.js);
      // hier geht es nur um "ist das überhaupt eine plausible Seitenzahl".
      if (typeof wert === 'number' && Number.isInteger(wert) && wert >= 1 && wert <= 9999) {
        return { ok: true };
      }
      const n = toNumeric(wert);
      if (n != null && Number.isInteger(n) && n >= 1 && n <= 9999) return { ok: false, koerziert: n };
      // Unparsbar/leer → nullen ist hier ungefährlich (null = ganzes Dokument).
      return { ok: false, koerziert: undefined };
    }
    case 'JAHR': {
      if (typeof wert === 'number' && Number.isInteger(wert) && wert >= JAHR_MIN && wert <= JAHR_MAX) {
        return { ok: true };
      }
      const n = toNumeric(wert);
      if (n != null && Number.isInteger(n) && n >= JAHR_MIN && n <= JAHR_MAX) return { ok: false, koerziert: n };
      // Unparsbar/außerhalb der Spanne → nullen statt raten, dann greift für
      // Altfälle der Regex-Fallback in analyse.js auf leistungsdatum.
      return { ok: false, koerziert: undefined };
    }
    case 'WINKEL': {
      if (typeof wert === 'number' && WINKEL.includes(wert)) return { ok: true };
      const n = toNumeric(wert);
      return { ok: false, koerziert: WINKEL.includes(n) ? n : 0 };
    }
    case 'LISTE': {
      if (Array.isArray(wert)
        && wert.length <= MAX_LISTEN_EINTRAEGE
        && wert.every((e) => typeof e === 'string' && e.length <= MAX_LISTEN_EINTRAG_LEN)) {
        return { ok: true };
      }
      let quelle = null;
      if (Array.isArray(wert)) quelle = wert;
      // Ein einzelner String statt einer Liste ist der häufigste Fall — node-pg
      // deutet ihn sonst als Array-Literal und der INSERT stirbt.
      else if (typeof wert === 'string') quelle = wert.split(/[,;]/);
      if (!quelle) return { ok: false, koerziert: undefined };
      const liste = quelle
        .filter((e) => typeof e === 'string' || typeof e === 'number')
        .map((e) => String(e).trim().slice(0, MAX_LISTEN_EINTRAG_LEN))
        .filter(Boolean)
        .slice(0, MAX_LISTEN_EINTRAEGE);
      return { ok: false, koerziert: liste.length ? liste : undefined };
    }
    default:
      return { ok: true };
  }
}

/**
 * Alle Verstöße im Ergebnis. Rein, synchron, idempotent — ein zweiter Lauf auf
 * sauberen Daten findet nichts und löst damit auch keinen Repair-Call aus.
 * Deshalb braucht es kein persistiertes „schon geprüft"-Flag.
 */
export function validiere(data, lxdCodes) {
  const verstoesse = [];
  for (const regel of feldRegeln(lxdCodes, data)) {
    for (const treffer of expandiere(data, regel.pfad)) {
      const ergebnis = pruefeWert(regel, treffer.ziel);
      if (ergebnis.ok) continue;
      verstoesse.push({
        pfad: treffer.pfad,
        regel: regel.regel,
        erlaubt: regel.erlaubt,
        nullbar: regel.nullbar !== false,
        wert: treffer.ziel,
        koerziert: ergebnis.koerziert,
      });
    }
  }
  return verstoesse;
}

/** Politik: wann wird überhaupt ein Repair-Call gemacht. */
function sollRepariert(verstoesse) {
  // Bewusste Vorgabe: JEDER Verstoß löst den Call aus, auch ein rein
  // koerzierbarer wie eine deutsche Datumsnotation. Wer das später auf
  // „nur nicht-koerzierbare" umstellen will, ändert genau diese Zeile —
  // die Datengrundlage dafür steht in postbuch.data_repairs.
  return verstoesse.length > 0;
}

function kuerzeWert(wert) {
  let s;
  try {
    s = JSON.stringify(wert);
  } catch {
    s = '"<nicht darstellbar>"';
  }
  if (s == null) s = 'null';
  return s.length > MAX_ZITAT_LEN ? `${s.slice(0, MAX_ZITAT_LEN)}…"` : s;
}

// ── Repair-Call ──────────────────────────────────────────────────────────────

/**
 * Genau ein Korrekturversuch. Wirft nie: ein API-Ausfall zählt als „Reparatur
 * hat nichts geliefert", damit ein Fehler hier kein zweites Retry-Regime startet.
 *
 * @returns {Promise<{ uebernommen: string[], modell: string|null, fehler: string|null }>}
 */
async function repariere(data, verstoesse, settings, meta) {
  const zitierbar = verstoesse.map((v) => ({
    pfad: v.pfad,
    regel: v.regel,
    erlaubt: v.erlaubt,
    wertGekuerzt: kuerzeWert(v.wert),
  }));
  const { system, user } = buildRepairPrompt(zitierbar);

  // Leichtestes Tier: die Aufgabe ist Formatkorrektur, kein Dokumentverständnis.
  const modell = resolveTierModelConfig('leicht', settings);

  let antwort;
  try {
    antwort = await callLLM(
      modell,
      user,
      { system, maxTokens: 2048 },
      settings,
      { ...(meta || {}), kategorie: 'repair' },
    );
  } catch (err) {
    return { uebernommen: [], modell: modell?.model || null, fehler: err.message };
  }

  let korrektur;
  try {
    korrektur = parseJsonFromText(antwort.text);
  } catch (err) {
    return { uebernommen: [], modell: modell?.model || null, fehler: `Antwort nicht lesbar: ${err.message}` };
  }
  if (!korrektur || typeof korrektur !== 'object' || Array.isArray(korrektur)) {
    return { uebernommen: [], modell: modell?.model || null, fehler: 'Antwort war kein JSON-Objekt' };
  }

  // Whitelist-Merge: ausschließlich die beanstandeten Pfade. Alles andere aus der
  // Repair-Antwort wird verworfen.
  const erlaubtePfade = new Set(verstoesse.map((v) => v.pfad));
  const uebernommen = [];
  for (const [pfad, rohwert] of Object.entries(korrektur)) {
    if (!erlaubtePfade.has(pfad)) continue;
    const wert = saeubere(rohwert);
    if (setzeAn(data, pfad, wert)) uebernommen.push(pfad);
  }

  return { uebernommen, modell: modell?.model || null, fehler: null };
}

// ── Öffentliche Schnittstelle ────────────────────────────────────────────────

/**
 * Prüft das Extraktionsergebnis, repariert es bei Bedarf und liefert einen
 * DB-tauglichen Stand zurück.
 *
 * Das übergebene Objekt wird NICHT verändert; der bereinigte Stand kommt als
 * `data` zurück (inklusive der app-eigenen _-Felder aus dem Original, die die
 * Hygiene sonst entfernen würde).
 *
 * @returns {Promise<{
 *   data: object,
 *   repariert: boolean,
 *   reparaturen: Array,
 *   fatal: object|null,
 * }>}
 */
export async function pruefeUndRepariere(rohdaten, settings, meta = {}) {
  const taxonomie = await getAktiveTaxonomie();
  const lxdCodes = {
    lebensbereiche: taxonomie.lebensbereiche.map(({ code }) => code),
    dokumentarten: taxonomie.dokumentarten.map(({ code }) => code),
    sdDokumentarten: new Set(taxonomie.dokumentarten
      .filter(({ spezial_pipeline }) => spezial_pipeline != null)
      .map(({ code }) => code)),
  };

  // App-eigene Felder vor der Hygiene sichern und danach zurücklegen: sie stammen
  // aus lib/llm.js, nicht aus dem Modell, und werden für ai_model / ai_cost_usd
  // gebraucht.
  //
  // Bewusst eine Positivliste, kein pauschales „alles mit _": das Modell schreibt
  // in dasselbe Objekt, und ein Dokument könnte sonst ein _-Feld unterschieben,
  // das die Hygiene zwar entfernt, dieser Schritt aber wieder hereinholt.
  const data = saeubere(rohdaten) || {};
  for (const k of APP_FELDER) {
    if (rohdaten?.[k] !== undefined) data[k] = rohdaten[k];
  }

  // Normalerweise hat analyzeDocument diesen Fehler bereits als Modellfehler
  // behandelt und das nächste Kettenglied versucht. Diese zweite Schranke
  // verhindert auch bei künftigen direkten Aufrufern einen leeren DB-Fachblock.
  const fachblockFehler = pruefeFachblockStruktur(data, taxonomie);
  if (fachblockFehler) {
    const fatal = { pfad: 'fachblock', regel: 'FACHBLOCK', nullbar: false, wert: fachblockFehler };
    appLog('ERROR', 'extract-validator', fachblockFehler, meta);
    return { data, repariert: false, reparaturen: [], fatal };
  }

  const verstoesse = validiere(data, lxdCodes);
  const reparaturen = [];

  if (!sollRepariert(verstoesse)) {
    return { data, repariert: false, reparaturen, fatal: null };
  }

  console.log(`[extract-validator] ${verstoesse.length} Verstoß/Verstöße: ${verstoesse.map((v) => `${v.pfad}/${v.regel}`).join(', ')}`);
  const vorher = new Map(verstoesse.map((v) => [v.pfad, v]));

  const ergebnis = await repariere(data, verstoesse, settings, meta);
  if (ergebnis.fehler) {
    console.warn(`[extract-validator] Repair-Call fehlgeschlagen: ${ergebnis.fehler}`);
    appLog('WARN', 'extract-validator', `Repair-Call fehlgeschlagen: ${ergebnis.fehler}`);
  }

  // Zweite Prüfung: was hat der Repair-Call wirklich geheilt?
  const verbleibend = validiere(data, lxdCodes);
  // D ist die Verarbeitungsform und deshalb immer Pflicht. Ist D unklar, faellt
  // das Paar sichtbar auf Allgemeines/Sonstiges. Bei gueltigem generischem D
  // darf nur L auf Allgemeines fallen. Bei sD-faehigem D bleibt ein ungueltiges
  // L dagegen fatal, damit keine Spezialpipeline stillschweigend verloren geht.
  const dVerstoss = verbleibend.find((v) => v.pfad === 'dokumentart');
  const lVerstoss = verbleibend.find((v) => v.pfad === 'lebensbereich');
  const fallbackPfade = new Set();
  if (dVerstoss) {
    data.lebensbereich = 'allgemeines';
    data.dokumentart = 'sonstiges';
    fallbackPfade.add('dokumentart');
    if (lVerstoss) fallbackPfade.add('lebensbereich');
  } else if (lVerstoss && !lxdCodes.sdDokumentarten.has(data.dokumentart)) {
    data.lebensbereich = 'allgemeines';
    fallbackPfade.add('lebensbereich');
  }
  const nochOffen = new Map(verbleibend.map((v) => [v.pfad, v]));

  for (const [pfad, v] of vorher) {
    if (!nochOffen.has(pfad)) {
      reparaturen.push({
        feld: pfad, regel: v.regel, roh: kuerzeWert(v.wert),
        ergebnis: 'ki-korrigiert', neu: kuerzeWert(expandiere(data, pfad)[0]?.ziel),
      });
    }
  }

  let fatal = null;
  for (const v of verbleibend) {
    if (fallbackPfade.has(v.pfad)) {
      reparaturen.push({
        feld: v.pfad, regel: v.regel, roh: kuerzeWert(v.wert),
        ergebnis: 'lxd-fallback', neu: kuerzeWert(expandiere(data, v.pfad)[0]?.ziel),
      });
      continue;
    }
    if (v.koerziert !== undefined) {
      setzeAn(data, v.pfad, v.koerziert);
      reparaturen.push({
        feld: v.pfad, regel: v.regel, roh: kuerzeWert(v.wert),
        ergebnis: 'koerziert', neu: kuerzeWert(v.koerziert),
      });
    } else if (v.nullbar) {
      setzeAn(data, v.pfad, null);
      reparaturen.push({
        feld: v.pfad, regel: v.regel, roh: kuerzeWert(v.wert),
        ergebnis: 'genullt', neu: null,
      });
    } else {
      fatal = v;
      reparaturen.push({
        feld: v.pfad, regel: v.regel, roh: kuerzeWert(v.wert),
        ergebnis: 'unreparierbar', neu: null,
      });
    }
  }

  if (reparaturen.length) {
    appLog('WARN', 'extract-validator',
      `KI-Ausgabe korrigiert: ${reparaturen.map((r) => `${r.feld} (${r.ergebnis})`).join(', ')}`,
      { details: JSON.stringify(reparaturen).slice(0, 2000) });
  }

  return { data, repariert: reparaturen.length > 0, reparaturen, fatal };
}

/** Nutzerverständliche Meldung für den _failed-Eintrag. */
export function fatalMeldung(fatal) {
  if (fatal?.regel === 'FACHBLOCK' && fatal?.wert) return fatal.wert;
  return `Pflichtfeld "${fatal?.pfad}" konnte auch nach KI-Korrektur nicht gültig ermittelt werden`;
}
