/**
 * lib/storage/nextcloud.js — Ablage-Adapter für Nextcloud (WebDAV)
 *
 * Implementiert die in lib/storage/index.js beschriebene Adapter-Schnittstelle.
 * Aufrufer holen sich den Adapter über getAdapter()/getActiveAdapter(); direkt
 * importiert wird diese Datei nur von den Nextcloud-eigenen Auth-Routen.
 *
 * ── Warum rohes WebDAV statt der `webdav`-Bibliothek ────────────────────────
 * Die Bibliothek bringt eine eigene HTTP-Schicht mit (`@buttercup/fetch`) und
 * folgt Redirects selbst. Damit wären für das Ablage-Backend sämtliche
 * Schutzmaßnahmen aus lib/net-guard.js aus: keine DNS-Auflösung mit
 * IP-Prüfung, kein Verbinden gegen die geprüfte IP (DNS-Rebinding wäre
 * trivial), kein `redirect:'manual'`, kein Body-Limit — und ohne den
 * `zielIstPrivat`-Marker würde clientSafeError() den rohen Fehlertext der
 * LAN-Gegenstelle an den Browser durchreichen.
 *
 * Postbuch braucht real sieben Verben (PROPFIND, MKCOL, PUT, GET, DELETE,
 * MOVE, SEARCH). Die selbst zu sprechen ist billiger als die Bibliothek
 * sicher einzuhängen.
 *
 * ── Ortsmodell ─────────────────────────────────────────────────────────────
 * Bei OneDrive ist alles ID-basiert. WebDAV ist pfadbasiert, hat aber mit
 * `oc:fileid` eine stabile ID (überlebt MOVE und Rename — am lebenden Server
 * verifiziert). Gespeichert wird deshalb weiterhin nur die ID; der Pfad wird
 * bei Bedarf über SEARCH aufgelöst und in einem prozessinternen Cache
 * gehalten.
 *
 * Bewusst KEINE storage_path-Spalte: ein Nutzer *wird* Dateien in der
 * Nextcloud-Web-UI verschieben. Ein Pfad in der DB wäre dann still falsch,
 * während die fileid weiterhin stimmt. Der Cache ist reine Performance und
 * nie Wahrheit — bei 404 wird er verworfen und neu aufgelöst.
 *
 * ── Eine Wurzel ────────────────────────────────────────────────────────────
 * davHome  /remote.php/dav/files/<user>/ — absolute Grenze, immer erzwungen.
 *          Kein Pfad darf sie verlassen (buildUrlInsideRoot/assertInsideRoot).
 *
 * Der konfigurierte Postbuch-Wurzelordner (nextcloud_root_path) ist NUR der
 * Ort, an dem die Ordnerstruktur angelegt wird (getAblageRoot in
 * service/storage-setup.js) — keine zusätzliche Zugriffsgrenze. Eine
 * gespeicherte fileid bleibt über download/uploadContent/remove erreichbar,
 * egal wo im Nextcloud-Konto die Datei gerade liegt (verschoben, umbenannt,
 * von Hand aus dem Wurzelordner herausgezogen) — exakt wie bei OneDrive, wo
 * die 40-stelligen Item-IDs bereits erratungssicher sind. Bei Nextcloud sind
 * fileids zwar kleine Dezimalzahlen und damit theoretisch erratbar, aber jede
 * ID, die hier ankommt, stammt aus einer zuvor selbst geschriebenen DB-Zeile
 * (storage_id) hinter Admin-/Rollenprüfung — nie aus einem rohen, ungeprüften
 * Client-Wert. Eine zusätzliche Pfadgrenze für ID-Zugriffe wurde bewusst
 * verworfen: Sie hätte sonst jede manuell verschobene Datei bis zum nächsten
 * "Wurzelordner umziehen" als "nicht erreichbar" gemeldet.
 */

import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import db from '../../db.js';
import { loadDynamicSettings, getFolders } from '../../config.js';
import {
  guardedFetch, readLimitedText, readLimitedBuffer, NetGuardError,
  MAX_LISTING_BYTES, TIMEOUT_PROBE_MS, TIMEOUT_TRANSFER_MS, releaseDispatchers,
} from '../net-guard.js';
import {
  sanitizeSegment, sanitizeFilename, buildUrlInsideRoot, splitSafePath,
} from './paths.js';

/** Backend-Name — identisch mit dem Wert in postbuch.storage_backend. */
export const name = 'nextcloud';

/** Anzeigename für UI und Logs. */
export const label = 'Nextcloud';

/**
 * Eigenschaften, in denen sich die Backends unterscheiden. Deklarativ.
 *
 * checksumInMeta bleibt bewusst FALSE: Nextcloud liefert `oc:checksums` nur für
 * Dateien, die MIT dem Header `OC-Checksum` hochgeladen wurden — also für
 * unsere eigenen. Für Fremddateien (Web-UI, Desktop-Client) berechnet der
 * Server nichts (nextcloud/server#56057). Ein Backend-weites „hat Checksummen"
 * wäre für den Deep-Scan schlicht falsch und würde Rematches verfälschen.
 * Stattdessen liefert getMeta() `sha256` optional pro Datei.
 */
export const capabilities = {
  oauth: false,           // Login-Flow v2 endet in einem App-Passwort, nicht in OAuth-Tokens
  pfadAufloesung: true,
  checksumInMeta: false,
  freierSpeicher: false,
};

// ── XML ──────────────────────────────────────────────────────────────────────
//
// fast-xml-parser verarbeitet per Default keine DTDs und ist damit XXE-frei.
// processEntities: false setzt das explizit fest, damit ein späteres
// Options-Refactoring die Eigenschaft nicht versehentlich kippt.
// removeNSPrefix, weil die Namespace-Präfixe (d:, oc:, nc:) serverseitig frei
// wählbar sind und nicht Teil des Vertrags sind.
const parser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: true,
  processEntities: false,
  parseTagValue: false,   // fileid & Co. bleiben Strings — keine Zahlen-Überraschungen
  trimValues: true,
});

// Ohne Entity-Verarbeitung bleiben auch die fünf vordefinierten XML-Entities
// und Zeichenreferenzen stehen („Steuer &amp; Behörden“). Für Namen werden
// genau diese dekodiert – eigene DTD-Entities gibt es weiterhin nicht.
const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function xmlText(wert) {
  return String(wert).replace(/&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos));/gi, (m, dez, hex, name) => {
    if (name) return XML_ENTITIES[name.toLowerCase()];
    const code = dez ? Number(dez) : parseInt(hex, 16);
    return code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
}

function alsArray(x) {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}

// ── Fehlerbehandlung ─────────────────────────────────────────────────────────

/** Fehler eines WebDAV-Aufrufs, mit HTTP-Status für die Ablaufsteuerung. */
export class NextcloudError extends Error {
  constructor(message, { status = 0, zielIstPrivat = false } = {}) {
    super(message);
    this.name = 'NextcloudError';
    this.status = status;
    this.zielIstPrivat = zielIstPrivat;
  }
}

