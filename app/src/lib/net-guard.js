/**
 * lib/net-guard.js — Absicherung frei konfigurierbarer ausgehender URLs
 *
 * Sobald eine `baseUrl` aus den Einstellungen kommt (LLM-Provider, später
 * Nextcloud), ist das per Definition ein SSRF-Primitiv. Das ist hier der
 * *Zweck* — ein Ollama im Intranet ist genau das Ziel —, deshalb wird nicht
 * verboten, sondern die Verstärker werden entfernt:
 *
 *   • Schema-Whitelist http:/https:, kein `user:pass@` in der URL
 *   • redirect: 'manual' — ein 30x ist standardmäßig ein Konfigurationsfehler.
 *     Wer Weiterleitungen braucht (Release-Downloads), setzt `maxRedirects`:
 *     dann wird jede Station erneut geprüft, nur HTTPS ist als Ziel erlaubt
 *     und der Authorization-Header fällt beim Wechsel des Origins weg.
 *   • DNS wird SELBST aufgelöst, die IPs werden geprüft, und die Verbindung
 *     geht gegen genau die geprüfte IP (undici-Agent mit connect.lookup).
 *     Ohne das ist jede Allowlist per DNS-Rebinding umgehbar.
 *   • Private Ziele nur mit explizitem Opt-in. 169.254.0.0/16 (Cloud-Metadaten)
 *     und 100.64.0.0/10 (CGNAT) bleiben IMMER blockiert — auch mit Opt-in.
 *   • Timeouts und ein Body-Limit als Stream-Zähler (nicht `await r.text()`
 *     mit anschließendem .slice() — das lädt erst alles in den RAM).
 *
 * Fehlermeldungen privater Ziele dürfen nicht an den Client durchgereicht
 * werden (sonst ist die App ein HTTP-Lesegerät fürs LAN) — dafür trägt jedes
 * Ergebnis `zielIstPrivat`.
 */

import dns from 'node:dns/promises';
import net from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';

export const TIMEOUT_PROBE_MS      = 10_000;   // Health / Verbindungstest / Modell-Listing
export const TIMEOUT_COMPLETION_MS = 180_000;  // Eigentliche LLM-Aufrufe
// Datei-Transfer (Up-/Download, Listings). Das AbortSignal gilt für den ganzen
// Request inklusive Body-Streaming — 10 s wären für ein PDF über eine langsame
// Leitung sofort ein Abbruch.
export const TIMEOUT_TRANSFER_MS   = 300_000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;     // 8 MB Antwort-Limit (Text/JSON)

/** Antwort-Limit für Datei-Downloads (readLimitedBuffer). */
export const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
/**
 * Antwort-Limit für WebDAV-Listings. Ein PROPFIND Depth:1 über einen Ordner mit
 * vielen tausend Dateien wird deutlich größer als 8 MB Text.
 */
export const MAX_LISTING_BYTES = 64 * 1024 * 1024;

/** Fehler mit Zusatzinformation, ob das Ziel im privaten Bereich lag. */
export class NetGuardError extends Error {
  constructor(message, { zielIstPrivat = false } = {}) {
    super(message);
    this.name = 'NetGuardError';
    this.zielIstPrivat = zielIstPrivat;
  }
}

// ── IP-Klassifikation ────────────────────────────────────────────────────────

function ipv4Parts(ip) {
  return ip.split('.').map(Number);
}

/** Immer verboten, unabhängig von allowPrivate. */
function istImmerVerboten(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ipv4Parts(ip);
    if (a === 169 && b === 254) return 'Link-Local/Cloud-Metadaten (169.254.0.0/16)';
    if (a === 100 && b >= 64 && b <= 127) return 'CGNAT (100.64.0.0/10)';
    if (a === 0) return 'Reserviert (0.0.0.0/8)';
    if (a >= 224) return 'Multicast/reserviert (224.0.0.0/4, 240.0.0.0/4)';
    return null;
  }
  const low = ip.toLowerCase();
  // IPv4-mapped IPv6 (::ffff:169.254.x.x) über den v4-Pfad prüfen.
  const mapped = low.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return istImmerVerboten(mapped[1]);
  if (low === '::') return 'Nicht spezifiziert (::)';
  if (low.startsWith('fe8') || low.startsWith('fe9') || low.startsWith('fea') || low.startsWith('feb')) {
    return 'IPv6 Link-Local (fe80::/10)';
  }
  if (low.startsWith('ff')) return 'IPv6 Multicast (ff00::/8)';
  return null;
}

