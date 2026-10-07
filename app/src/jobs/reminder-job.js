/**
 * jobs/reminder-job.js — Tägliche Erinnerungs-Pushes
 *
 * Ein gemeinsamer stündlicher Cron (Minute 0, Europe/Berlin). Pro Nutzer wird
 * geprüft, ob `push_reminder_hour` mit der aktuellen Berlin-Stunde übereinstimmt.
 * Trifft das zu, werden zwei unabhängige Erinnerungen erwogen:
 *
 *   1. Wiedervorlagen: alle nicht-erledigten WV mit faellig_am <= heute,
 *      die heute noch nicht benachrichtigt wurden — IMMER am Tag der WV
 *      (kein Offset). Voraussetzung: push_wiedervorlage = true.
 *   2. Zahlungs-Fälligkeiten: Rechnungen, deren faelligkeit innerhalb von
 *      push_payment_offset_days liegt. Voraussetzung: push_payment = true.
 *      Pro (postid, offset_days, heute) wird höchstens 1 Push gesendet.
 *
 * Marker:
 *   - wiedervorlage.push_notified_on = date  → Tag des letzten Pushes
 *   - _payment_push_log              → PK (postid, offset_days, notified_on)
 *
 * Steuerung über _settings.reminder_enabled (default true).
 * Cron-Ausdruck: stündlich um Minute 0.
 */

import { query } from '../db.js';
import { loadDynamicSettings } from '../config.js';
import { sendPushToAllUsers, PUSH_CATEGORIES } from '../lib/webpush.js';
import { appLog } from '../app-log.js';
import { offenerBetragSql, offeneRechnungSql } from '../lib/rechnungs-filter.js';

const REMINDER_CRON = '0 * * * *';  // jede Stunde zur Minute 0 (Europe/Berlin)
const DEFAULT_OFFSET = 3;
const DEFAULT_REMINDER_HOUR = 9;

let _cronJob = null;
let _running = false;

// Kalendertag in Europe/Berlin – wie Cron und DB-Session. toISOString() läge
// zwischen Mitternacht und 1 bzw. 2 Uhr noch auf dem UTC-Vortag.
function todayISO() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function appUrl(settings, path) {
  const host = (settings?.app_host || '').replace(/\/$/, '');
  return host ? `${host}${path}` : path;
}

/**
 * Aktuelle Stunde in Europe/Berlin (0..23).
 */
function currentBerlinHour() {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Berlin',
    hour: '2-digit',
    hour12: false,
  });
  return Number(fmt.format(new Date()));
}

// ── Empfänger-Auswahl pro Kategorie ────────────────────────────────────────

async function readAdminBool(settingsKey, defaultValue = true) {
  const r = await query(`SELECT value FROM postbuch._settings WHERE key = $1`, [settingsKey]);
  return r.rows[0] ? r.rows[0].value !== false : defaultValue;
}

async function readAdminInt(settingsKey, defaultValue) {
  const r = await query(`SELECT value FROM postbuch._settings WHERE key = $1`, [settingsKey]);
  const v = r.rows[0]?.value;
  return Number.isInteger(v) ? v : defaultValue;
}

/**
 * Prüft, ob der Admin (über _settings) für die gegebene Kategorie und Stunde
 * empfangsbereit ist. Liefert ggf. ein Recipient-Objekt mit username='admin'.
 */
async function adminRecipientForCategory(category, currentHour) {
  const adminHour = await readAdminInt('admin_push_reminder_hour', DEFAULT_REMINDER_HOUR);
  if (adminHour !== currentHour) return null;

  const master = await readAdminBool('admin_notification_push', true);
  if (!master) return null;

  const catEnabled = await readAdminBool(`admin_push_${category}`, true);
  if (!catEnabled) return null;

  const subsRow = await query(`SELECT value FROM postbuch._settings WHERE key = 'admin_webpush_subscriptions'`);
  const subs = subsRow.rows[0]?.value ?? [];
  if (!Array.isArray(subs) || subs.length === 0) return null;

  const recipient = { username: 'admin' };
  if (category === 'payment') {
    recipient.offset = await readAdminInt('admin_push_payment_offset_days', DEFAULT_OFFSET);
  }
  return recipient;
}

/**
 * Liefert Liste {username, offset?} aller Nutzer, deren push_reminder_hour mit
 * der angegebenen Stunde übereinstimmt UND die für die gegebene Kategorie
 * (wiedervorlage|payment) empfänglich sind.
 */