/**
 * Bildet einen HTTP-Status auf eine Meldung ab, die gefahrlos beim Nutzer
 * landen darf.
 *
 * Deny-by-default statt Durchreichen: der Antwort-Body der Gegenstelle wird
 * NIE Teil der Meldung. Nextcloud liegt per Definition im privaten Netz — ein
 * durchgereichter Body machte jede Route zum HTTP-Lesegerät fürs LAN.
 * Der volle Text geht ins Server-Log, nicht zum Client.
 */
function meldungFuerStatus(status, methode) {
  switch (status) {
    case 401: return 'Anmeldung an Nextcloud fehlgeschlagen – Benutzername oder App-Passwort stimmt nicht (mehr).';
    // Angemeldet, aber ohne Recht für diesen Vorgang (z. B. schreibgeschützt
    // freigegebener Ordner) – das Passwort ist hier nicht das Problem.
    case 403: return 'Nextcloud verweigert den Zugriff – dem Konto fehlt die Berechtigung für diesen Ordner bzw. diese Datei.';
    case 404: return 'Die Datei oder der Ordner ist in Nextcloud nicht (mehr) vorhanden.';
    case 405: return 'Der Ordner existiert in Nextcloud bereits.';
    case 409: return 'Der übergeordnete Ordner fehlt in Nextcloud.';
    case 412: return 'Am Zielort existiert bereits eine Datei mit diesem Namen.';
    case 413: return 'Die Datei ist größer, als der Nextcloud-Server annimmt.';
    case 423: return 'Die Datei ist in Nextcloud gerade gesperrt. Bitte später erneut versuchen.';
    case 507: return 'Auf dem Nextcloud-Server ist kein Speicherplatz mehr frei.';
    default:  return `Nextcloud hat den Vorgang abgelehnt (${methode} → HTTP ${status}). Details stehen im Server-Log.`;
  }
}

// ── Konfiguration ────────────────────────────────────────────────────────────

/**
 * Liest die Verbindungsdaten aus _settings und baut die beiden Wurzel-URLs.
 * @param {object} [settings] bereits geladene Settings (spart eine Abfrage)
 */
export async function ladeConfig(settings) {
  const s = settings || (await loadDynamicSettings());

  const rawBase = String(s.nextcloud_base_url || '').trim();
  const username = String(s.nextcloud_username || '').trim();
  const appPassword = String(s.nextcloud_app_password || '');

  if (!rawBase) throw new NextcloudError('Nextcloud ist nicht konfiguriert: Server-Adresse fehlt.');
  if (!username || !appPassword) {
    throw new NextcloudError('Nextcloud ist nicht verbunden: Benutzername oder App-Passwort fehlt.');
  }
  // Der Benutzername landet im Pfad. Er kommt aus der Serverantwort des
  // Login-Flows und ist damit fremdbestimmt — deshalb Whitelist, nicht nur
  // Enkodierung.
  if (!/^[A-Za-z0-9._@ -]{1,64}$/.test(username)) {
    throw new NextcloudError('Der Nextcloud-Benutzername enthält unzulässige Zeichen.');
  }

  let baseUrl;
  try {
    baseUrl = new URL(rawBase.endsWith('/') ? rawBase : `${rawBase}/`);
  } catch {
    throw new NextcloudError('Die Nextcloud-Server-Adresse ist keine gültige URL.');
  }

  const allowPrivate = s.storage_allow_private_targets === true;
  const allowInsecure = s.nextcloud_allow_insecure === true;

  // Protokollprüfung ZUR REQUEST-ZEIT, nicht nur beim Speichern: DNS ändert
  // sich, und das App-Passwort geht bei http:// base64-kodiert über den Draht.
  if (baseUrl.protocol === 'http:' && !allowInsecure) {
    throw new NextcloudError(
      'Die Verbindung zu Nextcloud ist unverschlüsselt (http). '
      + 'Für Server im eigenen Netzwerk lässt sich das in den Einstellungen ausdrücklich erlauben.',
    );
  }
  if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') {
    throw new NextcloudError('Nur http:// und https:// sind als Nextcloud-Adresse zulässig.');
  }

  const davHome = new URL(`remote.php/dav/files/${encodeURIComponent(username)}/`, baseUrl);

  return { baseUrl, username, appPassword, allowPrivate, allowInsecure, davHome };
}

/** Verwirft gepoolte Verbindungen — nach Änderung der Verbindungsdaten. */
export async function resetVerbindung(baseUrl) {
  leerePfadCache();
  releaseDispatchers(baseUrl);
}

// ── HTTP-Grundlage ───────────────────────────────────────────────────────────

function authHeader(cfg) {
  const roh = `${cfg.username}:${cfg.appPassword}`;
  return `Basic ${Buffer.from(roh, 'utf8').toString('base64')}`;
}

/**
 * Führt einen WebDAV-Request aus — immer über guardedFetch, damit
 * Schema-Whitelist, DNS-/IP-Prüfung, IP-Pinning, `redirect:'manual'` und
 * Timeouts greifen.
 *
 * @param {object} cfg     Ergebnis von ladeConfig()
 * @param {string} methode HTTP-Verb
 * @param {URL} url        Ziel-URL (muss bereits gegen die Wurzel geprüft sein)
 * @param {object} [opts]
 * @returns {Promise<{ response: Response, zielIstPrivat: boolean }>}
 */
async function dav(cfg, methode, url, opts = {}) {
  // Default ist das Transfer-Timeout, nicht das Probe-Timeout: DELETE
  // verschiebt serverseitig in den Papierkorb und MKCOL legt an — beides kann
  // auf einem kleinen Server länger als 10 s dauern. Das kurze Probe-Timeout
  // gilt nur für den reinen Verbindungstest.
  const {
    headers = {}, body, timeoutMs = TIMEOUT_TRANSFER_MS, erlaubt = [], leise = [],
  } = opts;

  let ergebnis;
  try {
    ergebnis = await guardedFetch(
      url,
      {
        method: methode,
        headers: { Authorization: authHeader(cfg), ...headers },
        body,
      },
      { allowPrivate: cfg.allowPrivate, timeoutMs, reuse: true },
    );
  } catch (err) {
    // NetGuardError trägt bereits zielIstPrivat. Die Message darf hier stehen
    // bleiben — sie stammt von uns, nicht von der Gegenstelle.
    if (err instanceof NetGuardError) {
      throw new NextcloudError(err.message, { zielIstPrivat: err.zielIstPrivat });
    }
    throw new NextcloudError(`Verbindung zu Nextcloud fehlgeschlagen: ${err.message}`);
  }

  const { response, zielIstPrivat } = ergebnis;
  if (!response.ok && !erlaubt.includes(response.status)) {
    // Body verwerfen bzw. nur fürs Server-Log lesen — nie in die geworfene
    // Meldung. `leise` unterdrückt das Log für Status, die im normalen Ablauf
    // vorkommen (412 = Namenskollision, die ohneKollision() gleich auffängt);
    // die als Fehler zu loggen wäre irreführendes Rauschen.
    if (leise.includes(response.status)) {
      await response.body?.cancel?.().catch(() => {});
    } else {
      const rohtext = await readLimitedText(response, 4096).catch(() => '');
      console.error(
        `[nextcloud] ${methode} ${url.pathname} → ${response.status}: ${rohtext.slice(0, 400)}`,
      );
    }
    throw new NextcloudError(meldungFuerStatus(response.status, methode), {
      status: response.status,
      zielIstPrivat,
    });
  }
  return { response, zielIstPrivat };
}

