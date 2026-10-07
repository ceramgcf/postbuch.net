/**
 * service/archive-importer.js — Import einer Dokumentenübergabe
 *
 * Liest ein vom archive-exporter erzeugtes ZIP (manifest.json + je x.pdf eine x.json)
 * und legt die Dokumente ohne KI-Neuverarbeitung an (keine LLM-/Klassifikations-
 * /Duplikat-Pipeline). Die PDF wird neu in die Zielablage hochgeladen. Das Format
 * enthält bewusst keinen Abrechnungs-, Akten-, Wiedervorlage- oder Sessionkontext.
 *
 * Robustheit gegen Versionssprünge:
 *  - formatVersion und scope werden geprüft; ältere Archivstände bleiben lesbar,
 *    werden aber nach der neuen Übergabesemantik ohne Perioden-/Kontextdaten importiert.
 *  - Unbekannte JSON-Felder werden ignoriert (per Spalten-Whitelist je Tabelle).
 *  - Fehlende Felder werden zu NULL/Default.
 *  - art/status werden gegen die erlaubten Werte validiert.
 *
 * conflictMode:
 *  - 'skip'      (Default): Dokument mit gleicher sha256 existiert → überspringen.
 *  - 'overwrite': nicht mehr unterstützt; ein Übergabepaket darf keinen Fremdbestand löschen.
 *  - 'createNew': immer neue postid vergeben.
 *
 * Streaming: Das ZIP wird per yauzl entrylazy von der Platte gelesen statt
 * vollständig in den RAM geladen. Für jeden Dokument-JSON-Eintrag
 * werden nur wenige Metadatenfelder dauerhaft gehalten (siehe `plan`); das vollständige
 * JSON inkl. Embedding-Vektor wird pro Dokument genau dann gelesen, wenn es gebraucht
 * wird, und danach nicht mehr referenziert. So bleibt der Speicherbedarf unabhängig
 * von der Dokumentanzahl im Archiv nahezu konstant. Header-Größenangaben im ZIP sind
 * nicht vertrauenswürdig (TOCTOU) — die eigentliche Grenze ist die Anzahl real
 * entpackter Bytes, mitgezählt während des Streamens (siehe `readEntryBuffer`).
 */

import yauzl from 'yauzl';
import { createHash } from 'node:crypto';
import { query, getClient } from '../db.js';
import { getActiveAdapterFor, legacyOnedriveWerte } from '../lib/storage/index.js';
import { loadDynamicSettings } from '../config.js';
import { regenerateEmbedding } from '../lib/embedding.js';
import { getGesamteTaxonomie } from '../lib/taxonomie.js';
import { istGueltigerStatus } from '../lib/post-status.js';
import * as tracker from '../jobs/tracker.js';

// Archive vor 1.7.0 tragen kein Signaturfeld — damals gab es genau ein
// Embedding-Modell. Ohne diesen Wert wären importierte Vektoren nach dem
// Signaturfilter unsichtbar, obwohl sie exakt passen.
const ARCHIV_LEGACY_SIGNATUR = 'openai/text-embedding-3-large/3072';
import { appLog } from '../app-log.js';
import { ensureAblageOrdner } from './storage-setup.js';
import { ergaenzeErkannteZahlung } from './rechnung-zahlung.js';

export const ARCHIVE_LIMITS = Object.freeze({
  maxEntries: 20000,
  maxEntryBytes: 150 * 1024 * 1024,
  maxJsonBytes: 16 * 1024 * 1024,
  maxTotalBytes: 4 * 1024 * 1024 * 1024,
});

function entrySize(entry, field) {
  const value = Number(entry?.header?.[field]);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`ZIP-Eintrag "${entry?.entryName || '?'}" hat eine ungültige Größenangabe`);
  }
  return value;
}

function validateEntryName(name) {
  if (!name || name.includes('\0') || name.includes('\\') || name.startsWith('/')) return false;
  const parts = name.split('/');
  return parts.every(part => part !== '..' && part !== '.');
}

// Schnelle Vorprüfung anhand der (nicht vertrauenswürdigen) ZIP-Header-Angaben.
// Entries werden bewusst in einer library-neutralen Form erwartet
// ({ entryName, isDirectory?, header: { size, compressedSize, flags } }),
// damit diese Funktion unabhängig von der konkreten ZIP-Bibliothek testbar bleibt.
// Der eigentliche Schutz gegen manipulierte Header (Zip-Bomben) liegt NICHT hier,
// sondern in readEntryBuffer(), die reale entpackte Bytes zählt.
export function validateArchiveEntries(entries) {
  if (!Array.isArray(entries) || entries.length > ARCHIVE_LIMITS.maxEntries) {
    throw new Error(`ZIP enthält zu viele Einträge (maximal ${ARCHIVE_LIMITS.maxEntries})`);
  }

  const names = new Set();
  let total = 0;
  for (const entry of entries) {
    const name = String(entry.entryName || '');
    if (!validateEntryName(name)) throw new Error(`Unsicherer ZIP-Pfad: ${name || '(leer)'}`);
    if (names.has(name)) throw new Error(`Doppelter ZIP-Eintrag: ${name}`);
    names.add(name);
    if (entry.isDirectory) continue;

    if ((Number(entry?.header?.flags) & 0x1) !== 0) {
      throw new Error(`Verschlüsselte ZIP-Einträge werden nicht unterstützt: ${name}`);
    }
    const size = entrySize(entry, 'size');
    const compressedSize = entrySize(entry, 'compressedSize');
    const maxForEntry = /\.json$/i.test(name) ? ARCHIVE_LIMITS.maxJsonBytes : ARCHIVE_LIMITS.maxEntryBytes;
    if (size > maxForEntry) throw new Error(`ZIP-Eintrag ist zu groß: ${name}`);
    if (compressedSize > maxForEntry) throw new Error(`ZIP-Eintrag ist komprimiert zu groß: ${name}`);
    total += size;
    if (!Number.isSafeInteger(total) || total > ARCHIVE_LIMITS.maxTotalBytes) {
      throw new Error(`Entpackter ZIP-Inhalt ist zu groß (maximal ${ARCHIVE_LIMITS.maxTotalBytes} Bytes)`);
    }
  }
}

