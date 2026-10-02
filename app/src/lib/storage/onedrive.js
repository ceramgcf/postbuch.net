/**
 * lib/storage/onedrive.js — Ablage-Adapter für Microsoft OneDrive (Graph API)
 *
 * Implementiert die in lib/storage/index.js beschriebene Adapter-Schnittstelle.
 * Aufrufer holen sich den Adapter über getAdapter()/getActiveAdapter() und
 * importieren diese Datei nicht direkt — Ausnahme sind die OneDrive-eigenen
 * OAuth-/Token-Funktionen (routes/onedrive-auth.js, index.js), die es bei
 * anderen Backends so nicht gibt.
 *
 * Token-Management via @azure/msal-node mit Custom Cache Plugin.
 * Tokens werden in _settings (key: 'onedrive_tokens') als JSONB gespeichert.
 * Alle Ordner-IDs kommen aus _settings (key: 'storage_folders' → 'onedrive').
 *
 * Kein direkter process.env-Zugriff — alles über loadDynamicSettings().
 */

import * as msal from '@azure/msal-node';
import db from '../../db.js';
import { loadDynamicSettings, getFolders } from '../../config.js';
import { appLog } from '../../app-log.js';
import { sanitizeFilename } from './paths.js';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

/** Backend-Name — identisch mit dem Wert in postbuch.storage_backend. */
export const name = 'onedrive';

/** Anzeigename für UI und Logs. */
export const label = 'OneDrive';

/**
 * Eigenschaften, in denen sich die Backends unterscheiden. Deklarativ, kein
 * Probing — ein Adapter weiß selbst, was er kann.
 */
export const capabilities = {
  oauth: true,            // Verbindung über OAuth statt Benutzer/Passwort
  pfadAufloesung: true,   // resolvePath()/getPath() vorhanden
  checksumInMeta: false,  // getMeta() liefert keinen sha256 → Deep-Scan lädt herunter
  freierSpeicher: true,
};

export async function getFreeSpace() {
  const response = await graphFetch('/me/drive?$select=quota');
  const data = await response.json();
  const remaining = Number(data?.quota?.remaining);
  return Number.isFinite(remaining) ? { freiBytes: remaining } : null;
}

// Scopes für Microsoft Graph OneDrive-Zugriff
const SCOPES = [
  'https://graph.microsoft.com/Files.ReadWrite.All',
  'https://graph.microsoft.com/User.Read',
  'offline_access',
];

// ── MSAL Clients (Singletons) ────────────────────────────────────────────────
//
// Zwei Auth-Modi, beide mit der EIGENEN Azure-App des Nutzers (es wird keine
// projektseitige Client-ID mitgeliefert):
//   'legacy'  ConfidentialClientApplication — Client-ID + Secret + Redirect-URI,
//             Browser-Redirect-OAuth (Standard, unverändert).
//   'device'  PublicClientApplication — nur Client-ID, kein Secret, keine
//             Redirect-URI, Device-Code-Flow. Voraussetzung: in der App-
//             Registrierung "Öffentliche Clientflows zulassen" = Ja.
//
// Der aktive Modus steht in _settings.onedrive_auth_mode. Fehlt das Feld, gilt
// bei leerem Token-Cache 'device'; ein vorhandener Cache bleibt aus
// Kompatibilitätsgründen 'legacy'. Beide Clients teilen sich
// das cachePlugin (hängt nur an _settings.onedrive_tokens). Der MSAL-Cache ist
// NICHT zwischen den Client-Typen migrierbar (Bindung an clientId+authority) —
// ein Moduswechsel verlangt bewusst /disconnect + neuen Connect-Flow.

let _msalClient = null;
let _msalPublicClient = null;

/**
 * Erzeugt das Cache-Plugin, das den MSAL-Token-Cache bei JEDER Token-Operation
 * aus/in _settings.onedrive_tokens liest/schreibt. Für beide Client-Typen gleich.
 */
function makeCachePlugin() {
  return {
    /**
     * Wird von MSAL VOR jeder Token-Operation aufgerufen.
     * Lädt den serialisierten Cache aus der DB und übergibt ihn an MSAL.
     */
    async beforeCacheAccess(context) {
      try {
        const row = await db.query(
          "SELECT value FROM postbuch._settings WHERE key = 'onedrive_tokens'"
        );
        if (row.rows[0]) {
          // value ist bereits als JSONB geparst — serialisieren für MSAL
          context.tokenCache.deserialize(JSON.stringify(row.rows[0].value));
        }
      } catch (e) {
        console.error('[onedrive] beforeCacheAccess Fehler:', e.message);
      }
    },

    /**
     * Wird von MSAL NACH jeder Token-Operation aufgerufen.
     * Speichert den aktualisierten Cache (z. B. neuer Access Token) zurück in die DB.
     */
    async afterCacheAccess(context) {
      if (context.cacheHasChanged) {
        try {
          const serialized = context.tokenCache.serialize();
          await db.query(
            `INSERT INTO postbuch._settings (key, value, updated_at)
             VALUES ('onedrive_tokens', $1::jsonb, NOW())
             ON CONFLICT (key) DO UPDATE
               SET value = $1::jsonb, updated_at = NOW()`,
            [serialized]
          );
        } catch (e) {
          console.error('[onedrive] afterCacheAccess Fehler:', e.message);
        }
      }
    },
  };
}

