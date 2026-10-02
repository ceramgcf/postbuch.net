/**
 * service/nextcloud-login-flow.js — Nextcloud Login-Flow v2
 *
 * Ablauf (am lebenden Nextcloud 29 verifiziert):
 *   1. POST <base>/index.php/login/v2
 *      → { poll: { token, endpoint }, login: "<url>" }
 *   2. Der Nutzer öffnet `login` im Browser, meldet sich an und bestätigt.
 *   3. Wir pollen POST <base>/login/v2/poll mit { token }:
 *      404 solange offen · 200 GENAU EINMAL mit { server, loginName, appPassword }
 *   Das Poll-Token ist 20 Minuten gültig.
 *
 * Das Ergebnis ist dasselbe wie bei einem manuell erzeugten App-Passwort — der
 * Unterschied ist, dass der Nutzer sein Nextcloud-HAUPTPASSWORT nie in Postbuch
 * tippt. Für die Zielgruppe ist das das entscheidende Vertrauenssignal.
 *
 * ── Sicherheitsauflagen ────────────────────────────────────────────────────
 *
 * • `poll.endpoint` und `login` stammen aus der Antwort eines fremden Servers.
 *   Beide werden gegen die konfigurierte Base-URL geprüft (Origin-Vergleich,
 *   kein String-Präfix). Ohne diese Prüfung wären zwei Angriffe möglich:
 *     – `login: "https://evil.example/…"` → der Admin tippt sein
 *       Nextcloud-Hauptpasswort in eine nachgebaute Maske. Genau das, was
 *       Login-Flow v2 verhindern soll, würde zum Phishing-Kanal.
 *     – `poll.endpoint: "http://10.0.0.1/admin/reboot"` → die App würde zum
 *       POST-Forger für beliebige URLs, 300 Mal hintereinander.
 *   Auch `server` aus der Endantwort darf die Base-URL nicht überschreiben.
 *
 * • Der State liegt NUR im Arbeitsspeicher, nicht in _settings. Das Poll-Token
 *   ist bearer-äquivalent — wer es hat, holt das App-Passwort ab. In _settings
 *   landete es im DB-Backup und damit in der Ablage. Das OneDrive-Muster
 *   (onedrive_auth_state in der DB) existiert nur, weil dort ein zustandsloser
 *   Browser-Callback zurückkommt; diese Randbedingung gibt es hier nicht.
 *   Folge: `--force-recreate` bricht einen laufenden Flow ab. Das ist der
 *   sichere Ausgang (fail-closed); das UI zeigt dann „Vorgang abgebrochen".
 *
 * • Ein Flow gleichzeitig, feste Wall-Clock-Deadline, festes Poll-Intervall
 *   (nie servergesteuert), Abbruch nach mehreren Fehlern in Folge.
 */

import db from '../db.js';
import { appLog } from '../app-log.js';
import {
  guardedFetch, readLimitedText, NetGuardError, TIMEOUT_PROBE_MS, releaseDispatchers,
} from '../lib/net-guard.js';
import { loadDynamicSettings } from '../config.js';

const POLL_INTERVALL_MS = 2_000;   // fest — nie vom Server steuern lassen
const FLOW_DAUER_MS = 10 * 60 * 1000;
const MAX_FEHLER_IN_FOLGE = 5;
const MAX_ANTWORT_BYTES = 64 * 1024;

/**
 * Laufender Flow. Höchstens einer pro Prozess.
 * @type {{ startedAt:number, ablaufAt:number, confirmUrl:string, origin:string,
 *          status:'wartet'|'fertig'|'abgelaufen'|'fehler'|'abgebrochen',
 *          fehler:string|null, username:string|null, abbruch:AbortController }|null}
 */
let _flow = null;

/** Öffentlich sichtbarer Zustand — enthält NIE Token oder App-Passwort. */
export function flowStatus() {
  if (!_flow) return { status: 'aus' };
  const verbleibendSek = Math.max(0, Math.round((_flow.ablaufAt - Date.now()) / 1000));
  return {
    status: _flow.status,
    confirmUrl: _flow.status === 'wartet' ? _flow.confirmUrl : null,
    verbleibendSek: _flow.status === 'wartet' ? verbleibendSek : 0,
    username: _flow.username,
    fehler: _flow.fehler,
  };
}

