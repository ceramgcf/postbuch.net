/**
 * lib/scanner-capabilities.js — Gerätefähigkeiten eines eSCL-Scanners ermitteln
 *
 * Holt `/eSCL/ScannerCapabilities` vom Gerät und übersetzt das XML in die
 * Form, die App und UI brauchen: welche Auflösungen und Farbmodi je Quelle
 * (Flachbett / ADF / ADF-Duplex) wirklich gehen.
 *
 * Warum hier im app-Container und nicht im scanner-Container:
 *   • Der Scanner ist ein optionales Compose-Profil. Die Ermittlung muss auch
 *     dann funktionieren, wenn der Container nicht läuft.
 *   • Der Einrichtungsassistent sucht das Netz nach Geräten ab — er fragt also
 *     Adressen ab, die noch in keiner Konfiguration stehen. Der scanner-Container
 *     kennt immer nur sein eigenes konfiguriertes Gerät.
 *   • `ScannerCapabilities` ist ein zustandsloser GET. Er belegt keinen
 *     Scan-Job und stört damit einen laufenden Scan nicht — anders als ein
 *     `scanimage -A`, das das Gerät öffnet.
 *
 * Genutzt von `routes/settings.js` (Ermittlung + Persistenz in `_settings`)
 * und vorgesehen für den Scanner-Schritt des Einrichtungsassistenten
 * (Gerätesuche im Netz, Verbindungstest). Der Parser existiert bewusst nur
 * einmal — beide Wege liefern dieselben Felder.
 */

import { XMLParser } from 'fast-xml-parser';
import { guardedFetch, readLimitedText } from './net-guard.js';
import net from 'node:net';

// fast-xml-parser verarbeitet per Default keine DTDs und ist damit XXE-frei;
// processEntities: false hält das explizit fest. removeNSPrefix, weil die
// Präfixe (scan:, pwg:) herstellerseitig frei wählbar sind.
const parser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: true,
  processEntities: false,
  parseTagValue: false,
  trimValues: true,
});

/** Ein Capabilities-XML ist wenige zehn KB groß. 1 MB ist bereits großzügig. */
const MAX_XML_BYTES = 1024 * 1024;

/**
 * Auflösungen unterhalb dieser Grenze werden verworfen. Für Belegablage mit
 * anschließender OCR ergibt weniger keinen brauchbaren Text mehr.
 */
export const MIN_DPI = 200;

/**
 * Obergrenze. Geräte melden oft 1200 oder 2400 dpi — für Dokumentenablage
 * entstehen daraus nur riesige Dateien ohne Erkenntnisgewinn.
 */
export const MAX_DPI = 600;

/**
 * Fallback, solange nie ermittelt wurde. Entspricht exakt dem Verhalten vor
 * Einführung der Ermittlung, damit ein Update bestehende Installationen nicht
 * anfasst und niemand zur Ermittlung gezwungen ist.
 */
export const STANDARD_QUELLE = Object.freeze({
  aufloesungen: [300, 600],
  modi: ['gray', 'color'],
});

/** Quellen-Schlüssel, wie sie App, UI und Scan-Endpunkte verwenden. */
export const QUELLEN = Object.freeze(['flatbed', 'adf', 'adf-duplex']);
export const SCANNER_PORTS = Object.freeze([80, 443, 8080]);

/**
 * Scannerziele sind absichtlich enger als andere konfigurierbare LAN-Ziele:
 * ausschließlich literale RFC1918-IPv4-Adressen und bekannte eSCL-Ports.
 * Damit wird der Capability-Test nicht zum Blind-SSRF gegen Loopback,
 * Link-Local/Metadaten, CGNAT, öffentliche Hosts oder interne DNS-Namen.
 */