async function fetchRecipients(category, currentHour) {
  const catColumn = `push_${category}`;
  const extraCols = category === 'payment' ? ', push_payment_offset_days' : '';
  const userRows = await query(
    `SELECT anmeldename AS username${extraCols}
       FROM postbuch.mensch
      WHERE notification_push = true
        AND loginfaehig = true AND aktiv = true
        AND ${catColumn} = true
        AND push_reminder_hour = $1
        AND webpush_subscriptions IS NOT NULL
        AND jsonb_array_length(webpush_subscriptions) > 0`,
    [currentHour],
  );
  const out = userRows.rows.map((r) => {
    const o = { username: r.username };
    if (category === 'payment') o.offset = r.push_payment_offset_days ?? DEFAULT_OFFSET;
    return o;
  });

  const adminR = await adminRecipientForCategory(category, currentHour);
  if (adminR) out.push(adminR);
  return out;
}

// ── Wiedervorlagen ──────────────────────────────────────────────────────────

/**
 * Sammelt alle fälligen WV (faellig_am <= heute, nicht erledigt) die heute noch
 * nicht benachrichtigt wurden.
 */
async function fetchDueWiedervorlagen() {
  const result = await query(
    `SELECT w.wv_id,
            w.postid,
            w.akteid,
            w.faellig_am,
            w.aktion,
            p.betreff AS post_betreff,
            a.betreff AS akte_betreff
       FROM postbuch.wiedervorlage w
       LEFT JOIN postbuch.postbuch p ON p.postid = w.postid
       LEFT JOIN postbuch.akte     a ON a.akteid = w.akteid
      WHERE w.erledigt = false
        AND w.faellig_am <= CURRENT_DATE
        AND (w.push_notified_on IS NULL OR w.push_notified_on < CURRENT_DATE)
      ORDER BY w.faellig_am ASC, w.wv_id ASC`,
  );
  return result.rows;
}

async function runWiedervorlagenReminder(settings, hour) {
  const recipients = await fetchRecipients('wiedervorlage', hour);
  if (recipients.length === 0) return { recipients: 0, sent: 0, hour };

  const rows = await fetchDueWiedervorlagen();
  if (rows.length === 0) return { recipients: recipients.length, sent: 0, hour };

  const today = todayISO();

  // Push-Inhalt vorbereiten (identisch für alle Empfänger an diesem Tag).
  let title, body, url;
  if (rows.length === 1) {
    const w = rows[0];
    const ref = w.postid || w.akteid;
    const refBetreff = w.post_betreff || w.akte_betreff || '';
    const isOverdue = new Date(w.faellig_am) < new Date(today);
    title = isOverdue ? '⏰ Wiedervorlage überfällig' : '⏰ Wiedervorlage fällig';
    body = `${w.aktion.slice(0, 80)}${refBetreff ? ' · ' + refBetreff.slice(0, 50) : ''} (${ref})`;
    url  = appUrl(settings, '/wiedervorlagen');
  } else {
    const overdueCount = rows.filter((r) => new Date(r.faellig_am) < new Date(today)).length;
    title = `⏰ ${rows.length} Wiedervorlagen fällig`;
    body  = overdueCount > 0
      ? `Davon ${overdueCount} überfällig — bitte erledigen oder verschieben`
      : 'Heute zu erledigen';
    url   = appUrl(settings, '/wiedervorlagen');
  }

  let totalSent = 0;
  for (const r of recipients) {
    const { sent } = await sendPushToAllUsers(
      { title, body, tag: `wv-${today}`, url, requireInteraction: false },
      { category: 'wiedervorlage', onlyUsername: r.username },
    );
    totalSent += sent;
  }

  // Marker auf heute setzen (gesendete WV).
  const ids = rows.map((r) => r.wv_id);
  await query(
    `UPDATE postbuch.wiedervorlage SET push_notified_on = CURRENT_DATE WHERE wv_id = ANY($1::int[])`,
    [ids],
  );

  appLog('INFO', 'reminder-job', `Wiedervorlagen-Erinnerung (Stunde ${hour}): ${rows.length} fällige WV, ${recipients.length} Empfänger, ${totalSent} Push(es) gesendet`);
  return { recipients: recipients.length, count: rows.length, sent: totalSent, hour };
}

// ── Zahlungsfälligkeiten ────────────────────────────────────────────────────

/**
 * Sammelt offene Rechnungen (arzt + handwerker + generisch), deren faelligkeit
 * im Fenster [today, today + offsetDays] liegt UND deren bezahlt_am IS NULL ist.
 * Nur solche, für die heute noch kein Push für genau diesen offset gesendet wurde.
 */