/** Gemeinsame MSAL-Logger-Optionen (nur Fehler, kein PII). */
const MSAL_SYSTEM = {
  loggerOptions: {
    loggerCallback(level, message, containsPii) {
      if (containsPii) return;
      if (level === msal.LogLevel.Error) {
        console.error('[msal]', message);
      }
    },
    piiLoggingEnabled: false,
    logLevel: msal.LogLevel.Error,
  },
};

/**
 * Legacy: (gecachter) ConfidentialClientApplication aus den eigenen Azure-App-
 * Credentials in _settings (Client-ID + Secret). Funktionskörper wie bisher.
 */
async function getConfidentialClient() {
  if (_msalClient) return _msalClient;

  const settings = await loadDynamicSettings();

  if (!settings.onedrive_client_id || !settings.onedrive_client_secret) {
    throw new Error(
      'OneDrive nicht konfiguriert: onedrive_client_id / onedrive_client_secret fehlen in _settings.'
    );
  }

  _msalClient = new msal.ConfidentialClientApplication({
    auth: {
      clientId: settings.onedrive_client_id,
      clientSecret: settings.onedrive_client_secret,
      authority: `https://login.microsoftonline.com/${settings.onedrive_tenant_id || 'common'}`,
    },
    cache: { cachePlugin: makeCachePlugin() },
    system: MSAL_SYSTEM,
  });

  return _msalClient;
}

/**
 * Device: (gecachter) PublicClientApplication aus der EIGENEN Client-ID des
 * Nutzers (onedrive_client_id) — kein Secret. Für den Device-Code-Flow.
 */
async function getPublicClient() {
  if (_msalPublicClient) return _msalPublicClient;

  const settings = await loadDynamicSettings();

  if (!settings.onedrive_client_id) {
    throw new Error(
      'OneDrive (Gerätecode) nicht konfiguriert: onedrive_client_id fehlt in _settings.'
    );
  }

  _msalPublicClient = new msal.PublicClientApplication({
    auth: {
      clientId: settings.onedrive_client_id,
      authority: `https://login.microsoftonline.com/${settings.onedrive_tenant_id || 'common'}`,
    },
    cache: { cachePlugin: makeCachePlugin() },
    system: MSAL_SYSTEM,
  });

  return _msalPublicClient;
}

/**
 * Dispatcher: liefert den zum aktiven onedrive_auth_mode passenden MSAL-Client.
 * 'device' → Public Client; 'legacy' → Confidential Client. Bei einem alten
 * Datensatz ohne Modus entscheidet ausschließlich der Token-Cache: vorhanden
 * bedeutet Bestandsverbindung/legacy, leer bedeutet Neuinstanz/device.
 */
async function getMsalClient() {
  const settings = await loadDynamicSettings();
  if (settings.onedrive_auth_mode === 'device') return getPublicClient();
  if (settings.onedrive_auth_mode !== 'legacy' && !settings.onedrive_tokens) return getPublicClient();
  return getConfidentialClient();
}

/**
 * Setzt beide gecachten MSAL-Clients zurück (z. B. nach Credentials-Änderung,
 * Connect, Moduswechsel oder /disconnect).
 */
export function resetMsalClient() {
  _msalClient = null;
  _msalPublicClient = null;
}

/**
 * Verdichtet MSALs wechselnde Fehlerformen auf handlungsorientierte Zustände.
 * Besonders AADSTS7000222/invalid_client darf nicht als normal abgelaufene
 * Anmeldung erscheinen: erneutes Verbinden hilft dort erst nach einem neuen
 * Secret in Azure.
 */
export function classifyAuthError(err) {
  const text = [err?.errorCode, err?.subError, err?.message, err?.errorMessage]
    .filter(Boolean).join(' ').toLowerCase();
  if (text.includes('aadsts7000222') || text.includes('invalid_client')) {
    return 'client_secret_abgelaufen';
  }
  // App-Registrierung oder Mandant existiert nicht bzw. darf diesen Flow
  // nicht: eine erneute Anmeldung hilft nicht, erst eine korrigierte Client-ID.
  if (/aadsts700016|aadsts90002|unauthorized_client/.test(text)) {
    return 'app_konfiguration_ungueltig';
  }
  if (/interaction_required|invalid_grant|no_tokens_found|token.*expired/.test(text)) {
    return 'anmeldung_abgelaufen';
  }
  return 'token_fehler';
}

