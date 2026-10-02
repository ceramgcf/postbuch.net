/**
 * routes/onedrive-auth.js — OAuth 2.0 Bootstrap für OneDrive
 *
 * Zwei Endpunkte:
 *   GET /api/onedrive-auth/start     → Leitet zu Microsoft-Login weiter (benötigt Admin-Auth)
 *   GET /api/onedrive-auth/callback  → Empfängt Code von Microsoft, tauscht gegen Tokens
 *
 * Sicherheit:
 *   - /start  ist hinter requireAdmin registriert → nur eingeloggte Admins können starten
 *   - /callback verwendet CSRF-State-Verifikation (State in DB gespeichert, 10-Min-Ablauf)
 *   - Der State wird nach erfolgreichem Abschluss aus der DB gelöscht
 *
 * Redirect URI: kommt aus app_host/APP_BASE_URL, nie aus dem Host-Header.
 * Azure Portal → App Registrations → Authentication → Redirect URIs muss alle verwendeten
 * Domains eintragen (z. B. https://postbuch.example.com/api/onedrive-auth/callback).
 */

import { Router } from 'express';
import { randomUUID } from 'crypto';
import * as onedrive from '../lib/storage/onedrive.js';
import db from '../db.js';
import { loadDynamicSettings } from '../config.js';
import { startPolling as startOnedrivePolling } from '../service/onedrive-watcher.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';

const router = Router();
const adminOnly = [requireAuth, requireAdmin];
const ASSISTENT_RETURN_PATHS = new Set(['/einrichtung/ablage']);

function sichererRueckweg(value) {
  const path = String(value || '');
  return ASSISTENT_RETURN_PATHS.has(path) ? path : '/einstellungen?tab=onedrive';
}

