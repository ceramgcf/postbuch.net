/**
 * routes/push.js — Web-Push-Routen
 *
 * GET  /api/push/vapid-public        — VAPID Public Key für PushManager.subscribe()
 * POST /api/push/subscribe           — Subscription speichern (eingeloggter Benutzer)
 * POST /api/push/unsubscribe         — Subscription entfernen
 * GET  /api/push/subscription-status — Hat dieser Benutzer eine aktive Subscription?
 *                                      Ist Push instanzweit erlaubt? Kennt der
 *                                      Server dieses Gerät (?geraet=<sha256>)?
 * GET  /api/push/my-prefs            — Master + Kategorie-Toggles + payment_offset_days
 * PATCH /api/push/my-prefs           — Partielles Update der Benachrichtigungseinstellungen
 */

import { createHash } from 'node:crypto';
import { Router } from 'express';
import { query } from '../db.js';
import {
  getVapidPublicKey, PUSH_CATEGORIES, webpushErlaubt, mitAboSperre,
} from '../lib/webpush.js';

const router = Router();
const ADMIN_USERNAME = 'admin';
const NICHT_ERLAUBT = 'Push-Benachrichtigungen sind auf dieser Instanz vom Admin abgeschaltet.';

// Erlaubte Boolean-Felder (Master + Kategorien) für PATCH.
const BOOL_FIELDS = ['push', 'discord', ...PUSH_CATEGORIES.map((c) => `push_${c}`)];

// Numerische Felder mit Validierungsgrenzen + Defaults.
// push_reminder_hour gilt für ALLE täglichen Erinnerungen (Wiedervorlagen + Zahlungen).
const INT_FIELDS = {
  push_payment_offset_days: { min: 0, max: 60, default: 3 },
  push_reminder_hour:       { min: 0, max: 23, default: 9 },
};

// ── GET /api/push/vapid-public ───────────────────────────────────────────────
router.get('/vapid-public', async (_req, res) => {
  try {
    if (!await webpushErlaubt()) return res.status(403).json({ error: NICHT_ERLAUBT });
    const key = await getVapidPublicKey();
    if (!key) {
      return res.status(503).json({ error: 'VAPID-Keys noch nicht generiert.' });
    }
    res.json({ publicKey: key });
  } catch (err) {
    console.error('[push/vapid-public] Fehler:', err);
    res.status(500).json({ error: 'Interner Fehler' });
  }
});

// ── POST /api/push/subscribe ────────────────────────────────────────────────
// Body: { subscription: { endpoint, keys: { p256dh, auth } } }
router.post('/subscribe', async (req, res) => {
  const sub = req.body?.subscription;
  if (!sub || typeof sub.endpoint !== 'string' || !sub.keys?.p256dh || !sub.keys?.auth) {
    return res.status(400).json({ error: 'Ungültige Subscription (endpoint + keys.p256dh + keys.auth erforderlich)' });
  }
  if (!/^https:\/\//i.test(sub.endpoint)) {
    return res.status(400).json({ error: 'Subscription endpoint muss HTTPS sein' });
  }

  const username = req.session?.username;
  if (!username) return res.status(401).json({ error: 'Nicht authentifiziert' });

  try {
    // Prüfen und Speichern unter derselben Sperre wie das instanzweite
    // Abschalten – sonst könnte ein Abo das Aufräumen überleben.
    const gespeichert = await mitAboSperre(async (q) => {
      if (!await webpushErlaubt(q)) return false;
      if (username === ADMIN_USERNAME) {
        await q(
          `INSERT INTO postbuch._settings (key, value)
           VALUES ('admin_webpush_subscriptions', $1::jsonb)
           ON CONFLICT (key) DO UPDATE
             SET value = CASE
               WHEN _settings.value @> jsonb_build_array(jsonb_build_object('endpoint', $2::text))
               THEN _settings.value
               ELSE _settings.value || jsonb_build_array($3::jsonb)
             END`,
          [JSON.stringify([sub]), sub.endpoint, JSON.stringify(sub)],
        );
      } else {
        await q(
          `UPDATE postbuch.mensch
              SET webpush_subscriptions = CASE
                WHEN webpush_subscriptions @> jsonb_build_array(jsonb_build_object('endpoint', $2::text))
                THEN webpush_subscriptions
                ELSE COALESCE(webpush_subscriptions, '[]'::jsonb) || jsonb_build_array($3::jsonb)
              END
            WHERE anmeldename = $1 AND loginfaehig = true`,
          [username, sub.endpoint, JSON.stringify(sub)],
        );
      }
      return true;
    });
    if (!gespeichert) return res.status(403).json({ error: NICHT_ERLAUBT });
    res.json({ success: true });
  } catch (err) {
    console.error('[push/subscribe] Fehler:', err);
    res.status(500).json({ error: 'Subscription konnte nicht gespeichert werden' });
  }
});