/**
 * Enthält der serialisierte MSAL-Cache Refresh-Tokens, aber keinen für die
 * konfigurierte Client-ID? Dann wurde die Client-ID geändert (oder falsch
 * eingetragen) – MSAL meldet dafür nur „keine Tokens“, was sonst wie eine
 * abgelaufene Anmeldung aussähe.
 */
export function refreshTokensGehoerenAndererApp(serialisierterCache, clientId) {
  if (!clientId) return false;
  try {
    const cache = typeof serialisierterCache === 'string' ? JSON.parse(serialisierterCache) : serialisierterCache;
    const tokens = Object.values(cache?.RefreshToken || {});
    return tokens.length > 0 && !tokens.some(rt => rt?.client_id === clientId);
  } catch {
    return false;
  }
}

// ── Token-Management ─────────────────────────────────────────────────────────

/**
 * Gibt einen gültigen Access Token zurück.
 * Refresht automatisch über MSAL wenn der Access Token abgelaufen ist.
 * Wirft einen Fehler wenn kein Refresh Token vorhanden ist (→ OAuth-Flow nötig).
 */
export async function getAccessToken() {
  let client = null;
  try {
    client = await getMsalClient();
    const cache = client.getTokenCache();
    const accounts = await cache.getAllAccounts();

    if (!accounts || accounts.length === 0) {
      throw new Error(
        'OneDrive: Keine gespeicherten Tokens. Bitte zuerst den OAuth-Flow durchführen:\n'
        + '/api/onedrive-auth/start'
      );
    }

    const result = await client.acquireTokenSilent({
      account: accounts[0],
      scopes: SCOPES,
    });

    if (!result?.accessToken) {
      throw new Error('OneDrive: Token-Refresh fehlgeschlagen. Bitte OAuth-Flow erneut ausführen.');
    }

    return result.accessToken;
  } catch (err) {
    err.postbuchAuthProblem = classifyAuthError(err);
    if (client && err.postbuchAuthProblem !== 'client_secret_abgelaufen') {
      try {
        const { onedrive_client_id: clientId } = await loadDynamicSettings();
        if (refreshTokensGehoerenAndererApp(client.getTokenCache().serialize(), clientId)) {
          err.postbuchAuthProblem = 'app_konfiguration_ungueltig';
        }
      } catch { /* Einordnung bleibt wie oben */ }
    }
    throw err;
  }
}

// ── Token Keep-Alive ─────────────────────────────────────────────────────────

/**
 * Startet einen periodischen Silent-Refresh, damit der Microsoft Refresh Token
 * niemals durch Inaktivität abläuft (90-Tage-Limit bei MSA-Konten).
 *
 * Funktionsprinzip: Jede erfolgreiche acquireTokenSilent-Nutzung verlängert
 * den Refresh Token automatisch. Ein täglicher Refresh-Ping genügt daher,
 * um das Token dauerhaft lebendig zu halten — ohne erneuten OAuth-Flow.
 *
 * Wird einmalig beim App-Start aufgerufen (index.js), nur wenn Tokens vorhanden.
 */
export function startTokenKeepAlive() {
  const INTERVAL_MS = 24 * 60 * 60 * 1000; // alle 24 Stunden

  async function ping() {
    try {
      await getAccessToken();
      console.log('[onedrive] Keep-alive: Token erfolgreich aktualisiert.');
    } catch (err) {
      // Nur loggen — kein crash. Tritt auf wenn noch keine Tokens in DB.
      console.warn('[onedrive] Keep-alive: Token-Refresh übersprungen —', err.message.split('\n')[0]);
      appLog('WARN', 'onedrive', `Token-Refresh übersprungen: ${err.message.split('\n')[0]}`);
    }
  }

  // Erster Ping nach 1 Stunde (nicht sofort beim Start, um DB-Init abzuwarten)
  setTimeout(() => {
    ping();
    setInterval(ping, INTERVAL_MS);
  }, 60 * 60 * 1000);

  console.log('[onedrive] Token Keep-alive gestartet (alle 24h).');
}

// ── Interner HTTP-Helper ─────────────────────────────────────────────────────

/**
 * Führt einen authentifizierten Graph-API-Aufruf durch.
 * Bei Fehler wird ein sprechender Error mit Statuscode geworfen.
 */
async function graphFetch(path, options = {}) {
  const token = await getAccessToken();
  const url = path.startsWith('https://') ? path : `${GRAPH_BASE}${path}`;

  // Content-Type wird nur bei JSON-Body gesetzt; für Binär-Uploads explizit überschreiben
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...options.headers,
  };

  const response = await fetch(url, { ...options, headers });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const err = new Error(
      `Graph API Fehler ${response.status} ${response.statusText} [${path.slice(0, 80)}]: ${body.slice(0, 300)}`
    );
    err.status = response.status;
    throw err;
  }

  return response;
}

