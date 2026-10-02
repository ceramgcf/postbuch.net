/**
 * lib/postbuch-feed.js — gemeinsame Basis der beiden öffentlichen Feeds
 *
 * Zwei Features holen sich Daten von der Postbuch-Homepage: der Update-Check
 * (`/latest.json`) und die kuratierten Modellempfehlungen
 * (`/llm-empfehlungen.json`). Beide brauchen denselben geführten JSON-GET und
 * dieselben Kleinst-Validatoren — Fachwissen über die Inhalte steht bewusst
 * NICHT hier, sondern in `update-manifest.js` bzw. `llm/empfehlungen-feed.js`.
 *
 * ── Harte Invarianten ──────────────────────────────────────────────────────
 *  • Die Bezugsquelle gehört zur Instanz, nicht zum Produkt. Sie kommt
 *    ausschließlich aus `POSTBUCH_FEED_BASE_URL` in der lokalen `.env`; es
 *    gibt bewusst weder einen eingebauten Default noch ein `_settings`-Feld.
 *    Damit kann weder ein Release noch ein Admin-API-Aufruf den Zielhost einer
 *    anderen Instanz vorgeben. Fehlt die Variable, bleiben beide Feeds aus.
 *    Einzige feste Abbildung: der mit 2.9.0 beendete Testkanal
 *    `https://test.postbuch.net` gilt als die öffentliche GitHub-Quelle; der
 *    Installer schreibt dieselbe Umstellung beim nächsten Lauf in die `.env`.
 *    Die Zugangsdaten (siehe unten) sind davon unberührt: sie bestimmen, OB
 *    geladen wird, nie WOHER.
 *  • Jeder Abruf läuft über `net-guard.js` — dieselbe Behandlung wie jede
 *    andere ausgehende Verbindung. `allowPrivate: false`. Weiterleitungen nur
 *    beim Release-Manifest (GitHub leitet Asset-Downloads um); jede Station
 *    wird dabei erneut geprüft, Zugangsdaten verlassen nie den Origin.
 *  • Fehler gehen nur über `clientSafeError()` nach außen.
 *  • Antwort-Limit 64 kB. Beide Feeds sind winzig; alles darüber ist ein Fehler
 *    auf Betreiberseite oder ein Versuch, den Speicher zu füllen.
 *
 * ── Zugangsdaten ────────────────────────────────────────────────────────────
 * Die Bezugsquelle liegt hinter HTTP Basic Auth. `POSTBUCH_FEED_AUTH` trägt
 * `benutzer:passwort` und kommt **ausschließlich aus der ENV** (`.env` →
 * docker-compose), nie aus `_settings`. Zwei Gründe:
 *
 *  1. `_settings` ist Konfiguration, kein Credential-Store — dieselbe
 *     Entscheidung wie beim Admin-Passwort (siehe `seed-settings.js`). Was
 *     nicht in der Tabelle steht, kann auch über keine Settings-Route
 *     versehentlich hinausgereicht werden.
 *  2. Ein Wechsel des Passworts ist damit `.env` ändern + Neustart. Läge der
 *     Wert geseedet in der DB, bräuchte jede Rotation `ENV_FORCE_OVERRIDE`.
 *
 * Der Header wird hier zentral gesetzt, nicht in den Aufrufern: so kann kein
 * künftiger dritter Feed-Konsument ihn vergessen.
 */

import { createHash } from 'node:crypto';
import { guardedFetchJson, clientSafeError, TIMEOUT_PROBE_MS } from './net-guard.js';

/** Ist für diese Instanz eine Bezugsquelle hinterlegt? */
export function hatFeedQuelle() {
  try {
    feedBasis();
    return true;
  } catch {
    return false;
  }
}

/**
 * Stabile, nicht rückrechenbar abgelegte Kennung für feed-gebundene Caches.
 *
 * Mit `vorab = true` (nur bei GitHub-Quellen wirksam) entsteht eine andere
 * Kennung: ein Cache aus dem Vorabkanal darf nach dem Zurückschalten nicht als
 * stabiler Stand erscheinen und umgekehrt.
 */
