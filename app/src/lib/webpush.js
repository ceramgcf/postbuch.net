/**
 * lib/webpush.js — Web-Push-Sender
 *
 * Nutzt die `web-push`-Library (RFC 8292 VAPID) zum Versand von Push-Nachrichten
 * an alle registrierten Browser-Subscriptions der Benutzer.
 *
 * Subscription-Schema (in mensch.webpush_subscriptions, JSONB-Array):
 *   [{ endpoint: "https://...", keys: { p256dh: "...", auth: "..." } }, ...]
 *
 * VAPID-Keys werden einmalig beim ersten Start in seed-settings.js generiert
 * und in _settings.vapid_public_key / vapid_private_key gespeichert.
 *
 * Push-Kategorien (siehe mensch.push_* / _settings.admin_push_*):
 *   new_doc        — neues Dokument verarbeitet
 *   reprocess      — Wiederverarbeitung abgeschlossen
 *   error          — Verarbeitungsfehler
 *   duplicate      — Duplikat-Verdacht oder -Auflösung
 *   wiedervorlage  — fällige Wiedervorlage
 *   payment        — Zahlungsfälligkeit (mit Offset pro Nutzer)
 */

import webpush from 'web-push';
import { query, getClient } from '../db.js';
import { loadDynamicSettings } from '../config.js';

// ── Instanzweiter Schalter (_settings.webpush_erlaubt) ─────────────────────
// Fehlt der Schlüssel, ist Push erlaubt (Standard). Nur ein explizites `false`
// schaltet ab. Geschrieben wird er ausschließlich über setzeWebpushErlaubt(),
// damit Abschalten und Entfernen aller Abonnements eine Einheit bleiben.
const ERLAUBT_KEY = 'webpush_erlaubt';

// Serialisiert Abschalten gegen gleichzeitiges Abonnieren: ohne die Sperre
// könnte ein Abo, das parallel zum Abschalten gespeichert wird, das Aufräumen
// überleben und nach dem nächsten Einschalten stillschweigend wieder empfangen.
const SPERRE_SQL = `SELECT pg_advisory_xact_lock(hashtext('postbuch_webpush_abos'))`;

/** Ist Web-Push auf dieser Instanz erlaubt? `q` erlaubt Aufruf in einer Transaktion. */
export async function webpushErlaubt(q = query) {
  const r = await q(`SELECT value FROM postbuch._settings WHERE key = $1`, [ERLAUBT_KEY]);
  return r.rows[0] ? r.rows[0].value !== false : true;
}

/**
 * Führt `fn(q)` in einer Transaktion unter der Abo-Sperre aus. `fn` bekommt
 * eine query-Funktion derselben Verbindung.
 */
export async function mitAboSperre(fn) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query(SPERRE_SQL);
    const result = await fn((text, params) => client.query(text, params));
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* Verbindung ggf. tot */ }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Schaltet Web-Push instanzweit an oder aus.
 *
 * Aus heißt: Einstellung auf `false` UND alle gespeicherten Abonnements
 * (Benutzer und Admin) werden gelöscht. Ein späteres Wiedereinschalten stellt
 * sie bewusst nicht wieder her – jede Person abonniert dann selbst neu. Die
 * persönlichen Schalter (Hauptschalter, Kategorien) bleiben unangetastet.
 *
 * @returns {Promise<{erlaubt:boolean, entfernteGeraete:number}>}
 */