// ── Item-ID-Validierung (letzte Verteidigungslinie) ──────────────────────────
//
// Item-IDs werden bewusst NICHT URL-enkodiert in die Graph-URL interpoliert
// (OneDrive-personal-IDs enthalten '!' als strukturelles Trennzeichen, das die
// Graph-API roh erwartet). Genau das macht jede ID, die aus einer Request-URL
// stammen könnte, zu einem Path-Traversal-Vektor: ein dekodiertes '/' oder '..'
// würde vom WHATWG-URL-Parser in fetch() aufgelöst und zeigte auf einen ganz
// anderen Graph-Endpunkt.
//
// Aufrufer autorisieren die ID fachlich (z. B. gegen _pipeline_suspensions);
// diese Prüfung hier ist die letzte, generische Absicherung — IDs erreichen die
// Lib auch aus _failed_documents und der Disaster-Recovery.
const ITEM_ID_RE = /^[A-Za-z0-9!$@._~+=-]{5,300}$/;

/**
 * Wirft, wenn die Item-ID nicht dem zulässigen Zeichensatz entspricht.
 * @param {string} id       OneDrive Item-ID
 * @param {string} context  Funktionsname für die Fehlermeldung
 * @returns {string} die unveränderte ID (für bequeme Verkettung)
 */
export function assertItemId(id, context = 'onedrive') {
  if (typeof id !== 'string' || !ITEM_ID_RE.test(id) || id.includes('..')) {
    throw new Error(`${context}: Ungültige OneDrive-Item-ID`);
  }
  return id;
}

/**
 * Formale Gültigkeitsprüfung einer Item-ID dieses Backends.
 *
 * Verbindliche Variante von assertItemId für Aufrufer, die kein Werfen wollen —
 * etwa routes/files.js, das nach dem Suspension-Lookup mit dem Backend DER
 * ZEILE prüft. Der Grobfilter in der Route selbst muss deshalb beide
 * ID-Formen durchlassen; streng wird es hier.
 * @param {string} value
 */
export function isValidId(value) {
  return typeof value === 'string' && ITEM_ID_RE.test(value) && !value.includes('..');
}

/**
 * Sieht der String aus wie eine Item-ID dieses Backends (im Gegensatz zu einem
 * Pfad oder einer Postid)? Rein formale Heuristik für Eingaben, bei denen
 * beides erlaubt ist (Disaster-Recovery-Startordner).
 *
 * OneDrive-IDs sind lang und alphanumerisch; Nextcloud-Fileids wären dagegen
 * kurze Integer — deshalb gehört die Heuristik in den Adapter, nicht in den
 * Aufrufer.
 * @param {string} value
 */
export function looksLikeId(value) {
  return typeof value === 'string' && /^[A-Z0-9!]+$/i.test(value) && value.length >= 20;
}

// ── Datei-Operationen ────────────────────────────────────────────────────────
//
// Hinweis zu Dateinamen: sanitizeFilename wird hier seit 2.0.1 angewandt — wie
// im Nextcloud-Adapter und wie es das Interface zusagt. Traversal ist bei der
// ID-basierten Graph-API zwar nicht das Thema, aber der Wunschname stammt aus
// einer KI-Ausgabe: Zero-Width- und RTL-Override-Zeichen liefen bis dahin
// unverändert in Ablage, storage_filename, UI und Discord-Nachricht, und ein
// überlanger Name oder ein '/' ließ Graph mit 400 antworten — das Dokument
// landete dann grundlos in _failed.
//
// Nur Neuschreibungen sind betroffen (move/uploadNew vergeben Namen);
// Bestandsnamen in der Ablage werden nicht angefasst.

/**
 * Lädt eine Datei herunter und gibt sie als Buffer zurück.
 * Mit onProgress wird der Fortschritt als { receivedBytes, totalBytes }
 * gemeldet; totalBytes ist null, wenn der Server kein Content-Length liefert.
 *
 * @param {string} fileId  OneDrive Item-ID
 * @param {(progress: { receivedBytes: number, totalBytes: number|null }) => void} [onProgress]
 */
