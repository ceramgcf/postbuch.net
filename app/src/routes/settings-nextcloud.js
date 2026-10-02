/**
 * routes/settings-nextcloud.js — Nextcloud-Verbindung (ADMIN-ONLY)
 *
 * Wird in routes/settings.js unter `/nextcloud` eingehängt. Der Settings-Router
 * hängt in index.js bereits hinter `requireAdmin` — deshalb entsteht hier KEIN
 * neuer Top-Level-Mount. Die Reihenfolge der unprotected Routen in index.js ist
 * das Fragilste am Backend und wird bewusst nicht angefasst.
 *
 * Anders als bei OneDrive gibt es keinen unauthentifizierten Callback: der
 * Login-Flow v2 wird serverseitig zu Ende gepollt.
 *
 * Routen:
 *   GET    /status                 Verbindungszustand (ohne Geheimnisse)
 *   PUT    /config                 Server-Adresse + Sicherheitsschalter
 *                                  (NICHT der Ablageordner — der kommt aus der
 *                                   Ordner-Initialisierung)
 *   POST   /login-flow/start       Login-Flow v2 starten
 *   GET    /login-flow/status      Wartezustand (überlebt einen Browser-Reload)
 *   POST   /login-flow/cancel      Laufenden Flow abbrechen
 *   PUT    /credentials            App-Passwort manuell hinterlegen (Fallback)
 *   POST   /test                   Verbindungstest, schreibt nichts
 *   POST   /disconnect             Zugangsdaten entfernen
 */

import { Router } from 'express';
import db from '../db.js';
import { appLog } from '../app-log.js';
import { loadDynamicSettings } from '../config.js';
import * as nextcloud from '../lib/storage/nextcloud.js';
import {
  flowStarten, flowStatus, flowAbbrechen,
} from '../service/nextcloud-login-flow.js';
import { istPrivateAdresse, clientSafeError } from '../lib/net-guard.js';
import dns from 'node:dns/promises';
import net from 'node:net';

const router = Router();

async function setze(key, value) {
  await db.query(
    `INSERT INTO postbuch._settings (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = NOW()`,
    [key, JSON.stringify(value)],
  );
}

async function loesche(...keys) {
  await db.query('DELETE FROM postbuch._settings WHERE key = ANY($1::text[])', [keys]);
}

/**
 * Liegt der Host im privaten Netz? Entscheidet, ob http:// überhaupt zur
 * Diskussion steht — gegen einen öffentlich erreichbaren Server ist
 * unverschlüsselt eine harte Blockade, kein Opt-in.
 */
async function istPrivatesZiel(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return istPrivateAdresse(host);
  try {
    const adressen = await dns.lookup(host, { all: true });
    return adressen.length > 0 && adressen.every((a) => istPrivateAdresse(a.address));
  } catch {
    return false;
  }
}

// ── GET /status ──────────────────────────────────────────────────────────────

router.get('/status', async (_req, res) => {
  try {
    const s = await loadDynamicSettings();
    const baseUrl = String(s.nextcloud_base_url || '');
    const username = String(s.nextcloud_username || '');
    // Nie das Passwort selbst, nur ob eines da ist.
    const hatPasswort = !!String(s.nextcloud_app_password || '');

    res.json({
      configured: !!baseUrl,
      connected: !!(baseUrl && username && hatPasswort),
      baseUrl,
      username,
      allowInsecure: s.nextcloud_allow_insecure === true,
      allowPrivateTargets: s.storage_allow_private_targets === true,
      rootPath: String(s.nextcloud_root_path || ''),
      isActiveBackend: (s.storage_backend || 'onedrive') === 'nextcloud',
      flow: flowStatus(),
    });
  } catch (err) {
    console.error('[nextcloud] /status Fehler:', err);
    res.status(500).json({ error: 'Status konnte nicht ermittelt werden.' });
  }
});

// ── PUT /config ──────────────────────────────────────────────────────────────
// Eigene Route statt PUT /api/settings/:key: diese Werte müssen semantisch
// validiert werden (URL-Form, Protokoll gegen Zielart), und der
// Unsicher-Schalter gehört protokolliert.
//
// Der Ablageordner (nextcloud_root_path) gehört bewusst NICHT hierher. Er ist
// die Pfadgrenze für ID-aufgelöste Zugriffe und muss deshalb exakt der Ordner
// sein, in dem die Ordnerstruktur wirklich liegt. Geschrieben wird er
// ausschließlich von der Ordner-Initialisierung (service/storage-setup.js).
// Zwei Stellen mit Schreibrecht liefen unweigerlich auseinander — und dann
// scheiterte jeder Download an der Pfadprüfung.