export async function setzeWebpushErlaubt(erlaubt) {
  return mitAboSperre(async (q) => {
    await q(
      `INSERT INTO postbuch._settings (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = NOW()`,
      [ERLAUBT_KEY, JSON.stringify(erlaubt === true)],
    );
    if (erlaubt === true) return { erlaubt: true, entfernteGeraete: 0 };

    // Die alte Anzahl kommt aus einer Unterabfrage im FROM: die wird vor dem
    // Update ausgewertet. (Eine CTE, die erst im RETURNING gelesen wird, sähe
    // die eben geänderte Zeile nicht mehr.)
    const u = await q(
      `UPDATE postbuch.mensch m
          SET webpush_subscriptions = '[]'::jsonb, updated_at = now()
         FROM (SELECT id, jsonb_array_length(webpush_subscriptions) AS n
                 FROM postbuch.mensch
                WHERE jsonb_array_length(webpush_subscriptions) > 0) alt
        WHERE m.id = alt.id
       RETURNING alt.n`,
    );
    const a = await q(
      `UPDATE postbuch._settings s
          SET value = '[]'::jsonb, updated_at = NOW()
         FROM (SELECT key,
                      CASE WHEN jsonb_typeof(value) = 'array' THEN jsonb_array_length(value) ELSE 0 END AS n
                 FROM postbuch._settings
                WHERE key = 'admin_webpush_subscriptions') alt
        WHERE s.key = alt.key
       RETURNING alt.n`,
    );
    const entfernteGeraete = u.rows.reduce((sum, r) => sum + Number(r.n || 0), 0)
      + Number(a.rows[0]?.n || 0);
    return { erlaubt: false, entfernteGeraete };
  });
}

// Push-Dienst anhand des Endpunkt-Hosts. Nach außen geht nur der Anbietername,
// nie der Endpunkt selbst: der ist eine Zustelladresse für genau dieses Gerät.
const PUSH_DIENSTE = [
  { re: /(^|\.)(fcm|android)\.googleapis\.com$/i, name: 'Google' },
  { re: /(^|\.)push\.services\.mozilla\.com$/i,  name: 'Mozilla' },
  { re: /(^|\.)push\.apple\.com$/i,              name: 'Apple' },
  { re: /(^|\.)notify\.windows\.com$/i,          name: 'Microsoft' },
];

export function pushDienstVon(endpoint) {
  let host = '';
  try { host = new URL(endpoint).hostname; } catch { /* unten: unbekannt */ }
  return PUSH_DIENSTE.find((d) => d.re.test(host))?.name || 'anderer Push-Dienst';
}

/**
 * Wer würde gerade tatsächlich Push bekommen?
 *
 * Gleiche Bedingungen wie collectTargets(): mindestens ein abonniertes Gerät,
 * Hauptschalter an und mindestens eine Kategorie an. Bei abgeschaltetem
 * Instanzschalter ist die Liste per Definition leer.
 *
 * @returns {Promise<Array<{name:string, geraete:number, dienste:string[]}>>}
 */
export async function ermittlePushEmpfaenger() {
  if (!await webpushErlaubt()) return [];
  const empfaenger = [];
  const eintrag = (name, subs) => ({
    name,
    geraete: subs.length,
    dienste: [...new Set(subs.map((s) => pushDienstVon(s?.endpoint)))].sort(),
  });

  const katSpalten = PUSH_CATEGORIES.map((c) => `push_${c}`).join(' OR ');
  const r = await query(
    `SELECT COALESCE(NULLIF(btrim(anzeigename), ''), kurzname, anmeldename) AS name,
            webpush_subscriptions AS subs
       FROM postbuch.mensch
      WHERE loginfaehig = true AND aktiv = true
        AND jsonb_array_length(webpush_subscriptions) > 0
        AND notification_push = true
        AND (${katSpalten})
      ORDER BY 1`,
  );
  for (const row of r.rows) empfaenger.push(eintrag(row.name, row.subs));

  const a = await query(
    `SELECT key, value FROM postbuch._settings
      WHERE key = 'admin_webpush_subscriptions'
         OR key = 'admin_notification_push'
         OR key LIKE 'admin\\_push\\_%'`,
  );
  const av = Object.fromEntries(a.rows.map((x) => [x.key, x.value]));
  const adminSubs = Array.isArray(av.admin_webpush_subscriptions) ? av.admin_webpush_subscriptions : [];
  const adminMaster = av.admin_notification_push !== false;
  const adminKategorie = PUSH_CATEGORIES.some((c) => av[`admin_push_${c}`] !== false);
  if (adminSubs.length > 0 && adminMaster && adminKategorie) {
    empfaenger.push(eintrag('Admin', adminSubs));
  }
  return empfaenger;
}