export async function download(fileId, onProgress) {
  // Der Download-Endpunkt liefert eine Weiterleitung zur echten Download-URL.
  // fetch folgt dieser automatisch (redirect: 'follow').
  // Hinweis: Item-IDs werden NICHT URL-enkodiert — OneDrive personal-IDs enthalten
  // das Zeichen '!' als strukturelles Trennzeichen, das Graph API direkt erwartet.
  assertItemId(fileId, 'download');
  const token = await getAccessToken();
  const url = `${GRAPH_BASE}/me/drive/items/${fileId}/content`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'follow',
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const err = new Error(
      `download Fehler ${response.status} [${fileId.slice(0, 40)}]: ${body.slice(0, 200)}`
    );
    err.status = response.status;
    throw err;
  }

  if (!onProgress || !response.body) {
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  const totalHeader = response.headers.get('content-length');
  const totalBytes = totalHeader ? Number(totalHeader) : null;
  let receivedBytes = 0;
  const chunks = [];

  for await (const chunk of response.body) {
    chunks.push(chunk);
    receivedBytes += chunk.length;
    onProgress({ receivedBytes, totalBytes });
  }

  return Buffer.concat(chunks);
}

/**
 * Verschiebt eine Datei in einen anderen Ordner und benennt sie um.
 * @param {string} fileId        Quell-Item-ID
 * @param {string} destFolderId  Ziel-Ordner-ID
 * @param {string} newName       Neuer Dateiname (inkl. .pdf)
 * @returns {{ id: string, webUrl: string, name: string }}
 *   name ist der tatsächlich vergebene Name — bei OneDrive immer der
 *   gewünschte, bei pfadbasierten Backends ggf. „Name (2)". Aufrufer, die
 *   storage_filename schreiben, nehmen diesen Wert.
 */