async function fetchUpcomingDueInvoices(offsetDays) {
  const result = await query(
    `WITH cand AS (
       SELECT ar.postid,
              ar.faelligkeit,
              p.betreff,
              ${offenerBetragSql('ar')} AS gesamtbetrag,
              'arztrechnung'::text AS typ
         FROM postbuch.arztrechnung ar
         JOIN postbuch.postbuch p ON p.postid = ar.postid
        WHERE ${offeneRechnungSql('ar')}
          AND ar.faelligkeit IS NOT NULL
          AND ar.faelligkeit BETWEEN CURRENT_DATE AND CURRENT_DATE + ($1::int * INTERVAL '1 day')
       UNION ALL
       SELECT hr.postid,
              hr.faelligkeit,
              p.betreff,
              ${offenerBetragSql('hr')} AS gesamtbetrag,
              'handwerkerrechnung'
         FROM postbuch.handwerkerrechnung hr
         JOIN postbuch.postbuch p ON p.postid = hr.postid
        WHERE ${offeneRechnungSql('hr')}
          AND hr.faelligkeit IS NOT NULL
          AND hr.faelligkeit BETWEEN CURRENT_DATE AND CURRENT_DATE + ($1::int * INTERVAL '1 day')
       UNION ALL
       SELECT gr.postid,
              gr.faelligkeit,
              p.betreff,
              ${offenerBetragSql('gr')} AS gesamtbetrag,
              'rechnung'
         FROM postbuch.generische_rechnung gr
         JOIN postbuch.postbuch p ON p.postid = gr.postid
        WHERE ${offeneRechnungSql('gr')}
          AND gr.faelligkeit IS NOT NULL
          AND gr.faelligkeit BETWEEN CURRENT_DATE AND CURRENT_DATE + ($1::int * INTERVAL '1 day')
     )
     SELECT c.* FROM cand c
       LEFT JOIN postbuch._payment_push_log l
         ON l.postid = c.postid
        AND l.offset_days = $1::int
        AND l.notified_on = CURRENT_DATE
      WHERE l.postid IS NULL
      ORDER BY c.faelligkeit ASC, c.postid ASC`,
    [offsetDays],
  );
  return result.rows;
}

async function runPaymentReminder(settings, hour) {
  const recipients = await fetchRecipients('payment', hour);
  if (recipients.length === 0) return { recipients: 0, sent: 0, hour };

  // Pro distinct offset einmal die Kandidaten sammeln und cachen.
  const cache = new Map();
  async function rowsForOffset(offset) {
    if (!cache.has(offset)) cache.set(offset, await fetchUpcomingDueInvoices(offset));
    return cache.get(offset);
  }

  let totalSent = 0;
  const today = todayISO();
  for (const r of recipients) {
    const rows = await rowsForOffset(r.offset);
    if (rows.length === 0) continue;

    let title, body;
    if (rows.length === 1) {
      const inv = rows[0];
      title = '💶 Zahlung fällig';
      body  = `${inv.betreff || inv.postid} · ${inv.gesamtbetrag}€ · ${inv.faelligkeit}`;
    } else {
      const sum = rows.reduce((acc, x) => acc + Number(x.gesamtbetrag || 0), 0);
      title = `💶 ${rows.length} Rechnungen fällig`;
      body  = `Insgesamt ${sum.toFixed(2)}€ in den nächsten ${r.offset} Tag(en)`;
    }

    const { sent } = await sendPushToAllUsers(
      {
        title,
        body,
        tag: `pay-${r.offset}-${today}`,
        url: appUrl(settings, '/unbezahlt'),
        requireInteraction: false,
      },
      { category: 'payment', onlyUsername: r.username },
    );
    totalSent += sent;

    for (const inv of rows) {
      await query(
        `INSERT INTO postbuch._payment_push_log (postid, typ, offset_days, notified_on)
         VALUES ($1, $2, $3, CURRENT_DATE)
         ON CONFLICT (postid, offset_days, notified_on) DO NOTHING`,
        [inv.postid, inv.typ, r.offset],
      );
    }
  }

  appLog('INFO', 'reminder-job', `Zahlungs-Erinnerung (Stunde ${hour}): ${recipients.length} Empfänger, ${totalSent} Push(es) gesendet`);
  return { recipients: recipients.length, sent: totalSent, hour };
}

// ── OneDrive-Client-Secret ─────────────────────────────────────────────────