router.put('/config', async (req, res) => {
  const { baseUrl, allowInsecure, allowPrivateTargets } = req.body || {};

  if (typeof baseUrl !== 'string' || !baseUrl.trim()) {
    return res.status(400).json({ error: 'Bitte eine Server-Adresse angeben.' });
  }

  let url;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    return res.status(400).json({
      error: 'Das ist keine gültige Adresse. Beispiel: https://cloud.example.de',
    });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return res.status(400).json({ error: 'Die Adresse muss mit http:// oder https:// beginnen.' });
  }
  if (url.username || url.password) {
    return res.status(400).json({ error: 'Zugangsdaten gehören nicht in die Adresse.' });
  }

  const privat = await istPrivatesZiel(url.hostname);
  if (url.protocol === 'http:' && !privat) {
    return res.status(400).json({
      error: 'Diese Adresse ist über das Internet erreichbar, aber nicht verschlüsselt. '
        + 'Aus Sicherheitsgründen kann Postbuch sich so nicht verbinden. Richte für öffentlich '
        + 'erreichbare Server ein gültiges https-Zertifikat ein — zum Beispiel kostenlos über Let\'s Encrypt.',
    });
  }
  if (url.protocol === 'http:' && privat && allowInsecure !== true) {
    return res.status(400).json({
      error: 'Die Verbindung ist unverschlüsselt. Bitte die unverschlüsselte Verbindung '
        + 'für das lokale Netzwerk ausdrücklich erlauben oder https verwenden.',
    });
  }

  try {
    const normalisiert = `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
    await setze('nextcloud_base_url', normalisiert);
    await setze('nextcloud_allow_insecure', allowInsecure === true);
    if (allowPrivateTargets !== undefined) {
      await setze('storage_allow_private_targets', allowPrivateTargets === true);
    }
    // Gepoolte Verbindungen und Pfad-Cache verwerfen — sie gehörten zur alten
    // Adresse.
    await nextcloud.resetVerbindung(normalisiert);

    appLog('INFO', 'nextcloud',
      `Server-Adresse gesetzt: ${normalisiert}`
      + `${allowInsecure === true ? ' (unverschlüsselt ausdrücklich erlaubt)' : ''}`, {
        entity: 'settings', entityId: req.session?.username || null,
      });

    res.json({ ok: true, baseUrl: normalisiert, zielIstPrivat: privat });
  } catch (err) {
    console.error('[nextcloud] /config Fehler:', err);
    res.status(500).json({ error: 'Die Einstellungen konnten nicht gespeichert werden.' });
  }
});

// ── Login-Flow v2 ────────────────────────────────────────────────────────────

router.post('/login-flow/start', async (req, res) => {
  try {
    const r = await flowStarten();
    appLog('INFO', 'nextcloud', 'Login-Flow v2 gestartet', {
      entity: 'settings', entityId: req.session?.username || null,
    });
    res.json(r);
  } catch (err) {
    if (err?.code === 'BEREITS_AKTIV') return res.status(409).json({ error: err.message });
    console.error('[nextcloud] login-flow/start Fehler:', err);
    res.status(400).json({ error: clientSafeError(err) });
  }
});

router.get('/login-flow/status', (_req, res) => {
  res.json(flowStatus());
});

router.post('/login-flow/cancel', (req, res) => {
  const abgebrochen = flowAbbrechen();
  if (abgebrochen) {
    appLog('INFO', 'nextcloud', 'Login-Flow abgebrochen', {
      entity: 'settings', entityId: req.session?.username || null,
    });
  }
  res.json({ ok: true, abgebrochen });
});

// ── PUT /credentials — manueller Fallback ────────────────────────────────────

router.put('/credentials', async (req, res) => {
  const { username, appPassword } = req.body || {};
  if (typeof username !== 'string' || !username.trim()) {
    return res.status(400).json({ error: 'Bitte den Nextcloud-Benutzernamen angeben.' });
  }
  if (!/^[A-Za-z0-9._@ -]{1,64}$/.test(username.trim())) {
    return res.status(400).json({ error: 'Der Benutzername enthält unzulässige Zeichen.' });
  }
  if (typeof appPassword !== 'string' || appPassword.length < 8) {
    return res.status(400).json({ error: 'Bitte ein gültiges App-Passwort angeben.' });
  }

  try {
    await setze('nextcloud_username', username.trim());
    await setze('nextcloud_app_password', appPassword);
    await nextcloud.resetVerbindung();
    appLog('INFO', 'nextcloud', `App-Passwort manuell hinterlegt (Benutzer "${username.trim()}")`, {
      entity: 'settings', entityId: req.session?.username || null,
    });
    res.json({ ok: true, username: username.trim() });
  } catch (err) {
    console.error('[nextcloud] /credentials Fehler:', err);
    res.status(500).json({ error: 'Die Zugangsdaten konnten nicht gespeichert werden.' });
  }
});

// ── POST /test ───────────────────────────────────────────────────────────────
// Verbindungstest ohne jede Schreiboperation. Nimmt ausschließlich die
// gespeicherten Einstellungen — niemals eine URL oder Zugangsdaten aus dem
// Body, sonst wäre die Route ein Probing-Werkzeug fürs LAN.

router.post('/test', async (_req, res) => {
  try {
    const r = await nextcloud.testeVerbindung();
    res.json({ ok: true, username: r.username });
  } catch (err) {
    console.error('[nextcloud] /test Fehler:', err);
    res.status(400).json({ ok: false, error: clientSafeError(err) });
  }
});

// ── POST /disconnect ─────────────────────────────────────────────────────────

router.post('/disconnect', async (req, res) => {
  try {
    const s = await loadDynamicSettings();
    if ((s.storage_backend || 'onedrive') === 'nextcloud') {
      return res.status(409).json({
        error: 'Nextcloud ist derzeit die aktive Ablage. Bitte zuerst auf ein anderes Backend umstellen.',
      });
    }
    flowAbbrechen();
    await loesche('nextcloud_username', 'nextcloud_app_password');
    await nextcloud.resetVerbindung();
    appLog('INFO', 'nextcloud', 'Nextcloud-Verbindung getrennt', {
      entity: 'settings', entityId: req.session?.username || null,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[nextcloud] /disconnect Fehler:', err);
    res.status(500).json({ error: 'Die Verbindung konnte nicht getrennt werden.' });
  }
});

export default router;