export async function move(fileId, destFolderId, newName) {
  assertItemId(fileId, 'move');
  assertItemId(destFolderId, 'move(destFolder)');
  const sicher = sanitizeFilename(newName, 'Dokument');
  const response = await graphFetch(`/me/drive/items/${fileId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      parentReference: { id: destFolderId },
      name: sicher,
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`move Fehler ${response.status}: ${body.slice(0, 300)}`);
  }
  const data = await response.json();
  return { id: data.id, webUrl: data.webUrl, name: data.name };
}

/**
 * Überschreibt den Inhalt einer bestehenden Datei.
 * @param {string} fileId   Ziel-Item-ID
 * @param {Buffer} content  Neuer Inhalt
 */
export async function uploadContent(fileId, content) {
  assertItemId(fileId, 'uploadContent');
  const token = await getAccessToken();
  const url = `${GRAPH_BASE}/me/drive/items/${fileId}/content`;

  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
    },
    body: content,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const err = new Error(`uploadContent Fehler ${response.status}: ${body.slice(0, 300)}`);
    err.status = response.status;
    throw err;
  }
}

/**
 * Lädt eine neue Datei in einen Ordner hoch.
 * @param {Buffer} content        Dateiinhalt
 * @param {string} name           Dateiname (inkl. .pdf)
 * @param {string} parentFolderId Ziel-Ordner-ID
 * @returns {{ id: string, webUrl: string, name: string }}
 *   name ist der tatsächlich vergebene Name (siehe move()).
 */
export async function uploadNew(content, fileName, parentFolderId) {
  assertItemId(parentFolderId, 'uploadNew');
  const token = await getAccessToken();
  const encodedName = encodeURIComponent(sanitizeFilename(fileName, 'Dokument'));
  // conflictBehavior=rename ist NICHT der Graph-Default — ohne diesen Parameter
  // ersetzt PUT eine gleichnamige Datei stillschweigend. Zwei Dokumente mit
  // identischem Namen im selben Ordner wären damit stiller Datenverlust. Der
  // Konformitätstest (service/storage-selftest.js) hat genau das aufgedeckt.
  // Graph vergibt dann "Name 1.pdf"; der tatsächliche Name steht im Rückgabewert.
  const url = `${GRAPH_BASE}/me/drive/items/${parentFolderId}:/${encodedName}:/content`
    + '?@microsoft.graph.conflictBehavior=rename';

  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
    },
    body: content,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const err = new Error(`uploadNew Fehler ${response.status}: ${body.slice(0, 300)}`);
    err.status = response.status;
    throw err;
  }

  const data = await response.json();
  return { id: data.id, webUrl: data.webUrl, name: data.name };
}

/**
 * Verschiebt eine Datei in den konfigurierten Papierkorb-Ordner.
 * Das ist ein selbstgebauter _trash-Ordner, nicht der OneDrive-Papierkorb.
 * @param {string} fileId     Quell-Item-ID
 * @param {string} trashName  Neuer Name im Papierkorb (z. B. 'Duplikat POSTID')
 */
export async function moveToTrash(fileId, trashName) {
  const settings = await loadDynamicSettings();
  const trashFolderId = getFolders(settings, name).trash;
  if (!trashFolderId) {
    throw new Error('OneDrive: Papierkorb-Ordner-ID nicht konfiguriert (storage_folders.onedrive.trash fehlt)');
  }
  return move(fileId, trashFolderId, trashName);
}

/**
 * Löscht eine Datei dauerhaft.
 * @param {string} fileId  Item-ID
 */
export async function remove(fileId) {
  assertItemId(fileId, 'remove');
  const token = await getAccessToken();
  const url = `${GRAPH_BASE}/me/drive/items/${fileId}`;
  const response = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  // 204 No Content = Erfolg, kein Body
  if (!response.ok && response.status !== 204) {
    const body = await response.text().catch(() => '');
    const err = new Error(`remove Fehler ${response.status}: ${body.slice(0, 300)}`);
    err.status = response.status;
    throw err;
  }
}

/**
 * Löst einen OneDrive-Pfad (relativ zum Root) in eine Item-ID auf.
 * Wird für den GUI-Ordner-Assistenten benötigt (Session 8).
 * @param {string} path  Pfad relativ zum Root (z. B. 'Postbuch/Arztrechnung')
 * @returns {{ id: string, name: string }}
 */
export async function resolvePath(path) {
  // Edge-Case: Root-Ordner direkt abrufen
  const cleanPath = path.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!cleanPath) {
    const response = await graphFetch('/me/drive/root');
    const data = await response.json();
    return { id: data.id, name: data.name };
  }
  // Pfad-Segmente einzeln enkodieren, Slashes erhalten
  const encodedPath = cleanPath.split('/').map((seg) => encodeURIComponent(seg)).join('/');
  const response = await graphFetch(`/me/drive/root:/${encodedPath}`);
  const data = await response.json();
  return { id: data.id, name: data.name };
}

/**
 * Erstellt einen Unterordner in einem bestehenden Ordner.
 * Bei Namenskonflikt legt Graph "name 1" an (conflictBehavior: rename).
 * @param {string} parentFolderId  Parent-Ordner-ID
 * @param {string} folderName      Neuer Ordnername
 * @returns {{ id: string }}
 */
export async function createFolder(parentFolderId, folderName) {
  assertItemId(parentFolderId, 'createFolder');
  const response = await graphFetch(
    `/me/drive/items/${parentFolderId}/children`,
    {
      method: 'POST',
      body: JSON.stringify({
        name: folderName,
        folder: {},
        '@microsoft.graph.conflictBehavior': 'rename',
      }),
    }
  );
  const data = await response.json();
  return { id: data.id };
}

/**
 * Sucht einen Unterordner mit dem gegebenen Namen; legt ihn an, wenn er fehlt.
 *
 * Sicherheitsregel: ein vorhandener Ordner wird NIEMALS überschrieben oder
 * gelöscht — es wird nur seine ID gelesen.
 *
 * @param {string} parentFolderId  Parent-Ordner-ID
 * @param {string} folderName      Ordnername
 * @param {{ strict?: boolean }} [opts]
 *   strict: Anlegen mit conflictBehavior 'fail'; bei 409 wird der vorhandene
 *   Ordner per Pfad geholt. Damit kann kein "name 1" entstehen, auch nicht bei
 *   parallelen Aufrufen — die Variante für die Ordner-Initialisierung.
 *   Ohne strict: erst listen, dann anlegen (ein Roundtrip weniger, wenn der
 *   Ordner-Inhalt ohnehin gebraucht wird).
 * @returns {{ id: string, existed: boolean }}
 */
export async function findOrCreateFolder(parentFolderId, folderName, opts = {}) {
  assertItemId(parentFolderId, 'findOrCreateFolder');

  if (!opts.strict) {
    const children = await listChildren(parentFolderId);
    const existing = children.find(c => c.isFolder && c.name === folderName);
    if (existing) return { id: existing.id, existed: true };
    const created = await createFolder(parentFolderId, folderName);
    return { id: created.id, existed: false };
  }

  const token = await getAccessToken();
  const createRes = await fetch(`${GRAPH_BASE}/me/drive/items/${parentFolderId}/children`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: folderName,
      folder: {},
      '@microsoft.graph.conflictBehavior': 'fail',
    }),
  });

  if (createRes.ok) {
    const data = await createRes.json();
    return { id: data.id, existed: false };
  }

  // 409 Conflict = Ordner existiert bereits → vorhandenen Ordner abrufen
  if (createRes.status === 409) {
    const encodedName = encodeURIComponent(folderName);
    const getRes = await fetch(
      `${GRAPH_BASE}/me/drive/items/${parentFolderId}:/${encodedName}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!getRes.ok) {
      const body = await getRes.text().catch(() => '');
      throw new Error(
        `findOrCreateFolder: Ordner "${folderName}" existiert, konnte aber nicht abgerufen werden: ${body.slice(0, 300)}`
      );
    }
    const data = await getRes.json();
    return { id: data.id, existed: true };
  }

  const body = await createRes.text().catch(() => '');
  throw new Error(`findOrCreateFolder "${folderName}" Fehler ${createRes.status}: ${body.slice(0, 300)}`);
}