// ── Pfad-Cache (bidirektional, prozessintern) ────────────────────────────────
//
// Reine Performance, nie Wahrheit. Passiv befüllt aus jeder Antwort, die href
// und oc:fileid zusammen liefert — dadurch kostet ein listAllFilesRecursive
// (DR-Deep-Scan) keinen einzigen zusätzlichen Request und wärmt nebenbei den
// gesamten Cache.
//
// Der Rückwärtsindex (pfad → id) ist nicht optional: getMeta() liefert
// parentId, und ohne ihn wäre das je ein zusätzlicher PROPFIND auf den
// Elternordner — bei ~30 Ordnern, die dauernd gebraucht werden.

const CACHE_MAX = 5000;
const _idZuPfad = new Map();
const _pfadZuId = new Map();

function cacheSetze(id, pfad) {
  if (!id || pfad === undefined || pfad === null) return;
  const key = String(id);
  const alt = _idZuPfad.get(key);
  if (alt !== undefined && alt !== pfad) _pfadZuId.delete(alt);

  // Map bewahrt Einfügereihenfolge → ältesten Eintrag verdrängen (LRU-nah).
  if (_idZuPfad.size >= CACHE_MAX && !_idZuPfad.has(key)) {
    const aeltester = _idZuPfad.keys().next().value;
    const aelterPfad = _idZuPfad.get(aeltester);
    _idZuPfad.delete(aeltester);
    if (aelterPfad !== undefined) _pfadZuId.delete(aelterPfad);
  }
  _idZuPfad.set(key, pfad);
  _pfadZuId.set(pfad, key);
}

function cacheHolePfad(id) {
  return _idZuPfad.get(String(id));
}

function cacheVerwerfe(id) {
  const key = String(id);
  const pfad = _idZuPfad.get(key);
  _idZuPfad.delete(key);
  if (pfad !== undefined) _pfadZuId.delete(pfad);
}

/** Nach einem Ordner-Move: alle Einträge unterhalb des alten Pfads verwerfen. */
function cacheVerwerfePraefix(praefix) {
  const mit = `${praefix}/`;
  for (const [pfad, id] of [..._pfadZuId]) {
    if (pfad === praefix || pfad.startsWith(mit)) {
      _pfadZuId.delete(pfad);
      _idZuPfad.delete(id);
    }
  }
}

export function leerePfadCache() {
  _idZuPfad.clear();
  _pfadZuId.clear();
}

// ── Pfad-Werkzeuge ───────────────────────────────────────────────────────────

/**
 * Wandelt einen vom Server gelieferten `d:href` in einen Pfad relativ zu
 * davHome um. Der href ist server-relativ und prozentkodiert; dekodiert wird
 * segmentweise, damit ein kodierter Slash nicht zu einem echten wird.
 *
 * @returns {string|null} z. B. "postbuch/Arztrechnung/Rechnung.pdf", oder ""
 *   für davHome selbst; null, wenn der href außerhalb liegt.
 */
function hrefZuPfad(cfg, href) {
  let pfadTeil;
  try {
    // href kann absolut oder server-relativ sein.
    pfadTeil = new URL(href, cfg.davHome).pathname;
  } catch {
    return null;
  }
  const basis = cfg.davHome.pathname; // endet auf '/'
  if (!pfadTeil.startsWith(basis)) {
    // Auch davHome ohne abschließenden Slash ist ein gültiger href.
    if (`${pfadTeil}/` === basis) return '';
    return null;
  }
  const rest = pfadTeil.slice(basis.length).replace(/\/+$/, '');
  if (!rest) return '';
  return rest.split('/').map((seg) => {
    try { return decodeURIComponent(seg); } catch { return seg; }
  }).join('/');
}

/** Baut aus einem Pfad relativ zu davHome die URL — inklusive davHome-Wurzelprüfung. */
function pfadZuUrl(cfg, pfad) {
  const segmente = String(pfad || '').split('/').filter(Boolean);
  return buildUrlInsideRoot(cfg.davHome, segmente);
}

/** Elternpfad und Basisname eines Pfads relativ zu davHome. */
function zerlege(pfad) {
  const i = pfad.lastIndexOf('/');
  if (i < 0) return { eltern: '', basis: pfad };
  return { eltern: pfad.slice(0, i), basis: pfad.slice(i + 1) };
}

// ── PROPFIND / SEARCH ────────────────────────────────────────────────────────

const PROPS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:prop>
    <d:displayname/><d:getcontentlength/><d:getlastmodified/><d:getetag/>
    <d:resourcetype/><oc:fileid/><oc:checksums/><oc:size/>
  </d:prop>
