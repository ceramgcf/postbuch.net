/**
 * lib/update-manifest.js — Validierung des Release-Manifests
 *
 * Das Manifest (`GET <POSTBUCH_FEED_BASE_URL>/latest.json`) ist die einzige Aussage einer
 * Instanz darüber, ob es eine neuere Version gibt. Es kommt von außen, also
 * gilt Whitelist-First: gebaut wird ein **neues** Objekt aus geprüften Feldern,
 * das Eingangsobjekt wird nie durchgereicht. Ein unbekanntes Feld ist kein
 * Fehler, es fällt einfach weg — aber ein URL-artiges Feld ist ein Fehler, denn
 * es deutet auf ein anderes Verständnis des Formats hin (siehe unten).
 *
 * **Im Manifest stehen bewusst KEINE URLs.** Die Bezugsquelle kennt der Client
 * selbst (lokale Feed-Basis + fester Pfad). Stünde sie im Manifest, wäre der Feed ein
 * Umleitungs-Primitiv: wer ihn schreiben kann, bestimmt, von wo eine Instanz
 * ihren nächsten Quellcode zieht.
 *
 * Erwartete Form:
 * {
 *   "schemaVersion": 1,
 *   "version": "2.2.0",
 *   "veroeffentlichtAm": "2026-07-30",
 *   "sicherheitsrelevant": false,
 *   "mindestVersion": null,
 *   "tarball":   { "sha256": "<64 hex>", "groesse": 2013456 },
 *   "installer": { "sha256": "<64 hex>" },
 *   "changelog": ["…", "…"],
 *   "signatur": "<Base64, Ed25519>",
 *   "signaturKeyId": "k1"
 * }
 *
 * Seit 2.3.0 wird `signatur` tatsächlich verifiziert — aber nicht hier. Dieser
 * Validator prüft ausschließlich die FORM; die Kryptographie steht in
 * `lib/release-signatur.js` und wird von `service/update-check.js` aufgerufen.
 * Ein Manifest ohne Signatur ist hier weiterhin gültig: ob das Konsequenzen
 * hat, entscheidet der Vertrauensanker der jeweiligen Instanz, nicht das Format.
 */

import { textFeld, semver, zahlImBereich, sha256Hex, isoDatum } from './postbuch-feed.js';

export const MANIFEST_SCHEMA_VERSION = 1;

const MAX_TARBALL_BYTES = 200 * 1024 * 1024;
const MAX_CHANGELOG_EINTRAEGE = 40;
const MAX_CHANGELOG_LAENGE = 200;

/** Felder, die im Manifest nichts verloren haben. Ihr Auftreten ist ein Fehler. */
const VERBOTENE_FELDER = ['url', 'urls', 'baseUrl', 'tarballUrl', 'downloadUrl', 'href', 'endpoint', 'mirror'];

class ManifestFehler extends Error {
  constructor(message) {
    super(message);
    this.name = 'ManifestFehler';
  }
}

function fehler(msg) {
  throw new ManifestFehler(`Ungültiges Release-Manifest: ${msg}`);
}

function pruefeKeineUrls(obj, pfad = '') {
  if (!obj || typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj)) {
    if (VERBOTENE_FELDER.includes(k)) {
      fehler(`unerlaubtes Feld "${pfad}${k}" — das Manifest enthält keine Adressen.`);
    }
    if (typeof v === 'string' && /^\s*[a-z][a-z0-9+.-]*:\/\//i.test(v)) {
      fehler(`Feld "${pfad}${k}" enthält eine URL — das Manifest enthält keine Adressen.`);
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) pruefeKeineUrls(v, `${pfad}${k}.`);
  }
}

/**
 * Validiert ein rohes Manifest-Objekt und gibt eine saubere Kopie zurück.
 *
 * @param {unknown} obj
 * @returns {{schemaVersion:number, version:string, veroeffentlichtAm:string,
 *            sicherheitsrelevant:boolean, mindestVersion:string|null,
 *            tarball:{sha256:string, groesse:number},
 *            installer:{sha256:string|null},
 *            changelog:string[], signatur:string|null}}
 * @throws {ManifestFehler} mit lesbarer deutscher Meldung
 */