export function normalisiereScannerEndpoint(roh) {
  const eingabe = String(roh || '').trim();
  if (!eingabe) return null;
  let url;
  try { url = new URL(eingabe); } catch { throw new Error('Ungültige Scanner-Adresse.'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Scanner-Adresse muss http:// oder https:// verwenden.');
  if (url.username || url.password) throw new Error('Zugangsdaten sind in der Scanner-Adresse nicht erlaubt.');
  if (!net.isIPv4(url.hostname)) throw new Error('Scanner-Adresse muss eine private IPv4-Adresse sein.');
  const [a, b] = url.hostname.split('.').map(Number);
  const rfc1918 = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  if (!rfc1918) throw new Error('Scanner-Adresse muss in einem privaten RFC1918-Netz liegen.');
  const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
  if (!SCANNER_PORTS.includes(port)) throw new Error('Erlaubte Scanner-Ports sind 80, 443 und 8080.');
  url.port = String(port);
  url.pathname = '/eSCL';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

// eSCL-Farbmodus → interner Modus. `BlackAndWhite1` ist 1-Bit-Lineart; viele
// Geräte (u. a. HP OfficeJet) melden es gar nicht, dann gibt es dort kein
// Schwarzweiß und die Option erscheint zu Recht nicht.
const FARBMODUS_MAP = {
  Grayscale8: 'gray',
  RGB24: 'color',
  BlackAndWhite1: 'bw',
};

// eSCL-Wurzelelement je Quelle → interner Quellen-Schlüssel.
const QUELLE_MAP = [
  ['Platen', 'PlatenInputCaps', 'flatbed'],
  ['Adf', 'AdfSimplexInputCaps', 'adf'],
  ['Adf', 'AdfDuplexInputCaps', 'adf-duplex'],
];

function alsArray(x) {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}

/**
 * eSCL gibt Längen in Pixeln bei 300 dpi an (`MaxWidth`, `MaxHeight`).
 * Für die Papierformat-Erkennung brauchen wir Millimeter.
 */
function pixelZuMm(wert) {
  const px = Number(wert);
  if (!Number.isFinite(px) || px <= 0) return 0;
  return Math.round((px / 300) * 25.4);
}

/** Baut `/eSCL/ScannerCapabilities` aus einer beliebig getippten Geräte-URL. */
export function capabilitiesUrl(geraeteUrl) {
  const url = new URL(normalisiereScannerEndpoint(geraeteUrl));
  url.pathname = '/eSCL/ScannerCapabilities';
  url.search = '';
  url.hash = '';
  return url.toString();
}

/**
 * Zieht aus einem SettingProfile-Block die unterstützten Auflösungen und
 * Farbmodi. Geräte liefern entweder eine Liste diskreter Werte oder einen
 * Bereich mit Schrittweite — beide Formen kommen vor.
 */
function leseProfil(caps) {
  const profile = alsArray(caps?.SettingProfiles?.SettingProfile);

  const modi = new Set();
  const aufloesungen = new Set();

  for (const profil of profile) {
    for (const roh of alsArray(profil?.ColorModes?.ColorMode)) {
      const modus = FARBMODUS_MAP[String(roh)];
      if (modus) modi.add(modus);
    }

    const unterstuetzt = profil?.SupportedResolutions;

    for (const diskret of alsArray(unterstuetzt?.DiscreteResolutions?.DiscreteResolution)) {
      // Nur quadratische Auflösungen; X≠Y ist für uns kein wählbarer Wert.
      const x = Number(diskret?.XResolution);
      const y = Number(diskret?.YResolution);
      if (Number.isFinite(x) && x === y) aufloesungen.add(x);
    }

    // Bereichsform: min..max in Schritten. Wir picken daraus nur die üblichen
    // Stufen heraus, statt jeden möglichen Wert anzubieten.
    const min = Number(unterstuetzt?.XResolutionRange?.Min);
    const max = Number(unterstuetzt?.XResolutionRange?.Max);
    if (Number.isFinite(min) && Number.isFinite(max) && max >= min) {
      for (const stufe of [200, 300, 400, 600]) {
        if (stufe >= min && stufe <= max) aufloesungen.add(stufe);
      }
    }
  }

  return {
    aufloesungen: [...aufloesungen]
      .filter(d => d >= MIN_DPI && d <= MAX_DPI)
      .sort((a, b) => a - b),
    modi: ['gray', 'color', 'bw'].filter(m => modi.has(m)),
    maxBreiteMm: pixelZuMm(caps?.MaxWidth),
    maxHoeheMm: pixelZuMm(caps?.MaxHeight),
  };
}

/**
 * Parst ein ScannerCapabilities-XML.
 *
 * Gibt bewusst **nur** Gerätefähigkeiten zurück — kein Roh-XML, keine
 * Seriennummer und vor allem nicht die Geräteadresse. Das Ergebnis wird über
 * `settings-public` auch an Nutzer mit `lesezugriff` ausgeliefert; die
 * Scanner-URL ist dagegen ein Admin-Feld und muss es bleiben.
 *
 * @param {string} xml
 * @returns {{geraet: string, quellen: Record<string, object>}}
 */
export function parseCapabilities(xml) {
  const wurzel = parser.parse(xml)?.ScannerCapabilities;
  if (!wurzel) throw new Error('Antwort ist kein ScannerCapabilities-Dokument');

  const quellen = {};
  for (const [aussen, innen, schluessel] of QUELLE_MAP) {
    const caps = wurzel?.[aussen]?.[innen];
    if (!caps) continue;
    const profil = leseProfil(caps);
    // Eine Quelle ohne verwertbare Auflösung oder ohne Farbmodus ist für uns
    // nicht nutzbar — dann lieber gar nicht melden als eine leere Liste, auf
    // die die UI zurückfällt.
    if (profil.aufloesungen.length && profil.modi.length) quellen[schluessel] = profil;
  }

  if (!Object.keys(quellen).length) {
    throw new Error('Das Gerät meldet keine nutzbare Quelle (Auflösung/Farbmodus)');
  }

  return {
    geraet: String(wurzel?.MakeAndModel || '').slice(0, 120),
    quellen,
  };
}

/**
 * Holt und parst die Gerätefähigkeiten.
 *
 * Der Scanner steht im LAN, also ist `allowPrivate` hier zwingend — das ist
 * genau der Zweck, nicht ein Versehen. Die URL stammt aus einer Admin-
 * Einstellung bzw. aus der Netzsuche des Einrichtungsassistenten; Fehler
 * privater Ziele dürfen nur über `clientSafeError()` nach außen.
 *
 * @param {string} geraeteUrl  z. B. http://192.168.1.50:80/eSCL
 * @param {{timeoutMs?: number}} [opts]
 */
export async function holeScannerCapabilities(geraeteUrl, { timeoutMs = 8000 } = {}) {
  const url = capabilitiesUrl(geraeteUrl);

  const { response } = await guardedFetch(
    url,
    { method: 'GET', headers: { Accept: 'application/xml, text/xml' } },
    {
      allowPrivate: true,
      timeoutMs,
      // Scanner sind eng auf literale RFC1918-Adressen und feste Ports
      // begrenzt. Ihr Gerätezertifikat darf self-signed, abgelaufen oder auf
      // einen anderen Namen ausgestellt sein; TLS dient hier nur dem Transport.
      allowUntrustedTls: url.startsWith('https://'),
    },
  );

  if (!response.ok) {
    await response.body?.cancel?.().catch(() => {});
    throw new Error(`Gerät antwortet mit HTTP ${response.status} auf ScannerCapabilities`);
  }

  const xml = await readLimitedText(response, MAX_XML_BYTES);
  return parseCapabilities(xml);
}

/**
 * Fähigkeiten einer Quelle, mit Rückfall auf den Stand vor der Ermittlung.
 * Einzige Stelle, an der dieser Rückfall entschieden wird — Validierung und
 * Anzeige müssen sich sonst zwangsläufig auseinanderentwickeln.
 *
 * @param {object|null} capabilities  Inhalt von `_settings.scanner_capabilities`
 * @param {string} quelle             'flatbed' | 'adf' | 'adf-duplex'
 */
export function quelleAusCapabilities(capabilities, quelle) {
  const q = capabilities?.quellen?.[quelle];
  if (Array.isArray(q?.aufloesungen) && q.aufloesungen.length
    && Array.isArray(q?.modi) && q.modi.length) {
    return {
      aufloesungen: q.aufloesungen.filter(d => Number.isInteger(d) && d >= MIN_DPI && d <= MAX_DPI),
      modi: q.modi.filter(m => m === 'gray' || m === 'color' || m === 'bw'),
    };
  }
  return { ...STANDARD_QUELLE };
}

/** Ordnet einen Scan-Endpunkt der Quelle zu, deren Fähigkeiten für ihn gelten. */
export function quelleFuerEndpunkt(endpunkt) {
  const e = String(endpunkt);
  if (!e.startsWith('adf/')) return 'flatbed';
  // Deckt sowohl 'adf/duplex' als auch 'adf/batch/duplex' ab.
  return e.endsWith('duplex') ? 'adf-duplex' : 'adf';
}