</d:propfind>`;

/**
 * Zieht aus einem <d:response>-Knoten den 200er-propstat.
 * Nextcloud teilt die Antwort auf: angeforderte, aber nicht vorhandene
 * Properties kommen in einem zweiten propstat mit Status 404.
 */
function props200(resp) {
  for (const ps of alsArray(resp.propstat)) {
    if (String(ps.status || '').includes(' 200 ')) return ps.prop || {};
  }
  return {};
}

/** Wandelt einen <d:response>-Knoten in einen Eintrag um. */
function eintragAus(cfg, resp) {
  const pfad = hrefZuPfad(cfg, resp.href);
  if (pfad === null) return null;
  const p = props200(resp);

  const istOrdner = p.resourcetype !== undefined
    && p.resourcetype !== null
    && p.resourcetype !== ''
    && Object.prototype.hasOwnProperty.call(p.resourcetype, 'collection');

  // getlastmodified ist RFC 1123. Auf ISO normalisieren — storage_modified ist
  // timestamptz, und dr-fingerprint vergleicht normalisiert.
  let lastModified = null;
  if (p.getlastmodified) {
    const d = new Date(p.getlastmodified);
    if (!Number.isNaN(d.getTime())) lastModified = d.toISOString();
  }

  // oc:checksums → { checksum: "SHA256:…" } oder { checksum: [ … ] }
  let sha256 = null;
  const pruefsummen = p.checksums?.checksum;
  for (const c of alsArray(pruefsummen)) {
    const m = String(c).match(/^SHA256:([0-9a-f]{64})$/i);
    if (m) { sha256 = m[1].toLowerCase(); break; }
  }

  const id = p.fileid !== undefined && p.fileid !== null && p.fileid !== ''
    ? String(p.fileid) : null;
  if (id) cacheSetze(id, pfad);

  const { basis } = zerlege(pfad);
  const groesse = istOrdner ? Number(p.size || 0) : Number(p.getcontentlength || 0);

  return {
    id,
    pfad,
    name: p.displayname ? xmlText(p.displayname) : basis,
    size: Number.isFinite(groesse) ? groesse : 0,
    isFolder: istOrdner,
    lastModified,
    etag: p.getetag ? String(p.getetag).replace(/"/g, '') : null,
    sha256,
    webUrl: id ? webUrlFuer(cfg, id) : null,
  };
}

/** PROPFIND mit Tiefe 0 oder 1. Liefert die Einträge als Liste. */
async function propfind(cfg, url, tiefe, opts = {}) {
  const { response } = await dav(cfg, 'PROPFIND', url, {
    headers: { Depth: String(tiefe), 'Content-Type': 'application/xml; charset=utf-8' },
    body: PROPS_XML,
    ...opts,
  });
  const xml = await readLimitedText(response, MAX_LISTING_BYTES);
  const doc = parser.parse(xml);
  return alsArray(doc?.multistatus?.response)
    .map((r) => eintragAus(cfg, r))
    .filter(Boolean);
}

/**
 * Löst eine fileid über DAV-SEARCH in einen Pfad auf.
 *
 * SEARCH läuft gegen /remote.php/dav/ mit einem Scope-href relativ dazu
 * (am lebenden Server verifiziert). Es liefert dieselben Properties wie ein
 * PROPFIND — der Aufruf ist also KEIN zusätzlicher Hop, sondern die
 * By-ID-Variante von PROPFIND und kostet genau einen Request, wie bei OneDrive.
 *
 * Die fileid ist rein numerisch (assertFileId) — deshalb kann sie nicht aus dem
 * XML-Literal ausbrechen. Andere Nutzerdaten kommen bewusst nie in einen
 * XML-Body.
 */
async function sucheNachIdViaSearch(cfg, fileId) {
  assertFileId(fileId, 'sucheNachIdViaSearch');
  const scope = `${cfg.davHome.pathname.replace(/^\/remote\.php\/dav/, '')}`;
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<d:searchrequest xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:basicsearch>
    <d:select><d:prop>
      <d:displayname/><d:getcontentlength/><d:getlastmodified/><d:getetag/>
      <d:resourcetype/><oc:fileid/><oc:checksums/><oc:size/>
    </d:prop></d:select>
    <d:from><d:scope><d:href>${scope}</d:href><d:depth>infinity</d:depth></d:scope></d:from>
    <d:where><d:eq><d:prop><oc:fileid/></d:prop><d:literal>${fileId}</d:literal></d:eq></d:where>
    <d:orderby/>
  </d:basicsearch>
</d:searchrequest>`;

  const suchUrl = new URL('remote.php/dav/', cfg.baseUrl);
  const { response } = await dav(cfg, 'SEARCH', suchUrl, {
    headers: { 'Content-Type': 'text/xml; charset=utf-8' },
    body,
    // 501 ist auf SEARCH-losen Servern (ownCloud) der erwartete Auslöser des
    // Meta-Fallbacks — kein Fehler, den man ins Log schreiben müsste.
    leise: [501],
    timeoutMs: TIMEOUT_TRANSFER_MS,
  });
  const xml = await readLimitedText(response, MAX_LISTING_BYTES);
  const doc = parser.parse(xml);
  const treffer = alsArray(doc?.multistatus?.response)
    .map((r) => eintragAus(cfg, r))
    .filter(Boolean);
  return treffer[0] || null;
}

// Server, die auf DAV-SEARCH mit HTTP 501 antworten (ownCloud implementiert das
// Verb nicht). Einmal erkannt, laufen ID→Pfad-Auflösungen für diesen Server
// direkt über den Meta-Endpunkt. Bewusst prozess-lokal wie der Pfad-Cache —
// eine reine Laufzeit-Weiche, keine persistierte Fähigkeitszusage (das
// deklarative `capabilities` bleibt unberührt).
const _keinSearch = new Set();