/** Privat im Sinne von „nur mit Opt-in erlaubt". */
export function istPrivateAdresse(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ipv4Parts(ip);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 192 && b === 0) return true;      // 192.0.0.0/24 IETF-Protokollzuweisungen
    return false;
  }
  const low = ip.toLowerCase();
  const mapped = low.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return istPrivateAdresse(mapped[1]);
  if (low === '::1') return true;
  if (low.startsWith('fc') || low.startsWith('fd')) return true;  // ULA fc00::/7
  return false;
}

// ── URL-Prüfung ──────────────────────────────────────────────────────────────

/**
 * Prüft eine ausgehende URL und löst sie auf geprüfte IP-Adressen auf.
 *
 * @param {string|URL} rawUrl
 * @param {object}  [opts]
 * @param {boolean} [opts.allowPrivate=false] — private Ziele (RFC1918, loopback, ULA) zulassen
 * @param {boolean} [opts.reuse=false] — Dispatcher je Origin für 60 s wiederverwenden
 *   (für Backends mit vielen kleinen Requests; siehe holeDispatcher)
 * @returns {Promise<{ url: URL, addresses: Array<{address:string, family:number}>, zielIstPrivat: boolean, dispatcher: Agent }>}
 * @throws {NetGuardError}
 */
export async function assertSafeOutboundUrl(rawUrl, {
  allowPrivate = false, reuse = false, allowUntrustedTls = false,
} = {}) {
  let url;
  try {
    url = rawUrl instanceof URL ? rawUrl : new URL(String(rawUrl));
  } catch {
    throw new NetGuardError(`Ungültige URL: ${String(rawUrl).slice(0, 120)}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new NetGuardError(`Nur http:// und https:// sind erlaubt (war: ${url.protocol})`);
  }
  if (url.username || url.password) {
    throw new NetGuardError('Zugangsdaten gehören nicht in die URL — bitte den Key separat hinterlegen.');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');

  // Literale IP: kein DNS nötig. Sonst auflösen (alle A/AAAA-Records prüfen —
  // ein einziger privater Record reicht für einen Rebinding-Angriff).
  let addresses;
  if (net.isIP(hostname)) {
    addresses = [{ address: hostname, family: net.isIPv6(hostname) ? 6 : 4 }];
  } else {
    try {
      addresses = await dns.lookup(hostname, { all: true, verbatim: true });
    } catch (err) {
      throw new NetGuardError(`DNS-Auflösung für "${hostname}" fehlgeschlagen: ${err.message}`);
    }
  }
  if (!addresses.length) throw new NetGuardError(`Keine IP-Adresse für "${hostname}" gefunden.`);

  let zielIstPrivat = false;
  for (const a of addresses) {
    const verboten = istImmerVerboten(a.address);
    if (verboten) {
      throw new NetGuardError(`Ziel ${hostname} → ${a.address} ist gesperrt: ${verboten}`, { zielIstPrivat: true });
    }
    if (istPrivateAdresse(a.address)) {
      zielIstPrivat = true;
      if (!allowPrivate) {
        throw new NetGuardError(
          `Ziel ${hostname} → ${a.address} liegt im privaten Netz. `
          + 'Zum Zulassen die Option „Private Netzwerkziele erlauben" aktivieren.',
          { zielIstPrivat: true },
        );
      }
    }
  }

  // Gegen die GEPRÜFTEN IPs verbinden: eigener Lookup, der nur die eben
  // validierten Adressen zurückgibt. Ein zweiter DNS-Roundtrip im Stack
  // (= das Rebinding-Fenster) findet damit nicht statt.
  const dispatcher = holeDispatcher(url, allowPrivate, addresses, reuse, allowUntrustedTls);

  return { url, addresses, zielIstPrivat, dispatcher };
}

// ── Dispatcher-Wiederverwendung (opt-in) ─────────────────────────────────────
//
// Jeder `new Agent(...)` hält seinen eigenen Connection-Pool offen, und niemand
// schließt ihn. Für die LLM-Aufrufe (wenige, große Requests) ist das egal — für
// ein Ablage-Backend mit hunderten kleinen WebDAV-Requests wäre es ein
// Speicher- und Socket-Leck.
//
// Deshalb ein TTL-Cache, aber ausdrücklich OPT-IN (`reuse: true`): die
// bestehenden Aufrufer verhalten sich unverändert. Die TTL begrenzt zugleich,
// wie lange eine einmal geprüfte DNS-Antwort weiterverwendet wird — das
// Rebinding-Fenster bleibt damit klein und explizit statt unbegrenzt.
const DISPATCHER_TTL_MS = 60_000;
const _dispatcherCache = new Map(); // key → { dispatcher, expires }

function holeDispatcher(url, allowPrivate, addresses, reuse, allowUntrustedTls = false) {
  const baue = () => new Agent({
    connect: {
      ...(url.protocol === 'https:' && allowUntrustedTls ? { rejectUnauthorized: false } : {}),
      lookup: (_host, options, cb) => {
        if (options?.all) return cb(null, addresses);
        return cb(null, addresses[0].address, addresses[0].family);
      },
    },
  });

  if (!reuse) return baue();

  const key = `${url.origin}|${allowPrivate}|${allowUntrustedTls}`;
  const jetzt = Date.now();
  const treffer = _dispatcherCache.get(key);
  if (treffer && treffer.expires > jetzt) return treffer.dispatcher;

  if (treffer) treffer.dispatcher.close?.().catch(() => {});
  const dispatcher = baue();
  _dispatcherCache.set(key, { dispatcher, expires: jetzt + DISPATCHER_TTL_MS });
  return dispatcher;
}

/**
 * Verwirft den zwischengespeicherten Dispatcher eines Origins — nach einer
 * Konfigurationsänderung (neue Base-URL, neue Credentials) oder am Ende eines
 * langlaufenden Flows.
 * @param {string|URL} [rawUrl] ohne Argument wird der gesamte Cache geleert
 */
export function releaseDispatchers(rawUrl) {
  if (!rawUrl) {
    for (const { dispatcher } of _dispatcherCache.values()) dispatcher.close?.().catch(() => {});
    _dispatcherCache.clear();
    return;
  }
  let origin;
  try { origin = (rawUrl instanceof URL ? rawUrl : new URL(String(rawUrl))).origin; } catch { return; }
  for (const [key, { dispatcher }] of _dispatcherCache) {
    if (key.startsWith(`${origin}|`)) {
      dispatcher.close?.().catch(() => {});
      _dispatcherCache.delete(key);
    }
  }
}

// ── Guarded Fetch ────────────────────────────────────────────────────────────

/**
 * Liest einen Response-Body als Text, bricht aber hart bei maxBytes ab —
 * gezählt wird am Stream, nicht nach dem vollständigen Laden.
 */
export async function readLimitedText(response, maxBytes = DEFAULT_MAX_BYTES) {
  if (!response.body) return '';
  const decoder = new TextDecoder('utf-8');
  const reader = response.body.getReader();
  let gelesen = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      gelesen += value.byteLength;
      if (gelesen > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new NetGuardError(`Antwort größer als ${Math.round(maxBytes / 1024)} kB — abgebrochen.`);
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock?.();
  }
  return text + decoder.decode();
}

/**
 * fetch() mit allen Schutzmaßnahmen. Gibt die Response zurück; der Body ist
 * über readLimitedText()/guardedFetchJson() zu lesen.
 *
 * @param {string|URL} rawUrl
 * @param {object} [init]                   — wie fetch(), ohne redirect
 * @param {object} [opts]
 * @param {boolean} [opts.allowPrivate]
 * @param {number}  [opts.timeoutMs]
 * @returns {Promise<{ response: Response, zielIstPrivat: boolean }>}
 */
export async function guardedFetch(rawUrl, init = {}, opts = {}) {
  const {
    allowPrivate = false, timeoutMs = TIMEOUT_PROBE_MS, reuse = false,
    allowUntrustedTls = false, maxRedirects = 0,
  } = opts;
  // Ein Gesamt-Timeout über alle Weiterleitungen, nicht je Sprung.
  const signal = init.signal ?? AbortSignal.timeout(timeoutMs);
  let headers = new Headers(init.headers || {});
  let ziel = rawUrl;
  let sprungeUebrig = maxRedirects;

  for (;;) {
    const { url, zielIstPrivat, dispatcher } = await assertSafeOutboundUrl(ziel, {
      allowPrivate, reuse, allowUntrustedTls,
    });

    let response;
    try {
      response = await undiciFetch(url, {
        ...init,
        headers,
        // Nie automatisch folgen: jede Station muss selbst durch
        // assertSafeOutboundUrl (DNS-/IP-Prüfung), sonst wäre eine
        // Weiterleitung ins LAN der Umweg um diese Prüfung.
        redirect: 'manual',
        dispatcher,
        signal,
      });
    } catch (err) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        throw new NetGuardError(`Zeitüberschreitung nach ${Math.round(timeoutMs / 1000)}s: ${url.origin}`, { zielIstPrivat });
      }
      throw new NetGuardError(`Verbindung zu ${url.origin} fehlgeschlagen: ${err.message}`, { zielIstPrivat });
    }

    // `redirect: 'manual'` liefert je nach Implementierung entweder die echte
    // 3xx-Antwort oder eine gefilterte „opaqueredirect"-Antwort (Status 0).
    const istWeiterleitung = response.type === 'opaqueredirect'
      || (response.status >= 300 && response.status < 400);
    if (!istWeiterleitung) return { response, zielIstPrivat };

    const location = response.headers.get('location');
    await response.body?.cancel?.().catch(() => {});

    // Standard (maxRedirects 0): ein 30x auf einen konfigurierten Endpunkt
    // ist ein Konfigurationsfehler.
    if (sprungeUebrig <= 0 || !location) {
      throw new NetGuardError(
        maxRedirects > 0
          ? `${url.origin} leitet zu oft oder ohne Ziel weiter (${response.status}).`
          : `${url.origin} antwortet mit einer Weiterleitung (${response.status}). `
            + 'Bitte die endgültige Adresse direkt eintragen.',
        { zielIstPrivat },
      );
    }

    let naechste;
    try {
      naechste = new URL(location, url);
    } catch {
      throw new NetGuardError(`${url.origin} leitet auf eine ungültige Adresse weiter.`, { zielIstPrivat });
    }
    // Weiterleitungen nur auf HTTPS, auch wenn der Start HTTP war.
    if (naechste.protocol !== 'https:') {
      throw new NetGuardError(`${url.origin} leitet auf ein unverschlüsseltes Ziel weiter.`, { zielIstPrivat });
    }
    // Zugangsdaten gelten nur für den Origin, für den sie konfiguriert wurden.
    if (naechste.origin !== url.origin) {
      headers = new Headers(headers);
      headers.delete('authorization');
      headers.delete('cookie');
    }
    ziel = naechste;
    sprungeUebrig -= 1;
  }
}