// yauzl-Entry → library-neutrale Form für validateArchiveEntries().
function toHeaderShape(entry) {
  return {
    entryName: entry.fileName,
    isDirectory: entry.fileName.endsWith('/'),
    header: {
      size: entry.uncompressedSize,
      compressedSize: entry.compressedSize,
      flags: entry.generalPurposeBitFlag,
    },
  };
}

function openZipFile(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: false }, (err, zipfile) => {
      if (err) return reject(new Error('ZIP-Archiv ist beschädigt oder wird nicht unterstützt'));
      resolve(zipfile);
    });
  });
}

// Liest alle Einträge einmal komplett ein (nur Metadaten aus dem zentralen
// Verzeichnis, kein Dateiinhalt). Diese Entry-Objekte bleiben danach für
// gezielte openReadStream()-Aufrufe gültig (wahlfreier Zugriff per Offset).
function collectEntries(zipfile) {
  return new Promise((resolve, reject) => {
    const entries = [];
    let settled = false;
    const fail = (err) => { if (!settled) { settled = true; reject(err); } };
    zipfile.on('entry', (entry) => {
      entries.push(entry);
      if (entries.length > ARCHIVE_LIMITS.maxEntries) {
        return fail(new Error(`ZIP enthält zu viele Einträge (maximal ${ARCHIVE_LIMITS.maxEntries})`));
      }
      zipfile.readEntry();
    });
    zipfile.on('end', () => { if (!settled) { settled = true; resolve(entries); } });
    zipfile.on('error', (err) => fail(new Error(`ZIP-Archiv ist beschädigt oder wird nicht unterstützt: ${err.message}`)));
    zipfile.readEntry();
  });
}

// Liest den Inhalt eines Eintrags vollständig in einen Buffer. `maxBytes` begrenzt
// diesen einzelnen Eintrag unabhängig von seiner (nicht vertrauenswürdigen)
// Header-Angabe. Mit countTotal=true fließt die reale Bytezahl zusätzlich in
// `runningTotal` ein und wird gegen ARCHIVE_LIMITS.maxTotalBytes geprüft — das ist
// die eigentliche Zip-Bomben-Bremse. Jeder Dokumentinhalt wird dafür genau einmal
// gezählt (siehe Aufrufstellen), auch wenn er (z. B. das JSON) technisch zweimal
// gelesen wird.
function readEntryBuffer(zipfile, entry, maxBytes, runningTotal, { countTotal = true } = {}) {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err, stream) => {
      if (err) return reject(err);
      let entryBytes = 0;
      const chunks = [];
      let failed = false;
      stream.on('data', (chunk) => {
        if (failed) return;
        entryBytes += chunk.length;
        if (entryBytes > maxBytes) {
          failed = true;
          stream.destroy(new Error(`ZIP-Eintrag "${entry.fileName}" überschreitet beim Entpacken das erlaubte Limit`));
          return;
        }
        if (countTotal) {
          runningTotal.bytes += chunk.length;
          if (runningTotal.bytes > ARCHIVE_LIMITS.maxTotalBytes) {
            failed = true;
            stream.destroy(new Error(`Entpackter ZIP-Inhalt ist zu groß (maximal ${ARCHIVE_LIMITS.maxTotalBytes} Bytes)`));
            return;
          }
        }
        chunks.push(chunk);
      });
      stream.on('end', () => { if (!failed) resolve(Buffer.concat(chunks)); });
      stream.on('error', reject);
    });
  });
}

// ── Spalten-Whitelists je Detailtabelle (Versions-Robustheit) ──────────────────
export const DETAIL_COLUMNS = Object.freeze({
  arztrechnung: ['typ','re_nr','rechnungsdatum','faelligkeit','bezahlt_am','name_arzt',
    'behandelte_person','leistung','gesamtbetrag','iban','verwendungszweck','kontoinhaber',
    'pkv_satz_override','beihilfe_satz_override','bezahlt_am_manuell','bestritten_betrag',
    'einreichung_seite_von','einreichung_seite_bis'],
  arztrechnung_einzelposition: ['subid','behandlungs_datum','goa_goz_gebueh_pzn','leistung',
    'begruendung','faktor','betrag','ist_differenz'],
  handwerkerrechnung: ['re_nr','rechnungsdatum','leistungsdatum','leistungsjahr','faelligkeit','bezahlt_am',
    'name_unternehmen','leistung','gesamtbetrag','lohnkosten','iban','verwendungszweck','bezahlt_am_manuell','bestritten_betrag',
    'estg35a_irrelevant'],
  generische_rechnung: ['re_nr','rechnungsdatum','gesamtbetrag','absender','bezahlt_am','faelligkeit',
    'iban','verwendungszweck','kontoinhaber','bezahlt_am_manuell','bestritten_betrag'],
  rechnung_zahlung: ['datum','betrag'],
  arztbericht: ['behandelte_person','anlass','norm_befunde','pathologische_befunde'],
  erstattungsbescheid: ['kostentraeger','bescheiddatum','erstattungsbetrag','matching_summary','hinweise',
    'ist_tier',
    'ai_eb_model','ai_eb_tokens_in','ai_eb_tokens_out','ai_eb_cost_usd',
    'ai_kuerzung_model','ai_kuerzung_tokens_in','ai_kuerzung_tokens_out','ai_kuerzung_cost_usd'],
  erstattungsbescheid_einzelposition: ['subid','arz_postid','erstattungsbetrag','rechnungsbetrag',
    'kuerzungsbetrag','behandelte_person','kostenart','bezugsdatum'],
  erstattungsbescheid_kuerzung: ['eb_subid','arz_postid','arz_subid','kuerzungsbetrag','begruendung'],
});

function pick(obj, cols) {
  const out = {};
  if (!obj) return out;
  for (const c of cols) if (obj[c] !== undefined) out[c] = obj[c];
  return out;
}