export function feedQuelleFingerprint({ vorab = false } = {}) {
  const basis = feedBasis();
  const kanal = vorab && githubQuelle() ? '#vorab' : '';
  return createHash('sha256').update(basis + kanal).digest('hex');
}

// GitHub-Releases-Seite eines Repos, z. B. https://github.com/<owner>/<repo>/releases.
// Owner und Repo nach GitHubs eigenen Namensregeln; alles andere ist eine
// flache Bezugsquelle (Dateien direkt unter der Basis, z. B. test.postbuch.net).
const GITHUB_RE = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})\/releases$/;

/** `{ owner, repo }` bei einer GitHub-Quelle, sonst null. Wirft nie. */
export function githubQuelle() {
  let basis;
  try {
    basis = feedBasis();
  } catch {
    return null;
  }
  const m = GITHUB_RE.exec(basis);
  if (!m || m[2] === '.' || m[2] === '..') return null;
  return { owner: m[1], repo: m[2] };
}

/**
 * Liest und normalisiert die instanzlokale Feed-Basis.
 *
 * Der Pfad bleibt absichtlich erlaubt: GitHub Releases und andere künftige
 * Veröffentlichungswege stellen ihre Assets oft nicht am Origin-Root bereit.
 * Query, Fragment und URL-Credentials wären dagegen nie Teil einer stabilen
 * Bezugsquelle und werden abgewiesen.
 */
function feedBasis() {
  const roh = String(process.env.POSTBUCH_FEED_BASE_URL || '').trim();
  if (!roh) {
    throw new FeedError(
      'Keine Bezugsquelle konfiguriert. POSTBUCH_FEED_BASE_URL in der .env setzen und die App neu starten.',
    );
  }

  let url;
  try {
    url = new URL(roh);
  } catch {
    throw new FeedError('POSTBUCH_FEED_BASE_URL in der .env ist keine gültige HTTPS-URL.');
  }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new FeedError(
      'POSTBUCH_FEED_BASE_URL muss eine HTTPS-URL ohne Zugangsdaten, Query oder Fragment sein.',
    );
  }
  const basis = url.href.replace(/\/+$/, '');
  return basis === TESTKANAL_ALT ? QUELLE_STANDARD : basis;
}

// Gleiche Werte wie QUELLE_STANDARD / QUELLE_TESTKANAL_ALT in deploy-pages/install.sh.
const QUELLE_STANDARD = 'https://github.com/ceramgcf/postbuch.net/releases';
const TESTKANAL_ALT = 'https://test.postbuch.net';

export const FEED_MAX_BYTES = 64 * 1024;

/**
 * `Authorization: Basic …` aus `POSTBUCH_FEED_AUTH`, oder null.
 *
 * Bei jedem Aufruf frisch gelesen statt einmal beim Import: ein Modul-Konstante
 * würde beim Testen und bei einem künftigen Reload den alten Wert festhalten.
 * Die Kosten sind eine Base64-Kodierung pro Tagesabruf.
 * Eine GitHub-Quelle bekommt nie Zugangsdaten, auch wenn aus dem früheren
 * Testkanal noch `POSTBUCH_FEED_AUTH` in der `.env` steht.
 */
function authHeader() {
  if (githubQuelle()) return null;
  const roh = String(process.env.POSTBUCH_FEED_AUTH || '').trim();
  if (!roh || !roh.includes(':')) return null;
  return `Basic ${Buffer.from(roh, 'utf8').toString('base64')}`;
}

/** Kennt diese Instanz Zugangsdaten für die Bezugsquelle? Ohne Wert-Preisgabe. */
export function hatFeedZugang() {
  return authHeader() !== null;
}

/** Ein Feed-Fehler, der gefahrlos an einen Admin-Client gehen darf. */
export class FeedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FeedError';
  }
}

/**
 * Holt einen Feed als JSON. Wirft `FeedError` mit client-sicherem Text.
 *
 * @param {string} pfad z. B. '/latest.json'
 * @param {object} [opts]
 * @param {number} [opts.maxBytes]
 * @param {number} [opts.timeoutMs]
 */