let _configuredPubKey = null;

// Erlaubte Kategorien — andere Werte werden zur Sicherheit auf 'new_doc' gemappt.
export const PUSH_CATEGORIES = Object.freeze([
  'new_doc', 'reprocess', 'error', 'duplicate', 'wiedervorlage', 'payment',
]);

function normalizeCategory(c) {
  return PUSH_CATEGORIES.includes(c) ? c : 'new_doc';
}

async function ensureVapid() {
  const s = await loadDynamicSettings();
  const publicKey  = s.vapid_public_key;
  const privateKey = s.vapid_private_key;
  if (!publicKey || !privateKey) return false;
  if (publicKey !== _configuredPubKey) {
    let subject = s.vapid_subject || process.env.VAPID_SUBJECT;
    if (!subject) {
      subject = 'mailto:admin@localhost';
      console.warn('[webpush] VAPID_SUBJECT nicht konfiguriert — Push-Zustellung kann fehlschlagen!');
    } else if (!subject.startsWith('mailto:') && !subject.startsWith('https://')) {
      subject = `mailto:${subject}`;
    }
    webpush.setVapidDetails(subject, publicKey, privateKey);
    _configuredPubKey = publicKey;
    console.log('[webpush] VAPID konfiguriert mit subject:', subject);
  }
  return true;
}

/**
 * Sammelt alle Push-Targets, die für eine bestimmte Kategorie aktiviert sind.
 * Optional: nur ein bestimmter Benutzer (für individuelle Erinnerungen mit Offset).
 *
 * @param {string}  category   - eine der PUSH_CATEGORIES
 * @param {object}  [options]
 * @param {string}  [options.onlyUsername]  - nur an diesen Benutzer (admin oder mensch.anmeldename)
 * @returns {Promise<Array<{ id, subs, type: 'user'|'admin' }>>}
 */
async function collectTargets(category, { onlyUsername } = {}) {
  const cat = normalizeCategory(category);
  const targets = [];

  // ── reguläre Benutzer ──
  // notification_push = Master-Schalter; push_<category> = Kategorie-Schalter.
  // Beides muss true sein.
  if (!onlyUsername || onlyUsername !== 'admin') {
    const params = [];
    // loginfaehig/aktiv wie beim Login: Wem der Zugang entzogen wurde, der
    // bekommt auch keine Dokumentmeldungen mehr auf ein früher abonniertes Gerät.
    // Ein auf eigene Dokumente beschränkter Lesezugriff erhält keine Pushes:
    // Meldungen nennen Betreff und Absender beliebiger Dokumente.
    let where = `loginfaehig = true AND aktiv = true AND lesebereich = 'alle'
                 AND webpush_subscriptions IS NOT NULL
                 AND jsonb_array_length(webpush_subscriptions) > 0
                 AND notification_push = true
                 AND push_${cat} = true`;
    if (onlyUsername) {
      params.push(onlyUsername);
      where += ` AND anmeldename = $${params.length}`;
    }
    const userRows = await query(
      `SELECT anmeldename AS username, webpush_subscriptions
         FROM postbuch.mensch
        WHERE ${where}`,
      params,
    );
    for (const row of userRows.rows) {
      targets.push({ id: row.username, subs: row.webpush_subscriptions, type: 'user' });
    }
  }

  // ── Admin (Subscriptions liegen in _settings) ──
  if (!onlyUsername || onlyUsername === 'admin') {
    const adminMasterRow = await query(
      `SELECT value FROM postbuch._settings WHERE key = 'admin_notification_push'`,
    );
    const adminMasterEnabled = adminMasterRow.rows[0] ? adminMasterRow.rows[0].value !== false : true;

    const adminCatRow = await query(
      `SELECT value FROM postbuch._settings WHERE key = $1`,
      [`admin_push_${cat}`],
    );
    const adminCatEnabled = adminCatRow.rows[0] ? adminCatRow.rows[0].value !== false : true;

    if (adminMasterEnabled && adminCatEnabled) {
      const adminRow = await query(
        `SELECT value FROM postbuch._settings WHERE key = 'admin_webpush_subscriptions'`,
      );
      const adminSubs = adminRow.rows[0]?.value ?? [];
      if (Array.isArray(adminSubs) && adminSubs.length > 0) {
        targets.push({ id: 'admin', subs: adminSubs, type: 'admin' });
      }
    }
  }

  return targets;
}