/**
 * Liefert die ID des Ablage-Wurzelverzeichnisses (Drive-Root).
 * Startpunkt der Ordner-Initialisierung.
 * @returns {{ id: string, name: string }}
 */
export async function getRoot() {
  const response = await graphFetch('/me/drive/root');
  const data = await response.json();
  return { id: data.id, name: data.name };
}

/**
 * Der Ordner, unterhalb dessen dieses Backend Postbuch-Daten hält.
 * Bei OneDrive gibt es keinen vom Nutzer-Speicher abgegrenzten Bereich — die
 * Ordner-IDs stehen einzeln in storage_folders —, deshalb identisch zu
 * getRoot(). Siehe lib/storage/index.js.
 */
export async function getAblageRoot() {
  return getRoot();
}

/**
 * Listet alle Dateien/Unterordner eines Ordners auf.
 * @param {string} folderId  Ordner-ID
 * @returns {Array<{ id: string, name: string, size: number, createdAt: string, createdDateTime: string, isFolder: boolean }>}
 */
export async function listChildren(folderId) {
  assertItemId(folderId, 'listChildren');
  const response = await graphFetch(
    `/me/drive/items/${folderId}/children?$select=id,name,size,createdDateTime,folder`
  );
  const data = await response.json();
  return (data.value || []).map((f) => ({
    id: f.id,
    name: f.name,
    size: f.size || 0,
    createdAt: f.createdDateTime,
    createdDateTime: f.createdDateTime,
    isFolder: !!f.folder,
  }));
}

/**
 * Metadaten eines Items in einem einzigen Roundtrip.
 *
 * Ersetzt die früheren getItemMeta()/getItemFingerprintMeta() — beide fragten
 * dieselbe Ressource ab, nur mit anderer $select-Liste, und wurden an manchen
 * Stellen nacheinander aufgerufen.
 *
 * @param {string} fileId  Item-ID
 * @returns {{ id: string, name: string, parentId: string|null, lastModified: string|null, webUrl: string|null, size: number|null, isFolder: boolean }}
 */
export async function getMeta(fileId) {
  assertItemId(fileId, 'getMeta');
  const response = await graphFetch(
    `/me/drive/items/${fileId}?$select=id,name,size,folder,parentReference,lastModifiedDateTime,webUrl`
  );
  const data = await response.json();
  return {
    id: data.id,
    name: data.name,
    parentId: data.parentReference?.id ?? null,
    lastModified: data.lastModifiedDateTime ?? null,
    webUrl: data.webUrl ?? null,
    size: data.size ?? null,
    isFolder: !!data.folder,
  };
}

/**
 * Menschenlesbarer Pfad eines Items (z. B. "/postbuch/Arztrechnung").
 * Für das Ordner-UI in den Einstellungen; Nextcloud braucht die Auflösung
 * ohnehin intern.
 * @param {string} fileId  Item-ID
 * @returns {string}
 */
export async function getPath(fileId) {
  assertItemId(fileId, 'getPath');
  const response = await graphFetch(
    `/me/drive/items/${fileId}?$select=name,parentReference`
  );
  const data = await response.json();
  // parentReference.path ist z. B. "/drive/root:/postbuch/Arztrechnung" oder "/drive/root:"
  const parentPath = (data.parentReference?.path || '').replace(/^\/drive\/root:/, '');
  return parentPath ? `${parentPath}/${data.name}` : `/${data.name}`;
}

/**
 * Listet alle Dateien (rekursiv inkl. Unterordner) ab einem Start-Ordner auf.
 * Liefert für jede Datei id, name, parentId, size, webUrl, lastModifiedDateTime.
 * Verwendet Pagination via @odata.nextLink.
 *
 * Wird vom DR-Recovery-Service genutzt, um über einen vom User gegebenen
 * Stamm-Ordner zu iterieren und SHA256-Vergleiche durchzuführen.
 *
 * @param {string} rootFolderId  Start-Ordner-ID
 * @returns {Array<{ id: string, name: string, parentId: string, size: number, webUrl: string, lastModifiedDateTime: string }>}
 */
export async function listAllFilesRecursive(rootFolderId) {
  assertItemId(rootFolderId, 'listAllFilesRecursive');
  const files = [];
  const queue = [rootFolderId];
  const visited = new Set();

  while (queue.length > 0) {
    const folderId = queue.shift();
    if (visited.has(folderId)) continue;
    visited.add(folderId);

    let url = `/me/drive/items/${folderId}/children?$select=id,name,size,file,folder,parentReference,webUrl,lastModifiedDateTime&$top=200`;
    while (url) {
      const response = await graphFetch(url);
      const data = await response.json();
      for (const item of (data.value || [])) {
        if (item.folder) {
          queue.push(item.id);
        } else if (item.file) {
          files.push({
            id: item.id,
            name: item.name,
            parentId: item.parentReference?.id ?? null,
            size: item.size || 0,
            webUrl: item.webUrl || null,
            lastModifiedDateTime: item.lastModifiedDateTime || null,
          });
        }
      }
      url = data['@odata.nextLink'] ?? null;
    }
  }

  return files;
}