export async function holeFeed(pfad, { maxBytes = FEED_MAX_BYTES, timeoutMs = TIMEOUT_PROBE_MS } = {}) {
  const url = `${feedBasis()}/${String(pfad).replace(/^\/+/, '')}`;
  const auth = authHeader();
  try {
    return await guardedFetchJson(url, {
      headers: auth
        ? { Accept: 'application/json', Authorization: auth }
        : { Accept: 'application/json' },
    }, { allowPrivate: false, timeoutMs, maxBytes });
  } catch (err) {
    console.warn(`[postbuch-feed] ${pfad} fehlgeschlagen:`, err.message);
    // 401/403 verdient eine eigene Meldung. Ein durchgereichtes „HTTP 401:
    // <HTML-Seite>" landete sonst als Netzfehler im UI und eine Instanz mit
    // falschem Passwort meldete monatelang „keine Updates", ohne dass jemand
    // den Grund sähe. Der Text nennt bewusst NICHT den konfigurierten Wert.
    if (/^HTTP 40[13]\b/.test(String(err?.message || ''))) {
      throw new FeedError(
        auth
          ? 'Die Bezugsquelle hat die hinterlegten Zugangsdaten abgelehnt '
            + '(HTTP 401). POSTBUCH_FEED_AUTH in der .env prüfen und die App neu starten.'
          : 'Die Bezugsquelle verlangt eine Anmeldung, diese Instanz hat aber keine '
            + 'Zugangsdaten hinterlegt (POSTBUCH_FEED_AUTH in der .env fehlt).',
      );
    }
    throw new FeedError(clientSafeError(err));
  }
}

// ── Release-Manifest ─────────────────────────────────────────────────────────

/** Weiterleitungen beim Manifest: GitHub braucht eine, Puffer für CDN-Wechsel. */
const MANIFEST_MAX_REDIRECTS = 5;
/** Die Release-Liste der API enthält Release-Texte und Asset-Listen. */
const GITHUB_API_MAX_BYTES = 4 * 1024 * 1024;
/** So viele Releases durchsucht der Vorabkanal (neueste zuerst). */
const GITHUB_API_PER_PAGE = 20;

async function holeJson(url, headers, opts, bezeichnung) {
  try {
    return await guardedFetchJson(url, { headers }, { allowPrivate: false, ...opts });
  } catch (err) {
    console.warn(`[postbuch-feed] ${bezeichnung} fehlgeschlagen:`, err.message);
    if (/^HTTP 404\b/.test(String(err?.message || ''))) {
      throw new FeedError(`Die Bezugsquelle hat noch kein passendes Release veröffentlicht (${bezeichnung}).`);
    }
    throw new FeedError(clientSafeError(err));
  }
}

/**
 * Höchste veröffentlichte Version eines GitHub-Repos einschließlich
 * Vorabversionen. Entwürfe und Tags außerhalb von `vX.Y.Z` zählen nicht.
 * @returns {Promise<string>} z. B. '2.9.1'
 */