/**
 * Sendet eine Push-Benachrichtigung an alle Benutzer mit aktiver Subscription,
 * die zusätzlich die angegebene Kategorie aktiviert haben.
 *
 * @param {object}   payload  - { title, body, icon?, badge?, url?, tag?, requireInteraction? }
 * @param {object}   [opts]
 * @param {string}   [opts.category='new_doc']   - PUSH_CATEGORIES
 * @param {string}   [opts.onlyUsername]         - nur an diesen Benutzer (für individuelle Erinnerungen)
 * @returns {Promise<{ sent: number, failed: number }>}
 */
export async function sendPushToAllUsers(payload, opts = {}) {
  const category = normalizeCategory(opts.category || 'new_doc');

  // Instanzweit abgeschaltet: kein einziger Request an einen Push-Dienst,
  // auch nicht an Abos, die irgendwie noch gespeichert sein sollten.
  if (!await webpushErlaubt()) return { sent: 0, failed: 0 };

  if (!await ensureVapid()) {
    console.warn('[webpush] VAPID-Keys fehlen — Web Push übersprungen');
    return { sent: 0, failed: 0 };
  }

  const targets = await collectTargets(category, { onlyUsername: opts.onlyUsername });
  if (targets.length === 0) return { sent: 0, failed: 0 };

  const payloadStr = JSON.stringify(payload);
  let sent = 0;

  for (const target of targets) {
    const invalidEndpoints = [];

    await Promise.allSettled(
      target.subs.map(async (sub) => {
        try {
          await webpush.sendNotification(sub, payloadStr);
          sent++;
        } catch (err) {
          if (err.statusCode === 410 || err.statusCode === 404) {
            invalidEndpoints.push(sub.endpoint);
          } else {
            console.warn('[webpush] Fehler für', target.id, ':', err.statusCode, err.message);
          }
        }
      }),
    );

    if (invalidEndpoints.length > 0) {
      if (target.type === 'admin') {
        await query(
          `UPDATE postbuch._settings
              SET value = COALESCE(
                (SELECT jsonb_agg(s)
                   FROM jsonb_array_elements(value) s
                  WHERE (s->>'endpoint') != ALL($1::text[])),
                '[]'::jsonb
              )
            WHERE key = 'admin_webpush_subscriptions'`,
          [invalidEndpoints],
        ).catch((e) => console.warn('[webpush] Admin-Cleanup-Fehler:', e.message));
      } else {
        await query(
          `UPDATE postbuch.mensch
              SET webpush_subscriptions = COALESCE(
                (SELECT jsonb_agg(s)
                   FROM jsonb_array_elements(webpush_subscriptions) s
                  WHERE (s->>'endpoint') != ALL($2::text[])),
                '[]'::jsonb
              )
            WHERE anmeldename = $1`,
          [target.id, invalidEndpoints],
        ).catch((e) => console.warn('[webpush] Cleanup-Fehler:', e.message));
      }
    }
  }

  return { sent, failed: 0 };
}

/**
 * Gibt den VAPID Public Key (URL-safe Base64) zurück.
 * null wenn Keys noch nicht generiert.
 */
export async function getVapidPublicKey() {
  const s = await loadDynamicSettings();
  return s.vapid_public_key || null;
}