/** Bricht einen laufenden Flow ab. */
export function flowAbbrechen() {
  if (!_flow) return false;
  _flow.abbruch.abort();
  _flow.status = 'abgebrochen';
  return true;
}

/**
 * Prüft, dass eine vom Server gelieferte URL zum konfigurierten Server gehört.
 * Origin-Vergleich, kein startsWith — "https://nc.example.evil" hat sonst das
 * Präfix "https://nc.example".
 */
function assertGleicherOrigin(kandidat, erwarteterOrigin, feld) {
  let u;
  try { u = new URL(String(kandidat)); } catch {
    throw new Error(`Nextcloud hat im Feld "${feld}" keine gültige URL geliefert.`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`Nextcloud hat im Feld "${feld}" ein unzulässiges Protokoll geliefert.`);
  }
  if (u.origin !== erwarteterOrigin) {
    throw new Error(
      `Nextcloud verweist im Feld "${feld}" auf einen anderen Server (${u.origin}) `
      + `als den konfigurierten (${erwarteterOrigin}). Vorgang abgebrochen.`,
    );
  }
  return u;
}

async function speichereCredentials(username, appPassword) {
  await db.query(
    `INSERT INTO postbuch._settings (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = NOW()`,
    ['nextcloud_username', JSON.stringify(username)],
  );
  await db.query(
    `INSERT INTO postbuch._settings (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = NOW()`,
    ['nextcloud_app_password', JSON.stringify(appPassword)],
  );
}

/**
 * Startet den Login-Flow. Liefert die Bestätigungs-URL, die der Nutzer im
 * Browser öffnen muss. Das Polling läuft danach im Hintergrund.
 *
 * @returns {Promise<{ confirmUrl:string, ablaufSek:number, origin:string }>}
 */
export async function flowStarten() {
  if (_flow?.status === 'wartet') {
    const err = new Error('Es läuft bereits ein Anmeldevorgang.');
    err.code = 'BEREITS_AKTIV';
    throw err;
  }

  const settings = await loadDynamicSettings();
  const rawBase = String(settings.nextcloud_base_url || '').trim();
  if (!rawBase) throw new Error('Bitte zuerst die Nextcloud-Server-Adresse speichern.');

  const allowPrivate = settings.storage_allow_private_targets === true;
  const allowInsecure = settings.nextcloud_allow_insecure === true;

  const baseUrl = new URL(rawBase.endsWith('/') ? rawBase : `${rawBase}/`);
  if (baseUrl.protocol === 'http:' && !allowInsecure) {
    throw new Error(
      'Die Serveradresse ist unverschlüsselt (http). Bitte https verwenden oder die '
      + 'unverschlüsselte Verbindung für das lokale Netzwerk ausdrücklich erlauben.',
    );
  }
  const origin = baseUrl.origin;

  const initUrl = new URL('index.php/login/v2', baseUrl);
  const { response } = await guardedFetch(
    initUrl,
    { method: 'POST', headers: { 'User-Agent': await geraeteName(settings) } },
    { allowPrivate, timeoutMs: TIMEOUT_PROBE_MS, reuse: true },
  );
  const text = await readLimitedText(response, MAX_ANTWORT_BYTES);
  let daten;
  try { daten = JSON.parse(text); } catch {
    throw new Error('Der Server hat keine gültige Login-Flow-Antwort geliefert. Ist das wirklich eine Nextcloud?');
  }

  const token = String(daten?.poll?.token || '');
  if (!/^[A-Za-z0-9]{32,256}$/.test(token)) {
    throw new Error('Der Server hat kein gültiges Anmelde-Token geliefert.');
  }
  // B3: beide fremdgelieferten URLs gegen den konfigurierten Origin prüfen.
  const confirmUrl = assertGleicherOrigin(daten?.login, origin, 'login');
  assertGleicherOrigin(daten?.poll?.endpoint, origin, 'poll.endpoint');
  // Der Poll-Endpunkt wird trotzdem SELBST gebaut, nicht übernommen — die
  // Prüfung oben ist die zweite Verteidigungslinie, nicht die einzige.
  const pollUrl = new URL('login/v2/poll', baseUrl);

  const jetzt = Date.now();
  _flow = {
    startedAt: jetzt,
    ablaufAt: jetzt + FLOW_DAUER_MS,
    confirmUrl: confirmUrl.href,
    origin,
    status: 'wartet',
    fehler: null,
    username: null,
    abbruch: new AbortController(),
  };

  appLog('INFO', 'nextcloud', `Login-Flow gestartet (Server ${origin})`);
  pollSchleife({ pollUrl, token, allowPrivate, origin, flow: _flow })
    .catch((err) => {
      if (_flow?.status === 'wartet') {
        _flow.status = 'fehler';
        _flow.fehler = err.message;
      }
    })
    .finally(() => releaseDispatchers(baseUrl));

  return { confirmUrl: confirmUrl.href, ablaufSek: Math.round(FLOW_DAUER_MS / 1000), origin };
}