function jsonFuerInlineScript(value) {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

export function abschlussSeite({ ok, titel, text, returnTo, account = null, fehler = null }) {
  const ziel = sichererRueckweg(returnTo);
  // Der Accountname wird im Popup bereits sichtbar ausgegeben, aber vom
  // Elternfenster nicht gebraucht. Er bleibt deshalb ganz aus dem
  // Script-Kontext heraus; das verkleinert die XSS-Fläche zusätzlich.
  // Im Fehlerfall bekommt das Elternfenster Code, Titel und Erklärung, damit
  // die OneDrive-Karte den Fehler selbst anzeigen kann.
  const payload = jsonFuerInlineScript(ok
    ? { type: 'postbuch-onedrive-oauth', ok }
    : { type: 'postbuch-onedrive-oauth', ok, fehler: fehler || 'unbekannt', titel, text });
  const zielJson = jsonFuerInlineScript(ziel);
  // Erfolg: Popup schließt sich bzw. kehrt automatisch zurück. Fehler: Die
  // Seite bleibt stehen, damit die Erklärung auch dann lesbar ist, wenn das
  // Elternfenster die Nachricht nicht mehr empfängt.
  const skript = ok
    ? `if(window.opener&&!window.opener.closed){window.opener.postMessage(p,window.location.origin);window.close();}`
      + `else{setTimeout(function(){window.location.replace(z);},1200);}`
    : `var o=window.opener&&!window.opener.closed;if(o){window.opener.postMessage(p,window.location.origin);}`
      + `var b=document.getElementById('schliessen'),l=document.getElementById('zurueck');`
      + `if(o){l.hidden=true;b.hidden=false;b.onclick=function(){window.close();};}`;
  return `<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${escapeHtml(titel)}</title>`
    + `<style>body{font-family:system-ui,sans-serif;max-width:520px;margin:50px auto;padding:20px;line-height:1.5}`
    + `.status{font-size:2em}a{color:#2563eb}button{font:inherit;padding:6px 14px;cursor:pointer}</style></head><body>`
    + `<div class="status">${ok ? '✅' : '❌'}</div><h1>${escapeHtml(titel)}</h1>`
    + `<p>${escapeHtml(text)}</p>${account ? `<p>Account: <b>${escapeHtml(account)}</b></p>` : ''}`
    + `<p><a id="zurueck" href="${escapeHtml(ziel)}">Zurück zu postbuch.net</a>`
    + `<button id="schliessen" type="button" hidden>Fenster schließen</button></p>`
    + `<script>(function(){var p=${payload};var z=${zielJson};${skript}})();</script>`
    + `</body></html>`;
}

const ERNEUT = 'Klicke danach in postbuch.net erneut auf „Mit Microsoft verbinden“.';
const NOCHMAL = 'Klicke in postbuch.net erneut auf „Mit Microsoft verbinden“.';

/**
 * Übersetzt einen Fehler beim Code-Austausch (Legacy-Redirect-Flow) in eine
 * handlungsorientierte Meldung. Hier ist die Microsoft-Anmeldung bereits
 * gelungen; scheitert der Austausch, liegt es fast immer an den App-Daten
 * (Secret, Client-ID), nicht am Konto. Microsoft-Freitext wird nicht
 * übernommen, nur ein erkannter AADSTS-Code.
 */
export function codeAustauschFehler(err) {
  const roh = [err?.errorCode, err?.subError, err?.message, err?.errorMessage]
    .filter(Boolean).join(' ');
  const text = roh.toLowerCase();
  if (text.includes('aadsts7000222')) {
    return {
      fehler: 'client_secret_abgelaufen',
      titel: 'Client-Secret abgelaufen',
      text: 'Die Microsoft-Anmeldung hat geklappt, aber das hinterlegte Client-Secret der Azure-App ist abgelaufen (AADSTS7000222). '
        + 'Erzeuge in Azure unter „Zertifikate & Geheimnisse“ ein neues Secret, trage dessen Wert und Ablaufdatum in den Dateiablage-Einstellungen ein und speichere. '
        + ERNEUT,
    };
  }
  if (text.includes('aadsts7000215') || text.includes('invalid_client')) {
    return {
      fehler: 'client_secret_ungueltig',
      titel: 'Client-Secret ungültig',
      text: `Die Microsoft-Anmeldung hat geklappt, aber Microsoft hat das hinterlegte Client-Secret abgelehnt${text.includes('aadsts7000215') ? ' (AADSTS7000215)' : ''}. `
        + 'Häufige Ursache: Statt des Secret-Werts wurde die geheime ID eingetragen, oder der Wert ist unvollständig. '
        + 'Kopiere in Azure unter „Zertifikate & Geheimnisse“ den Wert eines gültigen Secrets (oder erzeuge ein neues), trage ihn in den Dateiablage-Einstellungen ein und speichere. '
        + ERNEUT,
    };
  }
  if (/aadsts700016|aadsts90002|unauthorized_client/.test(text)) {
    return {
      fehler: 'app_konfiguration_ungueltig',
      titel: 'App-Registrierung ungültig',
      text: 'Microsoft erkennt die eingetragene App-Registrierung nicht oder sie darf diesen Anmeldeweg nicht verwenden. '
        + 'Prüfe Client-ID und Mandant in den Dateiablage-Einstellungen und speichere sie. ' + ERNEUT,
    };
  }
  const code = roh.match(/AADSTS\d+/i)?.[0]?.toUpperCase();
  return {
    fehler: 'unbekannt',
    titel: 'OneDrive-Verbindung fehlgeschlagen',
    text: `Der Microsoft-Login konnte nicht abgeschlossen werden${code ? ` (${code})` : ''}. Es wurde keine Verbindung gespeichert. `
      + 'Prüfe Client-ID, Client-Secret und Redirect-URI in den Dateiablage-Einstellungen. '
      + `${ERNEUT} Weitere Details stehen im Server-Log.`,
  };
}

/** Fehler, die Microsoft direkt im Redirect meldet (?error=…). */
export function microsoftRedirectFehler(error, description) {
  const e = String(error || '');
  if (e === 'access_denied' || e === 'consent_required') {
    return {
      fehler: 'abgelehnt',
      titel: 'Microsoft-Anmeldung abgebrochen',
      text: 'Die Anmeldung oder die Zustimmung zu den Berechtigungen wurde bei Microsoft abgebrochen. Es wurde keine Verbindung gespeichert. '
        + NOCHMAL,
    };
  }
  const code = String(description || '').match(/AADSTS\d+/i)?.[0]?.toUpperCase();
  return {
    fehler: 'microsoft_fehler',
    titel: 'Microsoft hat die Anmeldung abgelehnt',
    text: `Microsoft meldete „${e.slice(0, 60) || 'unbekannt'}“${code ? ` (${code})` : ''}. Es wurde keine Verbindung gespeichert. `
      + 'Prüfe Client-ID, Mandant und die in Azure eingetragene Redirect-URI. ' + ERNEUT,
  };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// ── Folgeaktionen nach erfolgreicher OneDrive-Verbindung ──────────────────────
// Gemeinsam genutzt von /callback (Legacy-Redirect-Flow) und /device/status
// (Device-Code-Flow), damit die Firstrun-Aktivierungen nicht dupliziert werden:
// Auth-Modus festhalten und Polling einschalten. Backup bleibt eine eigene,
// bewusste Entscheidung im Einrichtungsassistenten.
async function afterOnedriveConnected(mode) {
  // Aktiven Auth-Modus festhalten, damit der Dispatcher in lib/storage/onedrive.js
  // beim nächsten Token-Zugriff den richtigen Client-Typ wählt.
  await db.query(
    `INSERT INTO postbuch._settings (key, value, updated_at)
     VALUES ('onedrive_auth_mode', $1::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE
       SET value = $1::jsonb, updated_at = NOW()`,
    [JSON.stringify(mode)]
  );

  // Nach erfolgreicher Verbindung Polling standardmaessig aktivieren.
  // Intervall aus bestehender Config beibehalten (mind. 10s), sonst 60s.
  const pollingRow = await db.query(
    "SELECT value FROM postbuch._settings WHERE key = 'onedrive_polling'"
  );
  const existingPolling = pollingRow.rows[0]?.value || {};
  const rawInterval = Number(existingPolling.intervalSec);
  const intervalSec = Number.isFinite(rawInterval) ? Math.max(10, Math.floor(rawInterval)) : 60;
  const nextPolling = {
    ...existingPolling,
    enabled: true,
    intervalSec,
  };

  await db.query(
    `INSERT INTO postbuch._settings (key, value, updated_at)
     VALUES ('onedrive_polling', $1::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE
       SET value = $1::jsonb, updated_at = NOW()`,
    [JSON.stringify(nextPolling)]
  );

  // Poller sofort anwenden (ohne App-Neustart).
  await startOnedrivePolling();

}

async function configuredRedirectUri() {
  const settings = await loadDynamicSettings();
  const configured = String(settings.app_host || process.env.APP_BASE_URL || '').trim();
  if (!configured) throw new Error('APP_BASE_URL ist nicht konfiguriert');
  const base = new URL(configured);
  if (!['http:', 'https:'].includes(base.protocol)) throw new Error('APP_BASE_URL verwendet kein HTTP(S)');
  return new URL('/api/onedrive-auth/callback', base).toString();
}

// ── GET /start ───────────────────────────────────────────────────────────────
// Generiert eine Auth-URL und leitet den User zu Microsoft weiter.
// Speichert einen CSRF-State + die Redirect-URI in der DB (10 Minuten gültig).
//
// Dieser Endpunkt ist in index.js vor dem globalen Gate registriert und hängt
// deshalb hier explizit an requireAuth + requireAdmin.

router.get('/start', ...adminOnly, async (req, res) => {
  try {
    // Redirect URI ausschließlich aus der vertrauenswürdigen Konfiguration.
    const redirectUri = await configuredRedirectUri();

    const state = randomUUID();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // +10 Minuten

    // CSRF-State in DB persistieren (inkl. redirectUri für den Callback)
    await db.query(
      `INSERT INTO postbuch._settings (key, value, updated_at)
       VALUES ('onedrive_auth_state', $1::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE
         SET value = $1::jsonb, updated_at = NOW()`,
      [JSON.stringify({ state, redirectUri, expiresAt, returnTo: sichererRueckweg(req.query?.returnTo) })]
    );

    const authUrl = await onedrive.getAuthCodeUrl(redirectUri, state);
    res.redirect(authUrl);
  } catch (err) {
    console.error('[onedrive-auth] /start Fehler:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /callback ────────────────────────────────────────────────────────────
// Microsoft leitet hierher zurück mit ?code=...&state=...
// Dieser Endpunkt ist UNPROTECTED (kein requireAuth), weil der Browser-Redirect
// von Microsoft kommt und keine Session-Cookies enthält.
// Sicherheit wird durch State-Verifikation (CSRF-Schutz) gewährleistet.
//
// Wird in index.js VOR dem globalen requireAuth-Middleware registriert.

router.get('/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;

  // Microsoft hat einen Fehler zurückgeliefert (z. B. User hat abgebrochen)
  if (error) {
    console.error('[onedrive-auth] OAuth-Fehler von Microsoft:', error, error_description);
    let returnTo = null;
    if (state) {
      const r = await db.query(
        `DELETE FROM postbuch._settings
          WHERE key = 'onedrive_auth_state'
            AND value ->> 'state' = $1
          RETURNING value`,
        [String(state)],
      ).catch(() => ({ rows: [] }));
      returnTo = r.rows[0]?.value?.returnTo || null;
    }
    return res.status(400).send(abschlussSeite({
      ok: false,
      ...microsoftRedirectFehler(error, error_description),
      returnTo,
    }));
  }

  if (!code) {
    return res.status(400).send(abschlussSeite({
      ok: false, titel: 'OneDrive-Verbindung fehlgeschlagen',
      fehler: 'kein_code',
      text: `Microsoft hat keinen Autorisierungscode zurückgegeben. ${NOCHMAL}`, returnTo: null,
    }));
  }

  if (!state) {
    return res.status(400).send(abschlussSeite({
      ok: false, titel: 'OneDrive-Verbindung fehlgeschlagen',
      fehler: 'kein_state',
      text: `Die Sicherheitsprüfung konnte ohne State-Parameter nicht abgeschlossen werden. ${NOCHMAL}`, returnTo: null,
    }));
  }

  let callbackReturnTo = null;
  try {
    // State aus DB laden und verifizieren
    // Atomar konsumieren: derselbe State kann auch bei parallelen Callbacks nur
    // einmal benutzt werden. Ein falscher State löscht den gültigen Flow nicht.
    const stateRow = await db.query(
      `DELETE FROM postbuch._settings
        WHERE key = 'onedrive_auth_state'
          AND value ->> 'state' = $1
          AND (value ->> 'expiresAt')::timestamptz > NOW()
        RETURNING value`,
      [String(state)],
    );

    if (!stateRow.rows[0]) {
      return res.status(400).send(abschlussSeite({
        ok: false, titel: 'OneDrive-Verbindung abgelaufen', fehler: 'state_abgelaufen',
        text: `Die Sicherheitsprüfung ist abgelaufen (nach 10 Minuten) oder wurde bereits verwendet. Es wurde keine Verbindung gespeichert. ${NOCHMAL}`, returnTo: null,
      }));
    }

    const stored = stateRow.rows[0].value;
    callbackReturnTo = stored.returnTo;

    // Code gegen Tokens tauschen — MSAL speichert Tokens via afterCacheAccess in DB
    const result = await onedrive.acquireTokenByCode(code, stored.redirectUri);

    // Firstrun-Folgeaktionen (Modus + Polling + Backup) — der Redirect-Flow ist
    // immer der Legacy-/Eigen-App-Weg.
    await afterOnedriveConnected('legacy');

    const account = result?.account?.username || result?.account?.homeAccountId || 'Unbekannt';

    console.log(`[onedrive-auth] ✅ OAuth abgeschlossen. Account: ${account}`);

    res.send(abschlussSeite({
      ok: true,
      titel: 'OneDrive verbunden',
      text: 'Die Verbindung wurde sicher gespeichert. Du kannst mit der Einrichtung fortfahren.',
      returnTo: stored.returnTo,
      account,
    }));
  } catch (err) {
    console.error('[onedrive-auth] /callback Fehler:', err);
    res.status(500).send(abschlussSeite({
      ok: false,
      ...codeAustauschFehler(err),
      returnTo: callbackReturnTo,
    }));
  }
});

// ── GET /status ──────────────────────────────────────────────────────────────
// Gibt zurück ob OneDrive verbunden ist und welcher Account verwendet wird.
// Gibt keine Tokens zurück und ist serverseitig admin-only.

router.get('/status', ...adminOnly, async (req, res) => {
  try {
    const settings = await loadDynamicSettings();
    const tokens = settings.onedrive_tokens;

    if (!tokens) {
      return res.json({ connected: false, account: null });
    }

    // Account-Info aus MSAL-Cache-Format extrahieren
    let account = null;
    try {
      const cache = typeof tokens === 'string' ? JSON.parse(tokens) : tokens;
      const accountEntries = Object.values(cache.Account || {});
      if (accountEntries.length > 0) {
        account = accountEntries[0].username || accountEntries[0].homeAccountId || null;
      }
    } catch (_) {
      // kein Account-Info verfügbar
    }

    // Kurzer Token-Test: acquireTokenSilent gegen MSAL Cache
    let tokenValid = false;
    let authProblem = null;
    try {
      await onedrive.getAccessToken();
      tokenValid = true;
    } catch (err) {
      authProblem = err?.postbuchAuthProblem || onedrive.classifyAuthError(err);
    }

    const secretExpiresAt = settings.onedrive_client_secret_expires_at || null;
    const secretDaysRemaining = secretExpiresAt
      ? Math.ceil((Date.parse(secretExpiresAt) - Date.now()) / 86_400_000) : null;
    res.json({ connected: true, account, tokenValid, authProblem, secretExpiresAt, secretDaysRemaining });
  } catch (err) {
    console.error('[onedrive-auth] /status Fehler:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /authorize ───────────────────────────────────────────────────────────
// Gibt die Microsoft-Login-URL als JSON zurück (statt Redirect).
// Das Frontend öffnet diese URL in einem neuen Tab oder leitet direkt weiter.

router.post('/authorize', ...adminOnly, async (req, res) => {
  try {
    const redirectUri = await configuredRedirectUri();

    const state = randomUUID();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    await db.query(
      `INSERT INTO postbuch._settings (key, value, updated_at)
       VALUES ('onedrive_auth_state', $1::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE
         SET value = $1::jsonb, updated_at = NOW()`,
      [JSON.stringify({ state, redirectUri, expiresAt, returnTo: sichererRueckweg(req.body?.returnTo) })]
    );

    const authUrl = await onedrive.getAuthCodeUrl(redirectUri, state);
    res.json({ authUrl });
  } catch (err) {
    console.error('[onedrive-auth] /authorize Fehler:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /disconnect ─────────────────────────────────────────────────────────
// Löscht die gespeicherten Tokens aus der DB und setzt den MSAL-Client zurück.

router.post('/disconnect', ...adminOnly, async (req, res) => {
  try {
    const s = await loadDynamicSettings();
    if ((s.storage_backend || 'onedrive') === 'onedrive') {
      return res.status(409).json({
        error: 'OneDrive ist derzeit die aktive Ablage. Bitte zuerst auf ein anderes Backend umstellen.',
      });
    }
    await db.query("DELETE FROM postbuch._settings WHERE key = 'onedrive_tokens'");
    onedrive.resetMsalClient();
    res.json({ ok: true });
  } catch (err) {
    console.error('[onedrive-auth] /disconnect Fehler:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Device-Code-Flow (eigene Public-Client-App) ───────────────────────────────
//
// Kein WebSocket vorhanden → dasselbe Muster wie jobs/tracker.js: kurzlebiger
// Fortschrittszustand in einer In-Memory-Map, das Frontend pollt. MSAL erledigt
// das eigentliche Polling gegen Microsoft intern.
//
// Bewusst nur EIN aktiver Flow gleichzeitig: ein neuer /device/start-Aufruf
// bricht einen noch offenen alten Flow ab. Flow-State ist ablaufzeitgebunden
// (TTL) und Single-Use (nach success/error/expired beim nächsten Poll gelöscht).

/** flowId → { status, userCode, verificationUri, expiresAt, account, error, request } */
const deviceFlows = new Map();
let activeDeviceFlowId = null;

/** Bricht einen laufenden Flow ab (setzt MSAL-Cancel-Flag) und entfernt ihn. */
function verwerfeFlow(flowId) {
  const flow = deviceFlows.get(flowId);
  if (!flow) return;
  if (flow.request) flow.request.cancel = true; // MSAL bricht das Polling ab
  deviceFlows.delete(flowId);
}

/** Markiert abgelaufene Flows (lazy TTL-Cleanup). */
function raeumeAbgelaufeneFlows() {
  const now = Date.now();
  for (const [, flow] of deviceFlows) {
    if (flow.status === 'pending' && flow.expiresAt && now > flow.expiresAt) {
      flow.status = 'expired';
      if (flow.request) flow.request.cancel = true;
    }
  }
}

// ── POST /device/start ────────────────────────────────────────────────────────
// Startet den Device-Code-Flow gegen die eigene Public-Client-App. Antwortet,
// sobald Microsoft den User-Code ausgegeben hat, mit
// { flowId, userCode, verificationUri, expiresIn }. Der Token-Erwerb läuft im
// Hintergrund weiter. adminOnly, exakt wie /start und /authorize.

router.post('/device/start', ...adminOnly, async (req, res) => {
  try {
    raeumeAbgelaufeneFlows();

    // Nur ein aktiver Flow: einen noch offenen alten verwerfen.
    if (activeDeviceFlowId) verwerfeFlow(activeDeviceFlowId);

    const flowId = randomUUID();
    const flow = { status: 'pending', userCode: null, verificationUri: null, expiresAt: null, account: null, error: null, request: null };
    deviceFlows.set(flowId, flow);
    activeDeviceFlowId = flowId;

    // Promise, die resolved, sobald MSAL den User-Code liefert (erster Callback).
    const codeReady = new Promise((resolve, reject) => {
      const request = onedrive.createDeviceCodeRequest((info) => {
        flow.userCode = info.userCode;
        flow.verificationUri = info.verificationUri;
        // Ablauf an Microsofts expiresIn koppeln (typ. 15 Min), Fallback 15 Min.
        const ttlSec = Number.isFinite(info.expiresIn) && info.expiresIn > 0 ? info.expiresIn : 900;
        flow.expiresAt = Date.now() + ttlSec * 1000;
        resolve(info);
      });
      flow.request = request;

      // Hintergrund-Token-Erwerb — NICHT awaiten, bevor geantwortet wird.
      onedrive.acquireTokenByDeviceCode(request)
        .then(async (result) => {
          // Flow könnte zwischenzeitlich verworfen worden sein.
          if (!deviceFlows.has(flowId)) return;
          try {
            await afterOnedriveConnected('device');
            flow.account = result?.account?.username || result?.account?.homeAccountId || null;
            flow.status = 'success';
            console.log(`[onedrive-auth] ✅ Device-Code-Flow abgeschlossen. Account: ${flow.account || 'Unbekannt'}`);
          } catch (e) {
            flow.status = 'error';
            flow.error = e.message;
            console.error('[onedrive-auth] /device Folgeaktionen fehlgeschlagen:', e);
          }
        })
        .catch((err) => {
          if (deviceFlows.has(flowId)) {
            flow.status = 'error';
            flow.error = err.message;
          }
          console.error('[onedrive-auth] /device/start Token-Erwerb Fehler:', err.message);
          reject(err); // greift nur, wenn der Fehler VOR dem ersten Callback kam
        });
    });

    const info = await codeReady;
    res.json({
      flowId,
      userCode: info.userCode,
      verificationUri: info.verificationUri,
      expiresIn: info.expiresIn,
    });
  } catch (err) {
    console.error('[onedrive-auth] /device/start Fehler:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /device/status/:flowId ────────────────────────────────────────────────
// Pollt den Flow-Status. Nach 'success'/'error'/'expired' wird der Eintrag
// gelöscht (Single-Use: keine wiederholte Auslösung der Folgeaktionen).

router.get('/device/status/:flowId', ...adminOnly, async (req, res) => {
  try {
    raeumeAbgelaufeneFlows();
    const flow = deviceFlows.get(req.params.flowId);
    if (!flow) {
      return res.json({ status: 'unknown' });
    }

    const payload = { status: flow.status };
    if (flow.status === 'pending') {
      payload.userCode = flow.userCode;
      payload.verificationUri = flow.verificationUri;
    }
    if (flow.status === 'success') payload.account = flow.account;
    if (flow.status === 'error') payload.error = flow.error;

    // Endzustände Single-Use: nach Auslieferung entfernen.
    if (flow.status !== 'pending') {
      deviceFlows.delete(req.params.flowId);
      if (activeDeviceFlowId === req.params.flowId) activeDeviceFlowId = null;
    }

    res.json(payload);
  } catch (err) {
    console.error('[onedrive-auth] /device/status Fehler:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /device/:flowId ────────────────────────────────────────────────────
// Bricht einen Flow ab, den der Nutzer in der Oberfläche abgebrochen hat. Ohne
// diesen Aufruf pollte MSAL bis zum Ablauf des Codes weiter gegen Microsoft,
// und eine spätere Freigabe verbände OneDrive trotz Abbruch. Idempotent.

router.delete('/device/:flowId', ...adminOnly, (req, res) => {
  verwerfeFlow(req.params.flowId);
  if (activeDeviceFlowId === req.params.flowId) activeDeviceFlowId = null;
  res.json({ status: 'abgebrochen' });
});

export default router;