/**
 * Listet alle Dateien (keine Unterordner) in einem Ordner auf.
 * Unterstützt Pagination via @odata.nextLink.
 * @param {string} folderId  Ordner-ID
 * @returns {Array<{ id: string, name: string }>}
 */
export async function listAllFiles(folderId) {
  assertItemId(folderId, 'listAllFiles');
  const files = [];
  let url = `/me/drive/items/${folderId}/children?$select=id,name,file&$top=200`;

  while (url) {
    const response = await graphFetch(url);
    const data = await response.json();
    for (const item of (data.value || [])) {
      // 'file' property ist nur bei Dateien vorhanden, nicht bei Ordnern
      if (item.file) {
        files.push({ id: item.id, name: item.name });
      }
    }
    url = data['@odata.nextLink'] ?? null;
  }

  return files;
}

// ── OAuth Bootstrap ──────────────────────────────────────────────────────────
// Diese Funktionen werden nur einmalig (Session 4 Bootstrap) und later vom
// OAuth-GUI (Session 8) verwendet.

/**
 * Generiert die Microsoft-Login-URL für den Authorization Code Flow.
 * @param {string} redirectUri  Callback-URL (muss in Azure registriert sein)
 * @param {string} state        CSRF-Schutz-Wert (wird von MS an callback zurückgegeben)
 * @returns {Promise<string>}  URL, auf die der User weitergeleitet werden soll
 */
export async function getAuthCodeUrl(redirectUri, state) {
  const client = await getMsalClient();
  return client.getAuthCodeUrl({
    scopes: SCOPES,
    redirectUri,
    state,
    prompt: 'select_account',
  });
}

/**
 * Tauscht einen Authorization Code gegen Tokens und speichert sie in der DB.
 * Muss exakt dieselbe redirectUri verwenden wie getAuthCodeUrl().
 * @param {string} code         Code aus dem Callback-Query-Parameter
 * @param {string} redirectUri  Dieselbe URI wie beim getAuthCodeUrl()-Aufruf
 * @returns {Promise<object>}  MSAL AuthenticationResult
 */
export async function acquireTokenByCode(code, redirectUri) {
  const client = await getMsalClient();

  const result = await client.acquireTokenByCode({
    code,
    redirectUri,
    scopes: SCOPES,
  });

  // afterCacheAccess wird automatisch aufgerufen → Tokens in DB gespeichert
  // Client-Singleton zurücksetzen damit nächster Aufruf frischen Cache sieht
  resetMsalClient();

  return result;
}

// ── Device-Code-Flow (eigene Public-Client-App) ──────────────────────────────
//
// Startet den Device-Code-Flow gegen den Public Client (eigene Client-ID). MSAL
// ruft deviceCodeCallback einmal auf, sobald Microsoft den User-Code ausgegeben
// hat (userCode + verificationUri), und pollt danach im Hintergrund selbst gegen
// Microsoft, bis der Nutzer bestätigt. Die zurückgegebene Promise resolved erst
// mit den Tokens (oder wirft bei Ablauf/Fehler/Abbruch).

/**
 * Baut ein MSAL-DeviceCodeRequest-Objekt. Der Aufrufer behält die Referenz und
 * kann den laufenden Flow durch Setzen von `request.cancel = true` abbrechen
 * (MSAL prüft das Flag zwischen den Polls gegen Microsoft).
 *
 * @param {(info: {userCode:string, verificationUri:string, message:string, expiresIn:number}) => void} onDeviceCode
 * @returns {object} DeviceCodeRequest (mutierbar: `.cancel`)
 */
export function createDeviceCodeRequest(onDeviceCode) {
  return {
    scopes: SCOPES,
    cancel: false,
    deviceCodeCallback(response) {
      onDeviceCode({
        userCode: response.userCode,
        verificationUri: response.verificationUri,
        message: response.message,
        expiresIn: response.expiresIn,
      });
    },
  };
}

/**
 * Führt den Device-Code-Flow gegen den Public Client aus.
 * @param {object} request  Ergebnis von createDeviceCodeRequest() (Referenz halten)
 * @returns {Promise<object>} MSAL AuthenticationResult
 */
export async function acquireTokenByDeviceCode(request) {
  const client = await getPublicClient();
  const result = await client.acquireTokenByDeviceCode(request);

  // Tokens sind über afterCacheAccess in der DB — Singletons zurücksetzen,
  // damit der nächste Aufruf den frischen Cache sieht.
  resetMsalClient();

  return result;
}