/** Erkennbarer Gerätename, damit der Nutzer das App-Passwort gezielt widerrufen kann. */
async function geraeteName(settings) {
  const instanz = String(settings?.instance_name || 'Postbuch').replace(/[^\w .-]/g, '').slice(0, 40);
  return `Postbuch (${instanz || 'Postbuch'})`;
}

/**
 * Pollt bis Erfolg, Ablauf oder Abbruch.
 * Festes Intervall, harte Wall-Clock-Deadline, Fehlerzähler.
 */
async function pollSchleife({ pollUrl, token, allowPrivate, origin, flow }) {
  let fehlerInFolge = 0;

  while (flow.status === 'wartet') {
    if (flow.abbruch.signal.aborted) return;
    if (Date.now() >= flow.ablaufAt) {
      flow.status = 'abgelaufen';
      appLog('INFO', 'nextcloud', 'Login-Flow abgelaufen (keine Bestätigung innerhalb von 10 Minuten)');
      return;
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVALL_MS));
    if (flow.abbruch.signal.aborted || flow.status !== 'wartet') return;

    let response;
    try {
      ({ response } = await guardedFetch(
        pollUrl,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `token=${encodeURIComponent(token)}`,
        },
        { allowPrivate, timeoutMs: TIMEOUT_PROBE_MS, reuse: true },
      ));
    } catch (err) {
      fehlerInFolge += 1;
      if (fehlerInFolge >= MAX_FEHLER_IN_FOLGE) {
        flow.status = 'fehler';
        flow.fehler = err instanceof NetGuardError
          ? 'Der Nextcloud-Server ist nicht mehr erreichbar.'
          : 'Die Anmeldung konnte nicht abgeschlossen werden.';
        return;
      }
      continue;
    }

    // 404 = noch nicht bestätigt. Der Normalfall, kein Fehler.
    if (response.status === 404) {
      await response.body?.cancel?.().catch(() => {});
      fehlerInFolge = 0;
      continue;
    }

    const text = await readLimitedText(response, MAX_ANTWORT_BYTES).catch(() => '');
    if (!response.ok) {
      fehlerInFolge += 1;
      if (fehlerInFolge >= MAX_FEHLER_IN_FOLGE) {
        flow.status = 'fehler';
        flow.fehler = 'Die Anmeldung konnte nicht abgeschlossen werden.';
        return;
      }
      continue;
    }

    let daten;
    try { daten = JSON.parse(text); } catch {
      flow.status = 'fehler';
      flow.fehler = 'Der Server hat eine unlesbare Antwort geliefert.';
      return;
    }

    // Auch `server` aus der Endantwort darf die Konfiguration nicht umbiegen.
    try {
      assertGleicherOrigin(daten?.server, origin, 'server');
    } catch (err) {
      flow.status = 'fehler';
      flow.fehler = err.message;
      appLog('ERROR', 'nextcloud', `Login-Flow abgebrochen: ${err.message}`);
      return;
    }

    const loginName = String(daten?.loginName || '').trim();
    const appPassword = String(daten?.appPassword || '');
    if (!loginName || !appPassword) {
      flow.status = 'fehler';
      flow.fehler = 'Der Server hat keine vollständigen Zugangsdaten geliefert.';
      return;
    }
    if (!/^[A-Za-z0-9._@ -]{1,64}$/.test(loginName)) {
      flow.status = 'fehler';
      flow.fehler = 'Der gelieferte Benutzername enthält unzulässige Zeichen.';
      return;
    }

    await speichereCredentials(loginName, appPassword);
    flow.username = loginName;
    flow.status = 'fertig';
    // Weder Token noch Passwort ins Log — nur die Tatsache.
    appLog('INFO', 'nextcloud', `Nextcloud verbunden als "${loginName}"`);
    return;
  }
}