const META_PROPS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:prop><oc:meta-path-for-user/></d:prop>
</d:propfind>`;

/**
 * Löst eine fileid in einen vollständigen Eintrag auf.
 *
 * Standardweg ist DAV-SEARCH: ein Request, der Pfad UND Metadaten liefert — so
 * gegen Nextcloud verifiziert. ownCloud kennt das SEARCH-Verb nicht (HTTP 501);
 * für solche Server fällt die Auflösung auf den Meta-Endpunkt
 * `/remote.php/dav/meta/<id>` zurück (`oc:meta-path-for-user` liefert den Pfad
 * direkt, ein Request), gefolgt von einem PROPFIND Depth:0 für die Metadaten.
 * Der verifizierte Nextcloud-Pfad bleibt dadurch unangetastet; der Meta-Weg ist
 * reiner Fallback hinter einer Fähigkeitsweiche.
 */
async function sucheNachId(cfg, fileId) {
  const id = assertFileId(fileId, 'sucheNachId');
  const serverKey = cfg.davHome.href;
  if (!_keinSearch.has(serverKey)) {
    try {
      return await sucheNachIdViaSearch(cfg, id);
    } catch (err) {
      if (!(err instanceof NextcloudError) || err.status !== 501) throw err;
      _keinSearch.add(serverKey);
      console.warn(
        '[nextcloud] Server ohne DAV-SEARCH (HTTP 501) — ID→Pfad läuft künftig über den Meta-Endpunkt.',
      );
    }
  }
  return sucheNachIdViaMeta(cfg, id);
}

/**
 * ID→Eintrag ohne SEARCH: der Meta-Endpunkt liefert den (rohen, bereits
 * dekodierten) Pfad relativ zu davHome; ein anschließendes PROPFIND Depth:0 baut
 * daraus den kanonischen Eintrag samt Metadaten und wärmt den Cache. Der
 * servergelieferte Pfad wird über pfadZuUrl (buildUrlInsideRoot) an die
 * davHome-Grenze gebunden — eine geratene oder bösartige Antwort kann nicht
 * ausbrechen.
 */
async function sucheNachIdViaMeta(cfg, fileId) {
  const id = assertFileId(fileId, 'sucheNachIdViaMeta');
  const metaUrl = new URL(`remote.php/dav/meta/${id}/`, cfg.baseUrl);
  const { response } = await dav(cfg, 'PROPFIND', metaUrl, {
    headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },
    body: META_PROPS_XML,
    erlaubt: [404],
    timeoutMs: TIMEOUT_TRANSFER_MS,
  });
  if (response.status === 404) {
    await response.body?.cancel?.().catch(() => {});
    return null;
  }
  const xml = await readLimitedText(response, MAX_LISTING_BYTES);
  const doc = parser.parse(xml);
  const resp = alsArray(doc?.multistatus?.response)[0];
  const roh = String(props200(resp || {})['meta-path-for-user'] || '').replace(/^\/+/, '');
  if (!roh) return null;
  const [eintrag] = await propfind(cfg, pfadZuUrl(cfg, roh), 0);
  return eintrag || null;
}

// ── IDs ──────────────────────────────────────────────────────────────────────

/**
 * Normalisiert eine fileid auf die kanonische, rein numerische Form.
 *
 * Nextcloud liefert dieselbe ID in zwei Schreibweisen:
 *   PROPFIND/SEARCH `oc:fileid`  →  "54"
 *   Response-Header `OC-FileId`  →  "00000054ocwdw16tql5x"
 *                                    ^^^^^^^^ 8-stellig genullt
 *                                            ^^^^^^^^^^^^ Instanz-Kennung
 * Würden beide Formen ungeprüft in storage_id landen, zeigten zwei Zeilen auf
 * dieselbe Datei, ohne dass ein Vergleich das merkt.
 *
 * @returns {string|null} kanonische ID oder null
 */
export function normalisiereFileId(roh) {
  const s = String(roh ?? '').trim();
  if (!s) return null;
  const m = s.match(/^0*(\d{1,20})(?:[A-Za-z][A-Za-z0-9]*)?$/);
  if (!m) return null;
  try { return String(BigInt(m[1])); } catch { return null; }
}

/**
 * Wirft, wenn die ID keine gültige Nextcloud-fileid ist.
 * Letzte Verteidigungslinie vor dem Einsetzen in einen XML-Body oder eine URL.
 */
export function assertFileId(id, context = 'nextcloud') {
  const norm = normalisiereFileId(id);
  if (!norm) throw new NextcloudError(`${context}: Ungültige Nextcloud-Datei-ID`);
  return norm;
}

/**
 * Formale Gültigkeitsprüfung einer ID dieses Backends — verbindlich, im
 * Gegensatz zum Grobfilter in routes/files.js.
 */
export function isValidId(value) {
  return normalisiereFileId(value) !== null;
}

/**
 * Sieht der String aus wie eine ID dieses Backends (im Gegensatz zu einem
 * Pfad)? Für Eingaben, bei denen beides erlaubt ist (DR-Startordner).
 * Nextcloud-Fileids sind kurze Dezimalzahlen — anders als die 40-stelligen
 * OneDrive-IDs.
 */
export function looksLikeId(value) {
  return typeof value === 'string' && /^\d{1,20}$/.test(value.trim());
}

/**
 * Weblink auf die Datei in der Nextcloud-Oberfläche.
 *
 * Aus der konfigurierten Base-URL gebaut, nicht vom Server übernommen. Ändert
 * der Nutzer seinen Hostnamen, repariert der bestehende dr-fingerprint-Cron die
 * Links automatisch — es braucht keinen neuen Wartungsjob.
 *
 * NIEMALS ein öffentlicher Share-Link (/s/<token>): das wäre eine
 * unauthentifizierte Capability-URL auf ein Dokument mit Gesundheitsdaten.
 */
function webUrlFuer(cfg, fileId) {
  return new URL(`index.php/f/${encodeURIComponent(fileId)}`, cfg.baseUrl).href;
}

// ── ID → Pfad ────────────────────────────────────────────────────────────────

/**
 * Löst eine fileid in einen Pfad relativ zu davHome auf.
 *
 * Geprüft wird nur die ABSOLUTE Grenze (davHome) — eine geratene oder
 * bösartige Antwort kann also nicht aus dem Nutzer-Speicher ausbrechen. Der
 * konfigurierte Postbuch-Wurzelordner schränkt die ID-Auflösung bewusst nicht
 * zusätzlich ein (siehe Kopfkommentar der Datei): eine Datei bleibt über ihre
 * ID erreichbar, auch wenn sie von Hand irgendwo anders im Konto liegt.
 */
async function pfadVonId(cfg, fileId, { frisch = false } = {}) {
  const id = assertFileId(fileId, 'pfadVonId');

  if (!frisch) {
    const gecacht = cacheHolePfad(id);
    if (gecacht !== undefined) {
      pfadZuUrl(cfg, gecacht);
      return gecacht;
    }
  }

  const treffer = await sucheNachId(cfg, id);
  if (!treffer) {
    throw new NextcloudError('Die Datei ist in Nextcloud nicht (mehr) vorhanden.', { status: 404 });
  }
  pfadZuUrl(cfg, treffer.pfad);
  return treffer.pfad;
}

/**
 * Führt eine pfadbasierte Operation für eine fileid aus.
 *
 * Der Cache kann veraltet sein (der Nutzer hat die Datei in der Nextcloud-Web-UI
 * verschoben). Deshalb: bei 404/409 den Eintrag verwerfen, frisch auflösen und
 * GENAU EINMAL wiederholen. Das ist die vollständige Invalidierungsstrategie —
 * eine TTL braucht es nicht.
 */
async function withPath(cfg, fileId, fn) {
  const id = assertFileId(fileId, 'withPath');
  let pfad = await pfadVonId(cfg, id);
  try {
    return await fn(pfad);
  } catch (err) {
    if (!(err instanceof NextcloudError) || (err.status !== 404 && err.status !== 409)) throw err;
    cacheVerwerfe(id);
    pfad = await pfadVonId(cfg, id, { frisch: true });
    return fn(pfad);
  }
}

// ── Namenskollisionen ────────────────────────────────────────────────────────

/** Hängt " (n)" vor der Dateiendung an: "Rechnung.pdf" → "Rechnung (2).pdf". */
function mitZaehler(dateiname, n) {
  const m = dateiname.match(/^(.*?)(\.[A-Za-z0-9]{1,10})$/s);
  if (!m) return `${dateiname} (${n})`;
  return `${m[1]} (${n})${m[2]}`;
}

// Obergrenze für den Kollisions-Retry. Ohne Cap wäre das eine unbegrenzte
// PUT-Schleife gegen einen fremden Server.
const KOLLISION_MAX = 50;

/**
 * Führt eine erzeugende Operation aus und weicht bei Namenskollision auf
 * "Name (2)", "Name (3)" … aus.
 *
 * Nötig, weil WebDAV-PUT standardmäßig ÜBERSCHREIBT: zwei Dokumente mit
 * identischem LLM-Dateinamen wären sonst stiller Datenverlust. Bei OneDrive
 * verhindert das conflictBehavior; hier machen es `If-None-Match: *` bzw.
 * `Overwrite: F` plus dieser Zähler.
 *
 * @param {(name:string)=>Promise<any>} versuch  wirft mit status 412 bei Kollision
 * @returns {Promise<{ ergebnis:any, name:string }>}
 */
async function ohneKollision(wunschName, versuch) {
  for (let n = 1; n <= KOLLISION_MAX; n++) {
    const name = n === 1 ? wunschName : mitZaehler(wunschName, n);
    try {
      return { ergebnis: await versuch(name), name };
    } catch (err) {
      if (err instanceof NextcloudError && err.status === 412) continue;
      throw err;
    }
  }
  throw new NextcloudError(
    `Es existieren bereits ${KOLLISION_MAX} Dateien mit dem Namen "${wunschName}".`,
  );
}

// ── Interface: Lesen ─────────────────────────────────────────────────────────

/**
 * Liefert die Wurzel des Nutzer-Speichers (davHome).
 * Startpunkt der Ordner-Initialisierung — service/storage-setup.js legt den
 * konfigurierten Root-Pfad darunter an.
 */
export async function getRoot() {
  const cfg = await ladeConfig();
  const eintraege = await propfind(cfg, cfg.davHome, 0);
  const wurzel = eintraege[0];
  if (!wurzel?.id) throw new NextcloudError('Der Nextcloud-Nutzerordner ist nicht abrufbar.');
  return { id: wurzel.id, name: cfg.username };
}

/**
 * Liest den gespeicherten Postbuch-Wurzelordner (`nextcloud_root_path`),
 * relativ zu davHome. Leerer String = noch nicht eingerichtet (Zustand vor
 * dem ersten Setup-Lauf); dient nur als Ablageort für neue Ordner/Dateien,
 * schränkt ID-Zugriffe auf bestehende Dateien nicht ein.
 */
export async function leseAblageWurzelPfad() {
  const s = await loadDynamicSettings();
  return String(s.nextcloud_root_path || '').trim();
}

/**
 * Schreibt den Postbuch-Wurzelordner. Aufgerufen wird das ausschließlich von
 * der Ordner-Initialisierung: Er ist kein eigenständig einstellbarer Wert,
 * sondern der Ordner, in dem die Struktur tatsächlich angelegt wurde.
 */
export async function merkeAblageWurzelPfad(pfad) {
  // splitSafePath wirft bei '..' — der Wert darf nie aus einem ungeprüften
  // Pfad entstehen, auch wenn der Aufrufer intern ist.
  const wert = splitSafePath(String(pfad || '')).join('/');
  await db.query(
    `INSERT INTO postbuch._settings (key, value, updated_at)
     VALUES ('nextcloud_root_path', $1::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = NOW()`,
    [JSON.stringify(wert)],
  );
  return wert;
}

/**
 * Der Ordner, unterhalb dessen dieses Backend neue Postbuch-Daten ablegt.
 *
 * Unterschied zu getRoot(): getRoot() liefert den Nutzer-Speicher als Ganzes
 * (Startpunkt der Ordner-Initialisierung), getAblageRoot() den davon
 * abgegrenzten Postbuch-Bereich. Reiner Ablageort für Neuanlagen — bestehende
 * Dateien bleiben über ihre ID erreichbar, auch außerhalb dieses Bereichs.
 * Ohne nextcloud_root_path fallen beide zusammen.
 *
 * Wird angelegt, falls noch nicht vorhanden (idempotent, wie die
 * Ordner-Initialisierung).
 */
export async function getAblageRoot() {
  const cfg = await ladeConfig();
  const s = await loadDynamicSettings();
  const rootPath = String(s.nextcloud_root_path || '').trim();
  if (!rootPath) return getRoot();

  const wurzel = await getRoot();
  let aktuell = wurzel.id;
  let letzterName = wurzel.name;
  for (const seg of splitSafePath(rootPath)) {
    const r = await findOrCreateFolder(aktuell, seg, { strict: true });
    aktuell = r.id;
    letzterName = seg;
  }
  return { id: aktuell, name: letzterName };
}

/**
 * Metadaten eines Items in einem einzigen Roundtrip.
 * Liefert zusätzlich `sha256`, WENN Nextcloud eine Prüfsumme gespeichert hat —
 * das ist nur bei selbst hochgeladenen Dateien der Fall (siehe capabilities).
 */
export async function getMeta(fileId) {
  const cfg = await ladeConfig();
  const id = assertFileId(fileId, 'getMeta');

  const treffer = await sucheNachId(cfg, id);
  if (!treffer) throw new NextcloudError('Die Datei ist in Nextcloud nicht (mehr) vorhanden.', { status: 404 });
  pfadZuUrl(cfg, treffer.pfad);

  const { eltern } = zerlege(treffer.pfad);
  // Der Elternordner ist fast immer schon im Rückwärtsindex (Ordner-IDs werden
  // beim Listing mitgeschrieben) — sonst genau ein PROPFIND Depth:0.
  let parentId = _pfadZuId.get(eltern) ?? null;
  if (!parentId) {
    const [e] = await propfind(cfg, pfadZuUrl(cfg, eltern), 0);
    parentId = e?.id ?? null;
  }

  return {
    id: treffer.id,
    name: treffer.name,
    parentId,
    lastModified: treffer.lastModified,
    webUrl: treffer.webUrl,
    size: treffer.size,
    isFolder: treffer.isFolder,
    sha256: treffer.sha256,
  };
}

/** Menschenlesbarer Pfad eines Items (z. B. "/postbuch/Arztrechnung"). */
export async function getPath(fileId) {
  const cfg = await ladeConfig();
  return `/${await pfadVonId(cfg, fileId)}`;
}

/**
 * Löst einen Pfad relativ zum Nutzer-Speicher in eine Item-ID auf.
 * @param {string} path z. B. "postbuch/Arztrechnung"
 */
export async function resolvePath(path) {
  const cfg = await ladeConfig();
  const segmente = splitSafePath(path);
  const url = buildUrlInsideRoot(cfg.davHome, segmente);
  const [eintrag] = await propfind(cfg, url, 0);
  if (!eintrag?.id) throw new NextcloudError(`Der Ordner "${path}" existiert in Nextcloud nicht.`, { status: 404 });
  return { id: eintrag.id, name: eintrag.name };
}

/** Listet Dateien und Unterordner eines Ordners (nicht rekursiv). */
export async function listChildren(folderId) {
  const cfg = await ladeConfig();
  return withPath(cfg, folderId, async (pfad) => {
    const eintraege = await propfind(cfg, pfadZuUrl(cfg, pfad), 1);
    return eintraege
      .filter((e) => e.pfad !== pfad)   // Depth:1 enthält den Ordner selbst
      .map((e) => ({
        id: e.id,
        name: e.name,
        size: e.size,
        createdAt: e.lastModified,
        createdDateTime: e.lastModified,
        isFolder: e.isFolder,
      }));
  });
}

/** Listet nur die Dateien (keine Unterordner) eines Ordners. */
export async function listAllFiles(folderId) {
  const kinder = await listChildren(folderId);
  return kinder.filter((k) => !k.isFolder).map((k) => ({ id: k.id, name: k.name }));
}

/**
 * Listet alle Dateien rekursiv ab einem Start-Ordner.
 *
 * Über wiederholtes Depth:1 statt Depth:infinity: infinity liefert bei einem
 * großen Baum eine einzige riesige Antwort und ist auf vielen Installationen
 * per Konfiguration abgeschaltet.
 *
 * Nebeneffekt: füllt den Pfad-Cache für den gesamten Baum — der DR-Deep-Scan
 * bezahlt danach keinen einzigen SEARCH mehr.
 */
export async function listAllFilesRecursive(rootFolderId) {
  const cfg = await ladeConfig();
  const start = await pfadVonId(cfg, rootFolderId);

  const dateien = [];
  const queue = [start];
  const gesehen = new Set();

  while (queue.length > 0) {
    const pfad = queue.shift();
    if (gesehen.has(pfad)) continue;
    gesehen.add(pfad);

    const eintraege = await propfind(cfg, pfadZuUrl(cfg, pfad), 1);
    for (const e of eintraege) {
      if (e.pfad === pfad) continue;
      if (e.isFolder) {
        queue.push(e.pfad);
      } else {
        dateien.push({
          id: e.id,
          name: e.name,
          parentId: _pfadZuId.get(zerlege(e.pfad).eltern) ?? null,
          size: e.size,
          webUrl: e.webUrl,
          lastModifiedDateTime: e.lastModified,
        });
      }
    }
  }
  return dateien;
}

/**
 * Lädt eine Datei herunter.
 * @param {string} fileId
 * @param {(p:{receivedBytes:number,totalBytes:number|null})=>void} [onProgress]
 */
export async function download(fileId, onProgress) {
  const cfg = await ladeConfig();
  return withPath(cfg, fileId, async (pfad) => {
    const { response } = await dav(cfg, 'GET', pfadZuUrl(cfg, pfad), {
      timeoutMs: TIMEOUT_TRANSFER_MS,
    });
    return readLimitedBuffer(response, { onProgress });
  });
}

// ── Interface: Ordner ────────────────────────────────────────────────────────

/**
 * Erstellt einen Unterordner. Bei Namenskollision weicht der Name auf
 * "Name (2)" aus — analog zu conflictBehavior:'rename' bei OneDrive.
 */
export async function createFolder(parentFolderId, folderName) {
  const cfg = await ladeConfig();
  const sicher = sanitizeSegment(folderName);
  if (!sicher) throw new NextcloudError(`"${String(folderName).slice(0, 40)}" ergibt keinen gültigen Ordnernamen.`);

  return withPath(cfg, parentFolderId, async (elternPfad) => {
    const { ergebnis } = await ohneKollision(sicher, async (name) => {
      const url = buildUrlInsideRoot(cfg.davHome, [...elternPfad.split('/').filter(Boolean), name]);
      // MKCOL liefert 405, wenn die Collection existiert — das ist hier der
      // Kollisionsfall, nicht 412.
      const { response } = await dav(cfg, 'MKCOL', url, { erlaubt: [405] });
      if (response.status === 405) {
        await response.body?.cancel?.().catch(() => {});
        throw new NextcloudError('existiert', { status: 412 });
      }
      const id = assertFileId(response.headers.get('oc-fileid'), 'createFolder');
      cacheSetze(id, `${elternPfad ? `${elternPfad}/` : ''}${name}`);
      return { id };
    });
    return ergebnis;
  });
}

/**
 * Sucht einen Unterordner; legt ihn an, wenn er fehlt.
 *
 * Sicherheitsregel: ein vorhandener Ordner wird NIEMALS überschrieben oder
 * gelöscht — es wird nur seine ID gelesen.
 *
 * strict: MKCOL zuerst; bei 405 (existiert) den vorhandenen Ordner per PROPFIND
 * holen. Damit kann kein "Name (2)" entstehen, auch nicht bei parallelen
 * Aufrufen — die Variante für die Ordner-Initialisierung. Das ist exakt das
 * Gegenstück zu conflictBehavior:'fail' + 409 bei OneDrive.
 */
export async function findOrCreateFolder(parentFolderId, folderName, opts = {}) {
  const cfg = await ladeConfig();
  const sicher = sanitizeSegment(folderName);
  if (!sicher) throw new NextcloudError(`"${String(folderName).slice(0, 40)}" ergibt keinen gültigen Ordnernamen.`);

  if (!opts.strict) {
    const kinder = await listChildren(parentFolderId);
    const da = kinder.find((k) => k.isFolder && k.name === sicher);
    if (da) return { id: da.id, existed: true };
    const neu = await createFolder(parentFolderId, sicher);
    return { id: neu.id, existed: false };
  }

  return withPath(cfg, parentFolderId, async (elternPfad) => {
    const segmente = [...elternPfad.split('/').filter(Boolean), sicher];
    const url = buildUrlInsideRoot(cfg.davHome, segmente);
    const zielPfad = segmente.join('/');

    const { response } = await dav(cfg, 'MKCOL', url, { erlaubt: [405] });
    if (response.status !== 405) {
      const id = assertFileId(response.headers.get('oc-fileid'), 'findOrCreateFolder');
      cacheSetze(id, zielPfad);
      return { id, existed: false };
    }
    const [vorhanden] = await propfind(cfg, url, 0);
    if (!vorhanden?.id) {
      throw new NextcloudError(`Der Ordner "${sicher}" existiert, ist aber nicht abrufbar.`);
    }
    return { id: vorhanden.id, existed: true };
  });
}

// ── Interface: Schreiben ─────────────────────────────────────────────────────

// Server, deren Prüfsummen-Plugin kein SHA256 als OC-Checksum akzeptiert:
// ownCloud liefert per Default nur SHA1/MD5/ADLER32 und weist einen
// SHA256-OC-Checksum-Header beim Upload mit HTTP 400 ab. Einmal erkannt, laden
// wir für diesen Server ohne den Header hoch. Die Prüfsumme ist nur eine
// Optimierung (getMeta.sha256 ohne Download), kein Korrektheitsmerkmal —
// capabilities meldet checksumInMeta bereits false, der Deep-Scan hasht dann
// selbst. Prozess-lokal wie _keinSearch.
const _keinSha256 = new Set();

/**
 * PUT mit optionalem OC-Checksum-Header (SHA256). Weist der Server den Header ab
 * (ownCloud: HTTP 400 „computed checksum does not match"), wird der Server
 * gemerkt und der PUT einmalig ohne Prüfsummen-Header wiederholt. 412
 * (Namenskollision aus If-None-Match) bleibt unberührt und fliegt weiter nach
 * oben zu ohneKollision().
 */
async function putMitChecksum(cfg, url, content, sha, extraHeaders = {}) {
  const basisHeaders = {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(content.length),
    ...extraHeaders,
  };
  const leise = extraHeaders['If-None-Match'] ? [412] : [];
  const sendeChecksum = !_keinSha256.has(cfg.davHome.href);
  try {
    return await dav(cfg, 'PUT', url, {
      headers: sendeChecksum
        ? { ...basisHeaders, 'OC-Checksum': `SHA256:${sha}` }
        : basisHeaders,
      body: content,
      // Solange wir die Prüfsumme mitschicken, ist ein 400 der erwartete
      // Ablehnungsfall (ownCloud) — leise, weil putMitChecksum ihn gleich
      // abfängt und ohne Header wiederholt.
      leise: sendeChecksum ? [...leise, 400] : leise,
      timeoutMs: TIMEOUT_TRANSFER_MS,
    });
  } catch (err) {
    if (sendeChecksum && err instanceof NextcloudError && err.status === 400) {
      _keinSha256.add(cfg.davHome.href);
      console.warn(
        '[nextcloud] Server lehnt SHA256-OC-Checksum ab (HTTP 400) — Uploads laufen künftig ohne Prüfsummen-Header.',
      );
      return await dav(cfg, 'PUT', url, {
        headers: basisHeaders, body: content, leise, timeoutMs: TIMEOUT_TRANSFER_MS,
      });
    }
    throw err;
  }
}

/**
 * Lädt eine neue Datei in einen Ordner hoch.
 *
 * `If-None-Match: *` verhindert das stille Überschreiben einer gleichnamigen
 * Datei; bei 412 weicht ohneKollision() auf "Name (2)" aus. Der tatsächlich
 * verwendete Name wird zurückgegeben — der Aufrufer schreibt ihn nach
 * storage_filename und darf nicht seinen Wunschnamen annehmen.
 *
 * `OC-Checksum` macht den sha256 später per PROPFIND abrufbar, ohne die Datei
 * zu laden (nur für selbst hochgeladene Dateien, siehe capabilities).
 *
 * @returns {{ id: string, webUrl: string, name: string }}
 */
export async function uploadNew(content, fileName, parentFolderId) {
  const cfg = await ladeConfig();
  const sicher = sanitizeFilename(fileName, 'Dokument');
  const sha = createHash('sha256').update(content).digest('hex');

  return withPath(cfg, parentFolderId, async (elternPfad) => {
    const basis = elternPfad.split('/').filter(Boolean);
    const { ergebnis, name } = await ohneKollision(sicher, async (kandidat) => {
      const url = buildUrlInsideRoot(cfg.davHome, [...basis, kandidat]);
      const { response } = await putMitChecksum(cfg, url, content, sha, { 'If-None-Match': '*' });
      const id = assertFileId(response.headers.get('oc-fileid'), 'uploadNew');
      cacheSetze(id, [...basis, kandidat].join('/'));
      return id;
    });
    return { id: ergebnis, webUrl: webUrlFuer(cfg, ergebnis), name };
  });
}

/** Überschreibt den Inhalt einer bestehenden Datei (Name und ID bleiben). */
export async function uploadContent(fileId, content) {
  const cfg = await ladeConfig();
  const sha = createHash('sha256').update(content).digest('hex');
  await withPath(cfg, fileId, async (pfad) => {
    await putMitChecksum(cfg, pfadZuUrl(cfg, pfad), content, sha);
  });
}

/**
 * Verschiebt eine Datei in einen anderen Ordner und benennt sie um.
 *
 * Die fileid bleibt dabei erhalten (am lebenden Server verifiziert) — der
 * Rückgabewert `id` ist also identisch mit der Eingabe, genau wie bei OneDrive
 * die Item-ID erhalten bleibt.
 *
 * @returns {{ id: string, webUrl: string, name: string }}
 */
export async function move(fileId, destFolderId, newName) {
  const cfg = await ladeConfig();
  const id = assertFileId(fileId, 'move');
  const sicher = sanitizeFilename(newName, 'Dokument');

  const zielElternPfad = await pfadVonId(cfg, destFolderId);
  const zielBasis = zielElternPfad.split('/').filter(Boolean);

  return withPath(cfg, id, async (quellPfad) => {
    const quellUrl = pfadZuUrl(cfg, quellPfad);

    const { ergebnis, name } = await ohneKollision(sicher, async (kandidat) => {
      const zielUrl = buildUrlInsideRoot(cfg.davHome, [...zielBasis, kandidat]);
      const { response } = await dav(cfg, 'MOVE', quellUrl, {
        // Destination MUSS absolut sein. Overwrite: F macht die Kollision zu
        // einem 412 statt zu stillem Datenverlust.
        headers: { Destination: zielUrl.href, Overwrite: 'F' },
        leise: [412],
      });
      const neueId = normalisiereFileId(response.headers.get('oc-fileid')) || id;
      return { neueId, zielPfad: [...zielBasis, kandidat].join('/') };
    });

    // Beim Verschieben eines ORDNERS werden alle darunter gecachten Pfade
    // ungültig. Ob es einer war, wissen wir hier nicht — und müssen es auch
    // nicht: für eine Datei gibt es keine Einträge unter "<pfad>/", der Aufruf
    // ist dann ein No-Op. Billiger als ein PROPFIND nur zur Fallunterscheidung.
    cacheVerwerfePraefix(quellPfad);
    cacheVerwerfe(id);
    cacheSetze(ergebnis.neueId, ergebnis.zielPfad);

    return { id: ergebnis.neueId, webUrl: webUrlFuer(cfg, ergebnis.neueId), name };
  });
}

/**
 * Verschiebt eine Datei in den konfigurierten Papierkorb-Ordner.
 * Das ist ein selbstgebauter _trash-Ordner, nicht der Nextcloud-Papierkorb —
 * identisch zum OneDrive-Verhalten und damit 1:1 portiert.
 */
export async function moveToTrash(fileId, trashName) {
  const settings = await loadDynamicSettings();
  const trashFolderId = getFolders(settings, name).trash;
  if (!trashFolderId) {
    throw new NextcloudError(
      'Nextcloud: Papierkorb-Ordner nicht konfiguriert (storage_folders.nextcloud.trash fehlt).',
    );
  }
  return move(fileId, trashFolderId, trashName);
}

/** Löscht eine Datei. Sie landet im Nextcloud-Systempapierkorb des Nutzers. */
export async function remove(fileId) {
  const cfg = await ladeConfig();
  const id = assertFileId(fileId, 'remove');
  await withPath(cfg, id, async (pfad) => {
    await dav(cfg, 'DELETE', pfadZuUrl(cfg, pfad), { erlaubt: [404] });
  });
  cacheVerwerfe(id);
}

// ── Verbindungstest ──────────────────────────────────────────────────────────

/**
 * Prüft Erreichbarkeit und Anmeldung, ohne etwas zu schreiben.
 * @returns {{ ok: true, username: string, quotaBytes: number|null }}
 */
export async function testeVerbindung(settings) {
  const cfg = await ladeConfig(settings);
  // Kurzes Timeout: ein Verbindungstest soll das UI nicht minutenlang blockieren.
  const eintraege = await propfind(cfg, cfg.davHome, 0, { timeoutMs: TIMEOUT_PROBE_MS });
  if (!eintraege.length) throw new NextcloudError('Der Nextcloud-Nutzerordner ist nicht abrufbar.');
  return { ok: true, username: cfg.username, quotaBytes: eintraege[0].size ?? null };
}