async function runOneDriveSecretReminder(settings, hour) {
  if (settings.onedrive_auth_mode !== 'legacy' || !settings.onedrive_client_secret) return null;
  const expiresAt = settings.onedrive_client_secret_expires_at;
  if (!expiresAt || Number.isNaN(Date.parse(expiresAt))) return null;
  const days = Math.ceil((Date.parse(expiresAt) - Date.now()) / 86_400_000);
  if (days > 60) return null;

  const adminHour = await readAdminInt('admin_push_reminder_hour', DEFAULT_REMINDER_HOUR);
  if (hour !== adminHour) return null;
  const marker = await query(
    "SELECT value FROM postbuch._settings WHERE key = 'onedrive_secret_reminder_sent_for'",
  ).then((r) => r.rows[0]?.value || null);
  if (marker === expiresAt) return null;

  const body = days < 0
    ? 'Das Client-Secret ist abgelaufen. Erzeuge in Azure ein neues Secret und verbinde OneDrive neu.'
    : `Das OneDrive-Client-Secret läuft in ${days} Tagen ab. Erzeuge rechtzeitig ein neues Secret in Azure.`;
  const result = await sendPushToAllUsers({
    title: '⚠️ OneDrive-Secret erneuern',
    body,
    tag: `onedrive-secret-${expiresAt}`,
    url: appUrl(settings, '/einstellungen?tab=onedrive'),
    requireInteraction: true,
  }, { category: 'error', onlyUsername: 'admin' });

  if (result.sent > 0) {
    await query(
      `INSERT INTO postbuch._settings (key, value, updated_at)
       VALUES ('onedrive_secret_reminder_sent_for', $1::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [JSON.stringify(expiresAt)],
    );
    await appLog('WARN', 'reminder-job', body);
  } else {
    await appLog('WARN', 'reminder-job', `${body} Push konnte noch nicht zugestellt werden; ein neuer Versuch folgt.`);
  }
  return { days, ...result };
}

// ── Cron-Eintritt ───────────────────────────────────────────────────────────

async function runOnce(hour = currentBerlinHour()) {
  if (_running) {
    console.log('[reminder-job] Lauf bereits aktiv — überspringe');
    return null;
  }
  _running = true;
  try {
    const settings = await loadDynamicSettings();
    const wv  = await runWiedervorlagenReminder(settings, hour).catch((e) => {
      console.error('[reminder-job] WV-Fehler:', e);
      appLog('ERROR', 'reminder-job', `WV-Lauf fehlgeschlagen: ${e.message}`);
      return null;
    });
    const pay = await runPaymentReminder(settings, hour).catch((e) => {
      console.error('[reminder-job] Payment-Fehler:', e);
      appLog('ERROR', 'reminder-job', `Payment-Lauf fehlgeschlagen: ${e.message}`);
      return null;
    });
    const onedriveSecret = await runOneDriveSecretReminder(settings, hour).catch((e) => {
      console.error('[reminder-job] OneDrive-Secret-Fehler:', e);
      appLog('ERROR', 'reminder-job', `OneDrive-Secret-Erinnerung fehlgeschlagen: ${e.message}`);
      return null;
    });
    return { wiedervorlagen: wv, payment: pay, onedriveSecret };
  } finally {
    _running = false;
  }
}

/**
 * Komfort-Funktion für manuelle Tests / interne Aufrufe.
 */
export async function runRemindersOnce() {
  return runOnce(currentBerlinHour());
}

export async function startReminderJob() {
  try {
    const settings = await loadDynamicSettings();
    if (settings.reminder_enabled === false) {
      console.log('[reminder-job] deaktiviert (reminder_enabled=false)');
      return;
    }

    let cron;
    try {
      cron = await import('node-cron');
    } catch {
      console.warn('[reminder-job] node-cron fehlt — Erinnerungen deaktiviert');
      appLog('WARN', 'reminder-job', 'node-cron fehlt — Erinnerungen deaktiviert');
      return;
    }

    if (_cronJob) _cronJob.stop();
    _cronJob = cron.default.schedule(REMINDER_CRON, () => {
      runOnce(currentBerlinHour()).catch((e) => console.error('[reminder-job] Cron-Fehler:', e));
    }, { timezone: 'Europe/Berlin' });

    console.log(`[reminder-job] Erinnerungs-Cron gestartet: ${REMINDER_CRON} (Europe/Berlin, Stundenfilter pro Nutzer)`);
  } catch (err) {
    console.error('[reminder-job] Start fehlgeschlagen:', err.message);
  }
}

// Re-Export für Sichtbarkeit beim Aufrufer.
export { PUSH_CATEGORIES };