function safeFileBase(s, maxLen = 120) {
  return (s || 'Dokument').replace(/[/\\?%*:|"<>\r\n\t]/g, '_').trim().slice(0, maxLen) || 'Dokument';
}

async function insertRow(client, table, obj) {
  const cols = Object.keys(obj);
  if (!cols.length) return;
  const ph = cols.map((_, i) => '$' + (i + 1));
  await client.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${ph.join(',')})`, cols.map(c => obj[c]));
}

// Zahlungen einer Rechnung übernehmen. Archive ohne Zahlungsliste (ältere
// Versionen) erhalten wie der Bestand eine Zahlung über den zu zahlenden
// Betrag zum Bezahldatum. Ungültige Einträge werden übergangen.
async function importiereZahlungen(client, postid, zahlungen) {
  if (!Array.isArray(zahlungen)) {
    await ergaenzeErkannteZahlung(client, postid);
    return;
  }
  for (const z of zahlungen.slice(0, 100)) {
    const row = pick(z, DETAIL_COLUMNS.rechnung_zahlung);
    const betrag = Number(row.betrag);
    if (typeof row.datum !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.datum)) continue;
    if (!Number.isFinite(betrag) || betrag <= 0 || betrag >= 1e10) continue;
    await insertRow(client, 'postbuch.rechnung_zahlung', { postid, datum: row.datum, betrag: betrag.toFixed(2) });
  }
}

async function nextPostid() {
  const r = await query(`SELECT 'P' || lpad(nextval('postbuch.postbuch_seq')::text, 6, '0') AS id`);
  return r.rows[0].id;
}

// ── ENUM-Werte laden (Validierung von art/status) ──────────────────────────────
async function loadEnumSet(enumType) {
  const r = await query(`SELECT unnest(enum_range(NULL::${enumType}))::text AS v`);
  return new Set(r.rows.map(x => x.v));
}

// ── Personenbezüge ─────────────────────────────────────────────────────────────
// Dokumente verweisen per Kurzname-Text auf Menschen. Die Kurznamen der
// Quellinstanz sagen in der Zielinstanz nichts — deshalb sammelt die Vorprüfung
// alle vorkommenden Namen ein, und der Import verlangt für jeden einzelnen eine
// ausdrückliche Zuordnung (Zielkurzname oder null).
function personenName(wert) {
  return typeof wert === 'string' && wert.trim() ? wert.trim() : null;
}

/** Alle Personennamen eines Dokument-JSONs mit ihrer Rolle. */
export function sammlePersonen(doc) {
  const treffer = [];
  const fam = personenName(doc?.postbuch?.familienmitglied);
  if (fam) treffer.push({ name: fam, rolle: 'familienmitglied' });
  const detail = doc?.detail;
  if (detail?.type === 'arztrechnung' || detail?.type === 'arztbericht') {
    const name = personenName(detail.fields?.behandelte_person);
    if (name) treffer.push({ name, rolle: 'behandelt' });
  }
  if (detail?.type === 'erstattungsbescheid' && Array.isArray(detail.einzelpositionen)) {
    for (const ep of detail.einzelpositionen) {
      const name = personenName(ep?.behandelte_person);
      if (name) treffer.push({ name, rolle: 'behandelt' });
    }
  }
  return treffer;
}

const MAX_LEGENDE = 1000;
const MAX_NAME_LEN = 200;

/**
 * Personenlegende aus dem Manifest (optional, ab 2.9.0). Sie dient nur als
 * Hinweis für Zuordnungsvorschläge und das Vorbelegen beim Neuanlegen — aus
 * ihr wird nie ungeprüft eine Person übernommen.
 */
export function leseLegende(manifest) {
  const legende = new Map();
  if (!Array.isArray(manifest?.personenlegende)) return legende;
  for (const e of manifest.personenlegende.slice(0, MAX_LEGENDE)) {
    const kurzname = personenName(e?.kurzname);
    if (!kurzname || kurzname.length > MAX_NAME_LEN) continue;
    const anzeigename = personenName(e?.anzeigename);
    legende.set(kurzname, {
      kurzname,
      anzeigename: anzeigename && anzeigename.length <= MAX_NAME_LEN ? anzeigename : null,
      istTier: e?.istTier === true,
    });
  }
  return legende;
}

// Das Übergabeformat hat bewusst keine gemeinsamen Zielobjekte. Dadurch kann ein
// Import weder fremde Personen, Akten, Verbleibtabellen noch Wiedervorlagen anlegen.
export function validateManifest(manifest) {
  if (manifest == null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('Manifest ist kein JSON-Objekt');
  }
  if (manifest._format && manifest._format !== 'postbuch-archiv') {
    throw new Error(`Unbekanntes Archivformat: ${manifest._format}`);
  }
  if (manifest.scope && manifest.scope !== 'dokumentenuebergabe') {
    throw new Error(`Nicht unterstützter Archivumfang: ${manifest.scope}`);
  }
  if (manifest.scope === 'dokumentenuebergabe') {
    if (manifest._format !== 'postbuch-archiv') {
      throw new Error('Dokumentenübergabe benötigt die Formatkennung postbuch-archiv');
    }
    const version = Number(manifest.formatVersion);
    if (!Number.isInteger(version) || version < 2) {
      throw new Error('Dokumentenübergabe benötigt eine ganzzahlige Formatversion ab 2');
    }
    if (!Number.isSafeInteger(manifest.documentCount) || manifest.documentCount < 0) {
      throw new Error('Dokumentenübergabe benötigt eine gültige Dokumentanzahl');
    }
  }
}

export function resolveTaxonomyCode(value, allowed, field, strict) {
  if (allowed.has(value)) return value;
  if (strict) throw new Error(`${field} ist im Ziel nicht vorhanden: ${value ?? '(leer)'}`);
  return null;
}

/**
 * Vorprüfung ohne Schreibzugriff: dieselbe Paketprüfung wie beim Import, dazu
 * alle vorkommenden Personennamen mit Anzahl der Dokumente je Rolle.
 * @returns {Promise<{total: number, fehlerhaft: number, personen: object[], legende: Map}>}
 */
export function pruefeArchiv(zipPath, { jobId = null } = {}) {
  return importArchive(zipPath, { nurPruefen: true, jobId });
}

/**
 * Importiert ein Postbuch-Archiv-ZIP von der Platte (echtes Streaming, kein
 * vollständiges Einlesen in den RAM).
 * @param {string} zipPath Pfad zur temporären ZIP-Datei
 * @param {object} opts
 * @param {'skip'|'createNew'} [opts.conflictMode='skip']
 * @param {Record<string, string|null>} [opts.personenZuordnung] - Quellname → Zielkurzname oder null;
 *   Pflicht für jeden im Paket vorkommenden Namen
 * @param {boolean} [opts.regenerateMissingEmbeddings=true] - Embedding per OpenAI nachgenerieren, wenn keins im JSON
 * @param {string} [opts.jobId] - Job-ID für Fortschrittsmeldungen (tracker.js)
 * @returns {Promise<object>} Report
 */
export async function importArchive(zipPath, {
  conflictMode = 'skip', personenZuordnung = null, regenerateMissingEmbeddings = true, jobId = null, nurPruefen = false,
} = {}) {
  if (!['skip', 'createNew'].includes(conflictMode)) {
    throw new Error('Ungültiger Konfliktmodus für Dokumentenübergabe');
  }
  const settings = await loadDynamicSettings();
  const storage = getActiveAdapterFor(settings);

  const zipfile = await openZipFile(zipPath);
  try {
    const allEntries = await collectEntries(zipfile);
    validateArchiveEntries(allEntries.map(toHeaderShape));
    const entries = allEntries.filter(e => !e.fileName.endsWith('/'));
    const byName = new Map(entries.map(e => [e.fileName, e]));
    const runningTotal = { bytes: 0 };

    // manifest.json finden (auch in Unterordner)
    const manifestEntries = entries.filter(e => /(^|\/)manifest\.json$/i.test(e.fileName));
    const manifestEntry = manifestEntries[0];
    let manifest = {};
    if (manifestEntry) {
      const manifestBuf = await readEntryBuffer(zipfile, manifestEntry, ARCHIVE_LIMITS.maxJsonBytes, runningTotal);
      try {
        manifest = JSON.parse(manifestBuf.toString('utf8'));
      } catch (err) {
        throw new Error(`Manifest ist ungültiges JSON: ${err.message}`);
      }
    }
    validateManifest(manifest);

    // Doc-JSONs einsammeln (alles außer manifest.json)
    const docEntries = entries.filter(e =>
      /\.json$/i.test(e.fileName) && !/(^|\/)manifest\.json$/i.test(e.fileName)
    );

    const isPortablePackage = manifest.scope === 'dokumentenuebergabe';
    if (isPortablePackage && (manifestEntries.length !== 1 || manifestEntry.fileName !== 'manifest.json')) {
      throw new Error('Dokumentenübergabe benötigt genau ein manifest.json im ZIP-Stamm');
    }
    if (isPortablePackage && manifest.documentCount !== docEntries.length) {
      throw new Error(`Manifest nennt ${manifest.documentCount} Dokumente, ZIP enthält ${docEntries.length}`);
    }

    const report = {
      total: docEntries.length,
      imported: 0,
      skipped: 0,
      failed: 0,
      omittedRelations: [],
      omittedContext: [
        'abrechnungsperioden',
        'abrechnungssessions',
        'akten-und-aktenlinks',
        'wiedervorlagen',
        'verbleib-referenzen',
        'personenstammdaten',
        'salden',
        'logs-und-caches',
        'pkv-pruefungen',
      ],
      items: [],
    };
    // Name → { name, familienmitglied: n, behandelt: n } (Anzahl Dokumente je Rolle)
    const personen = new Map();
    const pruefErgebnis = () => ({
      total: docEntries.length,
      fehlerhaft: report.failed,
      personen: [...personen.values()].sort((a, b) => a.name.localeCompare(b.name, 'de')),
      legende: leseLegende(manifest),
    });
    if (!docEntries.length) return nurPruefen ? pruefErgebnis() : report;
    if (jobId) tracker.setTotal(jobId, docEntries.length);

    const lxdCodes = await getGesamteTaxonomie();
    const artCodes = new Set(lxdCodes.dokumentarten.map(({ code }) => code));
    const lebensbereichCodes = new Set(lxdCodes.lebensbereiche.map(({ code }) => code));
    const richtungEnum = await loadEnumSet('postbuch.post_richtung');

    const allowedDetails = new Set([
      'arztrechnung', 'handwerkerrechnung', 'generische_rechnung',
      'arztbericht', 'erstattungsbescheid',
    ]);

    if (isPortablePackage) {
      const jsonNames = new Set(docEntries.map((entry) => entry.fileName.replace(/\.json$/i, '.pdf')));
      for (const entry of entries) {
        if (/\.pdf$/i.test(entry.fileName) && !jsonNames.has(entry.fileName)) {
          throw new Error(`Dokumentenübergabe abgelehnt:\n${entry.fileName}: PDF ohne zugehöriges Dokumenten-JSON`);
        }
      }
    }

    // ── Vorprüfung + Planung in einem Durchgang ──────────────────────────────
    // Ein aktuelles Übergabepaket wird vollständig vorgeprüft, bevor auch nur
    // eine Datei hochgeladen oder eine DB-Zeile geschrieben wird — ein
    // beschädigtes oder unvollständiges Paket darf nicht erst einige PDFs
    // anlegen und danach mitten im Lauf scheitern.
    // Jedes Dokument-JSON wird dabei genau einmal geparst; nur eine schlanke
    // Metadatenzeile (kein Fachdaten-/Embedding-Inhalt) bleibt für Pass B übrig.
    const remap = new Map(); // alteId → finaleId
    const plan = [];
    let geprueft = 0;
    const sourceIds = new Set();
    const errors = [];
    for (const entry of docEntries) {
      let doc;
      try {
        const buf = await readEntryBuffer(zipfile, entry, ARCHIVE_LIMITS.maxJsonBytes, runningTotal);
        doc = JSON.parse(buf.toString('utf8'));
      } catch (e) {
        if (isPortablePackage) errors.push(`${entry.fileName}: JSON ungültig (${e.message})`);
        report.failed++;
        report.items.push({ file: entry.fileName, status: 'failed', error: 'JSON ungültig: ' + e.message });
        continue;
      }
      const rollenImDokument = new Set();
      for (const { name, rolle } of sammlePersonen(doc)) {
        if (!personen.has(name)) personen.set(name, { name, familienmitglied: 0, behandelt: 0 });
        const key = `${name}\u0000${rolle}`;
        if (!rollenImDokument.has(key)) { rollenImDokument.add(key); personen.get(name)[rolle]++; }
      }
      const pb = doc.postbuch || {};
      const orig = pb.postid;
      const sha = pb.sha256;
      const pdfName = entry.fileName.replace(/\.json$/i, '.pdf');
      const pdfEntry = byName.get(pdfName);

      if (isPortablePackage) {
        const sourceId = pb.postid;
        if (!/^P\d{6}$/.test(sourceId || '')) errors.push(`${entry.fileName}: ungültige PostID`);
        if (sourceIds.has(sourceId)) errors.push(`${entry.fileName}: doppelte Quell-PostID ${sourceId}`);
        sourceIds.add(sourceId);
        if (!pdfEntry) errors.push(`${entry.fileName}: zugehörige PDF fehlt (${pdfName})`);
        if (doc._format !== 'postbuch-archiv' || Number(doc._v) < 2) {
          errors.push(`${entry.fileName}: kein aktuelles Dokumentenübergabe-JSON`);
        }
        if (pb.sha256 != null && !/^[0-9a-f]{64}$/.test(pb.sha256)) {
          errors.push(`${entry.fileName}: ungültige SHA-256-Prüfsumme`);
        }
        if (!istGueltigerStatus(pb.status)) {
          errors.push(`${entry.fileName}: unbekannter oder fehlender Dokumentstatus ${pb.status ?? '(leer)'}`);
        }
        if (!richtungEnum.has(pb.richtung)) {
          errors.push(`${entry.fileName}: ungültige oder fehlende Dokumentrichtung ${pb.richtung ?? '(leer)'}`);
        }
        if (doc.detail != null && !allowedDetails.has(doc.detail?.type)) {
          errors.push(`${entry.fileName}: unbekannte oder fehlende Detailart ${doc.detail?.type ?? '(leer)'}`);
        }
        if (!artCodes.has(pb.art ?? pb.dokumentart)) {
          errors.push(`${entry.fileName}: Dokumentart fehlt oder ist im Ziel unbekannt`);
        }
        if (!artCodes.has(pb.dokumentart ?? pb.art)) {
          errors.push(`${entry.fileName}: Dokumentart-Feld fehlt oder ist im Ziel unbekannt`);
        }
        if (!lebensbereichCodes.has(pb.lebensbereich)) {
          errors.push(`${entry.fileName}: Lebensbereich fehlt oder ist im Ziel unbekannt`);
        }
        if (doc.embedding != null) {
          const vector = doc.embedding?.vector;
          if (!Array.isArray(vector) || vector.length === 0
              || doc.embedding?.dim !== vector.length || vector.length > 3072) {
            errors.push(`${entry.fileName}: beschädigter oder unzulässiger Embedding-Block`);
          }
        }
      }

      if (!pdfEntry) {
        report.failed++;
        report.items.push({ file: entry.fileName, status: 'failed', error: 'Zugehörige PDF fehlt: ' + pdfName });
        continue;
      }
      if (nurPruefen) {
        if (jobId) tracker.setStep(jobId, ++geprueft, entry.fileName);
        continue;
      }

      const shaRow = sha ? await query(`SELECT postid FROM postbuch.postbuch WHERE sha256 = $1 LIMIT 1`, [sha]) : { rows: [] };
      const origTaken = orig
        ? (await query(`SELECT 1 FROM postbuch.postbuch WHERE postid = $1`, [orig])).rows.length > 0
        : true;

      let action = 'insert', finalPostid = orig;
      if (conflictMode === 'skip') {
        if (shaRow.rows.length) { action = 'skip'; finalPostid = shaRow.rows[0].postid; }
        else finalPostid = (!orig || origTaken) ? await nextPostid() : orig;
      } else { // createNew
        finalPostid = await nextPostid();
      }

      if (orig) remap.set(orig, finalPostid);
      plan.push({
        entryName: entry.fileName,
        pdfEntryName: pdfName,
        sourcePostid: orig ?? null,
        action,
        finalPostid,
        detailType: doc.detail?.type ?? null,
      });
    }

    if (isPortablePackage && errors.length) {
      throw new Error(`Dokumentenübergabe abgelehnt:\n${errors.slice(0, 20).join('\n')}${errors.length > 20 ? `\n… und ${errors.length - 20} weitere Fehler` : ''}`);
    }
    if (nurPruefen) return pruefErgebnis();

    // Personenzuordnung: jeder vorkommende Name braucht eine ausdrückliche
    // Entscheidung, und jedes Ziel muss jetzt noch existieren — zwischen
    // Vorprüfung und Start kann ein Mensch umbenannt oder gelöscht worden sein.
    const zuordnung = new Map();
    if (personen.size) {
      if (!personenZuordnung || typeof personenZuordnung !== 'object' || Array.isArray(personenZuordnung)) {
        throw new Error('Für die Personen im Paket fehlt die Zuordnung');
      }
      const fehlend = [...personen.keys()].filter((n) => !Object.hasOwn(personenZuordnung, n));
      if (fehlend.length) throw new Error(`Keine Zuordnung für: ${fehlend.slice(0, 20).join(', ')}`);
      for (const name of personen.keys()) {
        const ziel = personenZuordnung[name];
        if (ziel !== null && typeof ziel !== 'string') throw new Error(`Ungültige Zuordnung für ${name}`);
        zuordnung.set(name, ziel);
      }
      const ziele = [...new Set([...zuordnung.values()].filter(Boolean))];
      const vorhanden = new Set((await query(
        `SELECT kurzname FROM postbuch.mensch WHERE kurzname = ANY($1)`, [ziele],
      )).rows.map((r) => r.kurzname));
      const unbekannt = ziele.filter((z) => !vorhanden.has(z));
      if (unbekannt.length) throw new Error(`Zielperson existiert nicht (mehr): ${unbekannt.join(', ')}`);
    }
    const ordneZu = (wert) => {
      const name = personenName(wert);
      return name ? (zuordnung.get(name) ?? null) : null;
    };
    report.personenZuordnung = [...zuordnung].map(([quelle, ziel]) => ({ quelle, ziel }));

    // Erstattungsbescheide ans Ende: ihre Einzelpositionen/Kürzungen referenzieren
    // Arztrechnungen per FK — diese müssen vorher (committed) existieren.
    plan.sort((a, b) => {
      const ea = a.detailType === 'erstattungsbescheid' ? 1 : 0;
      const eb = b.detailType === 'erstattungsbescheid' ? 1 : 0;
      return ea - eb;
    });

    // Löst eine referenzierte Arztrechnung auf (Remap → Existenzprüfung; sonst null).
    // Ein fehlender Endpunkt ist im Übergabepaket erlaubt, wird aber sichtbar gemeldet.
    const resolveArzPostid = async (client, orig, fileName, relation, issues = report.omittedRelations) => {
      if (orig == null) return null;
      if (!remap.has(orig)) {
        issues.push({ file: fileName, relation, sourcePostid: orig });
        return null;
      }
      const cand = remap.get(orig);
      const r = await client.query(`SELECT 1 FROM postbuch.arztrechnung WHERE postid = $1`, [cand]);
      if (r.rows.length) return cand;
      issues.push({ file: fileName, relation, sourcePostid: orig });
      return null;
    };

    // ── Pass B: Ausführen ────────────────────────────────────────────────────
    let maxPostNum = 0;
    const neuAngelegt = new Set();
    const ersetzungen = []; // { neu, altQuelle, zahlungen, fileName }
    let doneCount = 0;
    for (const item of plan) {
      const { entryName, pdfEntryName, action, finalPostid } = item;
      const fileName = entryName;

      if (action === 'skip') {
        report.skipped++;
        report.items.push({ file: fileName, postid: finalPostid, status: 'skipped', reason: 'sha256 existiert bereits' });
        doneCount++;
        if (jobId) tracker.setStep(jobId, doneCount, fileName);
        continue;
      }

      const jsonEntry = byName.get(entryName);
      const pdfEntry = byName.get(pdfEntryName);
      const client = await getClient();
      let uploadedFileId = null;
      const omittedRelations = [];
      try {
        // Vollständiges Dokument-JSON erneut lesen — die Vorprüfung/Planung hat
        // absichtlich nur die schlanke plan-Zeile behalten, nicht das gesamte
        // (ggf. embedding-tragende) Objekt für alle Dokumente gleichzeitig.
        const jsonBuf = await readEntryBuffer(zipfile, jsonEntry, ARCHIVE_LIMITS.maxJsonBytes, runningTotal, { countTotal: false });
        const doc = JSON.parse(jsonBuf.toString('utf8'));
        const pb = doc.postbuch || {};

        // PDF direkt in den Zielordner hochladen. Zielordner und Wunschname
        // stehen schon vor dem Upload fest — der frühere Umweg über _inbox +
        // move() war unnötig und ließ die Datei kurz für den onedrive-watcher
        // sichtbar sein, der sie parallel als neues Eingangsdokument einlesen
        // konnte.
        const pdfBuffer = await readEntryBuffer(zipfile, pdfEntry, ARCHIVE_LIMITS.maxEntryBytes, runningTotal);
        if (pb.sha256) {
          const realSha = createHash('sha256').update(pdfBuffer).digest('hex');
          if (realSha !== pb.sha256) {
            throw new Error(`PDF-Prüfsumme stimmt nicht mit dem Dokumenten-JSON überein (${pdfEntryName})`);
          }
        }
        const strictTaxonomy = isPortablePackage;
        const art = resolveTaxonomyCode(pb.art ?? pb.dokumentart, artCodes, 'Dokumentart', strictTaxonomy)
          || 'sonstiges';
        const dokumentart = resolveTaxonomyCode(pb.dokumentart ?? pb.art, artCodes, 'Dokumentart', strictTaxonomy)
          || art;
        const lebensbereich = resolveTaxonomyCode(pb.lebensbereich, lebensbereichCodes, 'Lebensbereich', strictTaxonomy)
          || 'allgemeines';
        // Vor dem Upload zuordnen: familienmitglied, behandelte Person und Richtung
        // können den Ablageort bestimmen.
        const familienmitglied = ordneZu(pb.familienmitglied);
        // Ausgangspost ohne Absender aus der Familie ist keine Ausgangspost —
        // dieselbe Regel wie in der KI-Pipeline.
        let richtung = richtungEnum.has(pb.richtung) ? pb.richtung : 'eingang';
        if (richtung === 'ausgang' && !familienmitglied) richtung = 'eingang';
        // Behandelte Person nach derselben Regel wie behandeltePersonSql():
        // beim Erstattungsbescheid nur, wenn alle Positionen dieselbe nennen.
        let behandeltePerson = null;
        if (['arztrechnung', 'arztbericht'].includes(doc.detail?.type)) {
          behandeltePerson = ordneZu(doc.detail.fields?.behandelte_person);
        } else if (doc.detail?.type === 'erstattungsbescheid') {
          const namen = (doc.detail.einzelpositionen || []).map((ep) => ordneZu(ep.behandelte_person));
          if (namen.length && namen.every((n) => n && n === namen[0])) behandeltePerson = namen[0];
        }
        const destFolderId = await ensureAblageOrdner(
          settings,
          {
            lebensbereich, dokumentart, familienmitglied, behandelte_person: behandeltePerson,
            briefdatum: pb.briefdatum || null, richtung,
          },
          storage.name,
        );

        const wunschFileName = `${safeFileBase(pb.betreff)} ${finalPostid}.pdf`;
        const uploaded = await storage.uploadNew(pdfBuffer, wunschFileName, destFolderId);
        uploadedFileId = uploaded.id;
        // Der Adapter kann den Namen geaendert haben (Sanitisierung oder
        // "(2)"-Suffix bei Kollision) — sonst zeigte storage_filename auf einen
        // Namen, den es in der Ablage so nicht gibt.
        const newFileName = uploaded.name || wunschFileName;
        let onedriveModified = null;
        try {
          const meta = await storage.getMeta(uploaded.id);
          onedriveModified = meta.lastModified || null;
        } catch { /* nicht fatal */ }

        await client.query('BEGIN');

        // Bewusst gegen die App-Liste statt gegen das DB-Enum: dort steht der
        // stillgelegte 'WaitingForAIReview' weiterhin drin, alte Archive dürfen
        // ihn aber nicht wieder einschleppen.
        const status = istGueltigerStatus(pb.status) ? pb.status : 'UserClearance';
        const vector = doc.embedding?.vector;
        const embeddingLiteral = Array.isArray(vector) && vector.length ? '[' + vector.join(',') + ']' : null;
        const embeddingSignatur = embeddingLiteral
          ? (doc.embedding?.signature || ARCHIV_LEGACY_SIGNATUR)
          : null;

        // Legacy-Spalten onedrive_* nur füllen, wenn die Datei wirklich in
        // OneDrive liegt (siehe legacyOnedriveWerte).
        const legacyOd = legacyOnedriveWerte(storage.name, {
          id: uploaded.id,
          name: newFileName,
          modified: onedriveModified,
        });

        await client.query(
          `INSERT INTO postbuch.postbuch
            (postid, briefdatum, erfassungsdatum, kontakt, fremdes_zeichen, art, betreff,
             zusammenfassung, schlagwoerter, onedrive_id, storage_id, storage_backend,
             link, status, autoreview_instructions,
             confidence, metadata, notiz, historisch, familienmitglied, richtung, embedding,
             sha256, onedrive_filename, storage_filename, onedrive_modified, storage_modified,
             ai_model, ai_pre_model, ai_tokens_in, ai_tokens_out, ai_pre_tokens_in, ai_pre_tokens_out,
             ai_cost_usd, ai_pre_cost_usd,
             verbleib_id, verbleib_ablage_id, verbleib_ort, original_urkunde, embedding_signature,
             data_repaired_at, data_repairs, lebensbereich, dokumentart, qr_codes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$38,$10,$37,$11,$12::postbuch.post_status,$13,
                   $14,$15::jsonb,$16,$17,$18,$19::postbuch.post_richtung,$20::halfvec,
                   $21,$39,$22,$40,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,
                   $43,$44,$41,$42,$45::jsonb)`,
          [
            finalPostid,
            pb.briefdatum || null,
            pb.erfassungsdatum || null,
            pb.kontakt ?? null,
            pb.fremdes_zeichen ?? null,
            art,
            pb.betreff ?? null,
            pb.zusammenfassung ?? null,
            pb.schlagwoerter ?? null,
            uploaded.id,
            uploaded.webUrl || null,
            status,
            pb.autoreview_instructions ?? null,
            pb.confidence ?? null,
            pb.metadata != null ? JSON.stringify(pb.metadata) : null,
            pb.notiz ?? null,
            !!pb.historisch,
            familienmitglied,
            richtung,
            embeddingLiteral,
            pb.sha256 ?? null,
            newFileName,
            onedriveModified,
            pb.ai?.model ?? null,
            pb.ai?.pre_model ?? null,
            pb.ai?.tokens_in ?? null,
            pb.ai?.tokens_out ?? null,
            pb.ai?.pre_tokens_in ?? null,
            pb.ai?.pre_tokens_out ?? null,
            pb.ai?.cost_usd ?? null,
            pb.ai?.pre_cost_usd ?? null,
            null,
            null,
            null,
            false,
            embeddingSignatur,
            storage.name,
            // $38–$40: Legacy-Spalten nur bei OneDrive (siehe legacyOnedriveWerte).
            legacyOd.id,
            legacyOd.name,
            legacyOd.modified,
            lebensbereich,
            dokumentart,
            pb.data_repaired_at ?? null,
            pb.data_repairs != null ? JSON.stringify(pb.data_repairs) : null,
            pb.qr_codes != null ? JSON.stringify(pb.qr_codes) : null,
          ]
        );

        // Detail-Tabelle
        const detail = doc.detail;
        if (detail?.type === 'arztrechnung') {
          await insertRow(client, 'postbuch.arztrechnung', {
            postid: finalPostid,
            ...pick(detail.fields, DETAIL_COLUMNS.arztrechnung),
            behandelte_person: ordneZu(detail.fields?.behandelte_person),
          });
          // Der aktuelle INSERT-Trigger leitet bei bekannten Personen sonst
          // automatisch die höchste offene Sammelperiode ab. Für die
          // Dokumentenübergabe ist genau diese implizite Kontextübernahme falsch:
          // innerhalb derselben Transaktion ausdrücklich wieder entkoppeln.
          await client.query(
            `UPDATE postbuch.arztrechnung
                SET abrechnungsperiode_pkv = NULL,
                    abrechnungsperiode_beihilfe = NULL
              WHERE postid = $1`,
            [finalPostid],
          );
          for (const ep of detail.einzelpositionen || []) {
            await insertRow(client, 'postbuch.arztrechnung_einzelposition', { postid: finalPostid, ...pick(ep, DETAIL_COLUMNS.arztrechnung_einzelposition) });
          }
        } else if (detail?.type === 'handwerkerrechnung') {
          await insertRow(client, 'postbuch.handwerkerrechnung', { postid: finalPostid, ...pick(detail.fields, DETAIL_COLUMNS.handwerkerrechnung) });
        } else if (detail?.type === 'generische_rechnung') {
          await insertRow(client, 'postbuch.generische_rechnung', { postid: finalPostid, ...pick(detail.fields, DETAIL_COLUMNS.generische_rechnung) });
        }
        if (['arztrechnung', 'handwerkerrechnung', 'generische_rechnung'].includes(detail?.type)) {
          await importiereZahlungen(client, finalPostid, detail.zahlungen);
          if (detail.ersetzt && typeof detail.ersetzt.postid === 'string') {
            ersetzungen.push({
              neu: finalPostid,
              altQuelle: detail.ersetzt.postid,
              zahlungen: Array.isArray(detail.ersetzt.umgezogene_zahlungen) ? detail.ersetzt.umgezogene_zahlungen.slice(0, 100) : [],
              altManuell: detail.ersetzt.alt_bezahlt_am_manuell === true,
              neuManuell: detail.ersetzt.neu_bezahlt_am_manuell === true,
              fileName,
            });
          }
        }
        if (detail?.type === 'arztbericht') {
          await insertRow(client, 'postbuch.arztbericht', {
            postid: finalPostid,
            ...pick(detail.fields, DETAIL_COLUMNS.arztbericht),
            behandelte_person: ordneZu(detail.fields?.behandelte_person),
          });
        } else if (detail?.type === 'erstattungsbescheid') {
          await insertRow(client, 'postbuch.erstattungsbescheid', { postid: finalPostid, ...pick(detail.fields, DETAIL_COLUMNS.erstattungsbescheid) });
          for (const ep of detail.einzelpositionen || []) {
            const row = pick(ep, DETAIL_COLUMNS.erstattungsbescheid_einzelposition);
            row.behandelte_person = ordneZu(ep.behandelte_person);
            row.arz_postid = await resolveArzPostid(client, row.arz_postid, fileName, 'bescheidposition.arztrechnung', omittedRelations);  // FK ON DELETE SET NULL → null ist erlaubt
            await insertRow(client, 'postbuch.erstattungsbescheid_einzelposition', { postid: finalPostid, ...row });
          }
          for (const ku of detail.kuerzungen || []) {
            const row = pick(ku, DETAIL_COLUMNS.erstattungsbescheid_kuerzung);
            const sourceArzPostid = row.arz_postid;
            row.arz_postid = await resolveArzPostid(client, row.arz_postid, fileName, 'kürzung.arztrechnung', omittedRelations);
            if (row.arz_postid == null) {
              row.arz_subid = null;
            } else if (row.arz_subid != null) {
              // Komposit-FK (arz_postid, arz_subid) → arztrechnung_einzelposition: nur behalten, wenn vorhanden
              const ep = await client.query(
                `SELECT 1 FROM postbuch.arztrechnung_einzelposition WHERE postid = $1 AND subid = $2`,
                [row.arz_postid, row.arz_subid]
              );
              if (!ep.rows.length) {
                omittedRelations.push({
                  file: fileName,
                  relation: 'kürzung.rechnungsposition',
                  sourcePostid: sourceArzPostid,
                  sourceSubid: ku.arz_subid,
                });
                row.arz_subid = null;
              }
            }
            await insertRow(client, 'postbuch.erstattungsbescheid_kuerzung', { postid: finalPostid, ...row });
          }
        }

        await client.query('COMMIT');
        report.omittedRelations.push(...omittedRelations);

        // Embedding-Fallback: kein Vektor im JSON → optional neu berechnen (best-effort)
        if (!doc.embedding?.vector && regenerateMissingEmbeddings) {
          regenerateEmbedding(finalPostid, settings).catch(e =>
            console.warn(`[archive-import] Embedding-Nachgenerierung fehlgeschlagen für ${finalPostid}: ${e.message}`));
        }

        const m = /^P(\d{6})$/.exec(finalPostid);
        if (m) maxPostNum = Math.max(maxPostNum, parseInt(m[1], 10));

        report.imported++;
        neuAngelegt.add(finalPostid);
        report.items.push({ file: fileName, postid: finalPostid, status: 'imported' });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        // Hochgeladene Datei wieder entfernen, damit keine Waise in der Ablage bleibt
        if (uploadedFileId) storage.moveToTrash(uploadedFileId, `import-fehler-${Date.now()}`).catch(() => {});
        console.error(`[archive-import] Fehler bei ${fileName}: ${err.message}`);
        appLog('ERROR', 'archive-import', `Import fehlgeschlagen für ${fileName}: ${err.message}`);
        report.failed++;
        report.items.push({
          file: fileName,
          postid: finalPostid,
          status: 'failed',
          error: err.message,
        });
      } finally {
        client.release();
      }
      doneCount++;
      if (jobId) tracker.setStep(jobId, doneCount, fileName);
    }

    // ── Pass C: Ersetzungskanten zwischen Rechnungen dieses Laufs ─────────────
    // Nur wenn beide Seiten in diesem Lauf neu angelegt wurden: Eine bereits
    // vorhandene Ursprungsrechnung trägt eigene Zahlungen, die Kante würde sie
    // doppelt zählen.
    for (const e of ersetzungen) {
      const alt = remap.get(e.altQuelle);
      if (!alt || !neuAngelegt.has(alt) || !neuAngelegt.has(e.neu)) {
        report.omittedRelations.push({ file: e.fileName, relation: 'ersetzt.rechnung', sourcePostid: e.altQuelle });
        continue;
      }
      const zahlungen = e.zahlungen
        .filter((z) => /^\d{4}-\d{2}-\d{2}$/.test(String(z?.datum)) && Number(z?.betrag) > 0)
        .map((z) => ({ datum: z.datum, betrag: Number(z.betrag).toFixed(2) }));
      try {
        await query(
          `INSERT INTO postbuch.dokument_beziehung
             (von_postid, zu_postid, art, umgezogene_zahlungen,
              alt_bezahlt_am_manuell, neu_bezahlt_am_manuell, created_by)
           SELECT $1::varchar, $2::varchar, 'ersetzt', $3::jsonb, $4::boolean, $5::boolean, 'archiv-import'
            WHERE EXISTS (SELECT 1 FROM postbuch.arztrechnung WHERE postid = $1
                          UNION ALL SELECT 1 FROM postbuch.handwerkerrechnung WHERE postid = $1
                          UNION ALL SELECT 1 FROM postbuch.generische_rechnung WHERE postid = $1)
              AND EXISTS (SELECT 1 FROM postbuch.arztrechnung WHERE postid = $2
                          UNION ALL SELECT 1 FROM postbuch.handwerkerrechnung WHERE postid = $2
                          UNION ALL SELECT 1 FROM postbuch.generische_rechnung WHERE postid = $2)
           ON CONFLICT DO NOTHING`,
          [e.neu, alt, JSON.stringify(zahlungen), e.altManuell, e.neuManuell],
        );
      } catch (err) {
        console.warn(`[archive-import] Ersetzung ${e.neu} → ${alt} nicht übernommen: ${err.message}`);
        report.omittedRelations.push({ file: e.fileName, relation: 'ersetzt.rechnung', sourcePostid: e.altQuelle });
      }
    }

    // postbuch-Sequence anheben (Identität importierter IDs bewahren ohne künftige Kollision)
    if (maxPostNum > 0) {
      await query(
        `SELECT setval('postbuch.postbuch_seq', GREATEST((SELECT last_value FROM postbuch.postbuch_seq), $1), true)`,
        [maxPostNum]
      ).catch(() => {});
    }

    appLog('INFO', 'archive-import',
      `Archiv-Import: ${report.imported} importiert, ${report.skipped} übersprungen, ${report.failed} Fehler (Modus: ${conflictMode})`
      + (report.personenZuordnung.length
        ? `; Personen: ${report.personenZuordnung.map(({ quelle, ziel }) => `${quelle} → ${ziel ?? '(keine)'}`).join(', ')}`
        : ''));
    // Fehlerliste im Report begrenzen — bei sehr großen Übergaben soll das
    // Job-Payload nicht auf mehrere tausend Einträge anwachsen.
    const failedItems = report.items.filter(i => i.status === 'failed').slice(0, 50);
    return {
      total: report.total,
      imported: report.imported,
      skipped: report.skipped,
      failed: report.failed,
      omittedRelations: report.omittedRelations.slice(0, 50),
      omittedContext: report.omittedContext,
      personenZuordnung: report.personenZuordnung,
      failedItems,
    };
  } finally {
    zipfile.close();
  }
}