export function validiereManifest(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) fehler('kein JSON-Objekt.');

  pruefeKeineUrls(obj);

  if (obj.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    fehler(`schemaVersion ${JSON.stringify(obj.schemaVersion)} wird nicht unterstützt `
      + `(erwartet: ${MANIFEST_SCHEMA_VERSION}). Diese Postbuch-Version ist vermutlich zu alt.`);
  }

  const version = semver(obj.version);
  if (!version) fehler(`"version" ist kein Semver (war: ${JSON.stringify(obj.version)}).`);

  const veroeffentlichtAm = isoDatum(obj.veroeffentlichtAm);
  if (!veroeffentlichtAm) fehler(`"veroeffentlichtAm" ist kein Datum im Format YYYY-MM-DD.`);

  if (obj.sicherheitsrelevant != null && typeof obj.sicherheitsrelevant !== 'boolean') {
    fehler('"sicherheitsrelevant" muss true oder false sein.');
  }

  let mindestVersion = null;
  if (obj.mindestVersion != null) {
    mindestVersion = semver(obj.mindestVersion);
    if (!mindestVersion) fehler('"mindestVersion" ist kein Semver.');
  }

  if (!obj.tarball || typeof obj.tarball !== 'object') fehler('"tarball" fehlt.');
  const tarSha = sha256Hex(obj.tarball.sha256);
  if (!tarSha) fehler('"tarball.sha256" ist keine 64-stellige Hex-Prüfsumme.');
  const groesse = zahlImBereich(obj.tarball.groesse, 1, MAX_TARBALL_BYTES);
  if (groesse == null || !Number.isInteger(groesse)) {
    fehler(`"tarball.groesse" liegt nicht zwischen 1 Byte und ${Math.round(MAX_TARBALL_BYTES / 1024 / 1024)} MB.`);
  }

  // installer.sha256 ist optional: eine Instanz, die den Installer nicht selbst
  // nachlädt, braucht ihn nicht — der Agent prüft ihn, wenn er ihn holt.
  let installerSha = null;
  if (obj.installer != null) {
    if (typeof obj.installer !== 'object') fehler('"installer" muss ein Objekt sein.');
    if (obj.installer.sha256 != null) {
      installerSha = sha256Hex(obj.installer.sha256);
      if (!installerSha) fehler('"installer.sha256" ist keine 64-stellige Hex-Prüfsumme.');
    }
  }

  let changelog = [];
  if (obj.changelog != null) {
    if (!Array.isArray(obj.changelog)) fehler('"changelog" muss eine Liste sein.');
    if (obj.changelog.length > MAX_CHANGELOG_EINTRAEGE) {
      fehler(`"changelog" hat ${obj.changelog.length} Einträge — erlaubt sind höchstens ${MAX_CHANGELOG_EINTRAEGE}.`);
    }
    changelog = obj.changelog.map((z, i) => {
      const t = textFeld(z, MAX_CHANGELOG_LAENGE);
      if (t === null) {
        fehler(`Changelog-Eintrag #${i + 1} ist unbrauchbar `
          + `(länger als ${MAX_CHANGELOG_LAENGE} Zeichen, oder enthält Markup/Steuerzeichen).`);
      }
      return t;
    }).filter(Boolean);
  }

  // Hier nur die FORM. Verifiziert wird in `lib/release-signatur.js`, aufgerufen
  // von `service/update-check.js` — Formprüfung und Kryptographie gehören nicht
  // in dieselbe Funktion: dieser Validator muss auch dann durchlaufen, wenn gar
  // kein Release-Schlüssel bekannt ist.
  let signatur = null;
  if (obj.signatur != null) {
    if (typeof obj.signatur !== 'string' || !/^[A-Za-z0-9+/=]{1,512}$/.test(obj.signatur.trim())) {
      fehler('"signatur" ist keine Base64-Zeichenkette.');
    }
    signatur = obj.signatur.trim();
  }

  // Welcher Release-Schlüssel unterschrieben hat. Optional: fehlt die Angabe,
  // probiert die Verifikation alle bekannten Schlüssel durch. Das Feld ist
  // Bequemlichkeit, keine Bedingung — es kommt aus derselben Quelle wie die
  // Signatur und darf deshalb nicht darüber entscheiden, OB geprüft wird.
  let signaturKeyId = null;
  if (obj.signaturKeyId != null) {
    if (typeof obj.signaturKeyId !== 'string' || !/^[a-z0-9-]{1,16}$/.test(obj.signaturKeyId.trim())) {
      fehler('"signaturKeyId" ist keine gültige Schlüsselkennung (a-z, 0-9, -, max. 16 Zeichen).');
    }
    signaturKeyId = obj.signaturKeyId.trim();
  }

  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    version,
    veroeffentlichtAm,
    sicherheitsrelevant: obj.sicherheitsrelevant === true,
    mindestVersion,
    tarball: { sha256: tarSha, groesse },
    installer: { sha256: installerSha },
    changelog,
    signatur,
    signaturKeyId,
  };
}

export { ManifestFehler };
export { istNeuer } from './postbuch-feed.js';