// ── POST /api/push/unsubscribe ──────────────────────────────────────────────
// Body: { endpoint: "https://..." }
router.post('/unsubscribe', async (req, res) => {
  const endpoint = req.body?.endpoint;
  if (typeof endpoint !== 'string' || !endpoint) {
    return res.status(400).json({ error: 'endpoint erforderlich' });
  }

  const username = req.session?.username;
  if (!username) return res.status(401).json({ error: 'Nicht authentifiziert' });

  try {
    if (username === ADMIN_USERNAME) {
      await query(
        `UPDATE postbuch._settings
            SET value = COALESCE(
              (SELECT jsonb_agg(s)
                 FROM jsonb_array_elements(value) s
                WHERE (s->>'endpoint') <> $1),
              '[]'::jsonb
            )
          WHERE key = 'admin_webpush_subscriptions'`,
        [endpoint],
      );
    } else {
      await query(
        `UPDATE postbuch.mensch
            SET webpush_subscriptions = COALESCE(
              (SELECT jsonb_agg(s)
                 FROM jsonb_array_elements(COALESCE(webpush_subscriptions, '[]'::jsonb)) s
                WHERE (s->>'endpoint') <> $2),
              '[]'::jsonb
            )
          WHERE anmeldename = $1 AND loginfaehig = true`,
        [username, endpoint],
      );
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[push/unsubscribe] Fehler:', err);
    res.status(500).json({ error: 'Abmeldung fehlgeschlagen' });
  }
});

// ── GET /api/push/subscription-status ──────────────────────────────────────
// subscribed:    hat der aktuelle User mind. eine Subscription?
// erlaubt:       ist Push instanzweit erlaubt?
// geraetBekannt: nur mit ?geraet=<sha256-hex des Endpunkts> – kennt der Server
//                genau dieses Browser-Abo für diesen User? Der Client schickt
//                bewusst nur den Hash: der Endpunkt ist eine Zustelladresse und
//                gehört nicht in Query-Strings und Zugriffslogs.
router.get('/subscription-status', async (req, res) => {
  const username = req.session?.username;
  if (!username) return res.status(401).json({ error: 'Nicht authentifiziert' });

  const geraet = typeof req.query.geraet === 'string' ? req.query.geraet.toLowerCase() : null;
  if (geraet !== null && !/^[0-9a-f]{64}$/.test(geraet)) {
    return res.status(400).json({ error: 'geraet muss ein SHA-256-Hexwert sein' });
  }

  try {
    let subs = [];
    if (username === ADMIN_USERNAME) {
      const r = await query(
        `SELECT value FROM postbuch._settings WHERE key = 'admin_webpush_subscriptions'`,
      );
      subs = r.rows[0]?.value ?? [];
    } else {
      const r = await query(
        `SELECT webpush_subscriptions FROM postbuch.mensch
          WHERE anmeldename = $1 AND loginfaehig = true`,
        [username],
      );
      subs = r.rows[0]?.webpush_subscriptions ?? [];
    }
    if (!Array.isArray(subs)) subs = [];
    const out = { subscribed: subs.length > 0, erlaubt: await webpushErlaubt() };
    if (geraet !== null) {
      out.geraetBekannt = subs.some((s) => typeof s?.endpoint === 'string'
        && createHash('sha256').update(s.endpoint).digest('hex') === geraet);
    }
    res.json(out);
  } catch (err) {
    console.error('[push/subscription-status] Fehler:', err);
    res.status(500).json({ error: 'Interner Fehler' });
  }
});

// ── Helper: Admin-Bool aus _settings lesen ─────────────────────────────────
async function readAdminBool(settingsKey, defaultValue = true) {
  const r = await query(`SELECT value FROM postbuch._settings WHERE key = $1`, [settingsKey]);
  return r.rows[0] ? r.rows[0].value !== false : defaultValue;
}

async function readAdminInt(settingsKey, defaultValue) {
  const r = await query(`SELECT value FROM postbuch._settings WHERE key = $1`, [settingsKey]);
  if (!r.rows[0]) return defaultValue;
  const v = r.rows[0].value;
  return typeof v === 'number' && Number.isInteger(v) ? v : defaultValue;
}

// ── GET /api/push/my-prefs ──────────────────────────────────────────────────
// Liefert Master + alle Kategorien + numerische Felder.
router.get('/my-prefs', async (req, res) => {
  const username = req.session?.username;
  if (!username) return res.status(401).json({ error: 'Nicht authentifiziert' });

  try {
    if (username === ADMIN_USERNAME) {
      const out = {
        push:    await readAdminBool('admin_notification_push',    true),
        discord: await readAdminBool('admin_notification_discord', true),
      };
      for (const cat of PUSH_CATEGORIES) {
        out[`push_${cat}`] = await readAdminBool(`admin_push_${cat}`, true);
      }
      for (const [field, cfg] of Object.entries(INT_FIELDS)) {
        out[field] = await readAdminInt(`admin_${field}`, cfg.default);
      }
      return res.json(out);
    }

    const cols = [
      'notification_push',
      'notification_discord',
      ...Object.keys(INT_FIELDS),
      ...PUSH_CATEGORIES.map((c) => `push_${c}`),
    ];
    const r = await query(
      `SELECT ${cols.join(', ')} FROM postbuch.mensch WHERE anmeldename = $1 AND loginfaehig=true`,
      [username],
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Benutzer nicht gefunden' });

    const row = r.rows[0];
    const out = {
      push:    row.notification_push,
      discord: row.notification_discord,
    };
    for (const cat of PUSH_CATEGORIES) out[`push_${cat}`] = row[`push_${cat}`];
    for (const field of Object.keys(INT_FIELDS)) out[field] = row[field];
    return res.json(out);
  } catch (err) {
    console.error('[push/my-prefs GET] Fehler:', err);
    res.status(500).json({ error: 'Interner Fehler' });
  }
});

// ── PATCH /api/push/my-prefs ────────────────────────────────────────────────
// Body: { push?, discord?, push_new_doc?, push_reprocess?, push_error?,
//         push_duplicate?, push_wiedervorlage?, push_payment?,
//         push_payment_offset_days?, push_reminder_hour? }
router.patch('/my-prefs', async (req, res) => {
  const username = req.session?.username;
  if (!username) return res.status(401).json({ error: 'Nicht authentifiziert' });

  const body = req.body || {};

  // 1) Validierung: Boolean-Felder
  const boolUpdates = {};
  for (const field of BOOL_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      if (typeof body[field] !== 'boolean') {
        return res.status(400).json({ error: `${field} muss boolean sein` });
      }
      boolUpdates[field] = body[field];
    }
  }

  // 2) Validierung: Integer-Felder
  const intUpdates = {};
  for (const [field, cfg] of Object.entries(INT_FIELDS)) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      const v = body[field];
      if (!Number.isInteger(v) || v < cfg.min || v > cfg.max) {
        return res.status(400).json({
          error: `${field} muss ganzzahlig zwischen ${cfg.min} und ${cfg.max} sein`,
        });
      }
      intUpdates[field] = v;
    }
  }

  if (Object.keys(boolUpdates).length === 0 && Object.keys(intUpdates).length === 0) {
    return res.status(400).json({ error: 'Mindestens ein Feld erforderlich' });
  }

  try {
    if (username === ADMIN_USERNAME) {
      // Admin: alles in _settings spiegeln.
      for (const [field, value] of Object.entries(boolUpdates)) {
        let settingsKey;
        if (field === 'push')          settingsKey = 'admin_notification_push';
        else if (field === 'discord')  settingsKey = 'admin_notification_discord';
        else                            settingsKey = `admin_${field}`; // push_new_doc → admin_push_new_doc
        await query(
          `INSERT INTO postbuch._settings (key, value) VALUES ($1, $2::jsonb)
           ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = NOW()`,
          [settingsKey, JSON.stringify(value)],
        );
      }
      for (const [field, value] of Object.entries(intUpdates)) {
        await query(
          `INSERT INTO postbuch._settings (key, value) VALUES ($1, $2::jsonb)
           ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = NOW()`,
          [`admin_${field}`, JSON.stringify(value)],
        );
      }
      return res.json({ success: true });
    }

    // Reguläre Nutzer: der Mensch hinter dem Anmeldenamen.
    const setParts = [];
    const vals = [];
    let i = 1;
    // Mapping: REST-Feldname → Spaltenname
    const colMap = {
      push: 'notification_push',
      discord: 'notification_discord',
    };
    for (const [field, value] of Object.entries(boolUpdates)) {
      const col = colMap[field] || field; // push_<cat> bleibt push_<cat>
      setParts.push(`${col} = $${i++}`);
      vals.push(value);
    }
    for (const [field, value] of Object.entries(intUpdates)) {
      setParts.push(`${field} = $${i++}`);
      vals.push(value);
    }
    vals.push(username);
    await query(
      `UPDATE postbuch.mensch SET ${setParts.join(', ')}, updated_at = now()
        WHERE anmeldename = $${i} AND loginfaehig = true`,
      vals,
    );
    return res.json({ success: true });
  } catch (err) {
    console.error('[push/my-prefs PATCH] Fehler:', err);
    res.status(500).json({ error: 'Interner Fehler' });
  }
});

export default router;