/**
 * Liest einen Response-Body als Buffer, mit demselben Stream-Zähler wie
 * readLimitedText. Für Datei-Downloads — `readLimitedText` taugt dafür nicht
 * (Text-Dekodierung, und das 8-MB-Default wäre für PDFs zu knapp).
 *
 * Das Default-Limit ist bewusst großzügig: der OneDrive-Adapter lädt heute ganz
 * ohne Limit herunter, und ein engeres Limit nur für ein Backend wäre eine
 * stille Asymmetrie im Verhalten.
 *
 * @param {Response} response
 * @param {object}  [opts]
 * @param {number}  [opts.maxBytes=512MB]
 * @param {(p:{receivedBytes:number,totalBytes:number|null})=>void} [opts.onProgress]
 *   Signatur identisch zu adapter.download(id, onProgress).
 * @returns {Promise<Buffer>}
 */
export async function readLimitedBuffer(response, { maxBytes = MAX_DOWNLOAD_BYTES, onProgress } = {}) {
  if (!response.body) return Buffer.alloc(0);

  const totalHeader = response.headers.get('content-length');
  const totalBytes = totalHeader ? Number(totalHeader) : null;

  // Schon am Content-Length abbrechen, wenn der Server ihn liefert — dann muss
  // der Body gar nicht erst durch die Leitung.
  if (Number.isFinite(totalBytes) && totalBytes > maxBytes) {
    await response.body.cancel?.().catch(() => {});
    throw new NetGuardError(
      `Datei ist ${Math.round(totalBytes / 1024 / 1024)} MB groß — Limit sind `
      + `${Math.round(maxBytes / 1024 / 1024)} MB.`,
    );
  }

  const reader = response.body.getReader();
  const chunks = [];
  let receivedBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new NetGuardError(
          `Antwort größer als ${Math.round(maxBytes / 1024 / 1024)} MB — abgebrochen.`,
        );
      }
      chunks.push(Buffer.from(value));
      onProgress?.({ receivedBytes, totalBytes });
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks);
}