async function hoechsteGithubVersion({ owner, repo }, timeoutMs) {
  const url = `https://api.github.com/repos/${owner}/${repo}/releases?per_page=${GITHUB_API_PER_PAGE}`;
  const liste = await holeJson(url, {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'postbuch.net-update-check',
  }, { timeoutMs, maxBytes: GITHUB_API_MAX_BYTES, maxRedirects: MANIFEST_MAX_REDIRECTS }, 'Release-Liste');
  if (!Array.isArray(liste)) throw new FeedError('Die Release-Liste von GitHub hat ein unerwartetes Format.');

  let beste = null;
  for (const r of liste) {
    if (!r || r.draft) continue;
    const m = /^v(\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(String(r.tag_name || ''));
    if (!m) continue;
    const hatManifest = Array.isArray(r.assets) && r.assets.some((a) => a?.name === 'latest.json');
    if (!hatManifest) continue;
    if (!beste || vergleicheSemver(m[1], beste) > 0) beste = m[1];
  }
  if (!beste) throw new FeedError('Auf GitHub ist noch kein Release mit Manifest veröffentlicht.');
  return beste;
}

/**
 * Holt das Release-Manifest der konfigurierten Bezugsquelle.
 *
 *  • Flache Quelle: `<basis>/latest.json`, wie bisher, mit Zugangsdaten.
 *    Einen Vorabkanal gibt es dort nicht.
 *  • GitHub, stabil: `<basis>/latest/download/latest.json` – GitHubs fester
 *    Verweis auf das neueste Release ohne Pre-release-Haken.
 *  • GitHub, Vorabversionen: höchste Version laut Release-Liste, dann
 *    `<basis>/download/v<ver>/latest.json`.
 *
 * An GitHub geht nie ein Authorization-Header; `POSTBUCH_FEED_AUTH` gehört zur
 * flachen Quelle. Die Signaturprüfung macht der Aufrufer.
 *
 * @returns {Promise<{ roh: object, erwarteteVersion: string|null, vorab: boolean }>}
 *   `erwarteteVersion` muss der Aufrufer gegen `manifest.version` prüfen.
 */
export async function holeReleaseManifest({ vorab = false, timeoutMs = TIMEOUT_PROBE_MS } = {}) {
  const gh = githubQuelle();
  if (!gh) {
    return { roh: await holeFeed('/latest.json', { timeoutMs }), erwarteteVersion: null, vorab: false };
  }
  const basis = feedBasis();
  const headers = { Accept: 'application/json', 'User-Agent': 'postbuch.net-update-check' };
  const opts = { timeoutMs, maxBytes: FEED_MAX_BYTES, maxRedirects: MANIFEST_MAX_REDIRECTS };
  if (!vorab) {
    const roh = await holeJson(`${basis}/latest/download/latest.json`, headers, opts, 'latest.json');
    return { roh, erwarteteVersion: null, vorab: false };
  }
  const version = await hoechsteGithubVersion(gh, timeoutMs);
  const roh = await holeJson(`${basis}/download/v${version}/latest.json`, headers, opts, `latest.json v${version}`);
  return { roh, erwarteteVersion: version, vorab: true };
}

// ── Kleinst-Validatoren ──────────────────────────────────────────────────────
// Whitelist-First: jede dieser Funktionen gibt entweder einen sauberen Wert
// oder null zurück. Es gibt keine „bereinigende" Variante, die ein kaputtes
// Feld halb übernimmt — halb übernommene Fremddaten sind der Weg, auf dem
// Markup und Steuerzeichen in ein UI wandern.

// Steuerzeichen (außer \n) und alles, was nach Markup/Link aussieht.
// eslint-disable-next-line no-control-regex
const STEUERZEICHEN_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029]/;
const MARKUP_RE = /[<>]|\]\(|https?:\/\/|javascript:|data:/i;

/**
 * Freitext aus dem Feed: getrimmt, gekappt, ohne Markup und Steuerzeichen.
 * @returns {string|null} null, wenn der Wert unbrauchbar ist
 */
export function textFeld(v, maxLen = 200) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t) return '';
  if (t.length > maxLen) return null;
  if (STEUERZEICHEN_RE.test(t)) return null;
  if (MARKUP_RE.test(t)) return null;
  return t;
}

/** Strikte Dreier-Semver ohne Präfix/Suffix. @returns {string|null} */
export function semver(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(t) ? t : null;
}

/**
 * Numerischer Semver-Vergleich. Kein `sort -V`-Nachbau, kein String-Vergleich
 * (der "2.10.0" kleiner als "2.9.0" macht).
 * @returns {number} <0 wenn a<b, 0 bei Gleichheit, >0 wenn a>b
 */
export function vergleicheSemver(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Ist `neu` echt neuer als `alt`? Beide müssen gültiges Semver sein. */
export function istNeuer(neu, alt) {
  if (!semver(neu) || !semver(alt)) return false;
  return vergleicheSemver(neu, alt) > 0;
}

/** Endliche Zahl im geschlossenen Intervall. @returns {number|null} */
export function zahlImBereich(v, min, max) {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
  if (!Number.isFinite(n)) return null;
  if (n < min || n > max) return null;
  return n;
}

/** Genau 64 Hex-Zeichen (sha256), kleingeschrieben. @returns {string|null} */
export function sha256Hex(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(t) ? t : null;
}

/** ISO-Datum `YYYY-MM-DD`, das auch wirklich existiert. @returns {string|null} */
export function isoDatum(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
  const d = new Date(`${t}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10) === t ? t : null;
}