/**
 * guardedFetch + JSON-Parsing + einheitliche Fehlerbehandlung.
 * Bei !ok wirft die Funktion mit dem (gekürzten) Fehlertext; ob dieser Text an
 * einen Client gehen darf, entscheidet der Aufrufer anhand `err.zielIstPrivat`.
 */
export async function guardedFetchJson(rawUrl, init = {}, opts = {}) {
  const { response, zielIstPrivat } = await guardedFetch(rawUrl, init, opts);
  const text = await readLimitedText(response, opts.maxBytes);
  if (!response.ok) {
    throw new NetGuardError(`HTTP ${response.status}: ${text.slice(0, 300)}`, { zielIstPrivat });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new NetGuardError(`Antwort ist kein gültiges JSON: ${text.slice(0, 200)}`, { zielIstPrivat });
  }
}

/**
 * Fehlertext, der an einen HTTP-Client gehen darf. Bei privaten Zielen wird die
 * Antwort der Gegenstelle NICHT durchgereicht — sonst wäre jede Testroute ein
 * generisches HTTP-Lesegerät aufs LAN.
 */
export function clientSafeError(err) {
  if (err?.zielIstPrivat) {
    return 'Die Gegenstelle im privaten Netz hat mit einem Fehler geantwortet. '
      + 'Details stehen aus Sicherheitsgründen nur im Server-Log.';
  }
  return String(err?.message || err).slice(0, 300);
}
